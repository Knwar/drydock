// The Idea board: ideas are captured cheaply (a title and a line), shaped in
// one chat where each message updates whatever it touches (the requirements
// doc, the system design, the brand, the UI mockups), and only become a
// project when the user promotes them. A promoted project starts with all of
// that in place, so it goes from team straight to the PM's plan.
//
// Ideas reuse the project stores: requirements and the design model are kept
// under the idea's id and handed over to the project on promotion. Files live
// in vault/ideas/<slug>/ (requirements, design, brand, ui/).
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../core/db.js';
import { getBus } from './bus.js';
import { addMessage, getConversation } from './chat.js';
import { isType, type ProjectType } from './plugins.js';
import { addMissingColumns, defineSchema } from './schema.js';
import { currentWorkspace } from './workspace.js';

defineSchema(
  `
CREATE TABLE IF NOT EXISTS ideas (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  pitch           TEXT NOT NULL DEFAULT '',
  type            TEXT NOT NULL DEFAULT 'software',
  status          TEXT NOT NULL DEFAULT 'raw',   -- raw|shaping|parked|promoted
  conversation_id TEXT,                          -- the shaping chat
  source          TEXT,                          -- the conversation it came up in
  brand_id        TEXT,
  project_id      TEXT,                          -- once promoted
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS brands (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  guidelines TEXT NOT NULL DEFAULT '',
  tokens     TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS idea_screens (
  idea_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  title      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (idea_id, id)
);
`,
  (db) => {
    addMissingColumns(db, 'conversations', { idea_id: 'TEXT' });
    addMissingColumns(db, 'brain_projects', { brand_id: 'TEXT' });
  },
);

export type IdeaStatus = 'raw' | 'shaping' | 'parked' | 'promoted';

export interface Idea {
  id: string;
  slug: string;
  title: string;
  pitch: string;
  type: ProjectType;
  status: IdeaStatus;
  conversation_id: string | null;
  source: string | null;
  brand_id: string | null;
  project_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface Brand {
  id: string;
  name: string;
  guidelines: string;
  tokens: Record<string, unknown>;
  updated_at: number;
}

export const isIdeaId = (id: string) => id.startsWith('idea-');
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

export const getIdea = (db: DB, id: string) => db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as Idea | undefined;
export const ideaForConversation = (db: DB, conversationId: string) => db.prepare('SELECT * FROM ideas WHERE conversation_id = ?').get(conversationId) as Idea | undefined;

export function listIdeas(db: DB, opts: { all?: boolean } = {}): Idea[] {
  return db.prepare(`SELECT * FROM ideas ${opts.all ? '' : "WHERE status != 'promoted'"} ORDER BY updated_at DESC`).all() as Idea[];
}

/** The idea's folder in the vault (its requirements, design, brand and UI files). */
export function ideaDir(db: DB, id: string): string {
  const idea = getIdea(db, id);
  const ws = currentWorkspace();
  if (!idea || !ws) throw new Error(`unknown idea ${id}`);
  return join(ws.vault, 'ideas', idea.slug);
}

const touch = (db: DB, id: string) => {
  db.prepare('UPDATE ideas SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  getBus().emit({ type: 'idea', idea_id: id });
};

/** Something the idea's shaping changed (requirements, design, brand, UI): it is being shaped now. */
export function ideaChanged(db: DB, id: string): void {
  db.prepare(`UPDATE ideas SET status = 'shaping' WHERE id = ? AND status = 'raw'`).run(id);
  touch(db, id);
}

export function captureIdea(db: DB, input: { title: string; pitch?: string; type?: string; source?: string | null }): Idea {
  const title = input.title.trim().replace(/\s+/g, ' ').slice(0, 80);
  const base = slugify(title);
  if (!base) throw new Error('the idea needs a title');
  let slug = base;
  for (let n = 2; db.prepare('SELECT 1 FROM ideas WHERE slug = ?').get(slug); n++) slug = `${base}-${n}`;
  const id = `idea-${randomBytes(5).toString('hex')}`;
  const now = Date.now();
  const type: ProjectType = isType(input.type) ? input.type : 'software';
  db.prepare('INSERT INTO ideas (id, slug, title, pitch, type, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, slug, title, (input.pitch ?? '').trim(), type, input.source ?? null, now, now);
  mkdirSync(ideaDir(db, id), { recursive: true });
  getBus().emit({ type: 'idea', idea_id: id });
  return getIdea(db, id)!;
}

export function updateIdea(db: DB, id: string, patch: { title?: string; pitch?: string; type?: string; status?: string }): Idea {
  const idea = getIdea(db, id);
  if (!idea) throw new Error(`unknown idea ${id}`);
  if (idea.status === 'promoted') throw new Error('this idea is already a project');
  if (patch.title !== undefined && !patch.title.trim()) throw new Error('the idea needs a title');
  if (patch.type !== undefined && !isType(patch.type)) throw new Error('type must be software or general');
  // parking and unparking only; shaping and promotion happen by themselves
  if (patch.status !== undefined && !['parked', 'raw', 'shaping'].includes(patch.status)) throw new Error('an idea can be parked or brought back');
  const status = patch.status === undefined ? idea.status : patch.status === 'parked' ? 'parked' : idea.conversation_id ? 'shaping' : 'raw';
  db.prepare('UPDATE ideas SET title = ?, pitch = ?, type = ?, status = ? WHERE id = ?').run(
    patch.title?.trim().slice(0, 80) ?? idea.title,
    patch.pitch?.trim() ?? idea.pitch,
    patch.type ?? idea.type,
    status,
    id,
  );
  touch(db, id);
  return getIdea(db, id)!;
}

/** Delete an idea: its records go; its folder moves to vault/ideas/.deleted so nothing is lost by accident. */
export function deleteIdea(db: DB, id: string): void {
  const idea = getIdea(db, id);
  if (!idea) return;
  if (idea.status === 'promoted') throw new Error('this idea is already a project');
  const dir = ideaDir(db, id);
  db.transaction(() => {
    for (const t of ['requirements', 'design_elements', 'design_relations', 'design_snapshots']) db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(id);
    db.prepare('DELETE FROM idea_screens WHERE idea_id = ?').run(id);
    db.prepare('DELETE FROM ideas WHERE id = ?').run(id);
  })();
  if (existsSync(dir)) {
    const bin = join(dir, '..', '.deleted');
    mkdirSync(bin, { recursive: true });
    renameSync(dir, join(bin, `${idea.slug}-${Date.now()}`));
  }
  getBus().emit({ type: 'idea', idea_id: id });
}

// ── brand ──

const parseBrand = (r: any): Brand => ({ id: r.id, name: r.name, guidelines: r.guidelines, tokens: JSON.parse(r.tokens || '{}'), updated_at: r.updated_at });
export const listBrands = (db: DB): Brand[] => (db.prepare('SELECT * FROM brands ORDER BY updated_at DESC').all() as any[]).map(parseBrand);
export const getBrand = (db: DB, id: string | null): Brand | null => {
  const r = id ? db.prepare('SELECT * FROM brands WHERE id = ?').get(id) : null;
  return r ? parseBrand(r) : null;
};

/** Write a brand's guidelines and tokens next to an idea or project, for people and agents to read. */
function writeBrandFiles(dir: string, b: Brand): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brand.md'), b.guidelines.endsWith('\n') ? b.guidelines : `${b.guidelines}\n`);
  writeFileSync(join(dir, 'brand-tokens.json'), `${JSON.stringify(b.tokens, null, 2)}\n`);
}

/** Save the idea's brand: updates the brand it uses, or creates one for it. Shared brands change everywhere they are used. */
export function saveBrand(db: DB, ideaId: string, input: { name?: string; guidelines?: string; tokens?: Record<string, unknown> }): Brand {
  const idea = getIdea(db, ideaId);
  if (!idea) throw new Error(`unknown idea ${ideaId}`);
  const now = Date.now();
  let brand = getBrand(db, idea.brand_id);
  if (!brand) {
    const id = `brand-${randomBytes(5).toString('hex')}`;
    db.prepare('INSERT INTO brands (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, input.name?.trim() || idea.title, now, now);
    db.prepare('UPDATE ideas SET brand_id = ? WHERE id = ?').run(id, ideaId);
    brand = getBrand(db, id)!;
  }
  db.prepare('UPDATE brands SET name = ?, guidelines = ?, tokens = ?, updated_at = ? WHERE id = ?').run(
    input.name?.trim() || brand.name,
    input.guidelines ?? brand.guidelines,
    JSON.stringify(input.tokens ?? brand.tokens),
    now,
    brand.id,
  );
  const saved = getBrand(db, brand.id)!;
  writeBrandFiles(ideaDir(db, ideaId), saved);
  ideaChanged(db, ideaId);
  return saved;
}

/** Use an existing brand (one shared with other ideas or projects) for this idea. */
export function useBrand(db: DB, ideaId: string, brandId: string | null): void {
  if (!getIdea(db, ideaId)) throw new Error(`unknown idea ${ideaId}`);
  if (brandId && !getBrand(db, brandId)) throw new Error(`unknown brand ${brandId}`);
  db.prepare('UPDATE ideas SET brand_id = ? WHERE id = ?').run(brandId, ideaId);
  const b = getBrand(db, brandId);
  if (b) writeBrandFiles(ideaDir(db, ideaId), b);
  ideaChanged(db, ideaId);
}

// ── UI mockups: one static HTML file per screen ──

export interface Screen {
  id: string;
  title: string;
  position: number;
  updated_at: number;
}

export const listScreens = (db: DB, ideaId: string) => db.prepare('SELECT id, title, position, updated_at FROM idea_screens WHERE idea_id = ? ORDER BY position, id').all(ideaId) as Screen[];
const SCREEN_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * Save a screen. Mockups are static: no scripts and nothing loaded from
 * elsewhere (the app also serves them under a policy that blocks both), so
 * a mockup can never run code or call out.
 */
export function saveScreen(db: DB, ideaId: string, input: { id: string; title: string; html: string; position?: number }): Screen {
  if (!getIdea(db, ideaId)) throw new Error(`unknown idea ${ideaId}`);
  if (!SCREEN_ID.test(input.id)) throw new Error('screen id: lowercase letters, digits and dashes, e.g. "home" or "settings-billing"');
  if (!input.title.trim()) throw new Error('give the screen a title');
  const html = input.html;
  if (html.length > 400_000) throw new Error('keep a screen under 400 KB');
  if (/<script\b|\son[a-z]+\s*=|javascript:/i.test(html)) throw new Error('mockups are static: no <script>, inline event handlers or javascript: links');
  if (/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html) || /@import|url\(\s*["']?(https?:)?\/\//i.test(html)) throw new Error('mockups load nothing from elsewhere: no remote images, fonts, stylesheets or links (use inline SVG, CSS and system fonts; link screens with href="other-screen.html")');
  const dir = join(ideaDir(db, ideaId), 'ui');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${input.id}.html`), html);
  const pos = input.position ?? (db.prepare('SELECT position FROM idea_screens WHERE idea_id = ? AND id = ?').get(ideaId, input.id) as { position: number } | undefined)?.position ?? listScreens(db, ideaId).length;
  db.prepare(
    `INSERT INTO idea_screens (idea_id, id, title, position, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(idea_id, id) DO UPDATE SET title = excluded.title, position = excluded.position, updated_at = excluded.updated_at`,
  ).run(ideaId, input.id, input.title.trim(), pos, Date.now());
  ideaChanged(db, ideaId);
  return listScreens(db, ideaId).find((s) => s.id === input.id)!;
}

export function removeScreen(db: DB, ideaId: string, screenId: string): void {
  if (!SCREEN_ID.test(screenId)) throw new Error('unknown screen');
  db.prepare('DELETE FROM idea_screens WHERE idea_id = ? AND id = ?').run(ideaId, screenId);
  rmSync(join(ideaDir(db, ideaId), 'ui', `${screenId}.html`), { force: true });
  ideaChanged(db, ideaId);
}

export function screenHtml(db: DB, ideaId: string, screenId: string): string | null {
  if (!SCREEN_ID.test(screenId)) return null;
  const file = join(ideaDir(db, ideaId), 'ui', `${screenId}.html`);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** A plain index page linking every screen, written beside them so the folder works on its own. */
function writeScreenIndex(dir: string, title: string, screens: Screen[]): void {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}: screens</title><body style="font-family:system-ui;margin:32px"><h1>${esc(title)}: screens</h1><ul>${screens.map((s) => `<li><a href="${s.id}.html">${esc(s.title)}</a></li>`).join('')}</ul></body>\n`,
  );
}

// ── the shaping chat ──

/** What exists for an idea: shown before promotion and given to agents. */
export function ideaSummary(db: DB, id: string) {
  const idea = getIdea(db, id);
  if (!idea) throw new Error(`unknown idea ${id}`);
  const req = db.prepare('SELECT MAX(version) AS v FROM requirements WHERE project_id = ?').get(id) as { v: number | null };
  const design = db.prepare('SELECT COUNT(*) AS n FROM design_elements WHERE project_id = ?').get(id) as { n: number };
  const brand = getBrand(db, idea.brand_id);
  const screens = listScreens(db, id);
  const missing: string[] = [];
  if (!req.v) missing.push('requirements');
  if (idea.type === 'software') {
    if (!design.n) missing.push('system design');
    if (!brand) missing.push('brand');
    if (!screens.length) missing.push('UI');
  }
  return { idea, requirementsVersion: req.v, designElements: design.n, brand, screens, missing };
}

/** The idea's single shaping chat with the Main agent, opened on first use. */
export function ideaThread(db: DB, id: string): string {
  const idea = getIdea(db, id);
  if (!idea) throw new Error(`unknown idea ${id}`);
  if (idea.conversation_id && getConversation(db, idea.conversation_id)) return idea.conversation_id;
  const conv = `ch:idea-${idea.slug}`;
  const now = Date.now();
  if (!getConversation(db, conv)) {
    db.prepare(`INSERT INTO conversations (id, kind, project_id, name, created_at, last_at, idea_id) VALUES (?, 'channel', NULL, ?, ?, ?, ?)`).run(conv, idea.title, now, now, id);
    db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, role_id) VALUES (?, 'main')`).run(conv);
  }
  db.prepare(`UPDATE ideas SET conversation_id = ?, status = CASE WHEN status = 'raw' THEN 'shaping' ELSE status END WHERE id = ?`).run(conv, id);
  touch(db, id);
  getBus().emit({ type: 'conversations' });
  return conv;
}

// ── promotion ──

/**
 * Hand the idea's work to its new project: requirements (marked final), the
 * design model, the brand and the UI files. Copies go into the project's
 * repo (docs/) so builders work from them, and into its vault folder.
 */
export function handOver(db: DB, ideaId: string, project: { id: string; root: string; vault: string }): void {
  const idea = getIdea(db, ideaId)!;
  const dir = ideaDir(db, ideaId);
  db.transaction(() => {
    // the new project's placeholder requirements give way to the idea's, when it has some
    if (db.prepare('SELECT 1 FROM requirements WHERE project_id = ?').get(ideaId)) db.prepare('DELETE FROM requirements WHERE project_id = ?').run(project.id);
    for (const t of ['requirements', 'design_elements', 'design_relations', 'design_snapshots']) db.prepare(`UPDATE ${t} SET project_id = ? WHERE project_id = ?`).run(project.id, ideaId);
    const latest = db.prepare('SELECT MAX(version) AS v FROM requirements WHERE project_id = ?').get(project.id) as { v: number | null };
    if (latest.v) db.prepare('UPDATE requirements SET final = 1 WHERE project_id = ? AND version = ?').run(project.id, latest.v);
    db.prepare(`UPDATE brain_projects SET origin = 'idea', brand_id = ? WHERE project_id = ?`).run(idea.brand_id, project.id);
    db.prepare(`UPDATE ideas SET status = 'promoted', project_id = ?, updated_at = ? WHERE id = ?`).run(project.id, Date.now(), ideaId);
  })();
  const docs = join(project.root, 'docs');
  mkdirSync(docs, { recursive: true });
  const reqDir = join(dir, 'requirements');
  if (existsSync(reqDir)) cpSync(reqDir, join(project.vault, 'requirements'), { recursive: true });
  if (existsSync(join(reqDir, 'current.md'))) cpSync(join(reqDir, 'current.md'), join(docs, 'requirements.md'));
  const brand = getBrand(db, idea.brand_id);
  if (brand) {
    writeBrandFiles(docs, brand);
    writeBrandFiles(join(project.vault, 'design'), brand);
  }
  const screens = listScreens(db, ideaId);
  if (screens.length) {
    for (const target of [join(docs, 'ui'), join(project.vault, 'design', 'ui')]) {
      cpSync(join(dir, 'ui'), target, { recursive: true });
      writeScreenIndex(target, idea.title, screens);
    }
  }
  const conv = idea.conversation_id;
  if (conv && getConversation(db, conv)) {
    const m = addMessage(db, conv, 'system', `Promoted to a project: ${idea.title}. Shaping continues in the project; this chat stays as its history.`);
    getBus().emit({ type: 'chat', conversation: conv, message: m });
  }
  getBus().emit({ type: 'idea', idea_id: ideaId });
}
