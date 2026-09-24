// Which process groups belong to a pty shell's terminal — pure, so the safety
// filtering is unit-testable. Shutdown signals exactly these groups.

const PTY_NAME = /^(ttys\d+|pts\/\d+)$/; // macOS / Linux pty names

export const isPtyName = (tty: string): boolean => PTY_NAME.test(tty.trim());

/** The shell as seen by the daemon: `null` = not verifiably ours (signal nothing);
 *  `tty: null` = ours, but no usable pty name (signal its own group only). */
export type ShellInfo = { tty: string | null } | null;

/**
 * Verify a session's pid is still OUR shell before trusting it: node-pty may
 * report an exit late, and the OS can reuse the pid meanwhile. Our shell is a
 * child of the daemon and a session/group leader (pgid === pid).
 * @param psLine `ps -o ppid=,pgid=,tty= -p <shellPid>` output
 */
export function shellInfo(shellPid: number, psLine: string, daemonPid: number): ShellInfo {
  const [ppid, pgid, tty = ''] = psLine.trim().split(/\s+/);
  if (Number(ppid) !== daemonPid || Number(pgid) !== shellPid) return null;
  return { tty: isPtyName(tty) ? tty : null };
}

/** Groups with a process on `tty`, from `ps -o pgid=,tty= -t <tty>` output — rows
 *  on any other tty (ps quirks), groups 0/1 and the daemon's own group dropped. */
export function ttyGroups(tty: string, psOutput: string, ownPgid: number): number[] {
  if (!isPtyName(tty)) return [];
  const groups = new Set<number>();
  for (const line of psOutput.split('\n')) {
    const [pgid, lineTty] = line.trim().split(/\s+/);
    if (lineTty === tty.trim()) groups.add(Number(pgid));
  }
  return [...groups].filter((g) => safeGroup(g, ownPgid));
}

/** Everything to SIGHUP for one session: the shell's group plus the groups on its
 *  tty (`onTty`, from ttyGroups — ignored when the tty isn't usable). */
export function ptyGroups(shellPid: number, info: ShellInfo, onTty: number[], ownPgid: number): number[] {
  if (info === null) return [];
  const groups = new Set([shellPid, ...(info.tty ? onTty : [])]);
  return [...groups].filter((g) => safeGroup(g, ownPgid));
}

/** SIGKILL only groups we signalled AND that are still verifiably ours now
 *  (a group that died on SIGHUP may have had its pgid reused). */
export function stillOurs(original: number[], current: number[]): number[] {
  const now = new Set(current);
  return original.filter((g) => now.has(g));
}

const safeGroup = (g: number, ownPgid: number) => Number.isInteger(g) && g > 1 && g !== ownPgid;
