// The `brain` MCP server each agent run gets (stdio). It is how agents act on
// Drydock itself: ask the user for permission, log decisions, and (later
// phases) create projects, write requirements and edit system designs.
// Identity comes from env set by the runner: BRAIN_ROLE, BRAIN_CONVERSATION.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DAEMON = process.env.BRAIN_DAEMON_URL ?? 'http://127.0.0.1:7900';
const ROLE = process.env.BRAIN_ROLE ?? 'main';
const CONVERSATION = process.env.BRAIN_CONVERSATION ?? null;

async function call(path: string, body?: unknown): Promise<any> {
  const res = await fetch(DAEMON + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

// Tool results are re-read on every later turn, so they are compact lines,
// not indented JSON; `detail: true` gives the long form where it exists.
const clip = (v: unknown, n = 160) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export const server = new McpServer({ name: 'brain', version: '0.1.0' });

// Tools of plugins this project has switched off are not offered at all (the
// runner passes their names), so agents neither see nor pay for them.
const DISABLED = new Set((process.env.BRAIN_DISABLED_TOOLS ?? '').split(',').filter(Boolean));
const registerTool = server.registerTool.bind(server);
(server as any).registerTool = (name: string, ...rest: unknown[]) => (DISABLED.has(name) ? undefined : (registerTool as any)(name, ...rest));

// Permission prompt tool (--permission-prompt-tool mcp__brain__approve): the
// request becomes an approval card in the app and waits for the user.
server.registerTool(
  'approve',
  {
    description: 'Internal: asks the user to allow a tool call. Do not call this yourself.',
    inputSchema: { tool_name: z.string(), input: z.any(), tool_use_id: z.string().optional() },
  },
  async ({ tool_name, input }) => {
    let a = await call('/api/approvals', { role: ROLE, conversation: CONVERSATION, tool: tool_name, input });
    while (a.status === 'pending') a = await call(`/api/approvals/${a.id}/wait`);
    return text(
      JSON.stringify(
        a.status === 'allowed'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: a.note ? `The user denied this: ${a.note}` : 'The user denied this action. Ask them how they want to proceed.' },
      ),
    );
  },
);

server.registerTool(
  'log_decision',
  {
    description: 'Record a decision the user agreed to in this conversation. It shows as a decision card and is saved to the vault.',
    inputSchema: {
      title: z.string().describe('The decision in a few words, e.g. "Use Redis for the live queue"'),
      why: z.string().describe('One or two sentences on why'),
      follow_ups: z.array(z.string()).optional().describe('Concrete next actions and who does them'),
      project_id: z.string().optional().describe('The project this belongs to, if any'),
    },
  },
  async ({ title, why, follow_ups, project_id }) => {
    await call('/api/decisions', { role: ROLE, conversation: CONVERSATION, title, why, follow_ups: follow_ups ?? [], project_id: project_id ?? null });
    return text(`Decision recorded: ${title}`);
  },
);

server.registerTool(
  'list_team',
  { description: "The user's current team members (roles) and the templates they can add.", inputSchema: {} },
  async () => {
    const [roles, templates] = await Promise.all([call('/api/roles'), call('/api/role-templates')]);
    return text(
      'Team: ' + roles.map((r: any) => `${r.name} (${r.id}, ${r.scope})`).join(', ') +
        '\nTemplates not added yet: ' + (templates.filter((t: any) => !t.added).map((t: any) => `${t.id} (${t.name})`).join(', ') || 'none'),
    );
  },
);

server.registerTool(
  'propose_team_member',
  {
    description:
      'Suggest adding a team member. The user sees an "Add to your team?" card and decides; you never add members yourself. Use a template id when one fits, otherwise give a name, skill and short persona.',
    inputSchema: {
      template: z.enum(['architect', 'pm', 'cto', 'cfo', 'marketing', 'social', 'qc', 'security', 'designer', 'writer', 'editor', 'podcast', 'researcher']).optional(),
      join: z.boolean().optional().describe('Also bring them into this chat (for an idea chat: when you need their part done here). Works for members already on the team too.'),
      name: z.string().optional().describe('For a custom member, e.g. "Legal advisor"'),
      skill: z.string().optional().describe('A Claude Code skill name, e.g. "marketing:seo-audit"'),
      scope: z.enum(['shared', 'project']).optional(),
      persona: z.string().optional().describe('For a custom member: who they are and how they work, 2-4 sentences'),
      reason: z.string().describe('One sentence: why the user needs them now'),
    },
  },
  async (b) => {
    const r = await call('/api/role-proposals', { ...b, role: ROLE, conversation: CONVERSATION });
    return text(r.status === 'exists' ? (b.join ? 'They are already in this chat: @mention them.' : 'That member is already on the team.') : 'Proposed. The user will choose Add or Not now on the card; if they add them, you will be asked to brief them.');
  },
);

server.registerTool(
  'list_projects',
  { description: 'List the projects in Drydock with their stage and progress.', inputSchema: {} },
  async () => {
    const ps = await call('/api/projects');
    if (!ps.length) return text('No projects yet.');
    return text(
      ps
        .map((p: any) =>
          [`${p.name} (project_id ${p.id})`, `stage ${p.stage}`, p.status !== 'active' ? p.status : '', p.phase ? `phase ${p.phase.index}/${p.phase.count} ${p.phase.title}` : '', p.cards.total ? `cards ${p.cards.done}/${p.cards.total}` : '', p.inReview ? `${p.inReview} in review` : '', p.blocked ? `${p.blocked} blocked` : '', p.rag ?? '']
            .filter(Boolean)
            .join(' · '),
        )
        .join('\n'),
    );
  },
);

// ── projects, requirements and design ────────────────────────────

server.registerTool(
  'create_project',
  {
    description:
      'Create a new project the user agreed to: a folder under projects/ with git and the board kit, a vault folder, and requirements v1. Only call after the user says yes, and after agreeing its type with them: software (apps, websites, APIs, tools: gets a system design stage and runs on this Mac) or general (anything else: writing, content, research, planning, events).',
    inputSchema: {
      name: z.string().describe('Short project name, e.g. "kusic"'),
      description: z.string().describe('Two or three sentences: what it is, for whom, the core idea'),
      type: z.enum(['software', 'general']).describe('software or general'),
    },
  },
  async ({ name, description, type }) => {
    const p = await call('/api/projects', { name, description, type });
    return text(`Project created: ${p.name} (project_id ${p.id})\nfolder: ${p.root}\nvault: ${p.vault}\nNext: discuss requirements with the user and keep them updated with save_requirements.`);
  },
);

server.registerTool(
  'get_requirements',
  { description: "Read a project's (or an idea's) current requirements (Markdown) and version history. For an idea, pass its idea_id as project_id.", inputSchema: { project_id: z.string() } },
  async ({ project_id }) => {
    const versions = await call(`/api/projects/${project_id}/requirements`);
    if (!versions.length) return text('No requirements yet.');
    return text(`Current: v${versions[0].version}${versions[0].final ? ' (final)' : ''}\n\n${versions[0].markdown}`);
  },
);

server.registerTool(
  'save_requirements',
  {
    description: 'Save a new version of the requirements document (the whole Markdown document, not a diff). Sections: Goal, Users, Features (table with ID, feature, priority Must/Should/Could), Non-functional, Out of scope, Open questions. For an idea, pass its idea_id as project_id (add Problem and Approach & tech sections).',
    inputSchema: { project_id: z.string(), markdown: z.string() },
  },
  async ({ project_id, markdown }) => {
    const v = await call(`/api/projects/${project_id}/requirements`, { markdown, author: ROLE });
    return text(`Saved requirements v${v.version}.`);
  },
);

server.registerTool(
  'get_design',
  {
    description: "Read a project's C4 design model: one line per element (indented under its parent) and per relation. detail: true adds responsibilities, interfaces and risks.",
    inputSchema: { project_id: z.string(), detail: z.boolean().optional() },
  },
  async ({ project_id, detail }) => {
    const d = await call(`/api/projects/${project_id}/design`);
    if (!d.elements.length) return text('No design yet.');
    const lines = [`Design${d.finalVersion ? ` v${d.finalVersion} (final)` : ' (draft)'}: ${d.elements.length} elements, ${d.relations.length} relations`];
    const kids = (parent: string | null, depth: number) => {
      for (const e of d.elements.filter((x: any) => (x.parent_id ?? null) === parent)) {
        lines.push(`${'  '.repeat(depth)}${e.id} [${e.kind}${e.technology ? `: ${e.technology}` : ''}] ${e.name}: ${clip(e.description, 140)}${e.status && e.status !== 'planned' ? ` (${e.status})` : ''}`);
        if (detail) for (const k of ['responsibilities', 'interfaces', 'risks']) if (e[k]) lines.push(`${'  '.repeat(depth + 1)}${k}: ${clip(e[k], 400)}`);
        kids(e.id, depth + 1);
      }
    };
    kids(null, 0);
    lines.push('Relations:');
    for (const r of d.relations) lines.push(`${r.source} → ${r.target}: ${r.label}${r.technology ? ` [${r.technology}]` : ''}${r.interaction === 'async' ? ' (async)' : ''}`);
    return text(lines.join('\n'));
  },
);

server.registerTool(
  'set_element',
  {
    description:
      'Create or update one C4 element. Top level (no parent_id): person, container (an app, API, worker), store (database), queue, or external system. Inside a container (parent_id = container id): component. Each needs a technology and a one-line description.',
    inputSchema: {
      project_id: z.string(),
      id: z.string().describe('Stable id: lowercase, e.g. "api" or "api.auth"'),
      kind: z.enum(['person', 'container', 'component', 'store', 'queue', 'external']),
      name: z.string(),
      parent_id: z.string().optional(),
      technology: z.string().optional().describe('e.g. "Node.js / Express", "PostgreSQL", "Flutter"'),
      description: z.string().describe('One line: what it does'),
      responsibilities: z.string().optional(),
      interfaces: z.string().optional().describe('e.g. "REST /v1 (HTTPS/JSON)"'),
      risks: z.string().optional(),
    },
  },
  async ({ project_id, ...el }) => {
    await call(`/api/projects/${project_id}/design/elements`, el);
    return text(`Saved ${el.kind} ${el.id}.`);
  },
);

server.registerTool(
  'set_relation',
  {
    description: 'Create or update a one-way relationship between two elements, with a specific label (a verb phrase, never just "Uses") and its protocol.',
    inputSchema: {
      project_id: z.string(),
      source: z.string(),
      target: z.string(),
      label: z.string().describe('e.g. "Reads/writes user records"'),
      technology: z.string().optional().describe('e.g. "HTTPS/JSON", "SQL", "WebSocket", "AMQP"'),
      interaction: z.enum(['sync', 'async']).optional(),
    },
  },
  async ({ project_id, ...r }) => {
    await call(`/api/projects/${project_id}/design/relations`, r);
    return text(`Saved ${r.source} → ${r.target}.`);
  },
);

server.registerTool(
  'remove_design_item',
  { description: 'Remove an element (with its children and relations) or a relation by id.', inputSchema: { project_id: z.string(), id: z.string() } },
  async ({ project_id, id }) => {
    const res = await fetch(`${DAEMON}/api/projects/${project_id}/design/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`remove failed: ${res.status}`);
    return text(`Removed ${id}.`);
  },
);

// ── the Idea board ───────────────────────────────────────────────

server.registerTool(
  'list_ideas',
  { description: 'The ideas on the Idea board (not yet projects): id, title, pitch, kind and how far they are shaped. Check it before capturing, to avoid duplicates.', inputSchema: {} },
  async () => {
    const ideas = await call('/api/ideas');
    if (!ideas.length) return text('The Idea board is empty.');
    return text(ideas.map((i: any) => `${i.title} (idea_id ${i.id}, ${i.type}, ${i.status}): ${clip(i.pitch, 100)}${i.requirementsVersion ? ` · requirements v${i.requirementsVersion}` : ''}${i.designElements ? ` · design ${i.designElements} elements` : ''}${i.brand ? ' · brand' : ''}${i.screens ? ` · ${i.screens} screens` : ''}`).join('\n'));
  },
);

server.registerTool(
  'capture_idea',
  {
    description: 'Save a new idea to the Idea board: a short title, a one-line pitch, its kind, and your first notes. Cheap: no project, folder or team is created. Do this as soon as the user floats something they might make, without asking.',
    inputSchema: {
      title: z.string(),
      pitch: z.string().describe('One sentence: what it is and for whom'),
      type: z.enum(['software', 'general']).describe('software for apps, sites, APIs, tools; general for anything else'),
      notes: z.string().optional().describe('Your first thinking in Markdown (problem, users, rough approach, open questions): saved as the idea\'s starting requirements'),
    },
  },
  async (b) => {
    const i = await call('/api/ideas', { ...b, source: CONVERSATION, role: ROLE });
    return text(`Saved to the Idea board: ${i.title} (idea_id ${i.id})${b.notes ? ', with your notes as its starting requirements' : ''}.`);
  },
);

server.registerTool(
  'get_idea',
  { description: "An idea's state: requirements (current text), design size, brand and UI screens.", inputSchema: { idea_id: z.string() } },
  async ({ idea_id }) => {
    const i = await call(`/api/ideas/${idea_id}`);
    return text(
      [
        `${i.title} (${i.type}, ${i.status}): ${i.pitch}`,
        `Design: ${i.designElements} elements · Brand: ${i.brand ? i.brand.name : 'none'} · Screens: ${i.screenList.map((x: any) => x.id).join(', ') || 'none'}${i.missing.length ? ` · Missing: ${i.missing.join(', ')}` : ''}`,
        `Features: ${i.featureList.length ? i.featureList.map((f: any) => `${f.id} ${f.title} [${f.module}, ${f.priority}${f.mvp ? ', MVP' : ''}]`).join('; ') : 'none yet'}`,
        `Analyses: ${i.sections.filter((x: any) => x.status === 'done').map((x: any) => `${x.kind}: ${x.summary}`).join(' | ') || 'none yet'}`,
        i.requirements ? `\nRequirements v${i.requirements.version}:\n${i.requirements.markdown}` : 'No requirements yet.',
      ].join('\n'),
    );
  },
);

server.registerTool(
  'save_idea_section',
  {
    description: "Save the result of one analysis of an idea (competitors, market, risks, MVP cut…) so it shows as a card on the idea's board. The kind is given in the request; a later save replaces it.",
    inputSchema: {
      idea_id: z.string(),
      kind: z.enum(['problem', 'competitors', 'market', 'pr-faq', 'assumptions', 'risks', 'business', 'metrics', 'features', 'mvp', 'estimate', 'decision']),
      summary: z.string().describe('One line: the headline finding'),
      markdown: z.string().describe('The full write-up (tables welcome; cite sources for facts)'),
    },
  },
  async ({ idea_id, ...b }) => {
    await call(`/api/ideas/${idea_id}/sections`, b);
    return text(`Saved ${b.kind} to the idea's board.`);
  },
);

server.registerTool(
  'save_features',
  {
    description:
      "Add or update an idea's features: what will be built, grouped by module, each detailed enough to build from without guessing. Matched by id (F1, F2…); fields you leave out keep their values (so the MVP cut can just set priority and mvp).",
    inputSchema: {
      idea_id: z.string(),
      features: z
        .array(
          z.object({
            id: z.string().describe('F1, F2, … (stable)'),
            module: z.string().optional().describe('e.g. "Trips", "Sharing", "Auth"'),
            title: z.string().optional(),
            priority: z.enum(['must', 'should', 'could', 'wont']).optional(),
            mvp: z.boolean().optional(),
            summary: z.string().optional(),
            stories: z.array(z.string()).optional().describe('"As a …, I want …, so that …"'),
            acceptance: z.array(z.string()).optional().describe('Given … When … Then …'),
            edge_cases: z.array(z.string()).optional(),
            data: z.array(z.string()).optional().describe('What it reads or writes'),
            open_questions: z.array(z.string()).optional(),
            source: z.string().optional().describe('Where you drafted it from, in a few words: "your message at 13:40", "the Problem analysis", "the MVP cut"'),
          }),
        )
        .min(1),
    },
  },
  async ({ idea_id, features }) => {
    const all = await call(`/api/ideas/${idea_id}/features`, { features });
    return text(`Saved ${features.length} feature(s); the idea now has ${all.length} (${all.filter((f: any) => f.mvp).length} in the MVP).`);
  },
);

server.registerTool(
  'ask_question',
  {
    description:
      "Ask the user something only they can decide about an idea, with 2 to 4 likely answers they can tap (most sensible first) and the features it affects. It shows under Still open on the idea's Board; their answer comes back to you in the chat. Asking the same question again re-words it. Don't also ask it in prose.",
    inputSchema: {
      idea_id: z.string(),
      text: z.string().describe('One short question'),
      options: z.array(z.string()).min(2).max(4).describe('Likely answers, short, most sensible first'),
      affects: z.array(z.string()).optional().describe('Feature ids it changes, e.g. ["F3"]'),
      intake: z.boolean().optional().describe('true for the basics asked when a new idea starts (platform, goal, audience, constraints); their answers come back together and start the first pass'),
    },
  },
  async ({ idea_id, ...q }) => {
    const r = await call(`/api/ideas/${idea_id}/questions`, q);
    return text(`Asked as ${r.id}. The user answers on the Board; you get the answer in this chat.`);
  },
);

server.registerTool(
  'close_question',
  {
    description: 'Mark an open question answered when the user answered it in the chat instead of on the Board.',
    inputSchema: { idea_id: z.string(), id: z.string().describe('Q1, Q2…'), answer: z.string().describe('Their answer, in a few words') },
  },
  async ({ idea_id, id, answer }) => {
    await call(`/api/ideas/${idea_id}/questions/${encodeURIComponent(id)}/answer`, { answer, quiet: true });
    return text(`${id} closed.`);
  },
);

server.registerTool(
  'remove_feature',
  { description: 'Remove a feature from an idea.', inputSchema: { idea_id: z.string(), id: z.string() } },
  async ({ idea_id, id }) => {
    const res = await fetch(`${DAEMON}/api/ideas/${idea_id}/features/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? String(res.status));
    return text(`Removed ${id}.`);
  },
);

server.registerTool(
  'save_brand',
  {
    description: "Save an idea's brand: the guidelines (Markdown: positioning, personality, voice and tone with do/don't, colour and type with reasons, imagery, usage) and the design tokens. Creates the brand on first save; later saves update it.",
    inputSchema: {
      idea_id: z.string(),
      name: z.string().optional(),
      guidelines: z.string().optional(),
      tokens: z.record(z.string(), z.any()).optional().describe('e.g. {"color":{"primary":"#3355ff","surface":"#ffffff","text":"#111111"},"font":{"body":"system-ui, sans-serif"},"radius":{"md":"8px"},"space":{"1":"4px","2":"8px"}}'),
    },
  },
  async ({ idea_id, ...b }) => {
    const r = await call(`/api/ideas/${idea_id}/brand`, b);
    return text(`Saved brand "${r.name}".`);
  },
);

server.registerTool(
  'list_brands',
  { description: 'Brands already made for other ideas or projects (the user may want to reuse one).', inputSchema: {} },
  async () => {
    const bs = await call('/api/brands');
    return text(bs.length ? bs.map((b: any) => `${b.name} (brand_id ${b.id})`).join('\n') : 'No brands yet.');
  },
);

server.registerTool(
  'use_brand',
  { description: 'Use an existing brand for this idea (only when the user wants to reuse it). Edits to a shared brand show everywhere it is used.', inputSchema: { idea_id: z.string(), brand_id: z.string() } },
  async ({ idea_id, brand_id }) => {
    await call(`/api/ideas/${idea_id}/brand/use`, { brand_id });
    return text('Brand linked.');
  },
);

server.registerTool(
  'save_screen',
  {
    description:
      'Save one UI mockup screen for an idea (creates or replaces it). Static HTML with inline CSS only: no <script>, no event handlers, nothing loaded from elsewhere (no remote fonts, images or stylesheets; use system fonts and inline SVG). Link screens with relative links like href="settings.html". Use the brand tokens as CSS custom properties, real content, and media queries for mobile and desktop.',
    inputSchema: {
      idea_id: z.string(),
      id: z.string().describe('Screen id: lowercase-with-dashes, e.g. "home", "settings"'),
      title: z.string(),
      html: z.string().describe('The whole HTML document'),
      position: z.number().int().optional(),
    },
  },
  async ({ idea_id, ...b }) => {
    const s = await call(`/api/ideas/${idea_id}/screens`, b);
    return text(`Saved screen ${s.id} (${s.title}).`);
  },
);

server.registerTool(
  'remove_screen',
  { description: 'Remove a UI mockup screen from an idea.', inputSchema: { idea_id: z.string(), id: z.string() } },
  async ({ idea_id, id }) => {
    const res = await fetch(`${DAEMON}/api/ideas/${idea_id}/screens/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? String(res.status));
    return text(`Removed screen ${id}.`);
  },
);

server.registerTool(
  'design_done',
  {
    description: 'Auto mode only: the system design is complete and its reviews (threat model, CTO) are addressed. Finalises it, sets up the verticals and starts the planning. With auto mode off the user finalises the design instead.',
    inputSchema: { project_id: z.string() },
  },
  async ({ project_id }) => {
    await call(`/api/projects/${project_id}/design/done`, {});
    return text('Design finalised; the PM has been asked to plan the phases.');
  },
);

server.registerTool(
  'start_building',
  {
    description: 'Auto mode only: you committed the phases with create_phase; this moves the project to building without the user\'s approval. Then advance to the first phase and run the phase loop. With auto mode off the user approves the roadmap instead.',
    inputSchema: { project_id: z.string() },
  },
  async ({ project_id }) => {
    await call(`/api/projects/${project_id}/auto/build`, {});
    return text('Building. Advance to the first phase (advance_phase) and run the phase loop.');
  },
);

server.registerTool(
  'offer_next_step',
  {
    description:
      'In an idea chat you lead: offer to build the system design or the UI mockups once the idea is ready for it. The user sees a card with a button and starts it there (or says not now); do not build it until then. Software ideas only.',
    inputSchema: {
      idea_id: z.string(),
      step: z.enum(['design', 'ui']).describe('design: the system design; ui: the UI mockups'),
      reason: z.string().describe('One sentence: why now (what is settled enough to build it from)'),
    },
  },
  async ({ idea_id, ...b }) => {
    await call(`/api/ideas/${idea_id}/offers`, { ...b, role: ROLE });
    return text('Offered. The user starts it with the button on the card; you will get the request in this chat when they do. Do not build it before.');
  },
);

server.registerTool(
  'propose_change',
  {
    description:
      "Propose a change to something the user settled for a project (its requirements, system design, brand or UI). The user sees a card and approves or declines; on approval a requirements change is applied as a new final version, and design, brand and UI changes go to their owner to apply. Never change these yourself.",
    inputSchema: {
      project_id: z.string(),
      area: z.enum(['requirements', 'design', 'brand', 'ui']),
      summary: z.string().describe('One sentence: what changes'),
      why: z.string().describe('The reason (usually the user\'s answer to your question)'),
      requirements_markdown: z.string().optional().describe('For a requirements change: the whole new document'),
    },
  },
  async (b) => {
    await call('/api/change-requests', { ...b, role: ROLE, conversation: CONVERSATION });
    return text('Proposed. The user approves or declines it on the card; wait for that before relying on the change.');
  },
);

// ── personal manager and the Daily ───────────────────────────────

server.registerTool(
  'list_reminders',
  { description: "The user's reminders (open first).", inputSchema: {} },
  async () => {
    const rs = (await call('/api/personal')).reminders;
    return text(rs.length ? rs.map((r: any) => `#${r.id} ${r.done ? '[done] ' : ''}${r.text}${r.due ? ` (due ${r.due})` : ''}`).join('\n') : 'No reminders.');
  },
);

server.registerTool(
  'add_reminder',
  { description: 'Add a reminder for the user.', inputSchema: { text: z.string(), due: z.string().optional().describe('YYYY-MM-DD or YYYY-MM-DDTHH:MM') } },
  async ({ text: t, due }) => {
    await call('/api/reminders', { text: t, due });
    return text(`Reminder added: ${t}`);
  },
);

server.registerTool(
  'save_note',
  { description: "Save a note to the user's vault (vault/personal/notes).", inputSchema: { title: z.string(), text: z.string() } },
  async ({ title, text: t }) => {
    const n = await call('/api/notes', { title, text: t });
    return text(`Saved note ${n.file}`);
  },
);

server.registerTool(
  'list_decisions',
  { description: 'Recent decisions across all projects, newest first.', inputSchema: {} },
  async () => {
    const ds = await call('/api/decisions/recent');
    return text(ds.length ? ds.map((d: any) => `${ago(d.created_at)}: ${d.title}${d.why ? `: ${clip(d.why, 200)}` : ''}`).join('\n') : 'No decisions yet.');
  },
);

server.registerTool(
  'record_inbox',
  {
    description: 'Record emails that need the user\'s action, for the personal page. Use the email thread id as id so repeats update rather than duplicate.',
    inputSchema: {
      items: z.array(
        z.object({
          id: z.string(),
          sender: z.string(),
          subject: z.string(),
          summary: z.string().optional(),
          tag: z.enum(['reply', 'payment', 'project', 'personal', 'travel', 'action']),
          action: z.string().optional().describe('The one next step, e.g. "Draft reply", "Pay by Friday"'),
          received: z.string().optional().describe('ISO date'),
        }),
      ),
    },
  },
  async ({ items }) => {
    await call('/api/personal/inbox', { items });
    return text(`Recorded ${items.length} inbox items.`);
  },
);

server.registerTool(
  'record_calendar',
  {
    description: 'Replace the calendar events shown for a date range (usually this week) with what the calendar says now.',
    inputSchema: {
      from: z.string().describe('YYYY-MM-DD'),
      to: z.string().describe('YYYY-MM-DD'),
      events: z.array(z.object({ day: z.string(), time: z.string().optional().describe('HH:MM, omit for all-day'), title: z.string(), meta: z.string().optional(), category: z.enum(['work', 'personal', 'social', 'reminder']).optional() })),
    },
  },
  async (b) => {
    await call('/api/personal/calendar', b);
    return text(`Recorded ${b.events.length} events.`);
  },
);

server.registerTool(
  'record_money',
  {
    description: 'Record bills found in email (invoices, renewals) and this month\'s spending by category (from receipts and bank emails). Only real amounts from emails; never estimate.',
    inputSchema: {
      bills: z.array(z.object({ id: z.string(), name: z.string(), amount: z.number().optional(), currency: z.string().optional(), due: z.string().optional(), autopay: z.boolean().optional() })).optional(),
      spending: z.object({ month: z.string().describe('YYYY-MM'), rows: z.array(z.object({ category: z.string(), amount: z.number(), currency: z.string().optional() })) }).optional(),
    },
  },
  async (b) => {
    await call('/api/personal/money', b);
    return text('Recorded.');
  },
);

server.registerTool(
  'publish_daily',
  {
    description: "Publish today's edition of The Daily. Call once, after gathering.",
    inputSchema: {
      headline: z.string().describe('One sentence: the most important thing today'),
      summary: z.string().describe('Two or three sentences'),
      focus: z.string().optional().describe('A suggested focus for the day'),
      sections: z.array(z.object({ title: z.string(), items: z.array(z.object({ text: z.string(), tone: z.enum(['work', 'personal', 'social', 'money', 'alert']).optional() })) })),
    },
  },
  async (b) => {
    const e = await call('/api/daily/publish', b);
    return text(`Published edition ${e.number} for ${e.day}.`);
  },
);

// ── team, learning, security and close-out ───────────────────────

server.registerTool(
  'recommend_team',
  {
    description:
      "Recommend a project's team after its requirements are final. The always-on core (Architect, PM, Quality control, Security Champion) is included automatically; list what else this project needs (max 4), each with a reason tied to the requirements. Use a template id when one fits, otherwise a developer specialist with a name and an installed skill.",
    inputSchema: {
      project_id: z.string(),
      members: z.array(
        z.object({
          template: z.enum(['architect', 'pm', 'qc', 'security', 'cto', 'cfo', 'marketing', 'social']).optional(),
          name: z.string().optional().describe('For a specialist, e.g. "Flutter developer"'),
          skill: z.string().optional().describe('e.g. "flutter-dev"'),
          kind: z.enum(['core', 'specialist']).optional(),
          reason: z.string().describe('One line, specific to these requirements'),
          persona: z.string().optional(),
        }),
      ),
    },
  },
  async ({ project_id, members }) => {
    const r = await call(`/api/projects/${project_id}/team/recommendation`, { members });
    return text(`Recommendation saved (${r.items.length} members). The user picks who to add.`);
  },
);

server.registerTool(
  'record_lesson',
  {
    description:
      'Record a lesson after a failed review (or in a retrospective). Blameless: classify the cause. Process causes go to project memory; agent-behavior mistakes also count towards a learning for that member once they recur.',
    inputSchema: {
      project_id: z.string(),
      cause: z.enum(['requirements-gap', 'missing-check', 'convention', 'environment', 'agent-behavior']),
      lesson: z.string().describe('Imperative rule under 25 words, e.g. "Validate every request body with the shared zod schema"'),
      mechanism: z.string().optional().describe('What was added so it cannot recur: a test, an acceptance criterion, a lint rule, a convention'),
      trigger: z.string().optional().describe('What happened, in one line'),
      card_id: z.string().optional(),
      member: z.string().optional().describe("The card's assigned member (name or id)"),
      supersedes: z.number().optional().describe('Id (number after L) of an older lesson this replaces'),
    },
  },
  async ({ project_id, ...b }) => {
    const r = await call(`/api/projects/${project_id}/lessons`, b);
    return text(`Lesson L${r.lesson} recorded.${r.learning ? ` ${r.learning.active ? 'It is now an active learning for' : 'Counted towards a learning for'} ${r.learning.role}.` : ''}`);
  },
);

server.registerTool(
  'member_learnings',
  { description: "A member's learned rules and the team checklist, to include when dispatching a builder for that member's card.", inputSchema: { member: z.string() } },
  async ({ member }) => {
    const r = await call(`/api/learnings?member=${encodeURIComponent(member)}`);
    const lines = [...r.rules.map((x: string) => `- ${x}`), ...r.checklist.map((x: string) => `- (team) ${x}`)];
    return text(lines.length ? `Rules for ${r.member}:\n${lines.join('\n')}` : `No learnings recorded for ${r.member}.`);
  },
);

server.registerTool(
  'save_threat_model',
  { description: "Save the project's STRIDE threat model (Markdown: threats per container/data flow, likelihood, impact, mitigation).", inputSchema: { project_id: z.string(), markdown: z.string() } },
  async ({ project_id, markdown }) => {
    const r = await call(`/api/projects/${project_id}/threat-model`, { markdown });
    return text(`Threat model saved to ${r.file}.`);
  },
);

server.registerTool(
  'report_status',
  { description: "Report a project's overall status (for check-ins).", inputSchema: { project_id: z.string(), rag: z.enum(['green', 'amber', 'red']) } },
  async ({ project_id, rag }) => {
    await call(`/api/projects/${project_id}/rag`, { rag });
    return text(`Status set to ${rag}.`);
  },
);

server.registerTool(
  'report_work_complete',
  {
    description: 'PM only: call when advance_phase returns null and every phase meets the Definition of Done. Opens the close-out with the Main agent.',
    inputSchema: { project_id: z.string(), summary: z.string().describe('What was delivered, known gaps, and what you would do next') },
  },
  async ({ project_id, summary }) => {
    const r = await call(`/api/projects/${project_id}/complete`, { summary });
    return text(`Reported. The close-out runs in ${r.channel}.`);
  },
);

server.registerTool(
  'save_enhancements',
  { description: 'Propose enhancements for a project (shown to the user to accept or drop).', inputSchema: { project_id: z.string(), items: z.array(z.object({ title: z.string(), why: z.string().optional() })) } },
  async ({ project_id, items }) => {
    await call(`/api/projects/${project_id}/enhancements`, { items });
    return text(`Saved ${items.length} enhancements.`);
  },
);

server.registerTool(
  'delegate',
  {
    description:
      "Hand work to team members: posts your message in a thread (an existing one, or a new topic thread, in a project's Discussions when project_id is given) and they answer there. Members must already be on the team.",
    inputSchema: {
      members: z.array(z.string()).describe('Names or ids, e.g. ["Quality control", "security"]'),
      message: z.string(),
      project_id: z.string().optional(),
      topic: z.string().optional().describe('Thread topic when starting a new one, e.g. "readiness check"'),
      conversation: z.string().optional().describe('An existing thread id to post into'),
    },
  },
  async (b) => {
    const r = await call('/api/delegate', { ...b, from: ROLE });
    return text(`Posted in ${r.conversation}. They will answer there; use thread_status to follow up.`);
  },
);

server.registerTool(
  'thread_status',
  { description: "Read a thread's recent messages, members and whether someone is working in it.", inputSchema: { conversation: z.string() } },
  async ({ conversation }) => {
    const t = await call(`/api/threads/${encodeURIComponent(conversation)}`);
    const head = `#${t.name} (${t.id}) · members: ${t.members.map((m: any) => (typeof m === 'string' ? m : m.name ?? m.id)).join(', ')} · ${t.working ? `${t.working} is working now` : 'nobody working'}`;
    return text([head, ...t.messages.map((m: any) => `${ago(m.at)} ${m.author}${m.kind !== 'text' ? ` (${m.kind})` : ''}: ${clip(m.body, 400)}`)].join('\n'));
  },
);

// ── secrets (values never come back to you) ──────────────────────

const SECRET_NAME = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).describe('UPPER_SNAKE env var name, e.g. STRIPE_API_KEY');

server.registerTool(
  'list_secrets',
  { description: "Names of the secrets in the user's password manager that you can use (never their values).", inputSchema: { project_id: z.string().optional() } },
  async ({ project_id }) => {
    const rows = await call(`/api/secrets/names${project_id ? `?project=${encodeURIComponent(project_id)}` : ''}`);
    return text(rows.length ? rows.map((r: any) => `${r.name} (${r.kind}, ${r.provider}${r.note ? `: ${r.note}` : ''})`).join('\n') : 'No secrets saved yet.');
  },
);

server.registerTool(
  'save_secret',
  {
    description:
      "Store a secret in the user's password manager and refer to it by name from then on. Give exactly one of: generate (a new random value you never see, for DB passwords, signing keys, webhook secrets), from_file (move KEY=value out of a .env-style file without reading it; the line becomes a pointer), or value (only when the value is already in front of you, e.g. the user pasted it).",
    inputSchema: {
      name: SECRET_NAME,
      generate: z.object({ bytes: z.number().int().min(16).max(128).optional() }).optional(),
      from_file: z.object({ path: z.string().describe('Path inside the workspace, e.g. projects/kusic/.env'), key: z.string() }).optional(),
      value: z.string().optional(),
      project_id: z.string().optional(),
      note: z.string().optional().describe('What it is for, e.g. "Postgres password for kusic dev"'),
    },
  },
  async ({ name, generate, from_file, value, project_id, note }) => {
    if ([generate, from_file, value].filter((x) => x !== undefined).length !== 1) throw new Error('Give exactly one of generate, from_file or value.');
    const r = await call('/api/secrets', { name, generate, from_file, value, project_id, note });
    return text(`Saved ${r.name} to ${r.provider}.${from_file ? ` The line in ${from_file.path} now points to it.` : ''} Use it by name with run_with_secrets; never write the value anywhere.`);
  },
);

server.registerTool(
  'request_secret',
  {
    description: 'Ask the user for a key only they can get (from another service, e.g. Stripe). They paste it into a card and it goes straight to their password manager; you are told when it is saved.',
    inputSchema: { name: SECRET_NAME, purpose: z.string().describe('One line: what it is for'), url: z.string().optional().describe("https link to the service's key page"), project_id: z.string().optional() },
  },
  async (b) => {
    await call('/api/secrets/request', { ...b, role: ROLE, conversation: CONVERSATION });
    return text(`Asked the user for ${b.name}. Carry on with other work; a message appears in this thread once it is saved.`);
  },
);

/** Open a ticket, wait for the user's answer on the card, then execute it once. */
async function ticketed(path: string, body: unknown): Promise<any> {
  let t = await call(path, { ...(body as object), role: ROLE, conversation: CONVERSATION });
  if (t.status === 'denied') throw new Error(t.note ? `The user denied this: ${t.note}` : 'The user denied this.');
  let a = { status: t.status };
  while (t.approval && a.status === 'pending') a = await call(`/api/approvals/${t.approval}/wait`);
  return call(`/api/secrets/tickets/${t.ticket}/execute`, {});
}

server.registerTool(
  'run_with_secrets',
  {
    description:
      'Run one shell command with secrets as environment variables (e.g. `npm run migrate` with DATABASE_URL). The user approves the exact command and confirms on their Mac; the output comes back with secret values blanked. Reference them as $NAME in the command; never echo them.',
    inputSchema: {
      command: z.string(),
      secrets: z.array(SECRET_NAME).min(1),
      cwd: z.string().optional().describe("Folder inside the workspace; defaults to this thread's project folder"),
    },
  },
  async (b) => {
    const r = await ticketed('/api/secrets/run', b);
    return text(`Exit ${r.code}\n${r.output}`);
  },
);

server.registerTool(
  'rotate_secret',
  { description: 'Replace a generated secret with a new random value (after the user approves). Anything using it needs restarting.', inputSchema: { name: SECRET_NAME } },
  async (b) => {
    const r = await ticketed('/api/secrets/rotate-request', b);
    return text(`Rotated ${r.rotated}.`);
  },
);

// ── running the app on this Mac ──────────────────────────────────

server.registerTool(
  'save_run_recipe',
  {
    description:
      "Tell Drydock how to run a project on this Mac (written to <project>/.drydock/run.json; commit it). web: services each get $PORT and must listen on 127.0.0.1; one is primary (its URL is <slug>.localhost). Other services' ports arrive as <NAME>_PORT / <NAME>_URL. needs: databases and services by type; each becomes an env var with its connection URL (a database of its own on the user's server, or Docker). secrets: names from list_secrets. install runs when lockfiles change; setup (migrations) runs on every start. app: launch builds and opens it.",
    inputSchema: {
      project_id: z.string(),
      recipe: z.object({
        kind: z.enum(['web', 'app', 'none']),
        install: z.string().optional(),
        setup: z.string().optional(),
        verify: z.string().optional().describe('Checks every card must pass before it merges, e.g. "npm run lint && npm run typecheck && npm test"'),
        services: z.array(z.object({ name: z.string(), command: z.string(), cwd: z.string().optional(), health: z.string().optional(), primary: z.boolean().optional() })).optional(),
        launch: z.string().optional(),
        needs: z.array(z.object({ type: z.enum(['postgres', 'mysql', 'mongodb', 'redis', 'rabbitmq', 's3', 'smtp', 'other']), as: z.string(), service: z.string().optional() })).optional(),
        secrets: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional().describe('Non-secret settings only'),
      }),
    },
  },
  async ({ project_id, recipe }) => {
    await call(`/api/projects/${project_id}/live/recipe`, { recipe });
    return text('Saved .drydock/run.json. The user starts it from the project overview; after that it restarts by itself on each merge.');
  },
);

server.registerTool(
  'list_local_services',
  { description: "Database and other servers the user registered on their network (no logins). A recipe's needs are matched against these, else Docker.", inputSchema: {} },
  async () => {
    const rows = await call('/api/local-services/names');
    return text(rows.length ? rows.map((s: any) => `${s.name}: ${s.type} on ${s.host}${s.ok === false ? ' (last check failed)' : ''}`).join('\n') : 'None registered; needs fall back to Docker.');
  },
);

server.registerTool(
  'live_status',
  { description: "Whether the project's app is running on this Mac, its URLs, services and databases.", inputSchema: { project_id: z.string() } },
  async ({ project_id }) => {
    const l = await call(`/api/projects/${project_id}/live`);
    const lines = [`${l.status}${l.message ? `: ${l.message}` : ''}${l.runnable ? '' : ' (no run recipe)'}`];
    for (const s of l.services) lines.push(`${s.name}${s.primary ? ' (primary)' : ''}: ${s.status} · ${s.url}${s.port ? ` · port ${s.port}` : ''}`);
    for (const d of l.databases) lines.push(`${d.as}: ${d.type} ${d.name} on ${d.where}`);
    if (l.needsApproval?.length) lines.push(`waiting for the user to approve: ${l.needsApproval.join(', ')}`);
    return text(lines.join('\n'));
  },
);

server.registerTool(
  'live_check',
  {
    description: "Smoke-test the app running on this Mac: GET each path and get status, time, size and page title (or the start of the error). Run it after a merge; for flows beyond page loads, use the project's own end-to-end tests.",
    inputSchema: { project_id: z.string(), paths: z.array(z.string()).max(20).optional().describe('Default ["/"]'), service: z.string().optional() },
  },
  async ({ project_id, paths, service }) => {
    const r = await call(`/api/projects/${project_id}/live/check`, { paths, service });
    if (!r.results.length) return text(r.message);
    const lines = r.results.map((x: any) => `${x.status ?? 'ERR'} ${x.path} ${x.ms}ms ${x.bytes}B${x.title ? ` "${x.title}"` : ''}${x.error ? ` · ${x.error}` : ''}`);
    return text(`${r.ok ? 'All passed' : 'FAILED'}\n${lines.join('\n')}`);
  },
);

server.registerTool(
  'live_logs',
  { description: "Recent output of the project's running app (secrets blanked).", inputSchema: { project_id: z.string(), service: z.string().optional(), lines: z.number().int().max(2000).optional() } },
  async ({ project_id, service, lines }) => {
    const q = new URLSearchParams({ ...(service ? { service } : {}), lines: String(lines ?? 200) });
    return text((await call(`/api/projects/${project_id}/live/logs?${q}`)).log || 'No output yet.');
  },
);

server.registerTool(
  'live_restart',
  { description: "Start or restart the project's app on this Mac (e.g. after fixing a crash). It uses only secrets the user already approved; if new ones are needed, the user has to press Start.", inputSchema: { project_id: z.string() } },
  async ({ project_id }) => {
    const r = await call(`/api/projects/${project_id}/live/start`, { by: 'agent' });
    return text(r.status === 'needs_approval' ? `The user must approve ${r.needsApproval.join(', ')} by pressing Start on the project overview.` : `Status: ${r.status}${r.message ? ` (${r.message})` : ''}`);
  },
);

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  await server.connect(new StdioServerTransport());
}
