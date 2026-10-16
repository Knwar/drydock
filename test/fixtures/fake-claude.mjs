#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format stream-json` in tests. It
// echoes the prompt, reports whether it was resumed, and, when the prompt
// contains NEEDS_APPROVAL, asks the daemon for permission like the brain MCP
// server's approve tool would.
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const prompt = val('-p') ?? '';
const resumed = val('--resume');
const session = resumed ?? 'sess-' + Math.random().toString(36).slice(2, 8);
const out = (o) => process.stdout.write(JSON.stringify({ session_id: session, ...o }) + '\n');
out({ type: 'system', subtype: 'init' });
let reply = `echo: ${prompt.slice(0, 200)}${resumed ? ' (resumed)' : ''}`;
if (prompt.includes('NEEDS_APPROVAL')) {
  const cfg = JSON.parse(readFileSync(val('--mcp-config'), 'utf8')).mcpServers.brain.env;
  const call = async (path, body) => (await fetch(cfg.BRAIN_DAEMON_URL + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)).json();
  let a = await call('/api/approvals', { role: cfg.BRAIN_ROLE, conversation: cfg.BRAIN_CONVERSATION, tool: 'Write', input: { file_path: 'x.txt' } });
  while (a.status === 'pending') a = await call(`/api/approvals/${a.id}/wait`);
  reply = `write ${a.status}`;
}
if (prompt.includes('Reply as') && prompt.includes('nothing to add')) reply = 'PASS';
out({ type: 'stream_event', event: { type: 'message_start' } });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } });
out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: 0.001, num_turns: 1, duration_ms: 5 });
