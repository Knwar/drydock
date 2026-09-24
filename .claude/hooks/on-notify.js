// Notification hook: Claude Code needs the user (permission prompt, or idle
// waiting for input). Flag the project "needs you" on the dashboard; the next
// on-status.js event (UserPromptSubmit / PreToolUse / Stop) replaces it.
// Best-effort: any failure exits 0, never blocks the session.
import { api, contextFor, readStdin } from './lib.js';

try {
  const data = await readStdin();
  const { projectId } = await contextFor(data.cwd ?? process.cwd());
  if (projectId) {
    let detail = String(data.message ?? '').replace(/\s+/g, ' ').trim();
    if (detail.length > 64) detail = `${detail.slice(0, 64)}…`;
    // the main session is the one that prompts the human
    // a finished session waiting for input is idle, not blocked; everything
    // else (permission prompts, elicitation, unknown types) needs the human
    const idle =
      data.notification_type === 'idle_prompt' ||
      (data.notification_type === undefined && /waiting for your input/i.test(detail));
    const status = idle ? { verb: 'idle', detail: 'waiting for user' } : { verb: 'needs you', detail };
    await api('POST', '/status', { project_id: projectId, agent: 'orchestrator', ...status });
  }
} catch {
  // best-effort
}
process.exit(0);
