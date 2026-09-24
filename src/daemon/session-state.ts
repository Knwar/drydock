// Live per-project agent session state, derived from POST /status pings.
// Ephemeral by design: held in memory only, NEVER persisted to SQLite — a
// daemon restart simply forgets it (every project reads as offline).

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

export class SessionStates {
  private projects = new Map<string, ProjectSession>();

  /** Record a ping. A subagent's 'finished' (SubagentStop) removes its entry
   *  instead; stale agent entries are pruned on every record. */
  record(projectId: string, entry: StatusEntry): void {
    let s = this.projects.get(projectId);
    if (!s) {
      s = { agents: new Map() };
      this.projects.set(projectId, s);
    }
    for (const [key, a] of s.agents) if (entry.at - a.at >= OFFLINE_MS) s.agents.delete(key);
    if (entry.agent === MAIN_AGENT) s.main = entry;
    else if (entry.verb === 'finished') s.agents.delete(entry.agent_id ?? entry.agent);
    else s.agents.set(entry.agent_id ?? entry.agent, entry);
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

  forget(projectId: string): void {
    this.projects.delete(projectId);
  }
}
