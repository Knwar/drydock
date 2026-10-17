// The skill library: craft know-how for each role (how to write a spec,
// model threats, plan a story...). Most are adapted from public skill repos;
// each records its source, commit, license and what was changed, and keeps
// the original files for a diff. The app ships the library in skills/; each
// workspace gets its own copy in .ai-brain/skills/, which is what the user
// edits and what agents load. Unedited copies follow app updates; edited
// ones are kept and show that a newer original exists.
//
// Agents get only their role's skills, as a Claude Code plugin made per run
// (skills appear as ai-brain:<id> and load on demand).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectType } from './plugins.js';
import type { Role } from './roles.js';

export const LIBRARY_DIR = process.env.BRAIN_SKILLS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
/** The plugin name agents see: skills are ai-brain:<id>. */
export const PLUGIN = 'ai-brain';

export interface SkillSource {
  repo: string;
  path: string;
  commit: string;
  license: string;
  url: string;
}

export interface SkillMeta {
  id: string;
  title: string;
  summary: string;
  roles: string[];
  types: (ProjectType | 'any')[];
  source: SkillSource | null;
  basedOn: SkillSource[];
  changes: string[];
}

/** Top-level entries that are bookkeeping, not what the agent reads. */
const NOT_CONTENT = new Set(['upstream', 'skill.json', '.base']);

/** Files that make up a skill's content (what the agent reads and the user edits). */
const contentFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (d === dir && NOT_CONTENT.has(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
};

const hashDir = (dir: string): string => {
  const h = createHash('sha256');
  for (const f of contentFiles(dir)) h.update(f).update('\0').update(readFileSync(join(dir, f))).update('\0');
  return h.digest('hex').slice(0, 16);
};

let cache: SkillMeta[] | null = null;
export function library(): SkillMeta[] {
  if (cache) return cache;
  if (!existsSync(LIBRARY_DIR)) return (cache = []);
  cache = readdirSync(LIBRARY_DIR)
    .filter((id) => existsSync(join(LIBRARY_DIR, id, 'skill.json')) && existsSync(join(LIBRARY_DIR, id, 'SKILL.md')))
    .map((id) => {
      const m = JSON.parse(readFileSync(join(LIBRARY_DIR, id, 'skill.json'), 'utf8')) as Partial<SkillMeta>;
      return { id, title: m.title ?? id, summary: m.summary ?? '', roles: m.roles ?? [], types: m.types ?? ['any'], source: m.source ?? null, basedOn: m.basedOn ?? [], changes: m.changes ?? [] };
    });
  return cache;
}
export const skillById = (id: string) => library().find((s) => s.id === id);

const wsDir = (dataDir: string, id: string) => join(dataDir, 'skills', id);
const BASE = '.base'; // hash of the library version the workspace copy came from

function copyIn(dataDir: string, id: string): void {
  const dst = wsDir(dataDir, id);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  const src = join(LIBRARY_DIR, id);
  for (const f of contentFiles(src)) {
    mkdirSync(dirname(join(dst, f)), { recursive: true });
    cpSync(join(src, f), join(dst, f));
  }
  writeFileSync(join(dst, BASE), hashDir(src));
}

/** Bring the workspace copies up to date: add new skills, update ones the user has not edited. */
export function syncSkills(dataDir: string): void {
  for (const s of library()) {
    const dst = wsDir(dataDir, s.id);
    if (!existsSync(join(dst, 'SKILL.md')) || !existsSync(join(dst, BASE))) {
      copyIn(dataDir, s.id);
      continue;
    }
    const base = readFileSync(join(dst, BASE), 'utf8').trim();
    if (hashDir(dst) === base && hashDir(join(LIBRARY_DIR, s.id)) !== base) copyIn(dataDir, s.id);
  }
}

export interface SkillState extends SkillMeta {
  /** the user changed the workspace copy */
  edited: boolean;
  /** the app has a newer original than the one the edited copy started from */
  updateAvailable: boolean;
  description: string;
}

export function skillState(dataDir: string, id: string): SkillState | null {
  const meta = skillById(id);
  if (!meta) return null;
  const dst = wsDir(dataDir, id);
  if (!existsSync(join(dst, 'SKILL.md'))) copyIn(dataDir, id);
  const base = existsSync(join(dst, BASE)) ? readFileSync(join(dst, BASE), 'utf8').trim() : '';
  const edited = hashDir(dst) !== base;
  return { ...meta, edited, updateAvailable: edited && hashDir(join(LIBRARY_DIR, id)) !== base, description: frontmatter(readFileSync(join(dst, 'SKILL.md'), 'utf8')).description ?? '' };
}

export function listSkills(dataDir: string): SkillState[] {
  syncSkills(dataDir);
  return library().map((s) => skillState(dataDir, s.id)!);
}

export function frontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return {};
  const get = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1])?.[1].trim().replace(/^["']|["']$/g, '');
  return { name: get('name'), description: get('description') };
}

/** The skill's three versions: the upstream original, the app's adaptation, and the user's copy. */
export function skillTexts(dataDir: string, id: string): { upstream: string | null; original: string; current: string } {
  if (!skillById(id)) throw new Error(`no skill ${id}`);
  skillState(dataDir, id);
  const up = join(LIBRARY_DIR, id, 'upstream', 'SKILL.md');
  return {
    upstream: existsSync(up) ? readFileSync(up, 'utf8') : null,
    original: readFileSync(join(LIBRARY_DIR, id, 'SKILL.md'), 'utf8'),
    current: readFileSync(join(wsDir(dataDir, id), 'SKILL.md'), 'utf8'),
  };
}

/** Save the user's edit. The frontmatter must still name the skill and say when to use it, or agents can't find it. */
export function saveSkill(dataDir: string, id: string, text: string): SkillState {
  if (!skillById(id)) throw new Error(`no skill ${id}`);
  const fm = frontmatter(text);
  if (fm.name !== id) throw new Error(`the skill must start with a header (between --- lines) with "name: ${id}"`);
  if (!fm.description) throw new Error('the header needs a "description:" line saying when to use the skill');
  skillState(dataDir, id);
  writeFileSync(join(wsDir(dataDir, id), 'SKILL.md'), text.endsWith('\n') ? text : `${text}\n`);
  return skillState(dataDir, id)!;
}

export function resetSkill(dataDir: string, id: string): SkillState {
  if (!skillById(id)) throw new Error(`no skill ${id}`);
  copyIn(dataDir, id);
  return skillState(dataDir, id)!;
}

// ── which skills an agent gets ──

export const defaultSkills = (roleId: string): string[] => library().filter((s) => s.roles.includes(roleId)).map((s) => s.id);

/** The role's chosen skills (its own list, else the library's defaults for it). */
export function roleSkills(role: Pick<Role, 'id' | 'skills'>): string[] {
  const list = role.skills ? (JSON.parse(role.skills) as string[]) : defaultSkills(role.id);
  return list.filter((id) => skillById(id));
}

const fits = (id: string, type: ProjectType | null) => {
  const t = skillById(id)?.types ?? [];
  return !type || t.includes('any') || t.includes(type);
};

/** Skills for one run: the role's, filtered to the project's type (all of them outside projects). */
export const runSkills = (role: Pick<Role, 'id' | 'skills'>, type: ProjectType | null) => roleSkills(role).filter((id) => fits(id, type));

/** Skills the PM hands to its builder and reviewer subagents. */
export const subagentSkills = (kind: 'builder' | 'reviewer', type: ProjectType | null) => defaultSkills(kind).filter((id) => fits(id, type));

/**
 * A plugin folder holding exactly these skills (links to the workspace
 * copies), for `claude --plugin-dir`. Folders are keyed by the set, so runs
 * with the same skills share one.
 */
export function pluginDir(dataDir: string, ids: string[]): string | null {
  const list = [...new Set(ids)].filter((id) => skillById(id)).sort();
  if (!list.length) return null;
  syncSkills(dataDir);
  const dir = join(dataDir, 'runs', 'skills', createHash('sha256').update(list.join(',')).digest('hex').slice(0, 12));
  if (!existsSync(join(dir, '.claude-plugin', 'plugin.json'))) {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(dir, 'skills'), { recursive: true });
    for (const id of list) symlinkSync(wsDir(dataDir, id), join(dir, 'skills', id), 'dir');
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN, version: '1.0.0', description: 'AI Brain skills for this role' }));
  }
  return dir;
}

/** Forget the parsed library (tests swap BRAIN_SKILLS_DIR contents). */
export const resetLibraryCache = () => {
  cache = null;
};
