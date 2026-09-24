// Which process groups belong to a pty shell's terminal — pure, so the safety
// filtering is unit-testable. Shutdown signals exactly these groups.

const PTY_NAME = /^(ttys\d+|pts\/\d+)$/; // macOS / Linux pty names

/**
 * @param shellPid  the pty shell's pid (a session + group leader)
 * @param tty       `ps -o tty= -p <shellPid>` output
 * @param psOutput  `ps -o pgid=,tty= -t <tty>` output ('' if not queried)
 * @param ownPgid   the daemon's own process group — never signalled
 */
export function ptyGroups(shellPid: number, tty: string, psOutput: string, ownPgid: number): number[] {
  const groups = new Set([shellPid]);
  const name = tty.trim();
  if (PTY_NAME.test(name)) {
    for (const line of psOutput.split('\n')) {
      const [pgid, lineTty] = line.trim().split(/\s+/);
      if (lineTty === name) groups.add(Number(pgid));
    }
  }
  return [...groups].filter((g) => Number.isInteger(g) && g > 1 && g !== ownPgid);
}

export const isPtyName = (tty: string): boolean => PTY_NAME.test(tty.trim());
