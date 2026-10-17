// The project pipeline (lifecycle stages 2–6): create a project inside the
// workspace, keep versioned requirements, hold the C4 design model, and move
// through the gates that hand work to the next agent.
import { ROLE_TEMPLATES } from './roles.js';
import { projectType, TYPES, type ProjectType } from './plugins.js';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as board from '../core/board.js';
import type { DB } from '../core/db.js';
import { getBus } from './bus.js';
import { addMessage, createChannel, getConversation } from './chat.js';
import { setStage, type Stage } from './projects.js';
import { respond } from './runner.js';
import { defineSchema } from './schema.js';
import { getRecommendation, setProjectStatus, setRecommendation } from './teamwork.js';
import { currentWorkspace, isInside } from './workspace.js';

const execFileAsync = promisify(execFile);
const INIT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'init-project.sh');

defineSchema(`
CREATE TABLE IF NOT EXISTS requirements (
  project_id TEXT NOT NULL,
  version    INTEGER NOT NULL,
  markdown   TEXT NOT NULL,
  author     TEXT,
  final      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, version)
);
CREATE TABLE IF NOT EXISTS design_elements (
  project_id       TEXT NOT NULL,
  id               TEXT NOT NULL,
  parent_id        TEXT,
  kind             TEXT NOT NULL,     -- person|container|component|store|queue|external
  name             TEXT NOT NULL,
  technology       TEXT,
  description      TEXT,
  responsibilities TEXT,
  interfaces       TEXT,
  risks            TEXT,
  status           TEXT NOT NULL DEFAULT 'planned',
  position         INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS design_relations (
  project_id  TEXT NOT NULL,
  id          TEXT NOT NULL,
  source      TEXT NOT NULL,
  target      TEXT NOT NULL,
  label       TEXT NOT NULL,
  technology  TEXT,
  interaction TEXT NOT NULL DEFAULT 'sync',  -- sync|async
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS design_snapshots (
  project_id TEXT NOT NULL,
  version    INTEGER NOT NULL,
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, version)
);
`);

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

export interface ProjectRef {
  id: string;
  name: string;
  root: string;
  slug: string;
  vault: string;
}

export function projectRef(db: DB, projectId: string): ProjectRef {
  const p = db.prepare('SELECT id, name, root_path FROM projects WHERE id = ?').get(projectId) as { id: string; name: string; root_path: string } | undefined;
  if (!p) throw new Error(`unknown project ${projectId}`);
  const ws = currentWorkspace();
  const slug = basename(p.root_path);
  return { id: p.id, name: p.name, root: p.root_path, slug, vault: ws ? join(ws.vault, 'projects', slug) : join(p.root_path, 'docs') };
}

/** Stage 2: folder under projects/, git + kit, vault folder, requirements v1. */
export async function createProject(db: DB, name: string, description: string, type: ProjectType = 'software'): Promise<ProjectRef> {
  const ws = currentWorkspace();
  if (!ws) throw new Error('set up a workspace first');
  const clean = name.trim();
  const slug = slugify(clean);
  if (!slug) throw new Error('project needs a name');
  const root = join(ws.projects, slug);
  if (existsSync(root)) throw new Error(`a project folder named ${slug} already exists`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), `# ${clean}\n\n${description.trim()}\n`);
  await execFileAsync('sh', [INIT, root, clean], { env: { ...process.env, DAEMON_URL: getBus().daemonUrl }, timeout: 120_000 });
  const project = board.getOrCreateProject(db, root, clean);
  setStage(db, project.id, 'requirements', description.trim());
  db.prepare('UPDATE brain_projects SET type = ? WHERE project_id = ?').run(type, project.id);
  const ref = projectRef(db, project.id);
  for (const d of ['requirements', 'design', 'roles', 'notes']) mkdirSync(join(ref.vault, d), { recursive: true });
  saveRequirements(
    db,
    project.id,
    `# ${clean} — Requirements\n\n## Goal\n\n${description.trim()}\n\n## Users\n\n_To discuss._\n\n## Features\n\n_To discuss._\n\n## Non-functional\n\n_To discuss._\n\n## Out of scope\n\n_To discuss._\n`,
    'main',
  );
  getBus().emit({ type: 'brain_project', project_id: project.id });
  return ref;
}

// ── requirements ─────────────────────────────────────────────────

export interface RequirementsVersion {
  version: number;
  markdown: string;
  author: string | null;
  final: number;
  created_at: number;
}

export function listRequirements(db: DB, projectId: string): RequirementsVersion[] {
  return db.prepare('SELECT version, markdown, author, final, created_at FROM requirements WHERE project_id = ? ORDER BY version DESC').all(projectId) as RequirementsVersion[];
}

export function saveRequirements(db: DB, projectId: string, markdown: string, author: string | null): RequirementsVersion {
  const latest = listRequirements(db, projectId)[0];
  if (latest && latest.markdown === markdown) return latest;
  if (latest?.final) throw new Error('requirements are final; reopen them first');
  const version = (latest?.version ?? 0) + 1;
  db.prepare('INSERT INTO requirements (project_id, version, markdown, author, created_at) VALUES (?, ?, ?, ?, ?)').run(projectId, version, markdown, author, Date.now());
  const ref = projectRef(db, projectId);
  mkdirSync(join(ref.vault, 'requirements'), { recursive: true });
  writeFileSync(join(ref.vault, 'requirements', `v${version}.md`), markdown);
  writeFileSync(join(ref.vault, 'requirements', 'current.md'), markdown);
  getBus().emit({ type: 'requirements', project_id: projectId });
  return listRequirements(db, projectId)[0];
}

// ── design model (C4) ────────────────────────────────────────────

export const ELEMENT_KINDS = ['person', 'container', 'component', 'store', 'queue', 'external'] as const;

export interface DesignElement {
  id: string;
  parent_id: string | null;
  kind: (typeof ELEMENT_KINDS)[number];
  name: string;
  technology: string | null;
  description: string | null;
  responsibilities: string | null;
  interfaces: string | null;
  risks: string | null;
  status: string;
  position: number;
}

export interface DesignRelation {
  id: string;
  source: string;
  target: string;
  label: string;
  technology: string | null;
  interaction: 'sync' | 'async';
}

export function getDesign(db: DB, projectId: string) {
  const elements = db.prepare('SELECT id, parent_id, kind, name, technology, description, responsibilities, interfaces, risks, status, position FROM design_elements WHERE project_id = ? ORDER BY position, id').all(projectId) as DesignElement[];
  const relations = db.prepare('SELECT id, source, target, label, technology, interaction FROM design_relations WHERE project_id = ? ORDER BY id').all(projectId) as DesignRelation[];
  const snap = db.prepare('SELECT MAX(version) AS v FROM design_snapshots WHERE project_id = ?').get(projectId) as { v: number | null };
  return { elements, relations, finalVersion: snap.v };
}

export function upsertElement(db: DB, projectId: string, e: Partial<DesignElement> & { id: string; name: string; kind: string }): void {
  if (!ELEMENT_KINDS.includes(e.kind as any)) throw new Error(`kind must be one of ${ELEMENT_KINDS.join(', ')}`);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(e.id)) throw new Error('element id: lowercase letters, digits, . _ - (e.g. "api" or "api.auth")');
  if (e.parent_id) {
    const parent = db.prepare('SELECT kind FROM design_elements WHERE project_id = ? AND id = ?').get(projectId, e.parent_id) as { kind: string } | undefined;
    if (!parent) throw new Error(`unknown parent ${e.parent_id}`);
  }
  const pos = e.position ?? (db.prepare('SELECT COUNT(*) AS n FROM design_elements WHERE project_id = ?').get(projectId) as { n: number }).n;
  db.prepare(
    `INSERT INTO design_elements (project_id, id, parent_id, kind, name, technology, description, responsibilities, interfaces, risks, status, position, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, id) DO UPDATE SET parent_id = excluded.parent_id, kind = excluded.kind, name = excluded.name,
       technology = excluded.technology, description = excluded.description, responsibilities = excluded.responsibilities,
       interfaces = excluded.interfaces, risks = excluded.risks, status = excluded.status, updated_at = excluded.updated_at`,
  ).run(projectId, e.id, e.parent_id ?? null, e.kind, e.name, e.technology ?? null, e.description ?? null, e.responsibilities ?? null, e.interfaces ?? null, e.risks ?? null, e.status ?? 'planned', pos, Date.now());
}

export function upsertRelation(db: DB, projectId: string, r: Partial<DesignRelation> & { source: string; target: string; label: string }): string {
  const has = db.prepare('SELECT 1 FROM design_elements WHERE project_id = ? AND id = ?');
  for (const end of [r.source, r.target]) if (!has.get(projectId, end)) throw new Error(`unknown element ${end}`);
  if (!r.label.trim() || /^uses$/i.test(r.label.trim())) throw new Error('give the relation a specific label, e.g. "Reads/writes user records", not "Uses"');
  const id = r.id ?? `${r.source}->${r.target}`;
  db.prepare(
    `INSERT INTO design_relations (project_id, id, source, target, label, technology, interaction, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, id) DO UPDATE SET source = excluded.source, target = excluded.target, label = excluded.label,
       technology = excluded.technology, interaction = excluded.interaction, updated_at = excluded.updated_at`,
  ).run(projectId, id, r.source, r.target, r.label.trim(), r.technology ?? null, r.interaction === 'async' ? 'async' : 'sync', Date.now());
  return id;
}

export function removeDesignItem(db: DB, projectId: string, id: string): void {
  const kids = db.prepare('SELECT id FROM design_elements WHERE project_id = ? AND parent_id = ?').all(projectId, id) as { id: string }[];
  for (const k of kids) removeDesignItem(db, projectId, k.id);
  db.prepare('DELETE FROM design_relations WHERE project_id = ? AND (id = ? OR source = ? OR target = ?)').run(projectId, id, id, id);
  db.prepare('DELETE FROM design_elements WHERE project_id = ? AND id = ?').run(projectId, id);
}

/** A Markdown copy of the model in the vault, so the design is readable outside the app. */
function writeDesignDoc(db: DB, projectId: string): void {
  const ref = projectRef(db, projectId);
  const { elements, relations } = getDesign(db, projectId);
  const name = (id: string) => elements.find((e) => e.id === id)?.name ?? id;
  const top = elements.filter((e) => !e.parent_id);
  const lines = [`# ${ref.name} — System design (C4)`, '', '## Containers and external systems', ''];
  for (const e of top) {
    lines.push(`### ${e.name} [${e.kind}${e.technology ? `: ${e.technology}` : ''}]`, '', e.description ?? '', '');
    const kids = elements.filter((k) => k.parent_id === e.id);
    if (kids.length) lines.push(...kids.map((k) => `- **${k.name}** [${k.technology ?? k.kind}]: ${k.description ?? ''}`), '');
  }
  lines.push('## Relationships', '', ...relations.map((r) => `- ${name(r.source)} → ${name(r.target)}: ${r.label}${r.technology ? ` [${r.technology}]` : ''}${r.interaction === 'async' ? ' (async)' : ''}`), '');
  mkdirSync(join(ref.vault, 'design'), { recursive: true });
  writeFileSync(join(ref.vault, 'design', 'system-design.md'), lines.join('\n'));
  writeFileSync(join(ref.vault, 'design', 'model.json'), JSON.stringify({ elements, relations }, null, 2));
}

export function designChanged(db: DB, projectId: string): void {
  writeDesignDoc(db, projectId);
  getBus().emit({ type: 'design', project_id: projectId });
}

// ── gates ────────────────────────────────────────────────────────

/** A gate that hands work to a role the user has not added yet. */
export class NeedsRole extends Error {
  constructor(public role: string, label: string) {
    super(`This step needs ${label} on your team.`);
  }
}

function requireRole(db: DB, id: string, label: string): void {
  if (!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(id)) throw new NeedsRole(id, label);
}

/** Members for a stage channel: the required role plus any optional ones the user has. */
function present(db: DB, ids: string[]): string[] {
  return ids.filter((id) => db.prepare('SELECT 1 FROM roles WHERE id = ?').get(id));
}

/** The project's channel for a stage, created on first use with its members. */
function stageChannel(db: DB, ref: ProjectRef, suffix: string, memberIds: string[]): string {
  const id = `ch:${slugify(`${ref.slug}-${suffix}`)}`;
  if (!getConversation(db, id)) createChannel(db, suffix, memberIds, ref.id, ref.slug);
  getBus().emit({ type: 'conversations' });
  return id;
}

function kickoff(db: DB, conversationId: string, text: string, mention: string): void {
  const m = addMessage(db, conversationId, 'user', text);
  getBus().emit({ type: 'chat', conversation: conversationId, message: m });
  respond(conversationId, mention);
}

/**
 * Gate 3: requirements are final. Locks them and opens the team step: a
 * recommendation starting from the always-on core (Architect, PM, QC,
 * Security Champion) that the Main agent tailors to the requirements.
 * The design starts once the user has added the team (startDesign).
 */
export function finalizeRequirements(db: DB, projectId: string): { recommendation: true } {
  const ref = projectRef(db, projectId);
  const latest = listRequirements(db, projectId)[0];
  if (!latest) throw new Error('no requirements yet');
  db.prepare('UPDATE requirements SET final = 1 WHERE project_id = ? AND version = ?').run(projectId, latest.version);
  if (!getRecommendation(db, projectId)) setRecommendation(db, projectId, [], 'baseline');
  askMainForTeam(db, ref, latest.version);
  getBus().emit({ type: 'brain_project', project_id: projectId });
  return { recommendation: true };
}

/** Skill names under ~/.claude/skills (what a specialist can be given). */
function installedSkills(): string[] {
  const dir = join(homedir(), '.claude', 'skills');
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(dir, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .slice(0, 60);
  } catch {
    return [];
  }
}

/** The Main agent reads the requirements and calls recommend_team (in a quiet thread of its own). */
function askMainForTeam(db: DB, ref: ProjectRef, version: number): void {
  const conv = `sys:team:${ref.id}`;
  if (!getConversation(db, conv)) {
    db.prepare(`INSERT INTO conversations (id, kind, role_id, project_id, name, created_at, last_at) VALUES (?, 'dm', 'main', ?, ?, ?, 0)`).run(conv, ref.id, `Team for ${ref.name}`, Date.now());
    db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, role_id) VALUES (?, 'main')`).run(conv);
  }
  const skills = installedSkills();
  const type = TYPES[projectType(db, ref.id)];
  const core = type.core.map((id) => ROLE_TEMPLATES.find((t) => t.id === id)?.name ?? id).join(', ');
  const specialists = type.id === 'software' ? 'developer specialists with a matching skill, and templates (cto, cfo, marketing, social) only if the requirements call for them' : 'specialists for this kind of work (for example a writer, an editor, a researcher, a designer) with a matching skill if one is installed, and templates (marketing, social, cfo, cto) only if the brief calls for them';
  const m = addMessage(
    db,
    conv,
    'system',
    `The requirements for ${ref.name} (a ${type.name.toLowerCase()} project) are final (v${version}, project_id ${ref.id}). Read them with get_requirements, then call recommend_team once with the members this project needs beyond the always-on core (${core}): ${specialists}. At most four extra members, each with a one-line reason that refers to the requirements. You may also give the core members a project-specific reason.${skills.length ? `\nInstalled skills you can assign: ${skills.join(', ')}` : ''}`,
  );
  getBus().emit({ type: 'chat', conversation: conv, message: m });
  respond(conv, '', { model: 'sonnet' });
}

/** Gate 3 → 4 (after the team step): the Architect designs; the Security Champion threat-models; the CTO reviews. */
export function startDesign(db: DB, projectId: string): string {
  const ref = projectRef(db, projectId);
  const latest = listRequirements(db, projectId)[0];
  if (!latest?.final) throw new Error('mark the requirements final first');
  requireRole(db, 'architect', 'an Architect');
  for (const id of ['architect', 'security', 'cto']) if (db.prepare('SELECT 1 FROM roles WHERE id = ?').get(id)) db.prepare(`INSERT OR IGNORE INTO project_members (project_id, role_id, kind, added_at) VALUES (?, ?, 'core', ?)`).run(projectId, id, Date.now());
  db.prepare(`UPDATE team_recommendations SET status = 'done' WHERE project_id = ?`).run(projectId);
  setStage(db, projectId, 'design');
  const members = present(db, ['architect', 'security', 'cto']);
  const ch = stageChannel(db, ref, 'design', members);
  const security = members.includes('security');
  kickoff(
    db,
    ch,
    `@Architect the requirements for ${ref.name} are final (v${latest.version}, project_id ${ref.id}, saved at ${join(ref.vault, 'requirements', 'current.md')}). ` +
      (getDesign(db, projectId).elements.length
        ? `A design was already drawn from the existing code: check it against the requirements with get_design, fix what is missing or wrong, and mark what the requirements change. Then summarise it here in a few lines`
        : `Read them and create the system design with the design tools: containers first (the verticals), then the components inside the important ones. Then summarise the design here in a few lines`) +
      (security ? ` and ask @Security Champion for the STRIDE threat model` : '') +
      (members.includes('cto') ? `, and the CTO for review.` : '.'),
    '@Architect',
  );
  getBus().emit({ type: 'brain_project', project_id: projectId });
  return ch;
}

/** Gate 3 → 5 for projects without the System design plugin: the PM plans the work in phases. */
export function startPlanning(db: DB, projectId: string): string {
  const ref = projectRef(db, projectId);
  const latest = listRequirements(db, projectId)[0];
  if (!latest?.final) throw new Error('mark the requirements final first');
  requireRole(db, 'pm', 'a PM (project manager)');
  for (const id of ['pm', 'qc']) if (db.prepare('SELECT 1 FROM roles WHERE id = ?').get(id)) db.prepare(`INSERT OR IGNORE INTO project_members (project_id, role_id, kind, added_at) VALUES (?, ?, 'core', ?)`).run(projectId, id, Date.now());
  db.prepare(`UPDATE team_recommendations SET status = 'done' WHERE project_id = ?`).run(projectId);
  setStage(db, projectId, 'plan');
  const ch = stageChannel(db, ref, 'build', present(db, ['pm', 'qc']));
  kickoff(
    db,
    ch,
    `@PM the requirements for ${ref.name} are final (v${latest.version}, project_id ${ref.id}, saved at ${join(ref.vault, 'requirements', 'current.md')}). ` +
      `This is not a software project: the work is documents and other files in the project folder, and the checks are reviews against each card's acceptance criteria. ` +
      `Follow the project kickoff in CLAUDE.md: draft the phases with the manager subagent, then post them here for my approval. Do not create cards or start the work until I approve.`,
    '@PM',
  );
  getBus().emit({ type: 'brain_project', project_id: projectId });
  return ch;
}

export function reopenRequirements(db: DB, projectId: string): void {
  db.prepare('UPDATE requirements SET final = 0 WHERE project_id = ?').run(projectId);
  setStage(db, projectId, 'requirements');
  getBus().emit({ type: 'brain_project', project_id: projectId });
}

/** Gate 4 → 5: freeze the design, create one vertical per internal app container, and ask the PM for a roadmap. */
export async function finalizeDesign(db: DB, projectId: string): Promise<string> {
  const ref = projectRef(db, projectId);
  const design = getDesign(db, projectId);
  if (!design.elements.length) throw new Error('the design is empty');
  requireRole(db, 'pm', 'a PM (project manager)');
  const version = (design.finalVersion ?? 0) + 1;
  db.prepare('INSERT INTO design_snapshots (project_id, version, model, created_at) VALUES (?, ?, ?, ?)').run(projectId, version, JSON.stringify(design), Date.now());

  const existing = new Set((db.prepare('SELECT name FROM projects WHERE parent_id = ?').all(projectId) as { name: string }[]).map((r) => r.name));
  for (const c of design.elements.filter((e) => !e.parent_id && e.kind === 'container')) {
    if (existing.has(c.name)) continue;
    const folder = join(ref.root, slugify(c.name));
    if (!isInside(ref.root, folder)) continue;
    mkdirSync(folder, { recursive: true });
    if (!existsSync(join(folder, 'README.md'))) writeFileSync(join(folder, 'README.md'), `# ${c.name}\n\n${c.description ?? ''}\n\nTechnology: ${c.technology ?? 'tbd'}\n`);
    const res = await fetch(`${getBus().daemonUrl}/vertical`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: projectId, name: c.name, root: folder }),
    });
    if (!res.ok) throw new Error(`could not create vertical ${c.name}: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
  }
  setStage(db, projectId, 'plan');
  for (const id of ['pm', 'qc', 'security']) if (db.prepare('SELECT 1 FROM roles WHERE id = ?').get(id)) db.prepare(`INSERT OR IGNORE INTO project_members (project_id, role_id, kind, added_at) VALUES (?, ?, 'core', ?)`).run(projectId, id, Date.now());
  const ch = stageChannel(db, ref, 'build', present(db, ['pm', 'qc', 'security', 'cto']));
  kickoff(
    db,
    ch,
    `@PM the system design for ${ref.name} is final (v${version}); it is in ${join(ref.vault, 'design', 'system-design.md')} and the verticals are set up on the board. ` +
      `Follow the project kickoff in CLAUDE.md: draft the phases with the manager subagent, then post them here for my approval. Do not create cards or start building until I approve.`,
    '@PM',
  );
  getBus().emit({ type: 'brain_project', project_id: projectId });
  return ch;
}

/** Gate 5 → 6: the roadmap is approved; the PM runs the phase loop. */
export function startBuilding(db: DB, projectId: string): string {
  const ref = projectRef(db, projectId);
  requireRole(db, 'pm', 'a PM (project manager)');
  setStage(db, projectId, 'build');
  const ch = stageChannel(db, ref, 'build', present(db, ['pm', 'qc', 'security', 'cto']));
  kickoff(db, ch, `@PM the roadmap is approved. Commit the phases if you have not, advance to the first phase and run the phase loop from CLAUDE.md. Post a short recap here at each phase boundary.`, '@PM');
  getBus().emit({ type: 'brain_project', project_id: projectId });
  return ch;
}

export function setProjectStage(db: DB, projectId: string, stage: Stage): void {
  setStage(db, projectId, stage);
  getBus().emit({ type: 'brain_project', project_id: projectId });
}

// ── security artefact and close-out ──────────────────────────────

export function saveThreatModel(db: DB, projectId: string, markdown: string): string {
  const ref = projectRef(db, projectId);
  mkdirSync(join(ref.vault, 'design'), { recursive: true });
  const file = join(ref.vault, 'design', 'threat-model.md');
  writeFileSync(file, markdown);
  getBus().emit({ type: 'design', project_id: projectId });
  return file;
}

/** From the PM when advance_phase returns null: open the close-out with the Main agent. */
export function reportWorkComplete(db: DB, projectId: string, summary: string): string {
  const ref = projectRef(db, projectId);
  setProjectStatus(db, projectId, 'review');
  const ch = stageChannel(db, ref, 'close-out', present(db, ['main', 'qc', 'security', 'pm']));
  kickoff(
    db,
    ch,
    `@Main agent the PM reports that every phase of ${ref.name} (project_id ${ref.id}) is complete.\n\nPM's summary: ${summary}\n\n` +
      `Run the close-out: readiness check (QC: tests, build, open TODOs, acceptance criteria; Security Champion: brain security-scan and a final pass), a short blameless retrospective recorded with record_lesson, enhancements with save_enhancements, then ask the user to sign off.`,
    '@Main agent',
  );
  // and tell the user in their main chat
  const note = addMessage(db, 'dm:main', 'main', `**${ref.name}**: the PM reports every phase is complete. I'm running the close-out (readiness check, retrospective, enhancements) in #close-out under the project's Discussions, and will ask you to sign off.`);
  getBus().emit({ type: 'chat', conversation: 'dm:main', message: note });
  return ch;
}
