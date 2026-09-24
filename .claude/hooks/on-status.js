// Live agent status for the stream overlay. Ephemeral: POST /status is
// broadcast and cached in memory by the daemon, never persisted. Registered on PreToolUse (all tools),
// UserPromptSubmit, Stop, SubagentStart and SubagentStop.
import { api, cardIdFrom, contextFor, readStdin } from './lib.js';

const data = await readStdin();
const { projectId, cardId } = await contextFor(data.cwd ?? process.cwd());
if (!projectId) process.exit(0);

const agent = data.agent_type ?? 'orchestrator';
const short = (s, n = 64) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (data.cwd) s = s.replaceAll(`${data.cwd}/`, '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function fromTool() {
  const tool = data.tool_name ?? '';
  const input = data.tool_input ?? {};
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return ['editing', short(input.file_path)];
  if (tool === 'Read') return ['reading', short(input.file_path)];
  if (tool === 'Grep') return ['searching', short(`"${input.pattern}"`)];
  if (tool === 'Glob') return ['scanning', short(input.pattern)];
  if (tool === 'Bash') return ['running', short(input.command)];
  if (tool === 'Task') return ['dispatching', short(input.subagent_type ?? 'agent')];
  if (/^(WebSearch|WebFetch)$/.test(tool)) return ['researching', short(input.query ?? input.url)];
  if (tool.startsWith('mcp__kankan__')) return ['updating board', tool.slice('mcp__kankan__'.length)];
  return ['using', tool];
}

let verb;
let detail = '';
switch (data.hook_event_name) {
  case 'PreToolUse':
    [verb, detail] = fromTool();
    break;
  case 'UserPromptSubmit':
    verb = 'working';
    detail = 'on your request';
    break;
  case 'Stop':
    verb = 'idle';
    detail = 'waiting for user';
    break;
  case 'SubagentStart':
    verb = 'started';
    break;
  case 'SubagentStop':
    verb = 'finished';
    break;
  default:
    process.exit(0);
}

await api('POST', '/status', {
  project_id: projectId,
  agent,
  agent_id: data.agent_id ?? null,
  verb,
  detail,
  task_id: cardId ?? cardIdFrom(JSON.stringify(data.tool_input ?? data)),
});
