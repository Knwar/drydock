import { createHmac } from 'node:crypto';

/**
 * The delivery TRANSPORT abstraction — the cloud seam.
 *
 * The dispatcher worker depends ONLY on this interface, so a cloud-relay
 * implementation can slot in later without the worker knowing how bytes
 * actually leave the machine.
 *
 * `send` never rejects: a failed/hung delivery comes back as `{ ok: false }`
 * so the worker can treat it as a retryable delivery rather than a crash.
 */
export interface DeliveryTransport {
  send(
    target: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ ok: boolean; status: number; error?: string }>;
}

/** Default abort deadline for a single send, so a hung target can't stall the worker. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Concrete transport that POSTs the body to `target` over local HTTP using
 * Node's global `fetch` (Node >=20).
 *
 * Contract:
 * - Returns `{ ok, status }` straight from the HTTP response (2xx → ok:true).
 * - On a thrown/network error, timeout, or unreachable target, returns
 *   `{ ok: false, status: 0, error }` — it NEVER throws.
 * - Sets `content-type: application/json` unless the caller already supplied one.
 */
export class LocalHTTPTransport implements DeliveryTransport {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async send(
    target: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ ok: boolean; status: number; error?: string }> {
    const finalHeaders = withDefaultContentType(headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: finalHeaders,
        body,
        signal: controller.signal,
        // SSRF defense: never auto-follow redirects — a validated target must not
        // be able to 302 to an internal/metadata address. A redirect just yields a
        // 3xx status (non-ok delivery), which is fine: webhooks shouldn't redirect.
        redirect: 'manual',
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Case-insensitively add a default `content-type: application/json` unless the caller set one. */
function withDefaultContentType(headers: Record<string, string>): Record<string, string> {
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (hasContentType) return headers;
  return { 'content-type': 'application/json', ...headers };
}

/**
 * Build the exact string that gets signed. Both signer and receiver MUST
 * construct this identically to verify.
 *
 * Format: `${timestamp}.${body}` — the timestamp, a literal '.', then the raw body.
 * The timestamp is coerced to a string; the body is signed verbatim (bytes as-is).
 */
export function signedString(body: string, timestamp: string | number): string {
  return `${timestamp}.${body}`;
}

/**
 * PURE signing helper (no I/O). Produces the value for the `X-Kankan-Signature`
 * header: an HMAC-SHA256 over `signedString(body, timestamp)` keyed by `secret`,
 * hex-encoded and prefixed, e.g. `sha256=<hex>`.
 *
 * Returns `null` when `secret` is null/empty (the caller then sends no
 * signature header).
 *
 * Receiver verification: recompute `sha256=HMAC_SHA256(secret, `${timestamp}.${body}`)`
 * in hex and compare (use a constant-time comparison in the receiver).
 */
export function signDelivery(
  body: string,
  secret: string | null | undefined,
  timestamp: string | number,
): string | null {
  if (!secret) return null;
  const hex = createHmac('sha256', secret).update(signedString(body, timestamp)).digest('hex');
  return `sha256=${hex}`;
}
