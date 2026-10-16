// The `brain` MCP server each agent run gets (stdio). It is how agents act on
// AI Brain itself: ask the user for permission, log decisions, and (later
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

export const server = new McpServer({ name: 'brain', version: '0.1.0' });

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
  'list_projects',
  { description: 'List the projects in AI Brain with their stage and progress.', inputSchema: {} },
  async () => text(JSON.stringify(await call('/api/projects'), null, 2)),
);

// ── projects, requirements and design ────────────────────────────

server.registerTool(
  'create_project',
  {
    description: 'Create a new project the user agreed to: a folder under projects/ with git and the board kit, a vault folder, and requirements v1. Only call after the user says yes.',
    inputSchema: { name: z.string().describe('Short project name, e.g. "kusic"'), description: z.string().describe('Two or three sentences: what it is, for whom, the core idea') },
  },
  async ({ name, description }) => {
    const p = await call('/api/projects', { name, description });
    return text(`Project created: ${p.name} (project_id ${p.id})\nfolder: ${p.root}\nvault: ${p.vault}\nNext: discuss requirements with the user and keep them updated with save_requirements.`);
  },
);

server.registerTool(
  'get_requirements',
  { description: "Read a project's current requirements (Markdown) and version history.", inputSchema: { project_id: z.string() } },
  async ({ project_id }) => {
    const versions = await call(`/api/projects/${project_id}/requirements`);
    if (!versions.length) return text('No requirements yet.');
    return text(`Current: v${versions[0].version}${versions[0].final ? ' (final)' : ''}\n\n${versions[0].markdown}`);
  },
);

server.registerTool(
  'save_requirements',
  {
    description: 'Save a new version of the requirements document (the whole Markdown document, not a diff). Sections: Goal, Users, Features (table with ID, feature, priority Must/Should/Could), Non-functional, Out of scope, Open questions.',
    inputSchema: { project_id: z.string(), markdown: z.string() },
  },
  async ({ project_id, markdown }) => {
    const v = await call(`/api/projects/${project_id}/requirements`, { markdown, author: ROLE });
    return text(`Saved requirements v${v.version}.`);
  },
);

server.registerTool(
  'get_design',
  { description: "Read a project's C4 design model: elements (with parent_id for nesting) and relations.", inputSchema: { project_id: z.string() } },
  async ({ project_id }) => text(JSON.stringify(await call(`/api/projects/${project_id}/design`), null, 2)),
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

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  await server.connect(new StdioServerTransport());
}
