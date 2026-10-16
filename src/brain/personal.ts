// Personal manager data (D10: email is the only external source for now):
// reminders the user keeps, and what the main agent extracts from email and
// calendar into structured rows — inbox items, events, bills, spending.
// Notes are Markdown files in vault/personal/notes.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../core/db.js';
import { defineSchema } from './schema.js';
import { currentWorkspace } from './workspace.js';

defineSchema(`
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  due        TEXT,               -- YYYY-MM-DD or YYYY-MM-DDTHH:MM, or null
  done       INTEGER NOT NULL DEFAULT 0,
  source     TEXT,               -- 'user' | 'email' | role id
  created_at INTEGER NOT NULL,
  done_at    INTEGER
);
CREATE TABLE IF NOT EXISTS inbox_items (
  id         TEXT PRIMARY KEY,   -- stable key, e.g. the email thread id
  sender     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  summary    TEXT,
  tag        TEXT NOT NULL DEFAULT 'action',  -- reply|payment|project|personal|travel|action
  action     TEXT,
  received   TEXT,
  status     TEXT NOT NULL DEFAULT 'open',    -- open|done|dismissed
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS calendar_events (
  id       TEXT PRIMARY KEY,
  day      TEXT NOT NULL,        -- YYYY-MM-DD
  time     TEXT,                 -- HH:MM or null (all day)
  title    TEXT NOT NULL,
  meta     TEXT,
  category TEXT NOT NULL DEFAULT 'work',      -- work|personal|social|reminder
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bills (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  amount   REAL,
  currency TEXT,
  due      TEXT,                 -- YYYY-MM-DD
  autopay  INTEGER NOT NULL DEFAULT 0,
  status   TEXT NOT NULL DEFAULT 'due',       -- due|paid
  source   TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spending (
  month    TEXT NOT NULL,        -- YYYY-MM
  category TEXT NOT NULL,
  amount   REAL NOT NULL,
  currency TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (month, category)
);
`);

const now = () => Date.now();

// ── reminders ──

export function listReminders(db: DB, includeDone = true) {
  return db.prepare(`SELECT * FROM reminders ${includeDone ? '' : 'WHERE done = 0'} ORDER BY done, COALESCE(due, '9999'), id`).all() as any[];
}
export function addReminder(db: DB, text: string, due: string | null, source = 'user') {
  const info = db.prepare('INSERT INTO reminders (text, due, source, created_at) VALUES (?, ?, ?, ?)').run(text.trim(), due || null, source, now());
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(info.lastInsertRowid));
}
export function setReminderDone(db: DB, id: number, done: boolean) {
  db.prepare('UPDATE reminders SET done = ?, done_at = ? WHERE id = ?').run(done ? 1 : 0, done ? now() : null, id);
}
export function deleteReminder(db: DB, id: number) {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
}

// ── extracted from email / calendar ──

export function upsertInbox(db: DB, items: { id: string; sender: string; subject: string; summary?: string; tag?: string; action?: string; received?: string }[]) {
  const st = db.prepare(
    `INSERT INTO inbox_items (id, sender, subject, summary, tag, action, received, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET sender = excluded.sender, subject = excluded.subject, summary = excluded.summary, tag = excluded.tag,
       action = excluded.action, received = excluded.received, updated_at = excluded.updated_at`,
  );
  for (const i of items) st.run(i.id, i.sender, i.subject, i.summary ?? null, i.tag ?? 'action', i.action ?? null, i.received ?? null, now());
}
export function listInbox(db: DB) {
  return db.prepare(`SELECT * FROM inbox_items WHERE status = 'open' ORDER BY COALESCE(received, '') DESC, updated_at DESC LIMIT 50`).all() as any[];
}
export function setInboxStatus(db: DB, id: string, status: 'open' | 'done' | 'dismissed') {
  db.prepare('UPDATE inbox_items SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
}

export function replaceEvents(db: DB, from: string, to: string, events: { id?: string; day: string; time?: string | null; title: string; meta?: string; category?: string }[]) {
  db.transaction(() => {
    db.prepare('DELETE FROM calendar_events WHERE day >= ? AND day <= ?').run(from, to);
    const st = db.prepare('INSERT OR REPLACE INTO calendar_events (id, day, time, title, meta, category, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    events.forEach((e, i) => st.run(e.id ?? `${e.day}-${e.time ?? 'allday'}-${i}`, e.day, e.time ?? null, e.title, e.meta ?? null, e.category ?? 'work', now()));
  })();
}
export function listEvents(db: DB, from: string, to: string) {
  return db.prepare(`SELECT * FROM calendar_events WHERE day >= ? AND day <= ? ORDER BY day, COALESCE(time, '00:00')`).all(from, to) as any[];
}

export function upsertBills(db: DB, bills: { id: string; name: string; amount?: number; currency?: string; due?: string; autopay?: boolean; status?: string; source?: string }[]) {
  const st = db.prepare(
    `INSERT INTO bills (id, name, amount, currency, due, autopay, status, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, amount = excluded.amount, currency = excluded.currency, due = excluded.due,
       autopay = excluded.autopay, status = excluded.status, source = excluded.source, updated_at = excluded.updated_at`,
  );
  for (const b of bills) st.run(b.id, b.name, b.amount ?? null, b.currency ?? null, b.due ?? null, b.autopay ? 1 : 0, b.status ?? 'due', b.source ?? 'email', now());
}
export function listBills(db: DB) {
  return db.prepare(`SELECT * FROM bills WHERE status = 'due' ORDER BY COALESCE(due, '9999')`).all() as any[];
}
export function setBillStatus(db: DB, id: string, status: 'due' | 'paid') {
  db.prepare('UPDATE bills SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
}

export function setSpending(db: DB, month: string, rows: { category: string; amount: number; currency?: string }[]) {
  db.transaction(() => {
    db.prepare('DELETE FROM spending WHERE month = ?').run(month);
    const st = db.prepare('INSERT INTO spending (month, category, amount, currency, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) st.run(month, r.category, r.amount, r.currency ?? null, now());
  })();
}
export function getSpending(db: DB, month: string) {
  return db.prepare('SELECT category, amount, currency FROM spending WHERE month = ? ORDER BY amount DESC').all(month) as any[];
}

// ── notes (vault/personal/notes/*.md) ──

const notesDir = () => {
  const ws = currentWorkspace();
  if (!ws) throw new Error('no workspace');
  const dir = join(ws.vault, 'personal', 'notes');
  mkdirSync(dir, { recursive: true });
  return dir;
};

export function listNotes(limit = 20) {
  const dir = notesDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const path = join(dir, f);
      const text = readFileSync(path, 'utf8');
      const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? f.replace(/\.md$/, '');
      const body = text.replace(/^#\s+.+$/m, '').trim();
      return { file: f, title, body: body.slice(0, 400), modified: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit);
}

export function addNote(text: string, title?: string) {
  const dir = notesDir();
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const heading = (title ?? text.split('\n')[0]).trim().slice(0, 80) || 'Note';
  let file = `${stamp}.md`;
  for (let i = 2; existsSync(join(dir, file)); i++) file = `${stamp}-${i}.md`;
  writeFileSync(join(dir, file), `# ${heading}\n\n${text.trim()}\n`);
  return { file, title: heading };
}
