import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openDb } from '../core/db.js';
import { addMessage, createChannel } from './chat.js';
import { addReminder } from './personal.js';
import './pipeline.js'; // registers its tables
import './teamwork.js';
import { ensureSchema } from './schema.js';
import { search, snippet } from './search.js';
import { setupWorkspace } from './workspace.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-search-')));
const prevHome = process.env.BRAIN_HOME;
process.env.BRAIN_HOME = join(tmp, 'home');
after(() => {
  process.env.BRAIN_HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe('search', () => {
  const ws = setupWorkspace(join(tmp, 'ws'));
  const db = openDb(':memory:');
  ensureSchema(db);
  const now = Date.now();
  db.prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)').run('p1', 'notes app', join(ws.root, 'projects', 'notes-app'), now);
  db.prepare('INSERT INTO projects (id, name, root_path, parent_id, created_at) VALUES (?, ?, ?, ?, ?)').run('v1', 'web', join(ws.root, 'projects', 'notes-app', 'web'), 'p1', now);
  db.prepare('INSERT INTO requirements (project_id, version, markdown, created_at) VALUES (?, 1, ?, ?), (?, 2, ?, ?)').run('p1', '# Old\n\nMarkdown preview', now, 'p1', '# Notes\n\n## Features\n\nFast markdown preview and search', now);
  db.prepare("INSERT INTO design_elements (project_id, id, parent_id, kind, name, technology, description, updated_at) VALUES ('p1', 'editor', 'app', 'component', 'Editor view', 'SwiftUI', 'Edits markdown with live preview', ?)").run(now);
  db.prepare("INSERT INTO tasks (id, project_id, title, requirements, created_at, updated_at) VALUES ('c1', 'v1', 'Preview pane', 'Render markdown preview safely', ?, ?)").run(now, now);
  const ch = createChannel(db, 'design', ['main'], 'p1');
  addMessage(db, ch.id, 'architect', 'The preview never fetches remote images.');
  addMessage(db, ch.id, 'architect', 'Used preview tool', 'tool');
  addReminder(db, 'Review the preview pane', null);
  mkdirSync(join(ws.vault, 'projects', 'notes-app'), { recursive: true });
  writeFileSync(join(ws.vault, 'projects', 'notes-app', 'system-design.md'), '# System design\n\nThe preview renders markdown as plain text.\n');
  writeFileSync(join(ws.vault, 'personal', 'notes', '2026-10-16.md'), '# Preview idea\n\nA side-by-side preview.\n');

  it('finds every kind of content and links to the right place', () => {
    const hits = search(db, 'preview');
    const by = (t: string) => hits.filter((h) => h.type === t);
    assert.equal(by('requirements').length, 1, 'latest version only');
    assert.equal(by('requirements')[0].link, '/project/p1/requirements');
    assert.equal(by('design')[0].link, '/project/p1/design/app?el=editor');
    assert.equal(by('card')[0].link, '/project/p1/board?card=c1', 'a vertical card opens on its top-level project');
    assert.equal(by('message').length, 1, 'tool traces are not searched');
    assert.equal(by('message')[0].link, `/project/p1?thread=${encodeURIComponent(ch.id)}`);
    assert.equal(by('reminder').length, 1);
    assert.equal(by('doc')[0].link, `/project/p1/docs?file=${encodeURIComponent('vault/projects/notes-app/system-design.md')}`);
    assert.equal(by('note')[0].title, 'Preview idea');
  });

  it('needs every word, ignores case, and skips empty queries', () => {
    assert.ok(search(db, 'MARKDOWN Preview').length > 0);
    assert.equal(search(db, 'preview kubernetes').length, 0);
    assert.deepEqual(search(db, '  '), []);
  });

  it('snippets centre on the match', () => {
    const s = snippet('a '.repeat(100) + 'needle here', ['needle']);
    assert.ok(s.startsWith('…') && s.includes('needle'));
  });
});
