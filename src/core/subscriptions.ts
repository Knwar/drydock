import type { DB } from './db.js';
import { assertSafeTarget } from './target-safety.js';
import { now, shortId } from './board.js';
import { buildWhere } from './sql-util.js';
import {
  EVENT_TYPES,
  SUBSCRIPTION_KINDS,
  type Delivery,
  type Subscription,
  type SubscriptionKind,
  type SubscriptionView,
} from './types.js';

// ── subscription registry: "who wants which events" (Phase 3 dispatcher reads it) ──
//
// Secret redaction is centralized HERE, at the data layer. Every public read
// (list/get, and the return value of create/update) goes through toView(),
// which strips the raw secret and exposes only has_secret. The daemon-route and
// MCP cards pass this module's return values straight through and physically
// cannot leak a secret. The lone exception is getSubscriptionSecret() — an
// internal delivery-use accessor for the Phase 3 dispatcher (see below).

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Redact a full row to its public view: drop `secret`, expose `has_secret`. */
function toView(row: Subscription): SubscriptionView {
  const { secret, ...rest } = row;
  return { ...rest, has_secret: secret != null && secret !== '' };
}

/**
 * PURE matcher (no db): does an event_filter match a given event type? '*'
 * matches everything; otherwise the type must be a member of the filter's
 * comma-separated list (tokens are trimmed). Phase 3's dispatcher imports this.
 */
export function subscriptionMatches(filter: string, eventType: string): boolean {
  if (filter === '*') return true;
  return filter
    .split(',')
    .map((t) => t.trim())
    .includes(eventType);
}

/** Validate an event_filter: '*' or a comma-separated list of real EventTypes. */
function assertEventFilter(filter: string): void {
  if (filter === '*') return;
  const tokens = filter.split(',').map((t) => t.trim());
  if (tokens.length === 0 || tokens.some((t) => t === '')) {
    throw new Error(`invalid event_filter: ${JSON.stringify(filter)} (empty token)`);
  }
  for (const t of tokens) {
    if (!EVENT_TYPE_SET.has(t)) throw new Error(`invalid event_filter token: ${t}`);
  }
}

export interface CreateSubscriptionInput {
  project_id?: string | null;
  kind: SubscriptionKind;
  event_filter: string;
  target: string;
  secret?: string | null;
  scopes?: string | null;
}

export function createSubscription(db: DB, input: CreateSubscriptionInput): SubscriptionView {
  if (!SUBSCRIPTION_KINDS.includes(input.kind)) {
    throw new Error(`invalid subscription kind: ${input.kind}`);
  }
  if (!input.target) throw new Error('subscription target is required');
  assertEventFilter(input.event_filter);
  // SSRF defense: reject dangerous targets (bad scheme, cloud-metadata, and —
  // in strict mode — internal ranges) at creation, before the row is stored.
  assertSafeTarget(input.target);
  const sub: Subscription = {
    id: shortId(),
    project_id: input.project_id ?? null,
    kind: input.kind,
    event_filter: input.event_filter,
    target: input.target,
    secret: input.secret ?? null,
    scopes: input.scopes ?? null,
    enabled: 1,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO subscriptions (id, project_id, kind, event_filter, target, secret, scopes, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sub.id,
    sub.project_id,
    sub.kind,
    sub.event_filter,
    sub.target,
    sub.secret,
    sub.scopes,
    sub.enabled,
    sub.created_at,
  );
  return toView(sub);
}

/**
 * Public list of subscriptions (redacted). With a project_id, returns that
 * project's subs PLUS global ones (project_id IS NULL); without, returns all.
 */
export function listSubscriptions(db: DB, projectId?: string): SubscriptionView[] {
  const rows = (
    projectId
      ? db
          .prepare(
            'SELECT * FROM subscriptions WHERE project_id = ? OR project_id IS NULL ORDER BY created_at',
          )
          .all(projectId)
      : db.prepare('SELECT * FROM subscriptions ORDER BY created_at').all()
  ) as Subscription[];
  return rows.map(toView);
}

/** Public lookup by id (redacted), or null. */
export function getSubscription(db: DB, id: string): SubscriptionView | null {
  const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as
    | Subscription
    | undefined;
  return row ? toView(row) : null;
}

/** Remove a subscription; returns whether a row was deleted. */
export function deleteSubscription(db: DB, id: string): boolean {
  return db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id).changes > 0;
}

/** Toggle a subscription enabled/disabled; returns the updated (redacted) view. */
export function updateSubscription(db: DB, id: string, patch: { enabled: boolean }): SubscriptionView {
  db.prepare('UPDATE subscriptions SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
  const view = getSubscription(db, id);
  if (!view) throw new Error(`no such subscription: ${id}`);
  return view;
}

/**
 * INTERNAL / delivery-use ONLY — the raw signing secret for a subscription, for
 * the Phase 3 dispatcher to sign outbound deliveries. NOT exposed over any
 * HTTP/MCP API: every public read redacts the secret (see toView). Returns null
 * when the subscription doesn't exist or has no secret.
 */
export function getSubscriptionSecret(db: DB, id: string): string | null {
  const row = db.prepare('SELECT secret FROM subscriptions WHERE id = ?').get(id) as
    | { secret: string | null }
    | undefined;
  return row?.secret ?? null;
}

// ── deliveries: read-only observability over the fan-out state machine ──

const DELIVERY_LIMIT_DEFAULT = 100;
const DELIVERY_LIMIT_MAX = 500;

/**
 * List delivery rows (per outbox-event × subscription attempt state), newest
 * first (id DESC). Optional filters — applied only when provided — narrow by
 * subscription_id and/or status ('dead' is the DLQ view). The limit defaults to
 * 100 and is capped at 500. Pure read (a prepared SELECT, no writes).
 */
export function listDeliveries(
  db: DB,
  opts: { subscription_id?: string; status?: string; limit?: number } = {},
): Delivery[] {
  const { clause, params } = buildWhere({
    subscription_id: opts.subscription_id,
    status: opts.status,
  });
  const requested = Number.isFinite(opts.limit) ? opts.limit! : DELIVERY_LIMIT_DEFAULT;
  const limit = Math.min(Math.max(1, requested), DELIVERY_LIMIT_MAX);
  return db
    .prepare(
      `SELECT id, outbox_id, subscription_id, status, attempts, last_status_code, last_error, next_attempt_at, created_at, updated_at
       FROM deliveries ${clause}ORDER BY id DESC LIMIT ?`,
    )
    .all(...params, limit) as Delivery[];
}
