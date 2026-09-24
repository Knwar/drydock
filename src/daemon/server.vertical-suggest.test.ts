import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// GET /project/:id/vertical-suggestions against the REAL daemon (temp DB, random port).

describe('GET /project/:id/vertical-suggestions', () => {
  let daemon: TestDaemon | undefined;
  let base: string;
  let projectId: string;
  let verticalId: string;

  before(async () => {
    daemon = await startDaemon({ env: { HOST: '127.0.0.1', KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '0' } });
    base = `http://127.0.0.1:${daemon.port}`;
    const root = join(daemon.dbDir, 'mono');
    for (const [folder, manifest] of [
      ['apps/web', 'package.json'],
      ['apps/mobile', 'pubspec.yaml'],
      ['services/api', 'go.mod'],
    ]) {
      mkdirSync(join(root, folder), { recursive: true });
      writeFileSync(join(root, folder, manifest), '');
    }
    writeFileSync(join(root, '.mcp.json'), '{}');
    const res = await fetch(`${base}/project?root=${encodeURIComponent(root)}`);
    projectId = ((await res.json()) as { project_id: string }).project_id;
  });

  after(async () => {
    await daemon?.stop();
  });

  const suggestions = async (id: string) => {
    const res = await fetch(`${base}/project/${id}/vertical-suggestions`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { suggestions: { name: string; folder: string; stack: string }[] }).suggestions;
  };

  it('suggests the sides of a monorepo project', async () => {
    assert.deepEqual(await suggestions(projectId), [
      { name: 'mobile', folder: 'apps/mobile', stack: 'flutter' },
      { name: 'web', folder: 'apps/web', stack: 'node' },
      { name: 'api', folder: 'services/api', stack: 'go' },
    ]);
  });

  it('→ [] once the project has a vertical, and for the vertical itself', async () => {
    const res = await fetch(`${base}/vertical`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: projectId, name: 'web', root: join(daemon!.dbDir, 'mono', 'apps', 'web') }),
    });
    assert.equal(res.status, 200);
    verticalId = ((await res.json()) as { project_id: string }).project_id;
    assert.deepEqual(await suggestions(projectId), []);
    assert.deepEqual(await suggestions(verticalId), []);
  });

  it('unknown project → 404', async () => {
    const res = await fetch(`${base}/project/does-not-exist/vertical-suggestions`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'unknown project' });
  });
});
