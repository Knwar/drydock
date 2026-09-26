import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// GET /config carries the code version the daemon started with; GET /version
// re-reads it on disk. Unchanged code → the two match.

describe('daemon code version', () => {
  let daemon: TestDaemon | undefined;
  before(async () => {
    daemon = await startDaemon();
  });
  after(async () => {
    await daemon?.stop();
  });

  it('/config version and /version agree while the code is unchanged', async () => {
    const cfg = (await (await fetch(`${daemon!.base}/config`)).json()) as {
      version: { fingerprint: string; files: number; sha: string | null };
    };
    assert.match(cfg.version.fingerprint, /^[0-9a-f]{16}$/);
    assert.ok(cfg.version.files > 0);
    const res = await fetch(`${daemon!.base}/version`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), cfg.version);
  });
});
