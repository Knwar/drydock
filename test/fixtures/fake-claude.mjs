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
// a long job: lets a test kill the daemon mid-run
if (prompt.includes('SLOW')) await new Promise((r) => setTimeout(r, 60_000));
let reply = `echo: ${prompt.slice(0, 200)}${resumed ? ' (resumed)' : ''}`;
if (prompt.includes('NEEDS_APPROVAL')) {
  const cfg = JSON.parse(readFileSync(val('--mcp-config'), 'utf8')).mcpServers.brain.env;
  const call = async (path, body) => (await fetch(cfg.BRAIN_DAEMON_URL + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)).json();
  let a = await call('/api/approvals', { role: cfg.BRAIN_ROLE, conversation: cfg.BRAIN_CONVERSATION, tool: 'Write', input: { file_path: 'x.txt' } });
  while (a.status === 'pending') a = await call(`/api/approvals/${a.id}/wait`);
  reply = `write ${a.status}`;
}
if (prompt.includes('Reply as') && prompt.includes('nothing to add')) reply = 'PASS';
// handover chain for tests: "HANDOFF to @X" makes this role mention X back; never-ending on purpose
const handoff = /HANDOFF/.test(prompt);
if (handoff) reply = `done, over to you HANDOFF to ${args[args.indexOf('--append-system-prompt') + 1].includes('You are the CTO') ? '@QC' : '@CTO'}`;
out({ type: 'stream_event', event: { type: 'message_start' } });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } });
// a session refresh asks for a handover note; record what the system prompt and effort were for the tests
if (prompt.includes('Your session is being refreshed')) reply = `HANDOVER NOTE for ${resumed}`;
if (process.env.FAKE_CLAUDE_LOG) (await import('node:fs')).appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ prompt: prompt.slice(0, 300), resumed, effort: val('--effort'), system: val('--append-system-prompt') }) + '\n');
// usage like the real CLI: the first call writes the cache, resumed ones read it
const usage = resumed ? { input_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 20 } : { input_tokens: 50, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0, output_tokens: 20 };
out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }], usage } });
out({ type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: 0.001, num_turns: 1, duration_ms: 5, usage });
