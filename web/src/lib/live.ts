// One WebSocket to the daemon's /ws (all projects); listeners get every message.
type Listener = (msg: any) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let debounce: number | undefined;
const pending: any[] = [];

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onmessage = (e) => {
    try {
      pending.push(JSON.parse(e.data));
    } catch {
      return;
    }
    clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      const batch = pending.splice(0);
      for (const msg of batch) for (const l of listeners) l(msg);
    }, 150);
  };
  socket.onclose = () => setTimeout(connect, 1500);
}

export function onLive(l: Listener): () => void {
  if (!socket) connect();
  listeners.add(l);
  return () => listeners.delete(l);
}
