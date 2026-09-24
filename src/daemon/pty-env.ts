import { execFileSync } from 'node:child_process';

/** Where a project's terminal opens: the git toplevel containing rootPath (so a
 *  monorepo vertical starts at the repo root and picks up its .claude/.mcp.json/
 *  CLAUDE.md), or rootPath itself when it isn't inside a git repo. */
export function sessionCwd(rootPath: string): string {
  try {
    const top = execFileSync('git', ['-C', rootPath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    return top || rootPath;
  } catch {
    return rootPath;
  }
}

/** The terminal's env: base minus undefined values, with the vertical bound via
 *  KANKAN_PROJECT_ID (overriding any inherited binding) and TERM set. */
export function sessionEnv(base: NodeJS.ProcessEnv, projectId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && k !== 'KANKAN_PROJECT_ID') env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.KANKAN_PROJECT_ID = projectId;
  return env;
}
