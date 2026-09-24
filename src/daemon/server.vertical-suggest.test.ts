import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Git in temp repos must not depend on the user's global config (identity, signing).
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'kankan-test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'kankan-test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: { ...process.env, ...GIT_ENV }, stdio: 'ignore' });

describe('vertical-suggestions: folders relative to the git toplevel', () => {
  it('a project rooted at a repo subfolder gets toplevel-relative folders that split-preview accepts', async (t) => {
    const daemon = await startDaemon({ env: { HOST: '127.0.0.1', KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '0' } });
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-suggest-')));
    t.after(async () => {
      await daemon.stop();
      rmSync(tmp, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${daemon.port}`;
    const repo = join(tmp, 'repo');
    const root = join(repo, 'product');
    for (const [folder, manifest] of [
      ['apps/web', 'package.json'],
      ['services/api', 'go.mod'],
    ]) {
      mkdirSync(join(root, folder), { recursive: true });
      writeFileSync(join(root, folder, manifest), '');
    }
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    const pid = ((await (await fetch(`${base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;

    const res = await fetch(`${base}/project/${pid}/vertical-suggestions`);
    assert.equal(res.status, 200);
    const { suggestions } = (await res.json()) as { suggestions: { name: string; folder: string; stack: string }[] };
    assert.deepEqual(suggestions, [
      { name: 'web', folder: 'product/apps/web', stack: 'node' },
      { name: 'api', folder: 'product/services/api', stack: 'go' },
    ]);

    const preview = await fetch(`${base}/project/${pid}/split-preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: suggestions.map(({ name, folder }) => ({ name, folder })) }),
    });
    assert.equal(preview.status, 200);
    const body = (await preview.json()) as { targets: { name: string; root: string; folder: string }[] };
    assert.deepEqual(
      body.targets.map((x) => [x.name, x.root, x.folder]),
      [
        ['web', join(root, 'apps/web'), 'product/apps/web'],
        ['api', join(root, 'services/api'), 'product/services/api'],
      ],
    );
  });

  it('a project rooted at the git toplevel keeps folders as-is', async (t) => {
    const daemon = await startDaemon({ env: { HOST: '127.0.0.1', KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '0' } });
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-suggest-')));
    t.after(async () => {
      await daemon.stop();
      rmSync(tmp, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${daemon.port}`;
    const root = join(tmp, 'repo');
    for (const [folder, manifest] of [
      ['apps/web', 'package.json'],
      ['services/api', 'go.mod'],
    ]) {
      mkdirSync(join(root, folder), { recursive: true });
      writeFileSync(join(root, folder, manifest), '');
    }
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
    const pid = ((await (await fetch(`${base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;
    const res = await fetch(`${base}/project/${pid}/vertical-suggestions`);
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { suggestions: unknown[] }).suggestions, [
      { name: 'web', folder: 'apps/web', stack: 'node' },
      { name: 'api', folder: 'services/api', stack: 'go' },
    ]);
  });
});
