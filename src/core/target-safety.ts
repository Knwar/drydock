/**
 * SSRF DEFENSE for delivery targets.
 *
 * Defense-in-depth so even a trusted/local caller can't turn the dispatcher
 * into a proxy to cloud metadata / internal services. `assertSafeTarget` is
 * called at subscription-CREATE time (createSubscription) so a dangerous target
 * is rejected before it's ever stored, and the transport separately refuses to
 * follow redirects (see LocalHTTPTransport) so a validated target can't 302 its
 * way to an internal address at delivery time.
 *
 * A subscription target may be scheme-prefixed for a connector, e.g.
 *   `slack:https://hooks.slack.com/...`  /  `signal:https://.../v2/send/...`
 * We strip that connector scheme with the SAME first-colon split the connector
 * layer uses, then validate the real endpoint URL.
 */

/**
 * Cloud-metadata / instance-identity endpoints that are ALWAYS blocked,
 * regardless of strict mode — reaching any of these from a webhook is never
 * legitimate and is the classic SSRF-to-credentials pivot.
 *   169.254.169.254        — AWS / Azure / GCP / OpenStack IMDS
 *   fd00:ec2::254          — AWS IMDS over IPv6
 *   metadata.google.internal — GCP metadata (DNS name)
 *   100.100.100.200        — Alibaba Cloud metadata
 */
const METADATA_HOSTS: ReadonlySet<string> = new Set([
  '169.254.169.254',
  'fd00:ec2::254',
  'metadata.google.internal',
  '100.100.100.200',
]);

/**
 * Split a target on the FIRST ':' only — mirrors `splitScheme` in
 * daemon/connectors.ts. The endpoint is itself an `https://...` URL full of
 * colons, so splitting on every ':' would mangle it. Returns null when there's
 * no scheme (or a leading ':').
 */
function splitScheme(target: string): { scheme: string; endpoint: string } | null {
  const i = target.indexOf(':');
  if (i <= 0) return null;
  return { scheme: target.slice(0, i), endpoint: target.slice(i + 1) };
}

/**
 * Resolve the EFFECTIVE endpoint of a target: if it carries a known connector
 * scheme (`slack:` / `signal:`), strip that prefix to get the real URL;
 * otherwise the target IS the URL. We only strip the KNOWN connector schemes so
 * that `http:`/`https:`/`file:` targets aren't mistaken for a connector prefix.
 */
const CONNECTOR_SCHEMES: ReadonlySet<string> = new Set(['slack', 'signal']);

function effectiveEndpoint(target: string): string {
  const split = splitScheme(target);
  if (split && CONNECTOR_SCHEMES.has(split.scheme)) return split.endpoint;
  return target;
}

/** Normalize a hostname for comparison: strip IPv6 brackets, lowercase. */
function normalizeHost(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

/** Parse a dotted-quad IPv4 string into its 4 octets, or null if it isn't one. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

/**
 * Is this hostname a PRIVATE / internal IP or name we block only in strict mode?
 * Covers loopback, link-local, and the RFC1918 private ranges (v4), plus the
 * common IPv6 forms (::1 loopback, fe80::/10 link-local). `localhost` is treated
 * as loopback by name.
 */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost') return true;

  // IPv6 loopback and link-local (fe80::/10).
  if (host === '::1') return true;
  if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
    // fe80::/10 = fe80..febf — the first hextet's high 10 bits fixed.
    return true;
  }

  const v4 = parseIPv4(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
  }
  return false;
}

/**
 * Assert that a delivery target is safe to store/deliver. Throws a clear Error
 * when it isn't; the daemon route turns thrown Errors into HTTP 400.
 *
 * Always (both modes):
 *   - the effective URL must parse and be http: or https: (reject file:, gopher:,
 *     ftp:, data:, and anything that doesn't parse as a URL);
 *   - cloud-metadata hosts are blocked.
 *
 * STRICT MODE (env `KANKAN_STRICT_TARGETS === '1'`, DEFAULT OFF — enable this
 * when the daemon is EXPOSED to untrusted callers, i.e. Phase 7 remote hosting):
 *   - ALSO blocks loopback, link-local, and RFC1918 private ranges. Left OFF by
 *     default so the local demo can keep using loopback targets like
 *     `slack:http://127.0.0.1:PORT/...`.
 */
export function assertSafeTarget(target: string): void {
  const effective = effectiveEndpoint(target);

  let url: URL;
  try {
    url = new URL(effective);
  } catch {
    throw new Error(`unsafe delivery target: cannot parse URL from ${JSON.stringify(target)}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `unsafe delivery target: scheme ${url.protocol} not allowed (only http/https)`,
    );
  }

  const host = normalizeHost(url.hostname);

  // ALWAYS block cloud-metadata endpoints, regardless of strict mode.
  if (METADATA_HOSTS.has(host)) {
    throw new Error(`unsafe delivery target: cloud-metadata host ${host} is blocked`);
  }

  // STRICT MODE: also block internal/private ranges. Off by default so the
  // loopback-based local demo keeps working.
  if (process.env.KANKAN_STRICT_TARGETS === '1' && isPrivateHost(host)) {
    throw new Error(
      `unsafe delivery target: private/internal host ${host} is blocked in strict mode`,
    );
  }
}
