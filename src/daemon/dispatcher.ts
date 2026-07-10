import type { DB } from '../core/db.js';
import { getSubscriptionSecret, subscriptionMatches } from '../core/board.js';
import { LocalHTTPTransport, signDelivery, type DeliveryTransport } from './transport.js';

/**
 * The delivery worker: drains the durable outbox and pushes each event to every
 * matching, enabled subscription, with a per-target state machine (pending →
 * delivered | failed → dead) and exponential backoff.
 *
 * Correctness contract (load-bearing):
 * - IDEMPOTENT FAN-OUT: delivery rows are INSERT OR IGNORE against
 *   UNIQUE(outbox_id, subscription_id), and the (insert + mark-processed) for
 *   one outbox row is a single db.transaction. A crash between committing the
 *   inserts and marking the row processed leaves the row 'pending' and re-fans
 *   on the next runOnce — INSERT OR IGNORE makes that harmless (no duplicate
 *   delivery rows). This is AT-LEAST-ONCE fan-out with exactly-one delivery row
 *   per (event, subscription).
 * - The worker owns no timers; the daemon interval drives runOnce(now). `now` is
 *   injected so tests are deterministic.
 */

/** Max delivery attempts before a delivery is parked in the DLQ ('dead'). */
export const MAX_ATTEMPTS = 6;
/** First retry delay (ms); each subsequent retry multiplies by BACKOFF_FACTOR. */
export const BASE_BACKOFF_MS = 2000;
/** Multiplier applied per attempt for exponential backoff. */
export const BACKOFF_FACTOR = 2;
/** Backoff ceiling (ms) so the delay can't grow without bound. */
export const MAX_BACKOFF_MS = 300000;

/** How many due deliveries one runOnce attempts, bounding a single tick's work. */
const DELIVER_BATCH = 50;

interface OutboxRow {
  id: number;
  project_id: string;
  task_id: string | null;
  type: string;
  payload: string | null;
  created_at: number;
  status: string;
}

interface SubscriptionRow {
  id: string;
  project_id: string | null;
  kind: string;
  event_filter: string;
  target: string;
  enabled: number;
}

interface DueDeliveryRow {
  id: number;
  outbox_id: number;
  subscription_id: string;
  attempts: number;
}

export class Dispatcher {
  private readonly db: DB;
  private readonly transport: DeliveryTransport;

  constructor(db: DB, transport: DeliveryTransport = new LocalHTTPTransport()) {
    this.db = db;
    this.transport = transport;
  }

  /**
   * One drain cycle: fan out any pending outbox events into delivery rows, then
   * attempt every due delivery. `now` (epoch ms) is injectable for deterministic
   * tests; the daemon passes the wall clock.
   */
  async runOnce(now: number = Date.now()): Promise<void> {
    this.fanOut(now);
    await this.deliver(now);
  }

  /**
   * STEP 1 — FAN-OUT. For each pending outbox event, create one delivery row per
   * matching enabled subscription, then mark the event processed. Each event's
   * (insert-deliveries + mark-processed) commits atomically in a single
   * transaction; INSERT OR IGNORE + the UNIQUE constraint make a re-run idempotent.
   */
  private fanOut(now: number): void {
    const events = this.db
      .prepare(`SELECT id, project_id, type FROM outbox WHERE status = 'pending' ORDER BY id`)
      .all() as Pick<OutboxRow, 'id' | 'project_id' | 'type'>[];
    if (events.length === 0) return;

    // A subscription applies when it's enabled and either global (project_id IS
    // NULL) or scoped to this event's project. subscriptionMatches (pure) then
    // gates on the event_filter.
    const matchingSubs = this.db.prepare(
      `SELECT id, event_filter FROM subscriptions
       WHERE enabled = 1 AND (project_id = ? OR project_id IS NULL)`,
    );
    const insertDelivery = this.db.prepare(
      `INSERT OR IGNORE INTO deliveries
        (outbox_id, subscription_id, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?, ?)`,
    );
    const markProcessed = this.db.prepare(`UPDATE outbox SET status = 'processed' WHERE id = ?`);

    for (const event of events) {
      const subs = matchingSubs.all(event.project_id) as { id: string; event_filter: string }[];
      // Wrap this event's fan-out in a single transaction: the delivery inserts
      // and the mark-processed commit together or not at all.
      this.db.transaction(() => {
        for (const sub of subs) {
          if (!subscriptionMatches(sub.event_filter, event.type)) continue;
          // next_attempt_at = now → due immediately on the next deliver pass.
          insertDelivery.run(event.id, sub.id, now, now, now);
        }
        markProcessed.run(event.id);
      })();
    }
  }

  /**
   * STEP 2 — DELIVER. Attempt every delivery that is due: pending or previously
   * failed, and whose next_attempt_at has arrived (or is unset). Bounded batch.
   */
  private async deliver(now: number): Promise<void> {
    const due = this.db
      .prepare(
        `SELECT id, outbox_id, subscription_id, attempts FROM deliveries
         WHERE status IN ('pending','failed')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY id
         LIMIT ?`,
      )
      .all(now, DELIVER_BATCH) as DueDeliveryRow[];

    const loadEvent = this.db.prepare(
      `SELECT id, project_id, task_id, type, payload, created_at FROM outbox WHERE id = ?`,
    );
    const loadSub = this.db.prepare(
      `SELECT id, target FROM subscriptions WHERE id = ?`,
    );

    for (const delivery of due) {
      const event = loadEvent.get(delivery.outbox_id) as
        | Pick<OutboxRow, 'id' | 'project_id' | 'task_id' | 'type' | 'payload' | 'created_at'>
        | undefined;
      const sub = loadSub.get(delivery.subscription_id) as { id: string; target: string } | undefined;
      // A delivery whose event or subscription vanished can never succeed — park it.
      if (!event || !sub) {
        this.markDead(delivery, now, null, 'event or subscription missing');
        continue;
      }

      // payload is the stored JSON string — included as-is (not re-parsed), so
      // the delivered body carries the exact payload snapshot from the outbox.
      const body = JSON.stringify({
        id: event.id,
        type: event.type,
        project_id: event.project_id,
        task_id: event.task_id,
        payload: event.payload,
        created_at: event.created_at,
      });
      const timestamp = now;
      const secret = getSubscriptionSecret(this.db, delivery.subscription_id);
      const sig = signDelivery(body, secret, timestamp);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'X-Kankan-Timestamp': String(timestamp),
        'X-Kankan-Event': event.type,
        ...(sig ? { 'X-Kankan-Signature': sig } : {}),
      };

      const result = await this.transport.send(sub.target, headers, body);
      if (result.ok) {
        this.markDelivered(delivery, now, result.status);
        continue;
      }

      const attempts = delivery.attempts + 1;
      const lastError = result.error ?? null;
      if (attempts >= MAX_ATTEMPTS) {
        this.markDead(delivery, now, result.status, lastError, attempts);
      } else {
        this.markFailed(delivery, now, result.status, lastError, attempts);
      }
    }
  }

  private markDelivered(delivery: DueDeliveryRow, now: number, status: number): void {
    this.db
      .prepare(
        `UPDATE deliveries SET status = 'delivered', last_status_code = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, now, delivery.id);
  }

  private markFailed(
    delivery: DueDeliveryRow,
    now: number,
    status: number,
    error: string | null,
    attempts: number,
  ): void {
    // Exponential backoff, capped: BASE * FACTOR^(attempts-1), clamped to MAX.
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * BACKOFF_FACTOR ** (attempts - 1));
    this.db
      .prepare(
        `UPDATE deliveries SET status = 'failed', attempts = ?, last_status_code = ?, last_error = ?,
           next_attempt_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(attempts, status, error, now + backoff, now, delivery.id);
  }

  private markDead(
    delivery: DueDeliveryRow,
    now: number,
    status: number | null,
    error: string | null,
    attempts = delivery.attempts + 1,
  ): void {
    // DLQ: no further retries — next_attempt_at cleared so it's never re-selected.
    this.db
      .prepare(
        `UPDATE deliveries SET status = 'dead', attempts = ?, last_status_code = ?, last_error = ?,
           next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(attempts, status, error, now, delivery.id);
  }
}
