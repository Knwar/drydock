// Feature ideas: a new idea for a project that already exists, shaped inside
// it. The project's PM leads (the Architect assesses the impact); the system
// design and brand are inherited, so a feature idea has its own board, a
// change document ("Changes") and only the screens it adds or changes.
//
// It ends one of three ways: Add to project (the user's approval: it joins the
// project's requirements and the PM places it on the roadmap), Park, or Make
// it its own idea (it moves to the Idea board, led by the Main agent).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../core/db.js';
import { getBus } from './bus.js';
import { addMessage, getConversation } from './chat.js';
import { captureIdea, featuresMarkdown, getIdea, listFeatures, listScreens, type Idea } from './ideas.js';
import { appendRequirements, listRequirements, projectRef } from './pipeline.js';
import { projectType } from './plugins.js';
import { respond } from './runner.js';
import { isAuto } from './teamwork.js';

const say = (db: DB, conv: string, author: string, body: string) => {
  const m = addMessage(db, conv, author, body);
  getBus().emit({ type: 'chat', conversation: conv, message: m });
  return m;
};

/** A new feature idea for a project: its type and brand come from the project. */
export function captureFeatureIdea(db: DB, projectId: string, input: { title: string; pitch?: string; source?: string | null }): Idea {
  projectRef(db, projectId); // throws for an unknown project
  const brand = (db.prepare('SELECT brand_id FROM brain_projects WHERE project_id = ?').get(projectId) as { brand_id: string | null } | undefined)?.brand_id ?? null;
  return captureIdea(db, { ...input, type: projectType(db, projectId) ?? 'software', parent: { projectId, brandId: brand } });
}

/** Where the project's work goes on now: its build thread with the PM, else its design thread with the Architect. */
function leadThread(db: DB, projectId: string): { channel: string; lead: string } | null {
  const slug = projectRef(db, projectId).slug;
  for (const [suffix, lead] of [['build', '@PM'], ['design', '@Architect']] as const) {
    if (getConversation(db, `ch:${slug}-${suffix}`)) return { channel: `ch:${slug}-${suffix}`, lead };
  }
  return null;
}

/** "# Title" goes, and every heading moves one level down, so the change sits under one "## Feature:" heading. */
const nest = (md: string) =>
  md
    .replace(/^# .*\n+/, '')
    .replace(/^(#{1,5}) /gm, '#$1 ')
    .trim();

/**
 * The user approved it: its changes join the project's requirements (a new
 * version), its spec goes into the repo (docs/features/<slug>.md), its screens
 * show on the project's UI tab, and the project's lead places it on the
 * roadmap (straight away in auto mode; otherwise it proposes and waits).
 */
export function addToProject(db: DB, ideaId: string): { thread: string | null; version: number } {
  const idea = getIdea(db, ideaId);
  if (!idea?.parent_project_id) throw new Error('not a feature idea');
  if (idea.status === 'added') throw new Error('this feature is already added to its project');
  const changes = listRequirements(db, ideaId)[0]?.markdown ?? '';
  const features = listFeatures(db, ideaId);
  if (!changes.trim() && !features.length) throw new Error('Nothing to add yet: shape it first (the PM writes its changes and stories in the chat).');
  const project = projectRef(db, idea.parent_project_id);
  const screens = listScreens(db, ideaId);
  const date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
  const doc = `docs/features/${idea.slug}.md`;
  const req = appendRequirements(
    db,
    project.id,
    [`## Feature: ${idea.title}`, '', `_Added on ${date} from a feature idea. Stories and acceptance criteria: ${doc}._`, '', changes.trim() ? nest(changes) : (idea.pitch || ''), ''].join('\n'),
    'pm',
  );
  // the spec builders work from, next to the rest of the project's docs
  const spec = [`# Feature: ${idea.title}`, '', idea.pitch ? `${idea.pitch}\n` : '', changes.trim() ? `## Changes\n\n${nest(changes)}\n` : '', features.length ? nest(featuresMarkdown(idea.title, features)) : '', screens.length ? `\n## Screens\n\nNew or changed screens (on the project's UI tab): ${screens.map((s) => s.title).join(', ')}.\n` : ''].join('\n');
  for (const dir of [join(project.root, 'docs', 'features'), join(project.vault, 'requirements', 'features')]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${idea.slug}.md`), spec);
  }
  db.prepare(`UPDATE ideas SET status = 'added', updated_at = ? WHERE id = ?`).run(Date.now(), ideaId);

  const at = leadThread(db, project.id);
  if (at) {
    const auto = isAuto(db, project.id);
    say(
      db,
      at.channel,
      'user',
      `${at.lead} A feature idea was approved and added to the project: **${idea.title}**. Its spec is in ${doc} (stories and acceptance criteria), and its changes are in the requirements as version ${req.version}. Place it on the roadmap: cards in the current phase if it fits there, otherwise a new phase after the right one, with its stories as the acceptance criteria. ${auto ? 'Auto mode is on: go ahead and plan it in.' : 'Propose where it goes and wait for my approval before creating cards.'}`,
    );
    respond(at.channel, at.lead);
  }
  if (idea.conversation_id) say(db, idea.conversation_id, 'system', `Added to ${project.name} (requirements v${req.version}, ${doc}).${at ? ` It is on its way to the roadmap in #${at.channel.replace(/^ch:/, '')}.` : ''} This chat stays as its history.`);
  getBus().emit({ type: 'idea', idea_id: ideaId });
  getBus().emit({ type: 'brain_project', project_id: project.id });
  return { thread: at?.channel ?? null, version: req.version };
}

/** It turned out to be a product of its own: it moves to the Idea board and the Main agent takes it over. */
export function makeOwnIdea(db: DB, ideaId: string): Idea {
  const idea = getIdea(db, ideaId);
  if (!idea?.parent_project_id) throw new Error('not a feature idea');
  if (idea.status === 'added') throw new Error('this feature is already added to its project');
  const from = projectRef(db, idea.parent_project_id).name;
  db.transaction(() => {
    db.prepare(`UPDATE ideas SET parent_project_id = NULL, status = CASE WHEN status = 'parked' THEN 'parked' ELSE 'shaping' END, updated_at = ? WHERE id = ?`).run(Date.now(), ideaId);
    if (idea.conversation_id) {
      db.prepare('UPDATE conversations SET project_id = NULL WHERE id = ?').run(idea.conversation_id);
      db.prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(idea.conversation_id);
      db.prepare(`INSERT INTO conversation_members (conversation_id, role_id) VALUES (?, 'main')`).run(idea.conversation_id);
    }
  })();
  if (idea.conversation_id) say(db, idea.conversation_id, 'system', `Moved out of ${from} to the Idea board as an idea of its own. The Main agent leads it from here; what was shaped so far stays.`);
  getBus().emit({ type: 'idea', idea_id: ideaId });
  getBus().emit({ type: 'conversations' });
  return getIdea(db, ideaId)!;
}
