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
    const cases: [string, string][] = [
      ['pyproject.toml', 'python'],
      ['requirements.txt', 'python'],
      ['Gemfile', 'ruby'],
      ['pom.xml', 'java'],
      ['build.gradle', 'java'],
      ['build.gradle.kts', 'java'],
      ['composer.json', 'php'],
      ['App.csproj', 'dotnet'],
      ['App.xcodeproj/', 'ios'],
    ];
    for (const [manifest, stack] of cases) {
      const root = repo(t, [`clients/a/${manifest}`, 'clients/b/package.json']);
      assert.deepEqual(
        suggestVerticals(root).map((s) => [s.folder, s.stack]),
        [
          ['clients/a', stack],
          ['clients/b', 'node'],
        ],
        manifest,
      );
    }
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

  it('never suggests packages/* children', (t) => {
    const root = repo(t, ['apps/web/package.json', 'apps/admin/package.json', 'packages/ui/package.json']);
    assert.deepEqual(
      suggestVerticals(root).map((s) => s.folder),
      ['apps/admin', 'apps/web'],
    );
    const pkgs = repo(t, ['packages/a/package.json', 'packages/b/package.json']);
    assert.deepEqual(suggestVerticals(pkgs), []);
  });

  it('ignores platform folders when the root is a Flutter app', (t) => {
    const root = repo(t, ['pubspec.yaml', 'android/build.gradle', 'ios/App.xcodeproj/', 'web/package.json']);
    assert.deepEqual(suggestVerticals(root), []);
    // other known names still count
    const withApi = repo(t, ['pubspec.yaml', 'android/build.gradle', 'api/go.mod', 'admin/package.json']);
    assert.deepEqual(
      suggestVerticals(withApi).map((s) => s.folder),
      ['admin', 'api'],
    );
  });

  it('ignores platform folders when the root is a React Native app', (t) => {
    const root = repo(t, ['android/build.gradle', 'ios/App.xcodeproj/']);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.80.0' } }));
    assert.deepEqual(suggestVerticals(root), []);
    // a plain node root does not hide them
    const plain = repo(t, ['android/build.gradle', 'ios/App.xcodeproj/']);
    writeFileSync(join(plain, 'package.json'), JSON.stringify({ dependencies: { express: '5.0.0' } }));
    assert.deepEqual(
      suggestVerticals(plain).map((s) => s.folder),
      ['android', 'ios'],
    );
  });

  it('a container with more than 3 candidates becomes one vertical', (t) => {
    const four = repo(t, [
      'mobile/pubspec.yaml',
      'services/a/package.json',
      'services/b/package.json',
      'services/c/package.json',
      'services/d/go.mod',
    ]);
    assert.deepEqual(suggestVerticals(four), [
      { name: 'mobile', folder: 'mobile', stack: 'flutter' },
      { name: 'services', folder: 'services', stack: 'node' },
    ]);
    const three = repo(t, ['mobile/pubspec.yaml', 'services/a/package.json', 'services/b/package.json', 'services/c/go.mod']);
    assert.deepEqual(
      suggestVerticals(three).map((s) => s.folder),
      ['mobile', 'services/a', 'services/b', 'services/c'],
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
