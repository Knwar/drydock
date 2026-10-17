// Team roles (D7/D8): each role is a Claude Code persona with a scope, a
// model and a skill. Shared roles see every project; project roles see one.
import type { DB } from '../core/db.js';
import { addMissingColumns, defineSchema } from './schema.js';

export type RoleScope = 'global' | 'shared' | 'project';

export interface Role {
  id: string;
  name: string;
  initials: string;
  scope: RoleScope;
  persona: string;
  skill: string | null;
  model: string;
  tone: string;
  position: number;
  builtin: number;
  /** reasoning effort for `claude --effort`; null = the role's default */
  effort: string | null;
  /** skill ids from the library (JSON list); null = the role's defaults */
  skills: string | null;
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Defaults: deep thinking where mistakes are expensive (design, security), light where it is routine. */
const DEFAULT_EFFORT: Record<string, string> = { architect: 'high', security: 'high', cto: 'high', pm: 'medium', qc: 'medium', main: 'medium', cfo: 'medium', marketing: 'low', social: 'low', writer: 'high', editor: 'medium', podcast: 'medium', researcher: 'high' };
export const effectiveEffort = (r: Pick<Role, 'id' | 'effort'>): string | null => r.effort ?? DEFAULT_EFFORT[r.id] ?? null;

/** The opening line of personas written before contracts existed (they held the whole workflow). */
const PRE_CONTRACT_OPENER = "You are a member of the user's personal AI team inside AI Brain";

// A persona is the user's part: character, focus and any extra rules. How the
// role works inside AI Brain is its contract (contracts.ts), which the user
// cannot edit; craft know-how comes from its skills (skills.ts).
export const DEFAULT_ROLES: Omit<Role, 'position' | 'builtin' | 'effort' | 'skills'>[] = [
  { id: 'main', name: 'Main agent', initials: 'M', scope: 'global', model: 'opus', skill: null, tone: 'b',
    persona: 'Calm, organised and direct. Think a step ahead for the user, keep them focused on what matters most today, and never bury them in detail.' },
  { id: 'cto', name: 'CTO', initials: 'CT', scope: 'shared', model: 'opus', skill: null, tone: 'v',
    persona: 'Pragmatic and sceptical of hype. Prefer boring, proven technology, and say plainly when something is over-engineered.' },
  { id: 'cfo', name: 'CFO', initials: 'CF', scope: 'shared', model: 'sonnet', skill: null, tone: 'v',
    persona: 'Careful and exact. Show your arithmetic, round conservatively, and flag anything that looks off.' },
  { id: 'marketing', name: 'Marketing', initials: 'MK', scope: 'shared', model: 'sonnet', skill: null, tone: 'v',
    persona: "Clear, specific and customer-led. Write in the customer's words, not marketing jargon." },
  { id: 'social', name: 'Social media', initials: 'SM', scope: 'shared', model: 'sonnet', skill: null, tone: 'v',
    persona: "Native to each platform: short hooks, one idea per post, in the user's own voice." },
  { id: 'qc', name: 'Quality control', initials: 'QC', scope: 'shared', model: 'sonnet', skill: null, tone: 'v',
    persona: 'Thorough and fair. Check every claim against evidence, and separate must-fix from nice-to-have.' },
  { id: 'architect', name: 'Architect', initials: 'AR', scope: 'project', model: 'opus', skill: null, tone: 'b',
    persona: 'Pragmatic. Choose the simplest design that meets the requirements, and explain trade-offs in plain words.' },
  { id: 'security', name: 'Security Champion', initials: 'SC', scope: 'shared', model: 'opus', skill: null, tone: 'r',
    persona: 'Practical, not alarmist. Rank risks by real impact and always give the fix.' },
  { id: 'pm', name: 'PM', initials: 'PM', scope: 'project', model: 'opus', skill: null, tone: 'b',
    persona: 'Decisive and organised. Small, well-specified pieces of work; keep the user informed without noise.' },
  { id: 'writer', name: 'Writer', initials: 'WR', scope: 'project', model: 'opus', skill: null, tone: 'g',
    persona: 'A versatile, disciplined writer. Serve the brief and the reader; plan before drafting and keep a consistent voice.' },
  { id: 'editor', name: 'Editor', initials: 'ED', scope: 'project', model: 'sonnet', skill: null, tone: 'g',
    persona: "A sharp but kind editor. Cut what doesn't serve the reader, and protect the author's voice." },
  { id: 'podcast', name: 'Podcast producer', initials: 'PP', scope: 'project', model: 'sonnet', skill: null, tone: 'g',
    persona: 'Story-led and well prepared. Every episode has one clear idea, a strong open, and moments worth sharing.' },
  { id: 'researcher', name: 'Researcher', initials: 'RS', scope: 'shared', model: 'sonnet', skill: null, tone: 'v',
    persona: 'Rigorous and neutral. Separate what is known from what is claimed, and say how sure you are.' },
];

defineSchema(
  `
CREATE TABLE IF NOT EXISTS roles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  initials   TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'shared',
  persona    TEXT NOT NULL,
  skill      TEXT,
  model      TEXT NOT NULL DEFAULT 'sonnet',
  tone       TEXT NOT NULL DEFAULT 'v',
  position   INTEGER NOT NULL DEFAULT 0,
  builtin    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`,
  (db) => {
    addMissingColumns(db, 'roles', { effort: 'TEXT', skills: 'TEXT', persona_before_contracts: 'TEXT' });
    // personas copied from older templates named the board after the engine
    db.prepare(`UPDATE roles SET persona = replace(persona, 'kankan', 'kanban') WHERE persona LIKE '%kankan%'`).run();
    // Personas from before contracts held the whole workflow, now in the contract:
    // template roles get the new short persona; the old text is kept alongside.
    const upgrade = db.prepare('UPDATE roles SET persona_before_contracts = persona, persona = ? WHERE id = ? AND persona LIKE ? AND persona_before_contracts IS NULL');
    for (const r of DEFAULT_ROLES) upgrade.run(r.persona, r.id, `${PRE_CONTRACT_OPENER}%`);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO roles (id, name, initials, scope, persona, skill, model, tone, position, builtin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    // a clean slate: only the Main agent; everyone else is added by the user (from a template or custom)
    const main = DEFAULT_ROLES.find((r) => r.id === 'main')!;
    insert.run(main.id, main.name, main.initials, main.scope, main.persona, main.skill, main.model, main.tone, 0, Date.now());
  },
);

/** What each template does, in a line for the user (the persona is written for the agent). */
const BLURBS: Record<string, string> = {
  cto: 'Reviews architecture and technical decisions across all projects, and flags risks.',
  cfo: 'Tracks money across projects and your personal finances: spend, budgets, bills.',
  marketing: 'Turns projects into launch plans, positioning, campaigns and content.',
  social: 'Plans your posting calendar and drafts posts. Never publishes without you.',
  qc: 'Checks what was built against the requirements: tests, diffs, findings.',
  architect: 'Designs each project as a C4 system model once requirements are final.',
  pm: "Runs a project's build on the board: phases, cards, builders and reviewers.",
  security: 'Threat-models each design, reviews risky cards, and runs security scans (OWASP).',
  writer: 'Plans and drafts books, stories, articles and scripts, keeping them consistent.',
  editor: 'Edits drafts for structure, clarity and voice, and catches AI-sounding prose.',
  podcast: 'Plans episodes, researches guests, and writes outlines, scripts and show notes.',
  researcher: 'Answers questions with cited briefs: every claim traced to a source.',
};

/** Ready-made roles the user can add to their team. */
export const ROLE_TEMPLATES = DEFAULT_ROLES.filter((r) => r.id !== 'main').map((r) => ({ ...r, blurb: BLURBS[r.id] ?? '' }));

export function addFromTemplate(db: DB, templateId: string): Role {
  const t = ROLE_TEMPLATES.find((r) => r.id === templateId);
  if (!t) throw new Error(`unknown template ${templateId}`);
  const { blurb: _blurb, ...role } = t;
  return getRole(db, t.id) ?? saveRole(db, role);
}

export function listRoles(db: DB): Role[] {
  return db.prepare('SELECT * FROM roles ORDER BY position, created_at').all() as Role[];
}

export function getRole(db: DB, id: string): Role | undefined {
  return db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as Role | undefined;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export function saveRole(db: DB, input: Partial<Role> & { name: string }): Role {
  const id = input.id ?? slug(input.name);
  if (!id) throw new Error('role needs a name');
  const existing = getRole(db, id);
  const next = {
    name: input.name.trim(),
    initials: (input.initials ?? input.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2)).toUpperCase(),
    scope: (['global', 'shared', 'project'].includes(input.scope ?? '') ? input.scope : existing?.scope ?? 'shared') as RoleScope,
    persona: input.persona ?? existing?.persona ?? '',
    skill: input.skill === undefined ? existing?.skill ?? null : input.skill || null,
    model: input.model ?? existing?.model ?? 'sonnet',
    tone: input.tone ?? existing?.tone ?? 'v',
    effort: input.effort === undefined ? existing?.effort ?? null : (EFFORTS as readonly string[]).includes(input.effort ?? '') ? input.effort : null,
    skills: input.skills === undefined ? existing?.skills ?? null : input.skills,
  };
  if (existing) {
    db.prepare('UPDATE roles SET name = ?, initials = ?, scope = ?, persona = ?, skill = ?, model = ?, tone = ?, effort = ?, skills = ? WHERE id = ?').run(
      next.name, next.initials, next.scope, next.persona, next.skill, next.model, next.tone, next.effort, next.skills, id,
    );
  } else {
    const pos = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM roles').get() as { p: number }).p;
    db.prepare(
      `INSERT INTO roles (id, name, initials, scope, persona, skill, model, tone, effort, skills, position, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(id, next.name, next.initials, next.scope, next.persona, next.skill, next.model, next.tone, next.effort, next.skills, pos, Date.now());
  }
  return getRole(db, id)!;
}

/**
 * Remove a member from the team: out of every channel, with their sessions,
 * standing permissions and integration access cleared. Chat history stays;
 * if they are added again they start with a fresh memory.
 */
export function deleteRole(db: DB, id: string): void {
  const role = getRole(db, id);
  if (!role) return;
  if (role.id === 'main') throw new Error('the Main agent cannot be removed');
  db.transaction(() => {
    db.prepare(`DELETE FROM conversation_members WHERE role_id = ? AND conversation_id NOT LIKE 'dm:%'`).run(id);
    db.prepare('DELETE FROM agent_sessions WHERE role_id = ?').run(id);
    db.prepare('DELETE FROM standing_permissions WHERE role_id = ?').run(id);
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'role_servers'`).get()) db.prepare('DELETE FROM role_servers WHERE role_id = ?').run(id);
    db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  })();
}
