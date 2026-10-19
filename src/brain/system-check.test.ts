import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'brain-syscheck-'));
// a stand-in claude that is installed but signed out
const bin = join(tmp, 'claude');
writeFileSync(bin, `#!/bin/sh\ncase "$1" in --version) echo "2.1.0 (Claude Code)";; auth) echo '{"loggedIn": false}'; exit 1;; esac\n`);
chmodSync(bin, 0o755);
process.env.BRAIN_CLAUDE_BIN = bin;
const { parseAuth, runChecks } = await import('./system-check.js');

describe('system checks', () => {
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('reads claude auth status', () => {
    assert.deepEqual(parseAuth('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'), { loggedIn: true, method: 'claude.ai', plan: 'max' });
    assert.equal(parseAuth('{"loggedIn":false}').loggedIn, false);
    assert.equal(parseAuth('not json').loggedIn, false);
  });

  it('flags a signed-out Claude CLI with the command that fixes it', async () => {
    const s = await runChecks();
    const by = Object.fromEntries(s.checks.map((c) => [c.id, c]));
    assert.equal(s.ok, false);
    assert.equal(by.node.ok, true);
    assert.equal(by.claude.ok, true);
    assert.equal(by.claude.detail, 'v2.1.0');
    assert.equal(by.signin.ok, false);
    assert.equal(by.signin.command, 'claude auth login');
  });
});
