import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendEvent, createSubscription, getOrCreateProject } from '../core/board.js';
import { openDb, type DB } from '../core/db.js';
import {
  BASE_BACKOFF_MS,
  BACKOFF_FACTOR,
  Dispatcher,
  MAX_ATTEMPTS,
} from './dispatcher.js';
import type { DeliveryTransport } from './transport.js';

/**
 * A stub transport that records every send and returns a programmed result — no
 * real network. `program` sets what the next (and subsequent) sends return.
 */
class StubTransport implements DeliveryTransport {
  calls: { target: string; headers: Record<string, string>; body: string }[] = [];
  private result: { ok: boolean; status: number; error?: string } = { ok: true, status: 200 };

  program(result: { ok: boolean; status: number; error?: string }): void {
    this.result = result;
  }

  async send(target: string, headers: Record<string, string>, body: string) {
    this.calls.push({ target, headers, body });
    return this.result;
  }
}

/**
 * A stub transport whose `send` returns a promise you resolve MANUALLY, so a
 * test can hold a send "in flight" across the await and drive OVERLAPPING
 * runOnce calls. `resolveNext` settles the pending send with a programmed result.
 */
class DeferredTransport implements DeliveryTransport {
  calls: { target: string; headers: Record<string, string>; body: string }[] = [];
  private pending: ((r: { ok: boolean; status: number; error?: string }) => void) | null = null;

  async send(target: string, headers: Record<string, string>, body: string) {
    this.calls.push({ target, headers, body });
    return new Promise<{ ok: boolean; status: number; error?: string }>((resolve) => {
      this.pending = resolve;
    });
  }

  /** Resolve the currently in-flight send (the one runOnce is awaiting). */
  resolveNext(result: { ok: boolean; status: number; error?: string }): void {
    const resolve = this.pending;
    assert.ok(resolve, 'no send in flight to resolve');
    this.pending = null;
    resolve(result);
  }
}

function setup() {
  const db = openDb();
  const project = getOrCreateProject(db, '/tmp/dispatcher-app', 'Dispatcher App');
  return { db, project };
}

/** Read a single delivery row (the tests only ever create one). */
function onlyDelivery(db: DB) {
  return db.prepare('SELECT * FROM deliveries').get() as {
    id: number;
    outbox_id: number;
    subscription_id: string;
    status: string;
    attempts: number;
    last_status_code: number | null;
    last_error: string | null;
    next_attempt_at: number | null;
  };
}

function outboxStatus(db: DB, id: number): string {
  return (db.prepare('SELECT status FROM outbox WHERE id = ?').get(id) as { status: string }).status;
}

describe('Dispatcher fan-out', () => {
  it('is idempotent: two runOnce → one delivery row, outbox processed', async () => {
    const { db, project } = setup();
    const sub = createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: '*',
      target: 'https://example.com/hook',
    });
    const ev = appendEvent(db, { project_id: project.id, type: 'note', payload: { msg: 'hi' } });

    const transport = new StubTransport();
    const dispatcher = new Dispatcher(db, transport);

    await dispatcher.runOnce(1000);
    await dispatcher.runOnce(2000); // re-fan must not double-create

    const rows = db
      .prepare('SELECT * FROM deliveries WHERE outbox_id = ? AND subscription_id = ?')
      .all(ev.id, sub.id);
    assert.equal(rows.length, 1); // INSERT OR IGNORE + UNIQUE → exactly one
    assert.equal(outboxStatus(db, ev.id), 'processed');
  });

  it('matches by project scope + event_filter; skips disabled and non-matching', async () => {
    const { db, project } = setup();
    const other = getOrCreateProject(db, '/tmp/other-dispatcher-app');

    // (a) project-scoped, matching filter → delivers
    const scoped = createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: 'move',
      target: 'https://example.com/scoped',
    });
    // (b) global (project_id null), wildcard → delivers
    const global = createSubscription(db, {
      project_id: null,
      kind: 'webhook',
      event_filter: '*',
      target: 'https://example.com/global',
    });
    // (c) other project → must NOT deliver
    createSubscription(db, {
      project_id: other.id,
      kind: 'webhook',
      event_filter: '*',
      target: 'https://example.com/other',
    });
    // (d) matching project but filter excludes 'move' → must NOT deliver
    createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: 'create,review',
      target: 'https://example.com/nomatch',
    });
    // (e) matching + wildcard but DISABLED → must NOT deliver
    const disabled = createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: '*',
      target: 'https://example.com/disabled',
    });
    db.prepare('UPDATE subscriptions SET enabled = 0 WHERE id = ?').run(disabled.id);

    const ev = appendEvent(db, { project_id: project.id, task_id: 't1', type: 'move', payload: { from: 'a', to: 'b' } });

    const transport = new StubTransport();
    await new Dispatcher(db, transport).runOnce(1000);

    const subIds = (db.prepare('SELECT subscription_id FROM deliveries WHERE outbox_id = ?').all(ev.id) as {
      subscription_id: string;
    }[]).map((r) => r.subscription_id).sort();
    assert.deepEqual(subIds, [scoped.id, global.id].sort()); // only scoped + global
  });
});

describe('Dispatcher delivery', () => {
  it('ok transport → delivered, with target/body/signature header sent', async () => {
    const { db, project } = setup();
    const sub = createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: '*',
      target: 'https://example.com/hook',
      secret: 'topsecret',
    });
    const ev = appendEvent(db, { project_id: project.id, task_id: 't1', type: 'note', payload: { msg: 'hi' } });

    const transport = new StubTransport();
    transport.program({ ok: true, status: 200 });
    await new Dispatcher(db, transport).runOnce(1720000000);

    const row = onlyDelivery(db);
    assert.equal(row.status, 'delivered');
    assert.equal(row.last_status_code, 200);

    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0];
    assert.equal(call.target, sub.target);
    // body is the event envelope with the payload carried as-is (stored string)
    const parsed = JSON.parse(call.body);
    assert.equal(parsed.id, ev.id);
    assert.equal(parsed.type, 'note');
    assert.equal(parsed.project_id, project.id);
    assert.equal(parsed.task_id, 't1');
    assert.equal(parsed.payload, ev.payload); // stored JSON string, not re-parsed
    // signature present because the subscription has a secret
    assert.ok(call.headers['X-Kankan-Signature']?.startsWith('sha256='));
    assert.equal(call.headers['X-Kankan-Event'], 'note');
    assert.equal(call.headers['X-Kankan-Timestamp'], '1720000000');
  });

  it('no secret → no signature header, but still delivered', async () => {
    const { db, project } = setup();
    createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: '*',
      target: 'https://example.com/nosig',
    });
    appendEvent(db, { project_id: project.id, type: 'note', payload: { msg: 'hi' } });

    const transport = new StubTransport();
    await new Dispatcher(db, transport).runOnce(1000);

    assert.equal(onlyDelivery(db).status, 'delivered');
    assert.equal(transport.calls[0].headers['X-Kankan-Signature'], undefined);
  });

  it('failing transport → attempts++, failed, growing next_attempt_at across ticks', async () => {
    const { db, project } = setup();
    createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: '*',
      target: 'https://example.com/flaky',
    });
    appendEvent(db, { project_id: project.id, type: 'note', payload: { msg: 'hi' } });

    const transport = new StubTransport();
    transport.program({ ok: false, status: 500, error: 'boom' });
    const dispatcher = new Dispatcher(db, transport);

    // tick 1 at t=1000 → attempt 1, backoff = BASE * FACTOR^0
    await dispatcher.runOnce(1000);
    let row = onlyDelivery(db);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
    assert.equal(row.last_status_code, 500);
    assert.equal(row.last_error, 'boom');
    const firstBackoff = BASE_BACKOFF_MS * BACKOFF_FACTOR ** 0;
    assert.equal(row.next_attempt_at, 1000 + firstBackoff);
    const firstDue = row.next_attempt_at!;

    // Not due yet → a tick before next_attempt_at must NOT re-attempt.
    await dispatcher.runOnce(firstDue - 1);
    assert.equal(onlyDelivery(db).attempts, 1); // untouched
    assert.equal(transport.calls.length, 1);

    // tick 2 at the due time → attempt 2, a strictly larger backoff window
    await dispatcher.runOnce(firstDue);
    row = onlyDelivery(db);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 2);
    const secondBackoff = BASE_BACKOFF_MS * BACKOFF_FACTOR ** 1;
    assert.equal(row.next_attempt_at, firstDue + secondBackoff);
    assert.ok(secondBackoff > firstBackoff); // backoff grows
    assert.equal(transport.calls.length, 2);
  });

  it('after MAX_ATTEMPTS → dead and no longer selected as due', async () => {
    const { db, project } = setup();
    createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: '*',
      target: 'https://example.com/dead',
    });
    appendEvent(db, { project_id: project.id, type: 'note', payload: { msg: 'hi' } });

    const transport = new StubTransport();
    transport.program({ ok: false, status: 503, error: 'down' });
    const dispatcher = new Dispatcher(db, transport);

    // Drive MAX_ATTEMPTS ticks, each time advancing the clock past the pending
    // next_attempt_at so the delivery is due again.
    let now = 1000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await dispatcher.runOnce(now);
      const row = onlyDelivery(db);
      if (row.next_attempt_at != null) now = row.next_attempt_at;
    }

    const dead = onlyDelivery(db);
    assert.equal(dead.status, 'dead'); // parked in the DLQ
    assert.equal(dead.attempts, MAX_ATTEMPTS);
    assert.equal(dead.next_attempt_at, null); // cleared → never re-selected
    assert.equal(transport.calls.length, MAX_ATTEMPTS);

    // A further tick far in the future must not re-attempt a dead delivery.
    await dispatcher.runOnce(now + MAX_BACKOFF_SENTINEL);
    assert.equal(transport.calls.length, MAX_ATTEMPTS);
    assert.equal(onlyDelivery(db).status, 'dead');
  });
});

describe('Dispatcher re-entrancy guard', () => {
  it('overlapping runOnce sends a due delivery exactly once; the row is never regressed', async () => {
    const { db, project } = setup();
    createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: '*',
      target: 'https://example.com/hook',
    });
    appendEvent(db, { project_id: project.id, type: 'note', payload: { msg: 'hi' } });

    const transport = new DeferredTransport();
    const dispatcher = new Dispatcher(db, transport);

    // runOnce #1 fans out, selects the due delivery, and awaits the (deferred)
    // send — it is now parked mid-flight, before any mark* update runs.
    const first = dispatcher.runOnce(1000);
    await Promise.resolve(); // let #1 reach the awaited send
    assert.equal(transport.calls.length, 1); // the one due send is in flight

    // runOnce #2 enters WHILE #1 is still in-flight. (c) It must no-op: return
    // without selecting/sending anything, so the same row isn't sent twice.
    await dispatcher.runOnce(1001);
    assert.equal(transport.calls.length, 1); // (a) still exactly one send — #2 no-opped

    // Resolve the in-flight send OK and let #1 finish its update.
    transport.resolveNext({ ok: true, status: 200 });
    await first;

    // (b) the row settles to 'delivered' and is never regressed to 'failed'.
    const row = onlyDelivery(db);
    assert.equal(row.status, 'delivered');
    assert.equal(row.attempts, 0);
    assert.equal(row.last_status_code, 200);
    assert.equal(transport.calls.length, 1); // no redelivery across the overlap
  });

  it('a runOnce entered while another is in-flight returns without sending', async () => {
    const { db, project } = setup();
    createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: '*',
      target: 'https://example.com/hook',
    });
    appendEvent(db, { project_id: project.id, type: 'note', payload: { msg: 'hi' } });

    const transport = new DeferredTransport();
    const dispatcher = new Dispatcher(db, transport);

    const first = dispatcher.runOnce(1000);
    await Promise.resolve(); // #1 is now awaiting the deferred send
    assert.equal(transport.calls.length, 1);

    // A plain assertion: a second runOnce, entered mid-flight, sends nothing.
    const before = transport.calls.length;
    await dispatcher.runOnce(1000);
    assert.equal(transport.calls.length, before); // guard short-circuited it

    transport.resolveNext({ ok: true, status: 200 });
    await first;
  });
});

describe('Dispatcher connector delivery', () => {
  it('connector sub → provider-formatted Slack body sent to the scheme-stripped endpoint', async () => {
    const { db, project } = setup();
    createSubscription(db, {
      project_id: project.id,
      kind: 'connector',
      event_filter: 'block',
      target: 'slack:https://hooks.slack.com/services/T/B/xxx',
    });
    appendEvent(db, {
      project_id: project.id,
      task_id: 'card-1',
      type: 'block',
      payload: { reason: 'need a secret' },
    });

    const transport = new StubTransport();
    transport.program({ ok: true, status: 200 });
    await new Dispatcher(db, transport).runOnce(1720000000);

    assert.equal(onlyDelivery(db).status, 'delivered');
    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0];
    // Scheme stripped: the raw https endpoint, NOT the 'slack:' target.
    assert.equal(call.target, 'https://hooks.slack.com/services/T/B/xxx');
    assert.equal(call.headers['content-type'], 'application/json');
    // Slack incoming-webhook shape: a single {"text": ...} field.
    const parsed = JSON.parse(call.body) as { text?: string };
    assert.equal(typeof parsed.text, 'string');
    assert.ok(parsed.text!.includes('card-1'));
    assert.ok(parsed.text!.includes('need a secret'));
    // Signed over the FINAL (Slack) body; event header still carries the type.
    assert.equal(call.headers['X-Kankan-Event'], 'block');
    assert.equal(call.headers['X-Kankan-Timestamp'], '1720000000');
  });

  it('webhook sub → unchanged generic envelope body + raw target', async () => {
    const { db, project } = setup();
    const sub = createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: 'block',
      target: 'https://example.com/hook',
    });
    const ev = appendEvent(db, {
      project_id: project.id,
      task_id: 'card-2',
      type: 'block',
      payload: { reason: 'still blocked' },
    });

    const transport = new StubTransport();
    transport.program({ ok: true, status: 200 });
    await new Dispatcher(db, transport).runOnce(1720000000);

    assert.equal(onlyDelivery(db).status, 'delivered');
    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0];
    // Raw target, unchanged behavior.
    assert.equal(call.target, sub.target);
    assert.equal(call.headers['content-type'], 'application/json');
    // Generic envelope, NOT the Slack shape.
    const parsed = JSON.parse(call.body) as Record<string, unknown>;
    assert.equal(parsed.id, ev.id);
    assert.equal(parsed.type, 'block');
    assert.equal(parsed.project_id, project.id);
    assert.equal(parsed.task_id, 'card-2');
    assert.equal(parsed.payload, ev.payload); // stored JSON string, not re-parsed
    assert.equal(parsed.text, undefined); // definitely not a connector body
  });

  it('connector sub with an unknown scheme → dead with last_error, transport NOT called', async () => {
    const { db, project } = setup();
    createSubscription(db, {
      project_id: project.id,
      kind: 'connector',
      event_filter: 'block',
      target: 'foo:bar',
    });
    appendEvent(db, {
      project_id: project.id,
      task_id: 'card-3',
      type: 'block',
      payload: { reason: 'unknown provider' },
    });

    const transport = new StubTransport();
    transport.program({ ok: true, status: 200 });
    await new Dispatcher(db, transport).runOnce(1720000000);

    const row = onlyDelivery(db);
    assert.equal(row.status, 'dead');
    assert.ok(row.last_error?.includes('unknown connector scheme'));
    assert.ok(row.last_error?.includes('foo:bar'));
    assert.equal(transport.calls.length, 0); // never sent
  });
});

// A large clock jump to prove a 'dead' delivery is never re-selected as due.
const MAX_BACKOFF_SENTINEL = 10_000_000;
