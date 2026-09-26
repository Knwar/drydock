// Live per-project agent session state, derived from POST /status pings.
// Ephemeral by design: held in memory only, NEVER persisted to SQLite — a
// daemon restart simply forgets it (every project reads as offline). An
// optional listener is told about state changes (e.g. to persist needs_you
// intervals); the state itself stays in memory.

/** A session with no ping for this long reads as offline. */
export const OFFLINE_MS = 10 * 60 * 1000;
/** A subagent ping this recent keeps an idle main session reading as working. */
export const RECENT_AGENT_MS = 2 * 60 * 1000;

export interface StatusEntry {
  agent: string; // agent type, for display
  agent_id: string | null; // distinguishes parallel subagents of one type
  verb: string;
  detail: string;
  task_id: string | null;
  at: number;
}

export type SessionState = 'working' | 'idle' | 'needs_you' | 'offline';

export interface SessionView {
  state: SessionState;
  main: StatusEntry | null;
  agents: StatusEntry[];
}

/** The agent name .claude/hooks/on-status.js sends for the main session. */
const MAIN_AGENT = 'orchestrator';

interface ProjectSession {
  main?: StatusEntry;
  agents: Map<string, StatusEntry>;
}

/** A project's session state changed, as observed at a ping, a sweep or a forget. */
export interface StateChange {
  projectId: string;
  from: SessionState;
  to: SessionState;
  /** When it changed: the ping time, or for a silent offline timeout the moment it went offline. */
  at: number;
  view: SessionView;
}

export class SessionStates {
  private projects = new Map<string, ProjectSession>();
  /** Last state reported to the listener (absent = offline). */
  private observed = new Map<string, SessionState>();

  constructor(private onChange?: (c: StateChange) => void) {}

  /** Record a ping. A subagent's 'finished' (SubagentStop) removes its entry
   *  instead; stale agent entries are pruned on every record. */
  record(projectId: string, entry: StatusEntry): void {
    this.settle(projectId, entry.at); // a silent offline timeout before this ping
    let s = this.projects.get(projectId);
    if (!s) {
      s = { agents: new Map() };
      this.projects.set(projectId, s);
    }
    for (const [key, a] of s.agents) if (entry.at - a.at >= OFFLINE_MS) s.agents.delete(key);
    if (entry.agent === MAIN_AGENT) s.main = entry;
    else if (entry.verb === 'finished') s.agents.delete(entry.agent_id ?? entry.agent);
    else s.agents.set(entry.agent_id ?? entry.agent, entry);
    this.settle(projectId, entry.at);
  }

  /** Report offline timeouts (no ping for OFFLINE_MS) that no ping has observed yet. */
  sweep(now: number): void {
    for (const projectId of [...this.observed.keys()]) this.settle(projectId, now);
  }

  /** Compare the state at `now` with the last reported one; report a change. */
  private settle(projectId: string, now: number): void {
    if (!this.onChange) return;
    const view = this.view(projectId, now);
    const from = this.observed.get(projectId) ?? 'offline';
    if (view.state === from) return;
    // offline began OFFLINE_MS after the last ping of any agent, not when we noticed
    const at = view.state === 'offline' ? Math.min(now, this.lastSeen(projectId) + OFFLINE_MS) : now;
    if (view.state === 'offline') this.observed.delete(projectId);
    else this.observed.set(projectId, view.state);
    this.onChange({ projectId, from, to: view.state, at, view });
  }

  private lastSeen(projectId: string): number {
    const s = this.projects.get(projectId);
    let at = s?.main?.at ?? -Infinity;
    for (const a of s?.agents.values() ?? []) at = Math.max(at, a.at);
    return at;
  }

  view(projectId: string, now: number): SessionView {
    const s = this.projects.get(projectId);
    const main = s?.main ?? null;
    const agents = s
      ? [...s.agents.values()].filter((a) => now - a.at < OFFLINE_MS).sort((a, b) => b.at - a.at)
      : [];
    const mainLive = main !== null && now - main.at < OFFLINE_MS;
    let state: SessionState;
    if (!mainLive && agents.length === 0) state = 'offline';
    else if (main?.verb === 'needs you') state = 'needs_you';
    else if (main?.verb === 'idle' && !agents.some((a) => now - a.at < RECENT_AGENT_MS)) state = 'idle';
    else state = 'working';
    return { state, main, agents };
  }

  forget(projectId: string, now = Date.now()): void {
    this.projects.delete(projectId);
    const from = this.observed.get(projectId);
    this.observed.delete(projectId);
    if (from && this.onChange) {
      this.onChange({ projectId, from, to: 'offline', at: now, view: { state: 'offline', main: null, agents: [] } });
    }
  }
}
