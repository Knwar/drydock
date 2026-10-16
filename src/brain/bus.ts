// Daemon handles that AI Brain modules need outside a request (agent runs,
// timers): the current DB, the daemon URL and live broadcasts. The daemon
// binds them once at startup.
import type { DB } from '../core/db.js';

export interface Bus {
  db: () => DB;
  emit: (msg: unknown) => void;
  daemonUrl: string;
}

let bus: Bus | null = null;

export function bindBus(b: Bus): void {
  bus = b;
}

export function getBus(): Bus {
  if (!bus) throw new Error('brain bus not bound');
  return bus;
}

let stopping = false;
/** The daemon is shutting down: in-flight agent runs are being cut off, not finishing. */
export function markShuttingDown(): void {
  stopping = true;
}
export const isShuttingDown = () => stopping;
