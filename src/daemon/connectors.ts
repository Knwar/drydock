/**
 * Provider CONNECTORS — the per-destination formatting seam.
 *
 * A connector turns a kankan event (from `task_events`) into the exact
 * provider-specific request body a chat/notification endpoint expects. This
 * module is PURE: no network, no db, no schema. The dispatcher (next card)
 * resolves a subscription's target to a connector, calls `format` to build the
 * body, and hands the result to a `DeliveryTransport`.
 *
 * A subscription target is scheme-prefixed, e.g.
 *   `slack:https://hooks.slack.com/services/T/B/xxx`
 *   `signal:https://signal-cli.example/v2/send/+15551234567`
 * The scheme selects the connector; the rest is the real endpoint URL.
 */

/** The event shape a connector formats — a subset of a `task_events` row. */
export interface ConnectorEvent {
  id: number;
  type: string;
  project_id: string;
  task_id: string | null;
  /** JSON string of the event payload, or null. Parse defensively. */
  payload: string | null;
  created_at: number;
}

/** What `format` returns: the request body plus an optional content type. */
export interface FormattedMessage {
  body: string;
  contentType?: string;
}

export interface Connector {
  /**
   * Strip the scheme prefix and return the real endpoint. The caller has
   * already resolved which connector to use (via `resolveConnector`), so this
   * simply hands back the endpoint portion.
   */
  parseTarget(rawTarget: string): string;
  /** Build the provider-specific request body from an event. */
  format(event: ConnectorEvent): FormattedMessage;
}

/**
 * Pull the blocker `reason` out of an event's JSON payload, defensively.
 * A 'block' event's payload is `{"reason":"..."}` (see `raiseBlocker` in
 * core/board.ts). Returns null when payload is null, not valid JSON, or has no
 * string `reason` — callers must degrade gracefully.
 */
function parseReason(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed && typeof parsed === 'object' && 'reason' in parsed) {
      const reason = (parsed as { reason: unknown }).reason;
      if (typeof reason === 'string' && reason.trim() !== '') return reason;
    }
  } catch {
    // malformed JSON — fall through to null, no throw
  }
  return null;
}

/**
 * The human-readable alert line, shared by every connector so all providers
 * carry the same wording. Cites the card (`task_id`) and the blocker reason,
 * and stays sensible when either is missing.
 */
function alertText(event: ConnectorEvent): string {
  const reason = parseReason(event.payload);
  const card = event.task_id ?? 'a card';
  const reasonPart = reason ? `: ${reason}` : ' — reason unavailable';
  return `:rotating_light: 🚨 Blocker on card ${card}${reasonPart}`;
}

/** Split a target on the FIRST ':' only. */
function splitScheme(target: string): { scheme: string; endpoint: string } | null {
  const i = target.indexOf(':');
  if (i <= 0) return null; // no scheme, or leading ':'
  return { scheme: target.slice(0, i), endpoint: target.slice(i + 1) };
}

/** Shared parseTarget: drop the scheme, return the endpoint (or the input if unschemed). */
function endpointOf(rawTarget: string): string {
  const split = splitScheme(rawTarget);
  return split ? split.endpoint : rawTarget;
}

/**
 * Slack incoming-webhook connector. Body is `{"text": <message>}` — the
 * canonical Slack webhook shape. This is the hero of the demo.
 */
export const slackConnector: Connector = {
  parseTarget: endpointOf,
  format(event: ConnectorEvent): FormattedMessage {
    return {
      body: JSON.stringify({ text: alertText(event) }),
      contentType: 'application/json',
    };
  },
};

/**
 * Signal connector, shaped for a signal-cli-style REST endpoint (e.g.
 * `POST /v2/send` with a JSON body). We send the same alert text under a
 * `message` field. NOTE: the exact signal-cli contract (recipients, number,
 * base64 attachments) can be refined later — this keeps the shape simple and
 * self-contained; Slack is the primary demo target.
 */
export const signalConnector: Connector = {
  parseTarget: endpointOf,
  format(event: ConnectorEvent): FormattedMessage {
    return {
      body: JSON.stringify({ message: alertText(event) }),
      contentType: 'application/json',
    };
  },
};

/** Registry of connectors keyed by target scheme. */
export const CONNECTORS: Record<string, Connector> = {
  slack: slackConnector,
  signal: signalConnector,
};

/**
 * Resolve a scheme-prefixed target to its connector and endpoint.
 *
 * Splits on the FIRST ':' ONLY — the endpoint is itself an `https://...` URL
 * full of colons, so splitting on every ':' would mangle it. Returns null when
 * there's no scheme or the scheme is unknown.
 *
 * @example
 * resolveConnector('slack:https://hooks.slack.com/services/T/B/xxx')
 * // → { connector: slackConnector, endpoint: 'https://hooks.slack.com/services/T/B/xxx' }
 */
export function resolveConnector(
  target: string,
): { connector: Connector; endpoint: string } | null {
  const split = splitScheme(target);
  if (!split) return null;
  const connector = CONNECTORS[split.scheme];
  if (!connector) return null;
  return { connector, endpoint: split.endpoint };
}
