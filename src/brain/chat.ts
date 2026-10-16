// Team chat (D3 + team chat requirements): DMs with each role, channels with
// several members, messages, decisions, and approval requests.
import { randomUUID } from 'node:crypto';
import type { DB } from '../core/db.js';
import { listRoles } from './roles.js';
import { addMissingColumns, defineSchema } from './schema.js';

export type MessageKind = 'text' | 'tool' | 'decision' | 'approval' | 'proposal' | 'secret_request' | 'error';

export interface Conversation {
  id: string;
  kind: 'dm' | 'channel';
  role_id: string | null;
  project_id: string | null;
  name: string;
  created_at: number;
  last_at: number;
  read_at: number;
}

export interface Message {
  id: number;
  conversation_id: string;
  author: string; // 'user' or a role id
  kind: MessageKind;
  body: string;
  meta: any;
  created_at: number;
}

defineSchema(
  `
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  role_id    TEXT,
  project_id TEXT,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_at    INTEGER NOT NULL,
  read_at    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL,
  role_id         TEXT NOT NULL,
  PRIMARY KEY (conversation_id, role_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  author          TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'text',
  body            TEXT NOT NULL DEFAULT '',
  meta            TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, id);
CREATE TABLE IF NOT EXISTS agent_sessions (
  role_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  seen_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (role_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  role_id         TEXT NOT NULL,
  conversation_id TEXT,
  message_id      INTEGER,
  tool            TEXT NOT NULL,
  input           TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  note            TEXT,
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);
CREATE TABLE IF NOT EXISTS standing_permissions (
  role_id    TEXT NOT NULL,
  tool       TEXT NOT NULL,
  policy     TEXT NOT NULL DEFAULT 'allow',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (role_id, tool)
);
CREATE TABLE IF NOT EXISTS brain_decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  project_id      TEXT,
  role_id         TEXT,
  title           TEXT NOT NULL,
  why             TEXT,
  follow_ups      TEXT,
  created_at      INTEGER NOT NULL
);
`,
  (db) => {
    addMissingColumns(db, 'agent_sessions', { turns: 'INTEGER NOT NULL DEFAULT 0', context_tokens: 'INTEGER NOT NULL DEFAULT 0' });
    ensureDms(db);
  },
);

const parseMeta = (m: any): Message => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null });

export const dmId = (roleId: string) => `dm:${roleId}`;

/** Every role has a DM; created lazily so new roles get one too. */
export function ensureDms(db: DB): void {
  const now = Date.now();
  const insert = db.prepare(`INSERT OR IGNORE INTO conversations (id, kind, role_id, name, created_at, last_at) VALUES (?, 'dm', ?, ?, ?, ?)`);
  const member = db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, role_id) VALUES (?, ?)`);
  for (const r of listRoles(db)) {
    insert.run(dmId(r.id), r.id, r.name, now, 0);
    member.run(dmId(r.id), r.id);
  }
}

export function getConversation(db: DB, id: string): Conversation | undefined {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | undefined;
}

export function members(db: DB, conversationId: string): string[] {
  return (db.prepare('SELECT role_id FROM conversation_members WHERE conversation_id = ? ORDER BY rowid').all(conversationId) as { role_id: string }[]).map((r) => r.role_id);
}

export function listConversations(db: DB) {
  ensureDms(db);
  // a removed member's DM is kept (history) but not listed until they are added again
  const rows = db
    .prepare(`SELECT * FROM conversations c WHERE c.kind != 'dm' OR EXISTS (SELECT 1 FROM roles r WHERE r.id = c.role_id) ORDER BY kind, created_at`)
    .all() as Conversation[];
  const last = db.prepare(`SELECT body, kind, author FROM messages WHERE conversation_id = ? AND kind IN ('text', 'decision', 'approval', 'proposal', 'secret_request') ORDER BY id DESC LIMIT 1`);
  const unread = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND author != 'user' AND kind IN ('text', 'decision', 'approval', 'proposal', 'secret_request') AND created_at > ?`);
  return rows.map((c) => ({
    ...c,
    members: members(db, c.id),
    last: (last.get(c.id) as { body: string; kind: string; author: string } | undefined) ?? null,
    unread: (unread.get(c.id, c.read_at) as { n: number }).n,
  }));
}

/**
 * A thread (channel) with one or more members. A project thread's id is
 * scoped by the project's slug, so two projects can each have "pricing".
 */
export function createChannel(db: DB, name: string, memberIds: string[], projectId: string | null = null, scope: string | null = null): Conversation {
  const display = name.trim().replace(/\s+/g, ' ').slice(0, 60);
  const clean = display.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!clean) throw new Error('give the thread a topic');
  if (!memberIds.length) throw new Error('add at least one team member to the thread');
  const id = `ch:${scope ? `${scope}-` : ''}${clean}`;
  if (getConversation(db, id)) throw new Error(`a thread called "${display}" already exists${projectId ? ' in this project' : ''}`);
  const now = Date.now();
  db.prepare(`INSERT INTO conversations (id, kind, project_id, name, created_at, last_at) VALUES (?, 'channel', ?, ?, ?, ?)`).run(id, projectId, display, now, now);
  const add = db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, role_id) VALUES (?, ?)');
  for (const m of memberIds) add.run(id, m);
  return getConversation(db, id)!;
}

export function listMessages(db: DB, conversationId: string, limit = 200): Message[] {
  const rows = db.prepare('SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(conversationId, limit);
  return rows.map(parseMeta);
}

export function addMessage(db: DB, conversationId: string, author: string, body: string, kind: MessageKind = 'text', meta: unknown = null): Message {
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO messages (conversation_id, author, kind, body, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(conversationId, author, kind, body, meta === null ? null : JSON.stringify(meta), now);
  db.prepare('UPDATE conversations SET last_at = ? WHERE id = ?').run(now, conversationId);
  return getMessage(db, Number(info.lastInsertRowid))!;
}

export function getMessage(db: DB, id: number): Message | undefined {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  return row ? parseMeta(row) : undefined;
}

export function updateMessageMeta(db: DB, id: number, meta: unknown): Message {
  db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
  return getMessage(db, id)!;
}

export function markRead(db: DB, conversationId: string): void {
  db.prepare('UPDATE conversations SET read_at = ? WHERE id = ?').run(Date.now(), conversationId);
}

// ── sessions: one Claude session per (role, conversation) ─────────

export function getSession(db: DB, roleId: string, conversationId: string): { session_id: string; seen_message_id: number; turns: number; context_tokens: number } | undefined {
  return db.prepare('SELECT session_id, seen_message_id, turns, context_tokens FROM agent_sessions WHERE role_id = ? AND conversation_id = ?').get(roleId, conversationId) as any;
}

/** One more turn in the session, and how big its context is now (tokens the latest call read). */
export function countTurn(db: DB, roleId: string, conversationId: string, contextTokens: number): void {
  db.prepare('UPDATE agent_sessions SET turns = turns + 1, context_tokens = ? WHERE role_id = ? AND conversation_id = ?').run(contextTokens, roleId, conversationId);
}

export function saveSession(db: DB, roleId: string, conversationId: string, sessionId: string, seen: number): void {
  db.prepare(
    `INSERT INTO agent_sessions (role_id, conversation_id, session_id, seen_message_id, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(role_id, conversation_id) DO UPDATE SET session_id = excluded.session_id, seen_message_id = excluded.seen_message_id, updated_at = excluded.updated_at,
       turns = CASE WHEN agent_sessions.session_id = excluded.session_id THEN agent_sessions.turns ELSE 0 END,
       context_tokens = CASE WHEN agent_sessions.session_id = excluded.session_id THEN agent_sessions.context_tokens ELSE 0 END`,
  ).run(roleId, conversationId, sessionId, seen, Date.now());
}

// ── approvals and standing permissions ───────────────────────────

export interface Approval {
  id: string;
  role_id: string;
  conversation_id: string | null;
  message_id: number | null;
  tool: string;
  input: any;
  status: 'pending' | 'allowed' | 'denied';
  note: string | null;
  created_at: number;
  decided_at: number | null;
}

export function standingTools(db: DB, roleId: string, policy: 'allow' | 'deny'): string[] {
  return (db.prepare('SELECT tool FROM standing_permissions WHERE role_id = ? AND policy = ?').all(roleId, policy) as { tool: string }[]).map((r) => r.tool);
}

export function setStanding(db: DB, roleId: string, tool: string, policy: 'allow' | 'deny' | null): void {
  if (policy === null) db.prepare('DELETE FROM standing_permissions WHERE role_id = ? AND tool = ?').run(roleId, tool);
  else
    db.prepare(
      `INSERT INTO standing_permissions (role_id, tool, policy, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(role_id, tool) DO UPDATE SET policy = excluded.policy`,
    ).run(roleId, tool, policy, Date.now());
}

export function listStanding(db: DB): { role_id: string; tool: string; policy: string; created_at: number }[] {
  return db.prepare('SELECT * FROM standing_permissions ORDER BY role_id, tool').all() as any[];
}

const parseApproval = (a: any): Approval => ({ ...a, input: a.input ? JSON.parse(a.input) : null });

export function createApproval(db: DB, roleId: string, conversationId: string | null, tool: string, input: unknown): Approval {
  const id = randomUUID().slice(0, 8);
  db.prepare('INSERT INTO approvals (id, role_id, conversation_id, tool, input, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, roleId, conversationId, tool, JSON.stringify(input ?? null), Date.now(),
  );
  return getApproval(db, id)!;
}

export function getApproval(db: DB, id: string): Approval | undefined {
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
  return row ? parseApproval(row) : undefined;
}

export function listPendingApprovals(db: DB): Approval[] {
  return (db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at`).all() as any[]).map(parseApproval);
}

export function decideApproval(db: DB, id: string, status: 'allowed' | 'denied', note: string | null): Approval {
  db.prepare(`UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'`).run(status, note, Date.now(), id);
  return getApproval(db, id)!;
}

export function linkApprovalMessage(db: DB, id: string, messageId: number): void {
  db.prepare('UPDATE approvals SET message_id = ? WHERE id = ?').run(messageId, id);
}

// ── decisions ─────────────────────────────────────────────────────

export function recordDecision(db: DB, d: { conversationId: string | null; projectId: string | null; roleId: string | null; title: string; why: string | null; followUps: string[] }) {
  const info = db
    .prepare('INSERT INTO brain_decisions (conversation_id, project_id, role_id, title, why, follow_ups, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(d.conversationId, d.projectId, d.roleId, d.title, d.why, JSON.stringify(d.followUps), Date.now());
  return Number(info.lastInsertRowid);
}

export function listDecisions(db: DB, projectId: string | null, limit = 50) {
  const rows = (
    projectId
      ? db.prepare('SELECT * FROM brain_decisions WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit)
      : db.prepare('SELECT * FROM brain_decisions ORDER BY id DESC LIMIT ?').all(limit)
  ) as any[];
  return rows.map((r) => ({ ...r, follow_ups: r.follow_ups ? JSON.parse(r.follow_ups) : [] }));
}
