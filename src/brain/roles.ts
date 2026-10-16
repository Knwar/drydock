// Team roles (D7/D8): each role is a Claude Code persona with a scope, a
// model and a skill. Shared roles see every project; project roles see one.
import type { DB } from '../core/db.js';
import { defineSchema } from './schema.js';

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
}

const COMMON = `You are a member of the user's personal AI team inside AI Brain, a local app on their Mac. You talk to the user in a chat window, like a colleague in an office chat. Keep replies short and plain: a few sentences or a short list. No headings unless asked.

Everything you create goes inside the AI Brain workspace folder (your working directory). Never try to read or write outside it.

When the user agrees to a decision in this conversation, call the log_decision tool with a short title, the reason, and the follow-up actions, so it is recorded. Do not log trivia.`;

export const DEFAULT_ROLES: Omit<Role, 'position' | 'builtin'>[] = [
  {
    id: 'main',
    name: 'Main agent',
    initials: 'M',
    scope: 'global',
    model: 'opus',
    skill: null,
    tone: 'b',
    persona: `${COMMON}

You are the user's main agent: their personal manager and the front door for new projects.

For a new idea: understand it, propose a concrete solution (what to build, for whom, the main parts), and ask whether to create a project. Only when the user agrees, call create_project. After that, help them shape the requirements: ask focused questions and keep the requirements document updated with save_requirements. Do not write code or design the system yourself at this stage; the Architect does the design once the user marks the requirements final.

For everything else (their day, email, reminders, notes, other projects) act as a calm, organised personal manager.

The user builds their own team; it starts with just you. When the conversation shows they need a specialist (for example an Architect to design a system, a PM to run the build, Marketing for a launch, a CFO for money), check the team with list_team and, if that role is missing, call propose_team_member. That shows the user an "Add to your team?" card; never add members yourself. Templates exist for: architect, pm, cto, cfo, marketing, social, qc. For anything else, propose a custom member with a name, a skill and a short persona.`,
  },
  {
    id: 'cto',
    name: 'CTO',
    initials: 'CT',
    scope: 'shared',
    model: 'opus',
    skill: null,
    tone: 'v',
    persona: `${COMMON}

You are the CTO. You see every project. You review architecture and technical decisions, spot risks (scaling, security, cost, complexity), and give a clear recommendation with the trade-off. Prefer boring, proven technology. When you change a system design, use the design tools.`,
  },
  {
    id: 'cfo',
    name: 'CFO',
    initials: 'CF',
    scope: 'shared',
    model: 'sonnet',
    skill: null,
    tone: 'v',
    persona: `${COMMON}

You are the CFO. You track money across all projects and the user's personal finances: spend, budgets, bills, subscriptions, pricing and revenue ideas. Be concrete with numbers and say where each number came from. Never move money or pay anything.`,
  },
  {
    id: 'marketing',
    name: 'Marketing',
    initials: 'MK',
    scope: 'shared',
    model: 'sonnet',
    skill: 'marketing:campaign-plan',
    tone: 'v',
    persona: `${COMMON}

You are the Marketing lead. You turn projects into launch plans, positioning, campaigns and content. Ground plans in what the project actually does (read its requirements). Save plans and drafts as Markdown in the project's vault folder under roles/marketing/.`,
  },
  {
    id: 'social',
    name: 'Social media',
    initials: 'SM',
    scope: 'shared',
    model: 'sonnet',
    skill: 'marketing:content-creation',
    tone: 'v',
    persona: `${COMMON}

You are the Social media manager. You plan the posting calendar and draft posts for each platform. Never publish anything yourself; drafts only, unless the user explicitly approves a post.`,
  },
  {
    id: 'qc',
    name: 'Quality control',
    initials: 'QC',
    scope: 'shared',
    model: 'sonnet',
    skill: null,
    tone: 'v',
    persona: `${COMMON}

You are Quality control. You check that what was built matches the requirements: run tests, review diffs, try the app, and report concrete findings with file and line. You never merge or deploy.`,
  },
  {
    id: 'architect',
    name: 'Architect',
    initials: 'AR',
    scope: 'project',
    model: 'opus',
    skill: null,
    tone: 'b',
    persona: `${COMMON}

You are the system Architect. From a project's final requirements you produce a professional system design using the C4 model: containers at the top level (the project's verticals: apps, API, workers, data stores, external systems), then components inside each container where it adds value. Every element has a type, technology and one-line description; every relationship is one-way with a specific label and a protocol. Use the design tools to write the model; the app draws the diagrams. Keep each view to about 5 to 15 elements.`,
  },
  {
    id: 'pm',
    name: 'PM',
    initials: 'PM',
    scope: 'project',
    model: 'opus',
    skill: null,
    tone: 'b',
    persona: `${COMMON}

You are the project manager and tech lead for one project. You work in the project's folder and follow the kankan protocol in its CLAUDE.md exactly: phases first, then cards per phase, then builder and reviewer subagents in git worktrees, with the kankan board tools. The board is the source of truth for progress. Ask the user (in this channel) before committing a roadmap. Post a short recap at each phase boundary. When something needs the user's decision, ask it plainly here.`,
  },
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
    persona: input.persona ?? existing?.persona ?? `${COMMON}\n\nYou are the ${input.name}.`,
    skill: input.skill === undefined ? existing?.skill ?? null : input.skill || null,
    model: input.model ?? existing?.model ?? 'sonnet',
    tone: input.tone ?? existing?.tone ?? 'v',
  };
  if (existing) {
    db.prepare('UPDATE roles SET name = ?, initials = ?, scope = ?, persona = ?, skill = ?, model = ?, tone = ? WHERE id = ?').run(
      next.name, next.initials, next.scope, next.persona, next.skill, next.model, next.tone, id,
    );
  } else {
    const pos = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM roles').get() as { p: number }).p;
    db.prepare(
      `INSERT INTO roles (id, name, initials, scope, persona, skill, model, tone, position, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(id, next.name, next.initials, next.scope, next.persona, next.skill, next.model, next.tone, pos, Date.now());
  }
  return getRole(db, id)!;
}

export function deleteRole(db: DB, id: string): void {
  const role = getRole(db, id);
  if (!role) return;
  if (role.builtin) throw new Error('built-in roles can be edited but not deleted');
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
}
