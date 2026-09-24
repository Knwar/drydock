import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { suggestVerticals } from './vertical-suggest.js';

/** A temp repo with the given files (relative paths; a trailing '/' makes a directory). */
function repo(t: TestContext, files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'kankan-vsuggest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const f of files) {
    const p = join(root, f);
    if (f.endsWith('/')) mkdirSync(p, { recursive: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, '');
    }
  }
  return root;
}

describe('suggestVerticals', () => {
  it('finds container children with their stacks', (t) => {
    const root = repo(t, ['apps/web/package.json', 'apps/mobile/pubspec.yaml', 'services/api/go.mod']);
    assert.deepEqual(suggestVerticals(root), [
      { name: 'mobile', folder: 'apps/mobile', stack: 'flutter' },
      { name: 'web', folder: 'apps/web', stack: 'node' },
      { name: 'api', folder: 'services/api', stack: 'go' },
    ]);
  });

  it('finds known top-level folders', (t) => {
    const root = repo(t, ['web/package.json', 'api/Cargo.toml', 'random/package.json']);
    assert.deepEqual(suggestVerticals(root), [
      { name: 'api', folder: 'api', stack: 'rust' },
      { name: 'web', folder: 'web', stack: 'node' },
    ]);
  });

  it('labels every manifest kind', (t) => {
    const root = repo(t, [
      'clients/a/pyproject.toml',
      'clients/b/requirements.txt',
      'clients/c/Gemfile',
      'clients/d/pom.xml',
      'clients/e/build.gradle',
      'clients/f/build.gradle.kts',
      'clients/g/composer.json',
      'clients/h/App.csproj',
      'clients/i/App.xcodeproj/',
    ]);
    assert.deepEqual(
      suggestVerticals(root).map((s) => [s.folder, s.stack]),
      [
        ['clients/a', 'python'],
        ['clients/b', 'python'],
        ['clients/c', 'ruby'],
        ['clients/d', 'java'],
        ['clients/e', 'java'],
        ['clients/f', 'java'],
        ['clients/g', 'php'],
        ['clients/h', 'dotnet'],
        ['clients/i', 'ios'],
      ],
    );
  });

  it('a single candidate → []', (t) => {
    const root = repo(t, ['apps/web/package.json', 'apps/empty/README.md']);
    assert.deepEqual(suggestVerticals(root), []);
  });

  it('ignores node_modules, .trees, dist, dot-folders, deeper folders and symlinks', (t) => {
    const root = repo(t, [
      'apps/web/package.json',
      'apps/node_modules/package.json',
      'apps/.hidden/package.json',
      'apps/dist/package.json',
      'node_modules/web/package.json',
      '.trees/api/package.json',
      '.cache/package.json',
      'apps/deep/nested/package.json',
      'elsewhere/package.json',
    ]);
    symlinkSync(join(root, 'elsewhere'), join(root, 'apps', 'linked'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'api'));
    assert.deepEqual(suggestVerticals(root), []);
  });

  it('the root manifest alone never makes the root a candidate', (t) => {
    const root = repo(t, ['package.json', 'go.mod']);
    assert.deepEqual(suggestVerticals(root), []);
    const withOne = repo(t, ['package.json', 'web/package.json']);
    assert.deepEqual(suggestVerticals(withOne), []);
  });

  it('drops packages/* when apps/ has candidates', (t) => {
    const root = repo(t, ['apps/web/package.json', 'apps/admin/package.json', 'packages/ui/package.json']);
    assert.deepEqual(
      suggestVerticals(root).map((s) => s.folder),
      ['apps/admin', 'apps/web'],
    );
    // no apps/ or services/ → packages/* are candidates
    const pkgs = repo(t, ['packages/a/package.json', 'packages/b/package.json']);
    assert.deepEqual(
      suggestVerticals(pkgs).map((s) => s.folder),
      ['packages/a', 'packages/b'],
    );
  });

  it('disambiguates name collisions with the parent folder', (t) => {
    const root = repo(t, ['apps/web/package.json', 'clients/web/package.json', 'services/api/go.mod']);
    assert.deepEqual(
      suggestVerticals(root).map((s) => s.name),
      ['apps-web', 'clients-web', 'api'],
    );
  });
});
