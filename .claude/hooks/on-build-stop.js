// SubagentStop (matcher: builder): card → in_review + build_end event.
// Only act on the card we can identify exactly — no "first in_progress card"
// guess, which raced across concurrent builders and could flip the wrong card to
// in_review. The reliable in_review trigger is the builder checking its last
// acceptance criterion (handled deterministically in the daemon); a builder that
// stops without finishing correctly stays in_progress.
import { api, cardIdFromEvent, projectIdFor, readStdin, subagentTranscriptPath, sumTokens } from './lib.js';

const data = await readStdin();
const projectId = await projectIdFor(data.cwd ?? process.cwd());
if (!projectId) process.exit(0);

const cardId = cardIdFromEvent(data);
if (!cardId) process.exit(0);

const agent = data.agent_type ?? 'builder';
await api('POST', `/task/${cardId}/move`, { lane: 'in_review', agent });
await api('POST', '/event', { project_id: projectId, task_id: cardId, type: 'build_end', agent });

// record this build run's cost: tokens (total, output, and the per-model
// breakdown the cost is priced from) from the subagent transcript; the daemon
// adds line-churn + elapsed time and credits the card's assigned team member
// (the subagent type is recorded as the run's role).
const tx = subagentTranscriptPath(data);
if (tx) {
  const { tokens, tokens_out, usage } = sumTokens(tx);
  if (tokens) await api('POST', `/task/${cardId}/activity`, { agent, role: agent, agent_id: data.agent_id, tokens, tokens_out, usage });
}
