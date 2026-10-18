// How a project's team works and learns (modelled on DACI staffing, Google
// blameless postmortems, Amazon COE, ADRs and PMI close-out):
// - project team: core members and scoped specialists, recommended when requirements are final
// - lessons: every review failure is classified; process causes go to project memory,
//   repeated agent-behaviour mistakes become (capped) learnings on that member
// - project memory: a compact digest injected into every agent working on the project
// - lifecycle status: active / paused / review (close-out) / closed
import { projectType, TYPES } from './plugins.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as board from '../core/board.js';
import type { DB } from '../core/db.js';
import { getBus } from './bus.js';
import { listDecisions } from './chat.js';
import { projectRef } from './pipeline.js';
import { addFromTemplate, getRole, listRoles, ROLE_TEMPLATES, saveRole } from './roles.js';
import { addMissingColumns, defineSchema } from './schema.js';
import { getSetting } from './settings.js';

export const MAX_LEARNINGS = 15;
export const LEARNING_THRESHOLD = 2; // a behaviour mistake must recur before it shapes the persona
export const CAUSES = ['requirements-gap', 'missing-check', 'convention', 'environment', 'agent-behavior'] as const;
export type Cause = (typeof CAUSES)[number];
/** Always on a project: quality and security by default. */
export const ALWAYS_RECOMMENDED = ['architect', 'pm', 'qc', 'security'];

defineSchema(
  `
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'core',   -- core | specialist
  reason     TEXT,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, role_id)
);
CREATE TABLE IF NOT EXISTS team_recommendations (
  project_id TEXT PRIMARY KEY,
  items      TEXT NOT NULL,                  -- JSON [{key, template?, name, skill?, kind, reason, persona?, required}]
  status     TEXT NOT NULL DEFAULT 'open',   -- open | done
  source     TEXT NOT NULL DEFAULT 'baseline', -- baseline | main
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS learnings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id    TEXT NOT NULL,
  rule       TEXT NOT NULL,                  -- imperative, under ~25 words
  count      INTEGER NOT NULL DEFAULT 1,
  evidence   TEXT,                           -- JSON [card ids]
  last_seen  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_lessons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  cause       TEXT NOT NULL,
  trigger     TEXT,                          -- what happened
  lesson      TEXT NOT NULL,                 -- what to do instead
  mechanism   TEXT,                          -- the check/test/convention added so it cannot recur
  source_card TEXT,
  count       INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'active', -- active | superseded
  superseded_by INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS enhancements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  title      TEXT NOT NULL,
  why        TEXT,
  status     TEXT NOT NULL DEFAULT 'proposed', -- proposed | accepted | dropped
  created_at INTEGER NOT NULL
);
`,
  (db) => {
    // lifecycle and check-in state on brain_projects (added after the table existed)
    addMissingColumns(db, 'brain_projects', {
      status: `TEXT NOT NULL DEFAULT 'active'`, // active | paused | review | closed
      closed_reason: 'TEXT',
      closed_at: 'INTEGER',
      checkin_tier: 'INTEGER NOT NULL DEFAULT 0',
      checkin_at: 'INTEGER',
      rag: 'TEXT',
      // auto mode: the project runs without the user's input after the requirements (auto.ts)
      auto_mode: 'INTEGER NOT NULL DEFAULT 0',
      auto_paused_until: 'INTEGER', // paused for usage until this time
      auto_nudged_at: 'INTEGER',
      auto_nudges: 'INTEGER NOT NULL DEFAULT 0',
    });
  },
);

/** Auto mode is on for this project. */
export const isAuto = (db: DB, projectId: string | null | undefined): boolean =>
  Boolean(projectId && (db.prepare('SELECT auto_mode FROM brain_projects WHERE project_id = ?').get(projectId) as { auto_mode: number } | undefined)?.auto_mode);

const now = () => Date.now();

// ── project team ─────────────────────────────────────────────────

export interface RecommendedMember {
  key: string; // template id, or slug of a custom name
  template?: string | null;
  name: string;
  skill?: string | null;
  kind: 'core' | 'specialist';
  reason: string;
  persona?: string | null;
  required?: boolean;
}

export function projectMembers(db: DB, projectId: string) {
  return db
    .prepare(
      `SELECT pm.role_id, pm.kind, pm.reason, pm.added_at, r.name, r.initials, r.tone, r.skill, r.scope
       FROM project_members pm JOIN roles r ON r.id = pm.role_id WHERE pm.project_id = ? ORDER BY pm.kind, pm.added_at`,
    )
    .all(projectId) as { role_id: string; kind: string; reason: string | null; name: string; initials: string; tone: string; skill: string | null; scope: string }[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** The always-on core for the project's type (software: Architect, PM, Quality control, Security Champion). */
export function baselineRecommendation(core: string[] = ALWAYS_RECOMMENDED): RecommendedMember[] {
  const reasons: Record<string, string> = {
    architect: 'Designs the system (C4 model) from the final requirements.',
    pm: 'Owns the work end to end: phases, cards, and who does and reviews each piece.',
    qc: 'Checks every card against its acceptance criteria before it is done.',
    security: 'Threat-models the design and reviews risky cards for vulnerabilities (OWASP ASVS).',
  };
  return core.map((id) => {
    const t = ROLE_TEMPLATES.find((x) => x.id === id)!;
    return { key: id, template: id, name: t.name, skill: t.skill, kind: 'core' as const, reason: reasons[id], required: true };
  });
}

export function getRecommendation(db: DB, projectId: string) {
  const row = db.prepare('SELECT * FROM team_recommendations WHERE project_id = ?').get(projectId) as { items: string; status: string; source: string; updated_at: number } | undefined;
  if (!row) return null;
  const members = new Set(projectMembers(db, projectId).map((m) => m.role_id));
  const items = (JSON.parse(row.items) as RecommendedMember[]).map((i) => ({ ...i, added: members.has(i.template ?? i.key) }));
  return { items, status: row.status, source: row.source, updated_at: row.updated_at };
}

/** Store a recommendation; the always-on core members are kept whatever the Main agent suggests. Max 8. */
export function setRecommendation(db: DB, projectId: string, items: Partial<RecommendedMember>[], source: 'baseline' | 'main'): void {
  const base = baselineRecommendation(TYPES[projectType(db, projectId)].core);
  const extra: RecommendedMember[] = [];
  for (const i of items) {
    const template = i.template && ROLE_TEMPLATES.some((t) => t.id === i.template) ? i.template : null;
    const name = template ? ROLE_TEMPLATES.find((t) => t.id === template)!.name : String(i.name ?? '').trim();
    if (!name) continue;
    const key = template ?? slug(name);
    if (base.some((b) => b.key === key)) {
      const b = base.find((x) => x.key === key)!;
      if (i.reason) b.reason = i.reason; // the Main agent's project-specific reason
      continue;
    }
    if (extra.some((e) => e.key === key)) continue;
    extra.push({ key, template, name, skill: template ? ROLE_TEMPLATES.find((t) => t.id === template)!.skill : i.skill ?? null, kind: i.kind === 'core' ? 'core' : 'specialist', reason: String(i.reason ?? ''), persona: i.persona ?? null });
  }
  const all = [...base, ...extra].slice(0, 8);
  db.prepare(
    `INSERT INTO team_recommendations (project_id, items, status, source, updated_at) VALUES (?, ?, 'open', ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET items = excluded.items, source = excluded.source, updated_at = excluded.updated_at`,
  ).run(projectId, JSON.stringify(all), source, now());
  getBus().emit({ type: 'team', project_id: projectId });
}

const DEV_PERSONA = (name: string, skill: string | null) =>
  `You are a member of the user's personal AI team inside AI Brain, working on one project as its ${name}.${skill ? ` Use the ${skill} skill for your work.` : ''} You build cards on the project board when the PM assigns them to you: follow each card's requirements and acceptance criteria exactly, work only in your card's git worktree, and keep changes small and tested. Everything you create stays inside the AI Brain workspace folder.`;

/** Add recommended members (by key) to the project: creates missing roles, joins the project, and puts builders on the board roster. */
export function addProjectMembers(db: DB, projectId: string, keys: string[]): string[] {
  const rec = getRecommendation(db, projectId);
  if (!rec) throw new Error('no recommendation for this project');
  const added: string[] = [];
  for (const key of keys) {
    const item = rec.items.find((i) => i.key === key);
    if (!item) continue;
    const role = item.template
      ? addFromTemplate(db, item.template)
      : getRole(db, item.key) ?? saveRole(db, { id: item.key, name: item.name, skill: item.skill ?? null, scope: 'project', model: 'sonnet', persona: item.persona || DEV_PERSONA(item.name, item.skill ?? null) });
    db.prepare(`INSERT OR IGNORE INTO project_members (project_id, role_id, kind, reason, added_at) VALUES (?, ?, ?, ?, ?)`).run(projectId, role.id, item.kind, item.reason, now());
    // specialists who build cards go on the board roster so the PM can assign them, with their skill
    if (item.kind === 'specialist' && !board.listTeam(db).some((t) => t.name === role.name)) board.createTeamMember(db, role.name, { skill: role.skill ?? undefined });
    added.push(role.id);
  }
  getBus().emit({ type: 'roles' });
  getBus().emit({ type: 'team', project_id: projectId });
  return added;
}

export function removeProjectMember(db: DB, projectId: string, roleId: string): void {
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND role_id = ?').run(projectId, roleId);
  getBus().emit({ type: 'team', project_id: projectId });
}

export const isProjectMember = (db: DB, projectId: string, roleId: string) =>
  Boolean(db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND role_id = ?').get(projectId, roleId));

// ── lessons: route each review failure by its cause ──────────────

// words that carry no meaning in a rule ("always check X carefully" ≈ "X")
const FILLER = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'are', 'that', 'this', 'from', 'into', 'before', 'after', 'always', 'never', 'every', 'each', 'all', 'any', 'make', 'sure', 'check', 'carefully', 'properly', 'correctly', 'when', 'then', 'use', 'using', 'should', 'must', 'not', 'don', 'does']);
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !FILLER.has(w)),
  );
/** Same rule in other words? Jaccard ≥ 0.6 on meaningful words; short rules must match exactly. */
export function similar(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  if (Math.min(x.size, y.size) < 3) return inter === x.size && inter === y.size;
  return inter / (x.size + y.size - inter) >= 0.6;
}

export interface LessonInput {
  projectId: string;
  cause: Cause;
  lesson: string; // what to do instead (imperative)
  trigger?: string;
  mechanism?: string;
  cardId?: string;
  member?: string | null; // the role id or board name that built the card
  supersedes?: number;
}

/**
 * Blameless routing: process causes (requirements gap, missing check,
 * convention, environment) go to project memory; agent-behaviour causes go to
 * project memory AND count towards a learning on that member, which becomes
 * active once it recurs. Learnings shared by several members become team rules.
 */
export function recordLesson(db: DB, l: LessonInput): { lesson: number; learning: { role: string; active: boolean } | null } {
  if (!CAUSES.includes(l.cause)) throw new Error(`cause must be one of ${CAUSES.join(', ')}`);
  const text = l.lesson.trim();
  if (!text) throw new Error('lesson required');
  if (l.supersedes) db.prepare(`UPDATE project_lessons SET status = 'superseded', updated_at = ? WHERE id = ? AND project_id = ?`).run(now(), l.supersedes, l.projectId);
  // merge with an active near-duplicate instead of piling up
  const active = db.prepare(`SELECT id, lesson FROM project_lessons WHERE project_id = ? AND status = 'active'`).all(l.projectId) as { id: number; lesson: string }[];
  const dup = active.find((a) => similar(a.lesson, text));
  let lessonId: number;
  if (dup) {
    db.prepare('UPDATE project_lessons SET count = count + 1, mechanism = COALESCE(?, mechanism), updated_at = ? WHERE id = ?').run(l.mechanism ?? null, now(), dup.id);
    lessonId = dup.id;
  } else {
    lessonId = Number(
      db
        .prepare('INSERT INTO project_lessons (project_id, cause, trigger, lesson, mechanism, source_card, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(l.projectId, l.cause, l.trigger ?? null, text, l.mechanism ?? null, l.cardId ?? null, now(), now()).lastInsertRowid,
    );
  }
  if (l.supersedes) db.prepare('UPDATE project_lessons SET superseded_by = ? WHERE id = ?').run(lessonId, l.supersedes);

  let learning: { role: string; active: boolean } | null = null;
  if (l.cause === 'agent-behavior' && l.member) {
    const role = resolveMember(db, l.member);
    if (role) learning = { role, active: addLearning(db, role, text, l.cardId ?? null) };
  }
  writeProjectMemory(db, l.projectId);
  getBus().emit({ type: 'memory', project_id: l.projectId });
  return { lesson: lessonId, learning };
}

/** A card's assigned agent may be a role id, a role name or a board roster name. */
function resolveMember(db: DB, member: string): string | null {
  const m = member.trim().toLowerCase();
  const role = listRoles(db).find((r) => r.id === m || r.name.toLowerCase() === m);
  return role?.id ?? null;
}

const score = (l: { count: number; last_seen: number }) => l.count * (1 / (1 + (now() - l.last_seen) / 86_400_000 / 14)); // halves after two weeks

/** Count a behaviour mistake against a member; keep at most MAX_LEARNINGS active, dropping the weakest. Returns whether it is now active. */
export function addLearning(db: DB, roleId: string, rule: string, cardId: string | null): boolean {
  const rows = db.prepare('SELECT * FROM learnings WHERE role_id = ?').all(roleId) as { id: number; rule: string; count: number; evidence: string; last_seen: number }[];
  const dup = rows.find((r) => similar(r.rule, rule));
  let id: number;
  if (dup) {
    const ev = [...new Set([...(JSON.parse(dup.evidence ?? '[]') as string[]), ...(cardId ? [cardId] : [])])].slice(-10);
    db.prepare('UPDATE learnings SET count = count + 1, evidence = ?, last_seen = ? WHERE id = ?').run(JSON.stringify(ev), now(), dup.id);
    id = dup.id;
  } else {
    id = Number(
      db.prepare('INSERT INTO learnings (role_id, rule, count, evidence, last_seen, created_at) VALUES (?, ?, 1, ?, ?, ?)').run(roleId, rule.trim().slice(0, 240), JSON.stringify(cardId ? [cardId] : []), now(), now()).lastInsertRowid,
    );
  }
  compactLearnings(db, roleId);
  promoteSharedLearnings(db);
  const row = db.prepare('SELECT count FROM learnings WHERE id = ?').get(id) as { count: number } | undefined;
  return (row?.count ?? 0) >= LEARNING_THRESHOLD;
}

/** Keep the active set (count ≥ threshold) within the cap, and candidates (count 1) to a short list. */
export function compactLearnings(db: DB, roleId: string): void {
  const rows = db.prepare('SELECT id, count, last_seen FROM learnings WHERE role_id = ?').all(roleId) as { id: number; count: number; last_seen: number }[];
  const active = rows.filter((r) => r.count >= LEARNING_THRESHOLD).sort((a, b) => score(b) - score(a));
  const candidates = rows.filter((r) => r.count < LEARNING_THRESHOLD).sort((a, b) => b.last_seen - a.last_seen);
  const drop = [...active.slice(MAX_LEARNINGS), ...candidates.slice(MAX_LEARNINGS)];
  for (const d of drop) db.prepare('DELETE FROM learnings WHERE id = ?').run(d.id);
}

export function activeLearnings(db: DB, roleId: string) {
  return (db.prepare('SELECT id, rule, count, last_seen FROM learnings WHERE role_id = ? AND count >= ?').all(roleId, LEARNING_THRESHOLD) as { id: number; rule: string; count: number; last_seen: number }[]).sort(
    (a, b) => score(b) - score(a),
  );
}

export function allLearnings(db: DB, roleId: string) {
  return db.prepare('SELECT id, rule, count, last_seen FROM learnings WHERE role_id = ? ORDER BY count DESC, last_seen DESC').all(roleId) as { id: number; rule: string; count: number; last_seen: number }[];
}

export function deleteLearning(db: DB, id: number): void {
  db.prepare('DELETE FROM learnings WHERE id = ?').run(id);
}

/** A rule two or more members had to learn is a team problem: make it a checklist item for everyone. */
function promoteSharedLearnings(db: DB): void {
  const rows = db.prepare('SELECT role_id, rule FROM learnings WHERE count >= ?').all(LEARNING_THRESHOLD) as { role_id: string; rule: string }[];
  const checklist = getSetting<string[]>(db, 'brain.team_checklist', []);
  let changed = false;
  for (const r of rows) {
    const others = rows.filter((o) => o.role_id !== r.role_id && similar(o.rule, r.rule));
    if (others.length && !checklist.some((c) => similar(c, r.rule))) {
      checklist.push(r.rule);
      changed = true;
    }
  }
  if (changed) db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('brain.team_checklist', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(JSON.stringify(checklist.slice(-15)), now());
}

export const teamChecklist = (db: DB) => getSetting<string[]>(db, 'brain.team_checklist', []);

// ── project memory: compact, injected everywhere ─────────────────

export function listLessons(db: DB, projectId: string) {
  return db.prepare('SELECT * FROM project_lessons WHERE project_id = ? ORDER BY status, count DESC, updated_at DESC').all(projectId) as any[];
}

const MEMORY_BUDGET = 6000; // characters ≈ 1.5k tokens

/** The digest every agent on the project reads: active lessons first, then recent decisions and team rules. */
export function memoryDigest(db: DB, projectId: string): string {
  const lessons = (db.prepare(`SELECT id, cause, lesson, mechanism, count FROM project_lessons WHERE project_id = ? AND status = 'active' ORDER BY count DESC, updated_at DESC`).all(projectId) as any[]);
  const decisions = listDecisions(db, projectId, 8);
  const checklist = teamChecklist(db);
  const lines: string[] = ['# Project memory', '', 'Read before working. Do not repeat these mistakes; follow these decisions.', ''];
  if (lessons.length) lines.push('## Lessons', ...lessons.map((l) => `- L${l.id} (${l.cause}${l.count > 1 ? `, ×${l.count}` : ''}): ${l.lesson}${l.mechanism ? ` — check: ${l.mechanism}` : ''}`), '');
  if (decisions.length) lines.push('## Decisions', ...decisions.map((d) => `- ${d.title}${d.why ? `: ${d.why}` : ''}`), '');
  if (checklist.length) lines.push('## Team checklist', ...checklist.map((c) => `- ${c}`), '');
  let out = lines.join('\n');
  if (out.length > MEMORY_BUDGET) out = out.slice(0, MEMORY_BUDGET).replace(/\n[^\n]*$/, '') + '\n- …older items omitted; see vault memory/lessons.md';
  return out;
}

/** Write the digest into the project (imported by its CLAUDE.md, so builders and reviewers read it too) and the full register into the vault. */
export function writeProjectMemory(db: DB, projectId: string): void {
  let ref;
  try {
    ref = projectRef(db, projectId);
  } catch {
    return;
  }
  const digest = memoryDigest(db, projectId);
  mkdirSync(join(ref.root, '.ai-brain'), { recursive: true });
  writeFileSync(join(ref.root, '.ai-brain', 'memory.md'), digest + '\n');
  const claude = join(ref.root, 'CLAUDE.md');
  const marker = '<!-- ai-brain:memory -->';
  if (existsSync(claude)) {
    const text = readFileSync(claude, 'utf8');
    if (!text.includes(marker)) writeFileSync(claude, `${marker}\n@.ai-brain/memory.md\n\n${text}`);
  }
  const all = listLessons(db, projectId);
  mkdirSync(join(ref.vault, 'memory'), { recursive: true });
  writeFileSync(
    join(ref.vault, 'memory', 'lessons.md'),
    [
      `# ${ref.name} — Lessons register`,
      '',
      'Blameless: each lesson names the cause and the mechanism added so it cannot recur. Superseded lessons are kept for history.',
      '',
      '| ID | Status | Cause | Lesson | Mechanism | Seen | Card |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...all.map((l) => `| L${l.id} | ${l.status}${l.superseded_by ? ` → L${l.superseded_by}` : ''} | ${l.cause} | ${l.lesson.replace(/\|/g, '/')} | ${(l.mechanism ?? '').replace(/\|/g, '/')} | ${l.count} | ${l.source_card ?? ''} |`),
      '',
    ].join('\n'),
  );
}

// ── enhancements and lifecycle ───────────────────────────────────

export function addEnhancements(db: DB, projectId: string, items: { title: string; why?: string }[]): void {
  const st = db.prepare('INSERT INTO enhancements (project_id, title, why, created_at) VALUES (?, ?, ?, ?)');
  for (const i of items) if (i.title?.trim()) st.run(projectId, i.title.trim(), i.why ?? null, now());
  getBus().emit({ type: 'brain_project', project_id: projectId });
}

export function listEnhancements(db: DB, projectId: string) {
  return db.prepare('SELECT * FROM enhancements WHERE project_id = ? ORDER BY id').all(projectId) as any[];
}

export function setEnhancementStatus(db: DB, id: number, status: 'proposed' | 'accepted' | 'dropped'): void {
  db.prepare('UPDATE enhancements SET status = ? WHERE id = ?').run(status, id);
}

export type ProjectStatus = 'active' | 'paused' | 'review' | 'closed';

export function projectStatus(db: DB, projectId: string): { status: ProjectStatus; closed_reason: string | null; checkin_tier: number; checkin_at: number | null; rag: string | null } {
  const row = db.prepare('SELECT status, closed_reason, checkin_tier, checkin_at, rag FROM brain_projects WHERE project_id = ?').get(projectId) as any;
  return row ?? { status: 'active', closed_reason: null, checkin_tier: 0, checkin_at: null, rag: null };
}

export function setProjectStatus(db: DB, projectId: string, status: ProjectStatus, reason: string | null = null): void {
  db.prepare(
    `INSERT INTO brain_projects (project_id, stage, created_at, updated_at, status, closed_reason, closed_at) VALUES (?, 'build', ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET status = excluded.status, closed_reason = excluded.closed_reason, closed_at = excluded.closed_at, updated_at = excluded.updated_at,
       checkin_tier = 0, checkin_at = NULL`,
  ).run(projectId, now(), now(), status, reason, status === 'closed' ? now() : null);
  getBus().emit({ type: 'brain_project', project_id: projectId });
}
