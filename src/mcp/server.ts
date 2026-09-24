// Thin stdio MCP client of the board daemon. Never touches SQLite.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DAEMON_URL = process.env.DAEMON_URL ?? 'http://localhost:7890';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Call the daemon; degrade to a readable error if it's down or rejects. */
async function api(method: string, path: string, body?: unknown): Promise<ToolResult> {
  try {
    const res = await fetch(`${DAEMON_URL}${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { content: [{ type: 'text', text }], isError: !res.ok };
  } catch {
    return {
      content: [{ type: 'text', text: `board daemon unreachable at ${DAEMON_URL} — board features unavailable; continue without them or ask the user to run scripts/dev.sh` }],
      isError: true,
    };
  }
}

const server = new McpServer({ name: 'kankan', version: '0.1.0' });

server.registerTool(
  'get_or_create_project',
  {
    description: 'Get or create the board project for a directory. Returns {project_id,name}.',
    inputSchema: { root_path: z.string(), name: z.string().optional() },
  },
  ({ root_path, name }) => {
    const params = new URLSearchParams({ root: root_path });
    if (name) params.set('name', name);
    return api('GET', `/project?${params}`);
  },
);

server.registerTool(
  'get_board',
  {
    description: 'Full board as summary cards (id,title,lane,tag,agent). Use sparingly; prefer get_active_card.',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/board?project=${encodeURIComponent(project_id)}`),
);

server.registerTool(
  'get_active_card',
  {
    description: 'Cards currently in_progress — "what am I on?".',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/active?project=${encodeURIComponent(project_id)}`),
);

server.registerTool(
  'get_next_card',
  {
    description: 'Top backlog card whose depends_on are all done, or null.',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/next?project=${encodeURIComponent(project_id)}`),
);

server.registerTool(
  'create_task',
  {
    description: 'Create a task in the backlog. Returns {task_id}. Pass phase_id to file it under a phase.',
    inputSchema: {
      project_id: z.string(),
      title: z.string(),
      tag: z.enum(['ui', 'api', 'db', 'infra']).optional(),
      requirements: z.string().optional(),
      depends_on: z.array(z.string()).optional(),
      phase_id: z.string().optional(),
    },
  },
  (input) => api('POST', '/task', input),
);

server.registerTool(
  'update_task',
  {
    description: 'Update a task’s requirements, tag, depends_on, or subtasks (acceptance criteria, replaces the whole list).',
    inputSchema: {
      task_id: z.string(),
      requirements: z.string().optional(),
      tag: z.enum(['ui', 'api', 'db', 'infra']).optional(),
      depends_on: z.array(z.string()).optional(),
      subtasks: z.array(z.string()).optional(),
    },
  },
  ({ task_id, ...patch }) => api('PATCH', `/task/${task_id}`, patch),
);

server.registerTool(
  'check_subtask',
  {
    description: 'Mark one acceptance criterion done (by zero-based index). When the last one is checked on an in_progress card, the daemon auto-moves it to in_review.',
    inputSchema: {
      task_id: z.string(),
      index: z.number().int().min(0),
      done: z.boolean().optional(),
    },
  },
  ({ task_id, index, done }) =>
    api('POST', `/task/${task_id}/check`, { index, done: done ?? true, agent: 'builder' }),
);

server.registerTool(
  'move_task',
  {
    description: 'Move a card to a lane. Judgment moves only (e.g. backlog→queued, review routing) — in_progress/in_review transitions are fired by hooks, not you.',
    inputSchema: {
      task_id: z.string(),
      lane: z.enum(['backlog', 'queued', 'in_progress', 'in_review', 'done']),
    },
  },
  ({ task_id, lane }) => api('POST', `/task/${task_id}/move`, { lane, agent: 'orchestrator' }),
);

server.registerTool(
  'assign_card',
  {
    description:
      'Record dispatch: which agent owns the card, in which worktree, on which branch. Pass a team member’s name/id as `agent` (or a `skill`) and the card picks up that persona’s skill for the builder to load.',
    inputSchema: {
      task_id: z.string(),
      agent: z.string(),
      worktree_path: z.string(),
      branch: z.string(),
      skill: z.string().optional(),
    },
  },
  ({ task_id, agent, worktree_path, branch, skill }) =>
    api('PATCH', `/task/${task_id}`, { assigned_agent: agent, worktree_path, branch, skill }),
);

server.registerTool(
  'delete_task',
  {
    description:
      'Permanently delete a card and its history (reviews, events), and strip it from other cards’ depends_on. Irreversible — for mistakes, duplicates, and throwaways, not for finished work (move that to done).',
    inputSchema: { task_id: z.string() },
  },
  ({ task_id }) => api('DELETE', `/task/${task_id}`),
);

server.registerTool(
  'redirect_task',
  {
    description:
      'Abandon a card’s current approach and reset it for a fresh start: clears the assignment/worktree/branch, resets the review-round counter and acceptance criteria, and returns it to the backlog. Pass requirements to set the new direction. Use when the approach is wrong (not just buggy) — then remove the stale worktree (kankan worktree remove <id> --force) and re-plan before redispatching.',
    inputSchema: { task_id: z.string(), requirements: z.string().optional(), note: z.string().optional() },
  },
  ({ task_id, ...rest }) => api('POST', `/task/${task_id}/redirect`, rest),
);

server.registerTool(
  'raise_blocker',
  {
    description:
      'Builder tool: flag that this card needs a human decision you cannot make yourself — an ambiguous or contradictory spec, a destructive/irreversible action to confirm, a missing secret/credential, or an architectural fork the requirements don’t resolve. Pass a specific question as `reason`, then stop and end your turn. The card stays where it is and jumps to the top of the human’s Attention queue until resolved. Not for ordinary uncertainty — that belongs in your final report.',
    inputSchema: { task_id: z.string(), reason: z.string() },
  },
  ({ task_id, reason }) => api('POST', `/task/${task_id}/block`, { reason, agent: 'builder' }),
);

server.registerTool(
  'resolve_blocker',
  {
    description:
      'Clear a card’s blocker once you’ve answered the builder’s question — work can resume. redirect_task and re-dispatching a builder (assign_card) already clear it; use this when you’ve just folded the decision into the card’s requirements without redispatching yet.',
    inputSchema: { task_id: z.string(), note: z.string().optional() },
  },
  ({ task_id, note }) => api('POST', `/task/${task_id}/unblock`, { note }),
);

server.registerTool(
  'record_review',
  {
    description: 'Record a review verdict for a card; bumps the review round.',
    inputSchema: {
      task_id: z.string(),
      verdict: z.enum(['pass', 'fail']),
      findings: z
        .array(
          z.object({
            file: z.string(),
            line: z.number().optional(),
            severity: z.string(),
            note: z.string(),
          }),
        )
        .optional(),
    },
  },
  ({ task_id, verdict, findings }) => api('POST', `/task/${task_id}/review`, { verdict, findings }),
);

server.registerTool(
  'get_stats',
  {
    description:
      'Per-agent project activity: cards touched, wall-clock time, lines added/removed, and tokens used (with output split). Plus project totals.',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/stats?project=${encodeURIComponent(project_id)}`),
);

server.registerTool(
  'get_team',
  {
    description:
      'The team roster: named agents and each one’s assigned skill (persona). Use to pick a specialized agent when dispatching a card.',
    inputSchema: {},
  },
  () => api('GET', '/team'),
);

server.registerTool(
  'create_phase',
  {
    description:
      'Add a phase to the project roadmap (status planned). Returns {phase_id}. Manager mode drafts the phases; commit them here after the user approves.',
    inputSchema: {
      project_id: z.string(),
      title: z.string(),
      goal: z.string().optional(),
      plan: z.string().optional(),
    },
  },
  (input) => api('POST', '/phase', input),
);

server.registerTool(
  'get_phases',
  {
    description:
      'The project roadmap: phases with status (planned|active|done) and card progress. Empty for flat/legacy projects.',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/phases?project=${encodeURIComponent(project_id)}`),
);

server.registerTool(
  'get_next_phase',
  {
    description: 'The next planned phase in the roadmap, or null.',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/phase/next?project=${encodeURIComponent(project_id)}`),
);

server.registerTool(
  'advance_phase',
  {
    description:
      'Scrum move: complete the active phase and activate the next planned one; returns the newly active phase, or null when the roadmap is finished. With nothing active yet it activates the first phase (kickoff). Use only when the active phase is genuinely done.',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('POST', '/phase/advance', { project_id }),
);

server.registerTool(
  'update_phase',
  {
    description:
      'Park, activate, close, or reorder a roadmap phase. Activating demotes the current active phase to planned. Judgment move — use advance_phase for the normal phase loop.',
    inputSchema: {
      phase_id: z.string(),
      status: z.enum(['planned', 'active', 'done']).optional(),
      position: z.number().int().min(1).optional(),
    },
  },
  ({ phase_id, status, position }) => api('POST', `/phase/${phase_id}`, { status, position }),
);

server.registerTool(
  'create_vertical',
  {
    description:
      "Create a vertical (its own board) under a workspace project. `root` = the vertical's folder: a monorepo subfolder or a separate repo (absolute path). An existing childless project at that folder is adopted. Returns {project_id, name, root_path, parent_id}.",
    inputSchema: { workspace_project_id: z.string(), name: z.string(), root: z.string() },
  },
  ({ workspace_project_id, name, root }) =>
    api('POST', '/vertical', { workspace_id: workspace_project_id, name, root }),
);

server.registerTool(
  'list_verticals',
  {
    description: 'The verticals (child boards) of a workspace project.',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/verticals?project=${encodeURIComponent(project_id)}`),
);

server.registerTool(
  'get_workspace',
  {
    description:
      'The workspace and all its verticals, given a workspace OR vertical project id. A standalone project returns verticals: [].',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/workspace?project=${encodeURIComponent(project_id)}`),
);

server.registerTool(
  'create_subscription',
  {
    description:
      'Register an outbound subscription (webhook|connector|bridge) that fires on matching board events. Returns the redacted subscription view (secret is never echoed back — only has_secret).',
    inputSchema: {
      project_id: z.string().optional(),
      kind: z.enum(['webhook', 'connector', 'bridge']),
      event_filter: z.string(),
      target: z.string(),
      secret: z.string().optional(),
      scopes: z.string().optional(),
    },
  },
  (input) => api('POST', '/subscriptions', input),
);

server.registerTool(
  'list_subscriptions',
  {
    description: 'List subscriptions (redacted; secrets shown only as has_secret). Pass project_id to scope to one project.',
    inputSchema: { project_id: z.string().optional() },
  },
  ({ project_id }) =>
    api('GET', project_id ? `/subscriptions?project_id=${encodeURIComponent(project_id)}` : '/subscriptions'),
);

server.registerTool(
  'get_subscription',
  {
    description: 'Get one subscription by id (redacted; secret shown only as has_secret).',
    inputSchema: { id: z.string() },
  },
  ({ id }) => api('GET', `/subscriptions/${encodeURIComponent(id)}`),
);

server.registerTool(
  'delete_subscription',
  {
    description: 'Delete a subscription by id.',
    inputSchema: { id: z.string() },
  },
  ({ id }) => api('DELETE', `/subscriptions/${encodeURIComponent(id)}`),
);

server.registerTool(
  'update_subscription',
  {
    description: 'Enable or disable a subscription by id. Returns the redacted subscription view.',
    inputSchema: { id: z.string(), enabled: z.boolean() },
  },
  ({ id, enabled }) => api('PATCH', `/subscriptions/${encodeURIComponent(id)}`, { enabled }),
);

await server.connect(new StdioServerTransport());
