// Autopilot: decide whether the daemon should prompt a project's idle Claude
// session to work its next queued card. Pure — server.ts gathers the inputs.

/** Nudging pauses while shared 5-hour subscription usage is at/above this. */
export const USAGE_PAUSE_PCT = 80;

/** The prompt typed into the session's Claude Code input on a nudge. */
export const NUDGE_PROMPT = 'Work the next queued card on this board (autopilot).';

export interface NudgeInput {
  autopilot: boolean;
  sessionState: string;
  mainIdleSince: number | null; // main session's idle status timestamp, or null if not idle
  lastNudgedIdleAt: number | null; // the mainIdleSince we last nudged for
  queued: number;
  claudeForeground: boolean;
  fivePct: number | null;
  fiveResetsAt: number | null; // epoch ms
  now: number;
}

export function shouldNudge(i: NudgeInput): { nudge: boolean; reason: string } {
  const no = (reason: string) => ({ nudge: false, reason });
  if (!i.autopilot) return no('autopilot off');
  if (i.sessionState !== 'idle') return no(`session ${i.sessionState}`);
  if (i.queued <= 0) return no('no queued cards');
  if (!i.claudeForeground) return no('claude not in foreground');
  const rolledOver = i.fiveResetsAt !== null && i.fiveResetsAt <= i.now;
  if (i.fivePct !== null && !rolledOver && i.fivePct >= USAGE_PAUSE_PCT)
    return no(`usage ${i.fivePct}% ≥ ${USAGE_PAUSE_PCT}%`);
  if (i.mainIdleSince !== null && i.lastNudgedIdleAt === i.mainIdleSince) return no('already nudged this idle period');
  return { nudge: true, reason: 'idle with queued cards' };
}

const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'node']);
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Does a process command line (from `ps -o command=`) look like Claude Code?
 *  Native `claude` binary, `node …/@anthropic-ai/claude-code/cli.js`, or a
 *  `claude` script run by an interpreter (`/bin/sh …/claude`). */
export function looksLikeClaude(cmd: string): boolean {
  const c = cmd.trim();
  if (c.includes('@anthropic-ai/claude-code')) return true;
  const [exe = '', arg1 = ''] = c.split(/\s+/);
  if (/(^|\/)claude$/.test(exe)) return true;
  return INTERPRETERS.has(base(exe)) && arg1.endsWith('/claude');
}

/** Normalize a rate-limit `resets_at` (epoch seconds, epoch ms, or ISO string) to epoch ms; null if absent/unparseable. */
export function resetsAtMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}
