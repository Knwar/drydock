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

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  await server.connect(new StdioServerTransport());
}
