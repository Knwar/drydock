// Thin stdio MCP client of the board daemon. Never touches SQLite.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { brainHome } from '../brain/workspace.js';

const DAEMON_URL = process.env.DAEMON_URL ?? 'http://localhost:7900';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Call the daemon; degrade to a readable error if it's down or rejects. */
/** An agent run's token, else the user's local token (their own Claude Code sessions). */
function daemonToken(): string {
  if (process.env.DAEMON_TOKEN) return process.env.DAEMON_TOKEN;
  try {
    return readFileSync(join(brainHome(), 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function api(method: string, path: string, body?: unknown): Promise<ToolResult> {
  try {
    const res = await fetch(`${DAEMON_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${daemonToken()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
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

const server = new McpServer({ name: 'kanban', version: '0.1.0' });

const WORK_TYPE = z.enum(['feature', 'defect', 'debt', 'risk']);
const ESTIMATE = z.number().gt(0).max(1000);
const ESTIMATE_GUIDE =
  ' estimate_hours: rough hours a human engineer would take (> 0, <= 1000), e.g. S ~2, M ~6, L ~16.';
const WORK_TYPE_GUIDE =
  ' work_type: feature = new user value; defect = fixing broken behaviour; debt = refactor, upgrade, tests or cleanup; risk = security, compliance or reliability.';

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
    description:
      'Create a task in the backlog. Returns {task_id}. Pass phase_id to file it under a phase.' + WORK_TYPE_GUIDE + ESTIMATE_GUIDE,
    inputSchema: {
      project_id: z.string(),
      title: z.string(),
      tag: z.enum(['ui', 'api', 'db', 'infra']).optional(),
      requirements: z.string().optional(),
      depends_on: z.array(z.string()).optional(),
      phase_id: z.string().optional(),
      work_type: WORK_TYPE.optional(),
      estimate_hours: ESTIMATE.optional(),
    },
  },
  (input) => api('POST', '/task', input),
);

server.registerTool(
  'update_task',
  {
    description:
      'Update a task’s requirements, tag, depends_on, subtasks (acceptance criteria, replaces the whole list), work_type or estimate_hours (null clears either).' +
      WORK_TYPE_GUIDE +
      ESTIMATE_GUIDE,
    inputSchema: {
      task_id: z.string(),
      requirements: z.string().optional(),
      tag: z.enum(['ui', 'api', 'db', 'infra']).optional(),
      depends_on: z.array(z.string()).optional(),
      subtasks: z.array(z.string()).optional(),
      work_type: WORK_TYPE.nullable().optional(),
      estimate_hours: ESTIMATE.nullable().optional(),
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
      'Abandon a card’s current approach and reset it for a fresh start: clears the assignment/worktree/branch, resets the review-round counter and acceptance criteria, and returns it to the backlog. Pass requirements to set the new direction. Use when the approach is wrong (not just buggy) — then remove the stale worktree (brain worktree remove <id> --force) and re-plan before redispatching.',
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
  'get_metrics',
  {
    description:
      'Flow metrics summary: throughput per ISO week for the last 4 ISO weeks ending at `to` (default now; the current week partial), cycle time p50/p85 (ms) over the same window, WIP by lane, the oldest in-flight card, `waiting` (work waiting on the human right now: needs-you sessions + open blockers, count and longest wait in ms), and `cost` {period: USD spent on build runs in the same window, estimatedShare: the share of it estimated from runs without a token breakdown (null when nothing was spent)}. A workspace id includes its verticals. from/to: epoch ms, YYYY-MM-DD, or a datetime (read in `tz` when it has no zone). tz: IANA zone, default the daemon\'s.',
    inputSchema: {
      project_id: z.string(),
      phase_id: z.string().optional(),
      tag: z.enum(['ui', 'api', 'db', 'infra']).optional(),
      agent: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      tz: z.string().optional(),
    },
  },
  async ({ project_id, phase_id, tag, agent, from, to, tz }) => {
    const params = new URLSearchParams({ project: project_id });
    for (const [k, v] of [['phase', phase_id], ['tag', tag], ['agent', agent], ['from', from], ['to', to], ['tz', tz]] as const) {
      if (v) params.set(k, v);
    }
    const summary = await api('GET', `/metrics/summary?${params}`);
    if (summary.isError) return summary;
    const waitParams = new URLSearchParams({ project: project_id });
    if (phase_id) waitParams.set('phase', phase_id);
    const wait = await api('GET', `/metrics/wait?${waitParams}`);
    // the flow summary stands on its own: a failed wait or cost lookup only drops
    // `waiting` / `cost`, with a note saying so
    const merged = JSON.parse(summary.content[0].text);
    const notes: string[] = [];
    if (wait.isError) notes.push(`waiting unavailable: ${wait.content[0]?.text}`);
    else {
      const { count, longestMs } = JSON.parse(wait.content[0].text).waiting;
      merged.waiting = { count, longestMs };
    }
    // cost over the summary's own window
    const costParams = new URLSearchParams(params);
    if (merged.range) {
      costParams.set('from', String(merged.range.from));
      costParams.set('to', String(merged.range.to));
    }
    costParams.set('limit', '1');
    const spent = await api('GET', `/metrics/cost?${costParams}`);
    if (spent.isError) notes.push(`cost unavailable: ${spent.content[0]?.text}`);
    else {
      const c = JSON.parse(spent.content[0].text);
      merged.cost = { period: c.totals.cost, estimatedShare: c.estimated.share };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(merged) }, ...notes.map((text) => ({ type: 'text' as const, text }))] };
  },
);

server.registerTool(
  'get_forecast',
  {
    description:
      'Monte Carlo finish-date forecast for the not-done cards of a committed plan (plan_id), a phase (project_id + phase_id), or the whole board (project_id), resampling the scope\'s daily throughput over the last `weeks` (default 6) calendar weeks. With plan_id, project_id is optional but, if given, must be the plan\'s workspace. Returns p50/p85/p95 {days, date} + a days histogram + the seed used, or status insufficient_history (need 10 history days and 5 done cards). seed: pass a previous result\'s seed to reproduce it. tz: IANA zone, default the daemon\'s.',
    inputSchema: {
      project_id: z.string().optional(),
      phase_id: z.string().optional(),
      plan_id: z.string().optional(),
      tag: z.enum(['ui', 'api', 'db', 'infra']).optional(),
      weeks: z.number().int().min(2).max(52).optional(),
      seed: z.number().int().min(0).max(2 ** 32 - 1).optional(),
      tz: z.string().optional(),
    },
  },
  ({ project_id, phase_id, plan_id, tag, weeks, seed, tz }) => {
    const params = new URLSearchParams();
    for (const [k, v] of [['project', project_id], ['phase', phase_id], ['plan', plan_id], ['tag', tag], ['weeks', weeks?.toString()], ['seed', seed?.toString()], ['tz', tz]] as const) {
      if (v) params.set(k, v);
    }
    return api('GET', `/metrics/forecast?${params}`);
  },
);

server.registerTool(
  'get_agentic_metrics',
  {
    description:
      'Agentic flow metrics over a window: autonomy (share of cards done with no blocker and no redirect, weekly trend), stops (agent self-stops = raised blockers vs human interrupts = redirects + reopens that are not review-fail rework; ratio agent:human, weekly), batch size (lines per done card: share over `batch_lines` (default 200), median, top 5; cards without line data counted apart), spec adherence (per phase: acceptance criteria checked / total and review first-pass rate on done cards; overall share of done cards with all criteria checked AND a first-pass review), governance (share of recorded tool events tied to a card, risky Bash commands from the recorded command text with a caveat, or null + reason when none is recorded, and share of done cards linked to a decision). A workspace includes its verticals; scope narrows to one of them. from/to: epoch ms, YYYY-MM-DD or a datetime (in `tz`). compare: "previous" adds the previous window\'s headline figures.',
    inputSchema: {
      project_id: z.string(),
      scope: z.string().optional().describe('the project itself or one of its verticals'),
      phase_id: z.string().optional(),
      tag: z.enum(['ui', 'api', 'db', 'infra']).optional(),
      agent: z.string().optional(),
      work_type: z.union([WORK_TYPE, z.literal('none')]).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      tz: z.string().optional().describe('IANA time zone, default the daemon’s'),
      batch_lines: z.number().int().min(1).optional(),
      compare: z.literal('previous').optional(),
    },
  },
  ({ project_id, scope, phase_id, tag, agent, work_type, from, to, tz, batch_lines, compare }) => {
    const params = new URLSearchParams({ project: project_id });
    for (const [k, v] of [
      ['scope', scope],
      ['phase', phase_id],
      ['tag', tag],
      ['agent', agent],
      ['workType', work_type],
      ['from', from],
      ['to', to],
      ['tz', tz],
      ['batchLines', batch_lines?.toString()],
      ['compare', compare],
    ] as const) {
      if (v) params.set(k, v);
    }
    return api('GET', `/metrics/agentic?${params}`);
  },
);

server.registerTool(
  'get_agentic_cost',
  {
    description:
      'Agentic cost (USD, priced like get_metrics cost): reworkCost (spend on build runs belonging to FAILED review rounds: a run belongs to its card\'s first review recorded at or after it; $, tokens, share of spend, top 5 cards), decisionLatencyCost (human-wait hours (needs-you + blockers) x the median agent cost per active hour = "$ of idle agent time"; live: days of slip = blocked time on the active phase\'s critical path, or on its in-flight cards flagged as an approximation, and the queue of what waits on the human now, oldest first), costAnomaly (daily spend per phase; days over the trailing 14-day mean + 2 sigma, with >= 5 trailing days), usageRunway (live: when the 5-hour / weekly limits run out at the current burn, the active phase p50/p85 forecast, and whether the weekly limit runs out before p85 with the gap in days). A workspace includes its verticals. from/to: epoch ms, YYYY-MM-DD or a datetime (in `tz`). compare: "previous" adds the previous window\'s headline figures.',
    inputSchema: {
      project_id: z.string(),
      phase_id: z.string().optional(),
      tag: z.enum(['ui', 'api', 'db', 'infra']).optional(),
      agent: z.string().optional(),
      work_type: z.union([WORK_TYPE, z.literal('none')]).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      tz: z.string().optional().describe('IANA time zone, default the daemon’s'),
      compare: z.literal('previous').optional(),
    },
  },
  ({ project_id, phase_id, tag, agent, work_type, from, to, tz, compare }) => {
    const params = new URLSearchParams({ project: project_id });
    for (const [k, v] of [
      ['phase', phase_id],
      ['tag', tag],
      ['agent', agent],
      ['workType', work_type],
      ['from', from],
      ['to', to],
      ['tz', tz],
      ['compare', compare],
    ] as const) {
      if (v) params.set(k, v);
    }
    return api('GET', `/metrics/agentic-cost?${params}`);
  },
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
      'Park, activate, close, or reorder a roadmap phase, and/or set its target date (target_date YYYY-MM-DD, null clears). Activating demotes the current active phase to planned. Judgment move — use advance_phase for the normal phase loop.',
    inputSchema: {
      phase_id: z.string(),
      status: z.enum(['planned', 'active', 'done']).optional(),
      position: z.number().int().min(1).optional(),
      target_date: z.string().nullable().optional(),
    },
  },
  async ({ phase_id, status, position, target_date }) => {
    const other = status !== undefined || position !== undefined;
    if (target_date === undefined) return api('POST', `/phase/${phase_id}`, { status, position });
    const t = await api('PUT', `/phase/${encodeURIComponent(phase_id)}/target`, { target_date });
    if (!other) return t;
    // both asked: say exactly which half happened
    if (t.isError)
      return { content: [{ type: 'text', text: `target_date rejected: ${t.content[0].text}; status/position change skipped` }], isError: true };
    const r = await api('POST', `/phase/${phase_id}`, { status, position });
    if (r.isError)
      return { content: [{ type: 'text', text: `target_date saved; status/position change failed: ${r.content[0].text}` }], isError: true };
    return r;
  },
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
  'suggest_verticals',
  {
    description:
      'Suggest verticals for a standalone project from its folder layout (monorepo sides with a manifest). Returns {suggestions:[{name, folder, stack}]} — [] once the project already has verticals.',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/project/${encodeURIComponent(project_id)}/vertical-suggestions`),
);

server.registerTool(
  'split_vertical',
  {
    description:
      "Split a project (or a vertical) into verticals and move its open cards onto them. targets: [{name, folder}] — folder relative to the repo root (monorepo side, kit shared) or an absolute path (separate repo, kit installed). Runs a preview first: each target's resolved root + kit, and a per-card placement suggestion from the files the card edited. assignments ({card_id: target index | 'stay'}) default to those suggestions; cards with no suggestion stay. Done cards always stay; refuses while a card to be moved is in progress or in review. Returns {verticals, moved}.",
    inputSchema: {
      project_id: z.string(),
      targets: z.array(z.object({ name: z.string(), folder: z.string() })).min(1),
      assignments: z.record(z.string(), z.union([z.number().int().min(0), z.literal('stay')])).optional(),
    },
  },
  async ({ project_id, targets, assignments }) => {
    const id = encodeURIComponent(project_id);
    const preview = await api('POST', `/project/${id}/split-preview`, { targets });
    if (preview.isError) return preview;
    const plan = JSON.parse(preview.content[0].text) as {
      targets: { name: string; root: string }[];
      placement: { card: { id: string }; suggestion: string | null }[];
    };
    const chosen =
      assignments ??
      Object.fromEntries(
        plan.placement.map((p) => [p.card.id, p.suggestion === null ? 'stay' : Number(p.suggestion)] as const),
      );
    return api('POST', `/project/${id}/split`, {
      targets: plan.targets.map((t) => ({ name: t.name, root: t.root })),
      assignments: chosen,
    });
  },
);

server.registerTool(
  'merge_verticals',
  {
    description:
      "Merge vertical `from` into sibling vertical `into`: all of from's cards (with history) move to into and from is removed (its terminal session closed). phases: 'append' adds from's roadmap after into's; 'fold' puts from's open cards into into's active phase. Optional name renames into; optional root re-roots it (from's or into's root, or a shared ancestor of both in the same repo). Refuses while any card of either vertical is in progress or in review.",
    inputSchema: {
      from: z.string(),
      into: z.string(),
      name: z.string().optional(),
      root: z.string().optional(),
      phases: z.enum(['append', 'fold']),
    },
  },
  (input) => api('POST', '/verticals/merge', input),
);

server.registerTool(
  'set_autopilot',
  {
    description:
      'Turn autopilot on/off for a vertical: when its Claude session is idle and it has queued cards, the daemon prompts it to work the next card. Off by default; pauses while 5-hour usage ≥ 80%.',
    inputSchema: { project_id: z.string(), on: z.boolean() },
  },
  ({ project_id, on }) => api('POST', `/project/${encodeURIComponent(project_id)}/autopilot`, { on }),
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
  'get_workspace_summary',
  {
    description:
      "Cross-board status for a whole workspace (given a workspace or vertical id): per board lane counts, active cards + agents, blockers, active phase progress, token/line totals, live session state (working/idle/needs_you/offline), and one combined attention list. The main orchestrator's 'where is everyone' read — cheaper than get_board per vertical.",
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/workspace/summary?project=${encodeURIComponent(project_id)}`),
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

// ── plan drafts (visual plans kept off the board until committed) ──

const planTag = z.enum(['ui', 'api', 'db', 'infra']);
const planNode = z.object({
  id: z.string(),
  title: z.string(),
  board_id: z.string(),
  phase: z.string().optional(),
  requirements: z.string().optional(),
  subtasks: z.array(z.string()).optional(),
  tag: planTag.optional(),
  touches: z.array(z.string()).optional(),
});
const draftOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_node'), node: planNode }),
  z.object({
    op: z.literal('update_node'),
    id: z.string(),
    patch: z.object({
      title: z.string().optional(),
      board_id: z.string().optional(),
      phase: z.string().nullable().optional(),
      requirements: z.string().nullable().optional(),
      subtasks: z.array(z.string()).nullable().optional(),
      tag: planTag.nullable().optional(),
      touches: z.array(z.string()).nullable().optional(),
    }),
  }),
  z.object({ op: z.literal('remove_node'), id: z.string() }),
  z.object({ op: z.literal('add_edge'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('remove_edge'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('set_title'), title: z.string() }),
]);

server.registerTool(
  'list_plans',
  {
    description:
      'Plan drafts of a workspace (a vertical id works too: it resolves to its workspace), most recently updated first, without their nodes (node_count/edge_count instead). Drafts are kept off the board until committed.',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/plan-drafts?workspace=${encodeURIComponent(project_id)}`),
);

server.registerTool(
  'get_plan',
  {
    description:
      'One plan draft: {draft (nodes, edges, version, committed map), layout (dependency columns + longest chain, null while there is a cycle), validation {errors (block commit), warnings (per pair of cards for shared files), groups (the shared-file warnings grouped per path)}, boards (valid board_ids), dirty}.',
    inputSchema: { plan_id: z.string() },
  },
  ({ plan_id }) => api('GET', `/plan-drafts/${encodeURIComponent(plan_id)}`),
);

server.registerTool(
  'create_plan',
  {
    description:
      'Create an empty plan draft on a workspace (a vertical id resolves to its workspace). Returns the draft (id, version 1). Writes a draft only, never cards.',
    inputSchema: { project_id: z.string(), title: z.string() },
  },
  ({ project_id, title }) => api('POST', '/plan-drafts', { workspace: project_id, title }),
);

server.registerTool(
  'edit_plan',
  {
    description: [
      'Apply a batch of ops to a plan draft, atomically (any bad op rejects the whole batch) and bumping version once. Writes the draft only, never cards. Pass version to reject the edit (409) if the draft changed since you read it. Returns the get_plan view. Ops:',
      '- add_node: {"op":"add_node","node":{"id":"api","title":"API contract","board_id":"<board id>","phase":"Foundation","requirements":"...","subtasks":["..."],"tag":"api","touches":["src/api/**"]}}. id is chosen by you and must be unique in the draft; board_id is the workspace or one of its verticals (see get_plan boards); phase is a phase NAME.',
      '- update_node: {"op":"update_node","id":"api","patch":{"title":"...","phase":null}}. Partial patch; null clears an optional field; the id cannot change.',
      '- remove_node: {"op":"remove_node","id":"api"} (also drops its edges).',
      '- add_edge / remove_edge: {"op":"add_edge","from":"api","to":"web"} means "web depends on api".',
      '- set_title: {"op":"set_title","title":"..."}.',
      'Cycles are allowed while editing but block commit (see get_plan validation).',
    ].join('\n'),
    inputSchema: { plan_id: z.string(), ops: z.array(draftOp), version: z.number().int().optional() },
  },
  ({ plan_id, ops, version }) => api('PATCH', `/plan-drafts/${encodeURIComponent(plan_id)}`, { ops, version }),
);

server.registerTool(
  'preview_plan_commit',
  {
    description:
      'Preview what commit_plan would do, per board: phases to add, cards to create/update/delete, and kept/locked cards (started, done or blocked cards are never changed, moved or deleted), plus validation errors that block commit. Read-only.',
    inputSchema: { plan_id: z.string() },
  },
  ({ plan_id }) => api('GET', `/plan-drafts/${encodeURIComponent(plan_id)}/diff`),
);

server.registerTool(
  'commit_plan',
  {
    description:
      'Write a plan draft onto the boards (creates/updates/deletes backlog cards and phases, as preview_plan_commit shows). Use ONLY after the user explicitly asks to commit the plan: this is the human’s judgment gate, like advance_phase. version must be the draft version the user approved; a stale version or validation errors return 409. Returns {diff, draft}.',
    inputSchema: { plan_id: z.string(), version: z.number().int() },
  },
  ({ plan_id, version }) => api('POST', `/plan-drafts/${encodeURIComponent(plan_id)}/commit`, { version }),
);

server.registerTool(
  'run_plan',
  {
    description:
      "Start a committed, clean plan: 'queue' moves its spec'd backlog cards (requirements + acceptance criteria) to queued, skipping the rest as needing spec; 'autopilot' also turns autopilot on for each involved vertical with queued cards, never for the main (workspace) session, whose cards are queued for the user. Use ONLY after the user explicitly asks to run the plan: this is the human’s judgment gate, like advance_phase. Returns {queued, skipped, autopilot}.",
    inputSchema: { plan_id: z.string(), mode: z.enum(['queue', 'autopilot']) },
  },
  ({ plan_id, mode }) => api('POST', `/plan-drafts/${encodeURIComponent(plan_id)}/run`, { mode }),
);

const link = z.object({ target_type: z.enum(['card', 'phase', 'plan']), target_id: z.string() });

server.registerTool(
  'record_decision',
  {
    description:
      "Record a decision in the project's decision log. Use it whenever the user makes or confirms a decision that changes scope, behaviour or design (not for routine card routing). Include the rationale, and link the affected cards/phases/plans (same workspace). A workspace-wide decision goes on the workspace's project_id; a vertical-only one on the vertical's. To replace an earlier decision pass supersedes=<its id> with the old decision's own project_id (a different one is rejected): the new one inherits its links and the old one is marked superseded. Returns the decision (or {superseded, decision}).",
    inputSchema: {
      project_id: z.string(),
      title: z.string(),
      decision: z.string().describe('what was decided'),
      rationale: z.string().optional().describe('why'),
      decided_by: z.string().optional().describe("who made or confirmed it, e.g. 'user'"),
      links: z.array(link).optional(),
      supersedes: z.string().optional().describe('id of the active decision this one replaces'),
    },
  },
  ({ supersedes, ...input }) =>
    supersedes
      ? api('POST', `/decisions/${encodeURIComponent(supersedes)}/supersede`, input)
      : api('POST', '/decisions', input),
);

server.registerTool(
  'list_decisions',
  {
    description:
      "The decision log, newest first. Check it before re-deciding something. Each item carries scope: 'own' (this board's), 'workspace' (listing a vertical also returns its workspace's decisions, which apply to it) or 'vertical' (listing a workspace also returns its verticals' decisions; see project_id). Filters: status (active|superseded), q (case-insensitive text search), card / phase (only decisions linked to it).",
    inputSchema: {
      project_id: z.string(),
      status: z.enum(['active', 'superseded']).optional(),
      q: z.string().optional(),
      card: z.string().optional(),
      phase: z.string().optional(),
    },
  },
  ({ project_id, ...filter }) => {
    const params = new URLSearchParams({ project: project_id });
    for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
    return api('GET', `/decisions?${params}`);
  },
);

server.registerTool(
  'add_risk',
  {
    description:
      'Open a risk in the risk register when a risk to delivery is identified (a dependency that may slip, an unproven approach, usage limits, a flaky area, a decision still pending). likelihood and impact are 1-5; score = likelihood x impact. Link the cards/phases it threatens. Returns the risk.',
    inputSchema: {
      project_id: z.string(),
      title: z.string(),
      likelihood: z.number().int().min(1).max(5),
      impact: z.number().int().min(1).max(5),
      description: z.string().optional(),
      owner: z.string().optional(),
      mitigation: z.string().optional(),
      links: z.array(link).optional(),
    },
  },
  (input) => api('POST', '/risks', input),
);

server.registerTool(
  'update_risk',
  {
    description:
      'Update a risk: re-rate it, record the mitigation, or move its status (open → mitigating → closed, or occurred if it happened). link / unlink add or remove card/phase/plan links. Returns the risk.',
    inputSchema: {
      risk_id: z.string(),
      title: z.string().optional(),
      description: z.string().nullable().optional(),
      likelihood: z.number().int().min(1).max(5).optional(),
      impact: z.number().int().min(1).max(5).optional(),
      owner: z.string().nullable().optional(),
      mitigation: z.string().nullable().optional(),
      status: z.enum(['open', 'mitigating', 'closed', 'occurred']).optional(),
      link: z.array(link).optional(),
      unlink: z.array(link).optional(),
    },
  },
  ({ risk_id, ...patch }) => api('PATCH', `/risks/${encodeURIComponent(risk_id)}`, patch),
);

server.registerTool(
  'list_risks',
  {
    description:
      "The risk register, highest score first. Each item carries scope: 'own' (this board's), 'workspace' (listing a vertical also returns its workspace's risks) or 'vertical' (listing a workspace also returns its verticals' risks; see project_id). Filters: status (open|mitigating|closed|occurred), q (case-insensitive text search), card / phase (only risks linked to it).",
    inputSchema: {
      project_id: z.string(),
      status: z.enum(['open', 'mitigating', 'closed', 'occurred']).optional(),
      q: z.string().optional(),
      card: z.string().optional(),
      phase: z.string().optional(),
    },
  },
  ({ project_id, ...filter }) => {
    const params = new URLSearchParams({ project: project_id });
    for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
    return api('GET', `/risks?${params}`);
  },
);

server.registerTool(
  'get_report',
  {
    description:
      "A status report for summarising project status to the user or publishing a weekly report: overall + per-phase RAG (from the schedule, with p50/p85/p95 forecast finish dates in json; an open blocker turns a green phase amber), what shipped in the range (by board and phase), what's next (queued / in-progress cards, milestones in the next 14 days), metrics (throughput, cycle p50/p85, first-pass rate, time waiting on you, cost + budgets with caveats), risks and decisions. A workspace includes its verticals. Range defaults to the last 7 days; from/to take YYYY-MM-DD (in tz), a datetime or epoch ms. format 'markdown' (default) returns ready-to-share Markdown; 'json' the structured report.",
    inputSchema: {
      project_id: z.string(),
      from: z.string().optional(),
      to: z.string().optional(),
      tz: z.string().optional().describe('IANA time zone, default the daemon’s'),
      format: z.enum(['markdown', 'json']).optional(),
    },
  },
  async ({ project_id, format, ...range }) => {
    const params = new URLSearchParams({ project: project_id });
    for (const [k, v] of Object.entries(range)) if (v) params.set(k, v);
    if (format !== 'json') return api('GET', `/report.md?${params}`);
    const report = await api('GET', `/report?${params}`);
    if (report.isError) return report;
    // the report's phases carry p50/p85 only: add each phase's p95 from the schedule
    // (same default seed, so it reads off the same simulation)
    const schedParams = new URLSearchParams({ project: project_id });
    if (range.tz) schedParams.set('tz', range.tz);
    const sched = await api('GET', `/metrics/schedule?${schedParams}`);
    if (sched.isError) return { content: [...report.content, { type: 'text' as const, text: `p95 unavailable: ${sched.content[0]?.text}` }] };
    const p95 = new Map(
      (JSON.parse(sched.content[0].text).phases as { id: string; p95?: string | null }[]).map((p) => [p.id, p.p95 ?? null]),
    );
    const r = JSON.parse(report.content[0].text);
    r.phases = (r.phases as { id: string }[]).map((p) => ({ ...p, p95: p95.get(p.id) ?? null }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(r) }] };
  },
);

await server.connect(new StdioServerTransport());
