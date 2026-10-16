// Content search for the command bar (⌘K). One local user and a modest
// database, so a plain case-insensitive scan is fast enough and needs no index
// to keep in sync. Every query word must appear; each hit carries the app path
// that opens it at the right spot.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DB } from '../core/db.js';
import { HttpError, on } from './router.js';
import { currentWorkspace } from './workspace.js';

export interface Hit {
  type: 'requirements' | 'design' | 'card' | 'decision' | 'lesson' | 'message' | 'note' | 'reminder' | 'doc';
  title: string;
  snippet: string;
  project: string | null; // project name
  link: string; // app path, may carry ?thread= / ?el= / ?card= / ?file=
}

const PER_TYPE = 6;
const MAX_FILES = 2000;
const MAX_BYTES = 512 * 1024;

const terms = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
const matches = (text: string, ts: string[]) => {
  const t = text.toLowerCase();
  return ts.every((w) => t.includes(w));
};

/** A short excerpt around the first query word. */
export function snippet(text: string, ts: string[], width = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = Math.max(0, flat.toLowerCase().indexOf(ts[0] ?? ''));
  const start = Math.max(0, at - 40);
  const out = flat.slice(start, start + width);
  return (start > 0 ? '…' : '') + out + (start + width < flat.length ? '…' : '');
}

/** `WHERE` for "every word appears in this text expression", with its bind values. */
const where = (expr: string, ts: string[]) => ({ sql: ts.map(() => `instr(lower(${expr}), ?) > 0`).join(' AND '), args: ts });

/** Top-level project (a vertical's parent) for a board project id. */
const topProject = `COALESCE(pr.parent_id, pr.id)`;

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
}

export function search(db: DB, q: string): Hit[] {
  const ts = terms(q);
  if (!ts.length || ts.every((t) => t.length < 2)) return [];
  const hits: Hit[] = [];
  const names = new Map((db.prepare('SELECT id, name, root_path, parent_id FROM projects').all() as { id: string; name: string; root_path: string; parent_id: string | null }[]).map((p) => [p.id, p]));
  const pname = (id: string | null) => (id ? names.get(id)?.name ?? null : null);

  // requirements: latest version per project
  {
    const w = where('r.markdown', ts);
    const rows = db
      .prepare(`SELECT r.project_id, r.markdown FROM requirements r WHERE r.version = (SELECT MAX(version) FROM requirements x WHERE x.project_id = r.project_id) AND ${w.sql} LIMIT ${PER_TYPE}`)
      .all(...w.args) as { project_id: string; markdown: string }[];
    for (const r of rows) hits.push({ type: 'requirements', title: `${pname(r.project_id) ?? 'Project'} requirements`, snippet: snippet(r.markdown, ts), project: pname(r.project_id), link: `/project/${r.project_id}/requirements` });
  }

  // design elements: open the view that shows the element, with it selected
  {
    const text = `name || ' ' || COALESCE(technology, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(responsibilities, '') || ' ' || COALESCE(interfaces, '') || ' ' || COALESCE(risks, '')`;
    const w = where(text, ts);
    const rows = db.prepare(`SELECT project_id, id, parent_id, name, kind, description, ${text} AS body FROM design_elements WHERE ${w.sql} LIMIT ${PER_TYPE}`).all(...w.args) as { project_id: string; id: string; parent_id: string | null; name: string; kind: string; body: string }[];
    for (const e of rows) {
      const view = e.parent_id ? `/design/${encodeURIComponent(e.parent_id)}` : '/design';
      hits.push({ type: 'design', title: `${e.name} (${e.kind})`, snippet: snippet(e.body, ts), project: pname(e.project_id), link: `/project/${e.project_id}${view}?el=${encodeURIComponent(e.id)}` });
    }
  }

  // cards
  {
    const w = where(`t.title || ' ' || COALESCE(t.requirements, '')`, ts);
    const rows = db
      .prepare(`SELECT t.id, t.title, t.requirements, ${topProject} AS top FROM tasks t JOIN projects pr ON pr.id = t.project_id WHERE ${w.sql} ORDER BY t.updated_at DESC LIMIT ${PER_TYPE}`)
      .all(...w.args) as { id: string; title: string; requirements: string | null; top: string }[];
    for (const c of rows) hits.push({ type: 'card', title: c.title, snippet: snippet(`${c.title} ${c.requirements ?? ''}`, ts), project: pname(c.top), link: `/project/${c.top}/board?card=${encodeURIComponent(c.id)}` });
  }

  // decisions: open the thread they were made in, else the project
  {
    const w = where(`title || ' ' || COALESCE(why, '')`, ts);
    const rows = db.prepare(`SELECT title, why, project_id, conversation_id FROM brain_decisions WHERE ${w.sql} ORDER BY created_at DESC LIMIT ${PER_TYPE}`).all(...w.args) as { title: string; why: string | null; project_id: string | null; conversation_id: string | null }[];
    for (const d of rows) {
      const base = d.project_id ? `/project/${d.project_id}` : '/';
      hits.push({ type: 'decision', title: d.title, snippet: snippet(`${d.title} ${d.why ?? ''}`, ts), project: pname(d.project_id), link: d.conversation_id ? `${base}?thread=${encodeURIComponent(d.conversation_id)}` : base });
    }
  }

  // project lessons
  {
    const w = where(`lesson || ' ' || COALESCE(trigger, '') || ' ' || cause`, ts);
    const rows = db.prepare(`SELECT project_id, lesson, trigger FROM project_lessons WHERE status = 'active' AND ${w.sql} ORDER BY updated_at DESC LIMIT ${PER_TYPE}`).all(...w.args) as { project_id: string; lesson: string; trigger: string | null }[];
    for (const l of rows) hits.push({ type: 'lesson', title: l.lesson.slice(0, 90), snippet: snippet(`${l.trigger ?? ''} ${l.lesson}`, ts), project: pname(l.project_id), link: `/project/${l.project_id}/memory` });
  }

  // messages (what people and agents said, not tool traces)
  {
    const w = where('m.body', ts);
    const rows = db
      .prepare(
        `SELECT m.body, m.author, m.conversation_id, c.name, c.kind, c.project_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.kind IN ('text', 'decision') AND c.id NOT LIKE 'sys:%' AND ${w.sql} ORDER BY m.id DESC LIMIT 200`,
      )
      .all(...w.args) as { body: string; author: string; conversation_id: string; name: string; kind: string; project_id: string | null }[];
    const who = new Map((db.prepare('SELECT id, name FROM roles').all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
    // the latest matching message per thread
    const seen = new Set<string>();
    for (const m of rows) {
      if (seen.has(m.conversation_id) || seen.size >= PER_TYPE) continue;
      seen.add(m.conversation_id);
      const base = m.project_id ? `/project/${m.project_id}` : '/';
      const where_ = m.kind === 'channel' ? `#${m.name}` : m.name;
      hits.push({ type: 'message', title: `${m.author === 'user' ? 'You' : who.get(m.author) ?? m.author} in ${where_}`, snippet: snippet(m.body, ts), project: pname(m.project_id), link: `${base}?thread=${encodeURIComponent(m.conversation_id)}` });
    }
  }

  // reminders
  {
    const w = where('text', ts);
    const rows = db.prepare(`SELECT text, due, done FROM reminders WHERE ${w.sql} ORDER BY done, created_at DESC LIMIT ${PER_TYPE}`).all(...w.args) as { text: string; due: string | null; done: number }[];
    for (const r of rows) hits.push({ type: 'reminder', title: r.text.slice(0, 90), snippet: `${r.done ? 'Done' : r.due ? `Due ${r.due}` : 'No due date'}`, project: null, link: '/personal' });
  }

  // vault documents: project docs open in the project's Docs tab; personal notes on Personal
  const ws = currentWorkspace();
  if (ws) {
    const files: string[] = [];
    walk(join(ws.vault, 'projects'), files);
    walk(join(ws.vault, 'personal', 'notes'), files);
    const bySlug = new Map([...names.values()].filter((p) => !p.parent_id).map((p) => [p.root_path.split('/').pop()!, p.id]));
    let notes = 0;
    let docs = 0;
    for (const f of files) {
      if (notes >= PER_TYPE && docs >= PER_TYPE) break;
      let text: string;
      try {
        if (statSync(f).size > MAX_BYTES) continue;
        text = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const rel = relative(ws.root, f);
      if (!matches(`${rel} ${text}`, ts)) continue;
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? rel.split('/').pop()!;
      const slug = rel.match(/^vault\/projects\/([^/]+)\//)?.[1];
      const pid = slug ? bySlug.get(slug) : undefined;
      if (pid && docs < PER_TYPE) {
        docs++;
        hits.push({ type: 'doc', title, snippet: snippet(text, ts), project: pname(pid), link: `/project/${pid}/docs?file=${encodeURIComponent(rel)}` });
      } else if (!slug && notes < PER_TYPE) {
        notes++;
        hits.push({ type: 'note', title, snippet: snippet(text.replace(/^#\s+.+$/m, ''), ts), project: null, link: '/personal' });
      }
    }
  }
  return hits;
}

on('GET', '/api/search', (_q, res, url, ctx) => {
  const q = (url.searchParams.get('q') ?? '').slice(0, 200);
  if (!currentWorkspace()) throw new HttpError(400, 'no workspace');
  ctx.json(res, 200, { q, hits: search(ctx.db(), q) });
});
