// The request gate: in front of every route and WebSocket, so that only
// requests that make sense reach the daemon.
//
// - Host must name this machine (localhost, 127.0.0.1, [::1]; and when the user
//   opened the daemon to the network with HOST, this Mac's own addresses and
//   names): a DNS-rebinding page arrives with its own hostname.
// - A browser request (it carries Origin, or Sec-Fetch-Site) must come from
//   Drydock's own app: the daemon's port or the dev UI's. A page on any other
//   site, or an app an agent built (served on <slug>.localhost or another port),
//   is refused. Cross-site fetch metadata is refused outright.
// - A browser request with a body must send JSON, so a page can't slip in a
//   no-preflight text/plain "simple request".
// Local processes (agents' tool servers, hooks, the CLI) send no Origin and
// pass here; giving each caller its own token is the next layer.

export interface GateRequest {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  contentType: string | undefined;
  /** content-length > 0, or a chunked body */
  hasBody: boolean;
  /** a WebSocket handshake */
  upgrade?: boolean;
}

export interface GatePolicy {
  /** hostnames that name this machine */
  hosts: Set<string>;
  /** exact origins of Drydock's own app, e.g. http://localhost:7900 */
  origins: Set<string>;
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** The hosts and app origins for a daemon on `port` (and the dev UI on `webPort`); `extraHosts` are this machine's other names. */
export function gatePolicy(port: number, webPort: number, extraHosts: string[] = []): GatePolicy {
  const hosts = new Set(LOOPBACK);
  for (const h of extraHosts) if (h) hosts.add(h.includes(':') && !h.startsWith('[') ? `[${h.toLowerCase()}]` : h.toLowerCase());
  const origins = new Set<string>();
  for (const h of hosts) for (const p of new Set([port, webPort])) origins.add(`http://${h}:${p}`);
  return { hosts, origins };
}

/** The hostname in a Host header ("localhost:7900" → "localhost", "[::1]:7900" → "[::1]"). */
export function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

/** null when the request may go on; otherwise why it is refused. */
export function checkRequest(r: GateRequest, policy: GatePolicy): string | null {
  if (!r.host || !policy.hosts.has(hostName(r.host))) return 'unknown host';
  const browser = Boolean(r.origin) || Boolean(r.secFetchSite);
  if (!browser) return null;
  if (r.secFetchSite === 'cross-site') return 'cross-site request';
  if (r.origin !== undefined && !policy.origins.has(r.origin.toLowerCase())) return 'request from another site';
  // same-origin page loads and navigations carry no Origin; anything that changes state needs one
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(r.method);
  if ((write || r.upgrade) && !r.origin) return 'missing origin';
  if (write && r.hasBody && !/^application\/json\b/i.test(r.contentType ?? '')) return 'body must be JSON';
  return null;
}
