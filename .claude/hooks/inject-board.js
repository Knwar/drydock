// SessionStart: print a compact board summary into context.
import { api, readStdin, resolveProject } from './lib.js';

const data = await readStdin();
const cwd = data.cwd ?? process.cwd();
const project = await resolveProject(cwd);
if (!project) process.exit(0); // daemon down or no project here — stay silent

const board = (await api('GET', `/board?project=${project.id}`)) ?? [];
const lanes = ['backlog', 'queued', 'in_progress', 'in_review', 'done'];
const counts = lanes.map((l) => `${l}:${board.filter((c) => c.lane === l).length}`).join(' ');

console.log(`[board] project_id=${project.id} (${project.name})`);
console.log(`[board] ${counts}`);
const inFlight = board.filter((c) => c.lane === 'in_progress' || c.lane === 'in_review');
for (const c of inFlight) {
  console.log(`[board]   ${c.id} "${c.title}" ${c.lane}${c.agent ? ` (${c.agent})` : ''}`);
}

// Workspace role: a vertical is scoped to its folder; a workspace lists its verticals.
const view = await api('GET', `/workspace?project=${project.id}`);
if (view?.workspace) {
  const self = [view.workspace, ...(view.verticals ?? [])].find((p) => p.id === project.id);
  if (self?.parent_id) {
    const ws = view.workspace;
    console.log(
      `[board] vertical "${self.name}" of workspace "${ws.name}" (workspace_id=${ws.id}) — scope: ${self.root_path}. Work ONLY this board's cards; cross-cutting work belongs to the workspace board.`,
    );
  } else if (view.verticals?.length) {
    console.log('[board] workspace verticals:');
    for (const v of view.verticals) console.log(`[board]   ${v.name} (${v.id}) — ${v.root_path}`);
  }
}
