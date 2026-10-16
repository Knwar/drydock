// Project types and plugins. The core (overview, requirements, board, team,
// memory, docs, threads) is the same for every project; anything that only
// fits some kinds of work is a plugin: a sidebar page under the project, an
// optional overview card, and the agent tools that go with it. Each project
// type turns some plugins on by default; the user can switch any plugin on
// or off per project. Plugins are first-party only (part of this app).
import type { DB } from '../core/db.js';
import type { Stage } from './projects.js';

export interface PluginManifest {
  id: string;
  name: string;
  /** an icon name the web app knows */
  icon: string;
  description: string;
  /** project types it is meant for (any project may still turn it on) */
  types: ProjectType[];
  /** shows a card on the project overview */
  overviewCard?: boolean;
  /** brain MCP tools that exist only while the plugin is on */
  tools: string[];
}

export const PLUGINS: PluginManifest[] = [
  {
    id: 'design',
    name: 'System design',
    icon: 'diagram',
    description: 'A C4 architecture model drawn as diagrams, written by the Architect, with a design stage before planning.',
    types: ['software'],
    tools: ['get_design', 'set_element', 'set_relation', 'remove_design_item', 'save_threat_model'],
  },
  {
    id: 'live',
    name: 'On this Mac',
    icon: 'agent',
    description: 'Runs the project on this Mac at <project>.localhost with its own databases, restarting after each merge.',
    types: ['software'],
    overviewCard: true,
    tools: ['save_run_recipe', 'list_local_services', 'live_status', 'live_logs', 'live_restart', 'live_check'],
  },
];

export type ProjectType = 'software' | 'general';

export interface TypeSpec {
  id: ProjectType;
  name: string;
  description: string;
  stages: Stage[];
  plugins: string[];
  /** the always-recommended team */
  core: string[];
}

export const TYPES: Record<ProjectType, TypeSpec> = {
  software: {
    id: 'software',
    name: 'Software',
    description: 'Apps, websites, APIs, tools: requirements, a system design, then a phased build with code review.',
    stages: ['idea', 'create', 'requirements', 'design', 'plan', 'build'],
    plugins: ['design', 'live'],
    core: ['architect', 'pm', 'qc', 'security'],
  },
  general: {
    id: 'general',
    name: 'General',
    description: 'Anything else (writing, content, research, planning, events): a brief, a plan in phases, then the work, each piece reviewed.',
    stages: ['idea', 'create', 'requirements', 'plan', 'build'],
    plugins: [],
    core: ['pm', 'qc'],
  },
};

export const isType = (t: unknown): t is ProjectType => typeof t === 'string' && t in TYPES;
export const pluginById = (id: string) => PLUGINS.find((p) => p.id === id);

export function projectType(db: DB, projectId: string): ProjectType {
  const t = (db.prepare('SELECT type FROM brain_projects WHERE project_id = ?').get(projectId) as { type: string | null } | undefined)?.type;
  return isType(t) ? t : 'software';
}

/** The plugins switched on for a project: its own choice, else its type's defaults. */
export function projectPlugins(db: DB, projectId: string): string[] {
  const raw = (db.prepare('SELECT plugins FROM brain_projects WHERE project_id = ?').get(projectId) as { plugins: string | null } | undefined)?.plugins;
  const list = raw ? (JSON.parse(raw) as string[]) : TYPES[projectType(db, projectId)].plugins;
  return list.filter((id) => pluginById(id));
}

export function setPlugin(db: DB, projectId: string, id: string, on: boolean): string[] {
  if (!pluginById(id)) throw new Error(`no plugin ${id}`);
  const cur = new Set(projectPlugins(db, projectId));
  if (on) cur.add(id);
  else cur.delete(id);
  const list = PLUGINS.map((p) => p.id).filter((x) => cur.has(x));
  db.prepare('UPDATE brain_projects SET plugins = ? WHERE project_id = ?').run(JSON.stringify(list), projectId);
  return list;
}

/** Tools to hide from agents in a project: those of plugins it has off. Outside projects every tool is there. */
export function disabledTools(db: DB, projectId: string | null): string[] {
  if (!projectId) return [];
  const on = new Set(projectPlugins(db, projectId));
  return PLUGINS.filter((p) => !on.has(p.id)).flatMap((p) => p.tools);
}
