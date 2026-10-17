import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('MCP servers and role access', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-integrations-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('never blocks the board for project roles, even when a .mcp.json also lists a kanban server', async () => {
    // `claude mcp list` run from a folder whose .mcp.json has its own kanban entry
    const fake = join(tmp, 'claude');
    writeFileSync(fake, `#!/bin/sh\necho "kanban: node dist/mcp/server.js - ⏸ Pending approval (run \\\`claude\\\` to approve)"\necho "claude.ai Gmail: https://gmail.example/mcp - ✔ Connected"\n`);
    chmodSync(fake, 0o755);
    process.env.BRAIN_CLAUDE_BIN = fake;
    const { blockedServers, listServers } = await import('./integrations.js');
    const { ensureSchema } = await import('./schema.js');
    const db = new Database(':memory:');
    ensureSchema(db as never);

    const servers = await listServers(true);
    assert.deepEqual(servers.filter((s) => s.prefix === 'mcp__kanban').map((s) => s.status), ['built_in']);
    assert.deepEqual(blockedServers(db as never, 'pm'), ['mcp__claude_ai_Gmail']);
  });
});
