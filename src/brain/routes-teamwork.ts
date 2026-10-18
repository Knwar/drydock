// /api routes for project teams, memory and learnings, close-out, project
// status, check-ins and delegation.
import { stopApp } from './live.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addMessage, createChannel, getConversation, listMessages, members as convMembers } from './chat.js';
import { checkinSettings, lastActivity, runCheckins } from './checkins.js';
import { enterBuild, finalizeDesign, projectRef, reportWorkComplete, saveThreatModel, slugify, startAfterTeam, NeedsRole } from './pipeline.js';
import { autoProgress, autoResume, autoState, runAuto, setAuto } from './auto.js';
import { getRole, listRoles } from './roles.js';
import { HttpError, on } from './router.js';
import { activeRuns, respond } from './runner.js';
import { putSetting } from './settings.js';
import {
  activeLearnings,
  addEnhancements,
  addProjectMembers,
  allLearnings,
  CAUSES,
  deleteLearning,
  getRecommendation,
  listEnhancements,
  listLessons,
  memoryDigest,
  projectMembers,
  projectStatus,
  recordLesson,
  removeProjectMember,
  setEnhancementStatus,
  isAuto,
  setProjectStatus,
  setRecommendation,
  teamChecklist,
  writeProjectMemory,
} from './teamwork.js';

const project = (db: any, id: string) => {
  try {
    return projectRef(db, id);
  } catch {
    throw new HttpError(404, 'unknown project');
  }
};

// ── team ──

on('GET', '/api/projects/:id/team', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  project(db, p.id);
  ctx.json(res, 200, { members: projectMembers(db, p.id), recommendation: getRecommendation(db, p.id) });
});

/** From the Main agent: its tailored recommendation (the always-on core is kept). */
on('POST', '/api/projects/:id/team/recommendation', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  project(db, p.id);
  const b = await ctx.readBody(req);
  setRecommendation(db, p.id, Array.isArray(b?.members) ? b.members : [], 'main');
  ctx.json(res, 200, getRecommendation(db, p.id));
});

on('POST', '/api/projects/:id/team', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  project(db, p.id);
  const b = await ctx.readBody(req);
  const keys: string[] = Array.isArray(b?.keys) ? b.keys.map(String) : [];
  if (!keys.length) throw new HttpError(400, 'keys required');
  try {
    ctx.json(res, 200, { added: addProjectMembers(db, p.id, keys), team: projectMembers(db, p.id) });
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
});

on('DELETE', '/api/projects/:id/team/:role', (_q, res, _u, ctx, p) => {
  project(ctx.db(), p.id);
  removeProjectMember(ctx.db(), p.id, p.role);
  ctx.json(res, 200, { ok: true });
});

/** After the team step: the design stage when the project has System design, else straight to planning. */
on('POST', '/api/projects/:id/design/start', async (_q, res, _u, ctx, p) => {
  project(ctx.db(), p.id);
  try {
    ctx.json(res, 200, await startAfterTeam(ctx.db(), p.id));
  } catch (err) {
    if (err instanceof NeedsRole) throw new HttpError(409, err.message, { needs_role: err.role });
    throw new HttpError(400, (err as Error).message);
  }
});

// ── memory, lessons and learnings ──

on('GET', '/api/projects/:id/memory', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  const ref = project(db, p.id);
  const threat = join(ref.vault, 'design', 'threat-model.md');
  ctx.json(res, 200, {
    lessons: listLessons(db, p.id),
    digest: memoryDigest(db, p.id),
    checklist: teamChecklist(db),
    enhancements: listEnhancements(db, p.id),
    learnings: projectMembers(db, p.id).map((m) => ({ role_id: m.role_id, name: m.name, items: activeLearnings(db, m.role_id) })),
    threatModel: existsSync(threat) ? readFileSync(threat, 'utf8') : null,
  });
});

/** From the PM after a review fails (or the Main agent in a retrospective). */
on('POST', '/api/projects/:id/lessons', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  project(db, p.id);
  const b = await ctx.readBody(req);
  if (!CAUSES.includes(b?.cause)) throw new HttpError(400, `cause must be one of ${CAUSES.join(', ')}`);
  try {
    const r = recordLesson(db, { projectId: p.id, cause: b.cause, lesson: String(b.lesson ?? ''), trigger: b.trigger, mechanism: b.mechanism, cardId: b.card_id, member: b.member ?? null, supersedes: b.supersedes ? Number(b.supersedes) : undefined });
    ctx.json(res, 200, r);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
});

on('GET', '/api/roles/:id/learnings', (_q, res, _u, ctx, p) => {
  if (!getRole(ctx.db(), p.id)) throw new HttpError(404, 'unknown role');
  ctx.json(res, 200, { active: activeLearnings(ctx.db(), p.id), all: allLearnings(ctx.db(), p.id) });
});

on('DELETE', '/api/learnings/:id', (_q, res, _u, ctx, p) => {
  deleteLearning(ctx.db(), Number(p.id));
  ctx.broadcast({ type: 'memory' });
  ctx.json(res, 200, { ok: true });
});

/** For the PM: what a member (role id, role name or board roster name) has learned, to pass to builders. */
on('GET', '/api/learnings', (_q, res, url, ctx) => {
  const db = ctx.db();
  const who = (url.searchParams.get('member') ?? '').toLowerCase();
  const role = listRoles(db).find((r) => r.id === who || r.name.toLowerCase() === who);
  ctx.json(res, 200, { member: role?.name ?? who, rules: role ? activeLearnings(db, role.id).map((l) => l.rule) : [], checklist: teamChecklist(db) });
});

on('POST', '/api/projects/:id/threat-model', async (req, res, _u, ctx, p) => {
  project(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  if (!b?.markdown?.trim()) throw new HttpError(400, 'markdown required');
  ctx.json(res, 200, { file: saveThreatModel(ctx.db(), p.id, b.markdown) });
});

// ── close-out and status ──

on('POST', '/api/projects/:id/complete', async (req, res, _u, ctx, p) => {
  project(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  ctx.json(res, 200, { channel: reportWorkComplete(ctx.db(), p.id, String(b?.summary ?? 'All phases are done.')) });
});

on('POST', '/api/projects/:id/enhancements', async (req, res, _u, ctx, p) => {
  project(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  addEnhancements(ctx.db(), p.id, Array.isArray(b?.items) ? b.items : []);
  ctx.json(res, 200, listEnhancements(ctx.db(), p.id));
});

on('POST', '/api/enhancements/:id', async (req, res, _u, ctx, p) => {
  const b = await ctx.readBody(req);
  if (!['proposed', 'accepted', 'dropped'].includes(b?.status)) throw new HttpError(400, 'status must be proposed, accepted or dropped');
  setEnhancementStatus(ctx.db(), Number(p.id), b.status);
  ctx.broadcast({ type: 'brain_project' });
  ctx.json(res, 200, { ok: true });
});

/** User actions (confirmed in the UI): pause, resume, or sign off and close. */
on('POST', '/api/projects/:id/status', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  project(db, p.id);
  const b = await ctx.readBody(req);
  const status = b?.status;
  if (!['active', 'paused', 'closed'].includes(status)) throw new HttpError(400, 'status must be active, paused or closed');
  const reason = status === 'closed' ? (['completed', 'cancelled'].includes(b?.reason) ? b.reason : 'completed') : null;
  const was = projectStatus(db, p.id).status;
  setProjectStatus(db, p.id, status, reason);
  if (status === 'active' && was === 'paused') autoResume(db, p.id); // an auto project picks up where it left off
  if (status === 'closed') writeProjectMemory(db, p.id);
  if (status !== 'active') await stopApp(db, p.id); // a paused or closed project stops running on this Mac
  ctx.json(res, 200, projectStatus(db, p.id));
});

// ── auto mode (auto.ts) ──

const stageOf = (db: any, id: string) => (db.prepare('SELECT stage FROM brain_projects WHERE project_id = ?').get(id) as { stage: string } | undefined)?.stage ?? '';

/** The user's switch (confirmed in the UI). */
on('POST', '/api/projects/:id/auto', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  project(db, p.id);
  const b = await ctx.readBody(req);
  setAuto(db, p.id, Boolean(b?.on));
  ctx.json(res, 200, autoState(db, p.id));
});

/** From the Architect in auto mode: the design is complete and reviewed; finalise it and start the planning. */
on('POST', '/api/projects/:id/design/done', async (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  project(db, p.id);
  const stage = stageOf(db, p.id);
  if (!isAuto(db, p.id)) throw new HttpError(409, 'auto mode is off: tell the user the design is ready; they finalise it with the Finalise design button');
  if (stage !== 'design') throw new HttpError(409, `the project is at the ${stage} stage, not design`);
  try {
    const channel = await finalizeDesign(db, p.id);
    autoProgress(db, p.id);
    ctx.json(res, 200, { channel, stage: 'plan' });
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
});

/** From the PM in auto mode: it committed the phases; building starts without the user's approval. */
on('POST', '/api/projects/:id/auto/build', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  project(db, p.id);
  const stage = stageOf(db, p.id);
  if (!isAuto(db, p.id)) throw new HttpError(409, 'auto mode is off: post the phases for the user to approve');
  if (stage === 'build') return ctx.json(res, 200, { stage: 'build' });
  if (stage !== 'plan') throw new HttpError(409, `the project is at the ${stage} stage, not plan`);
  try {
    enterBuild(db, p.id);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  autoProgress(db, p.id);
  ctx.json(res, 200, { stage: 'build' });
});

on('POST', '/api/projects/:id/rag', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  project(db, p.id);
  const b = await ctx.readBody(req);
  const rag = ['green', 'amber', 'red'].includes(b?.rag) ? b.rag : null;
  db.prepare('UPDATE brain_projects SET rag = ?, updated_at = ? WHERE project_id = ?').run(rag, Date.now(), p.id);
  ctx.broadcast({ type: 'brain_project', project_id: p.id });
  ctx.json(res, 200, { rag });
});

on('GET', '/api/projects/:id/activity', (_q, res, _u, ctx, p) => {
  project(ctx.db(), p.id);
  ctx.json(res, 200, { last_activity: lastActivity(ctx.db(), p.id), ...projectStatus(ctx.db(), p.id) });
});

on('GET', '/api/settings/checkins', (_q, res, _u, ctx) => ctx.json(res, 200, checkinSettings(ctx.db())));
on('POST', '/api/settings/checkins', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  const n = (v: unknown, d: number) => (Number(v) > 0 ? Math.min(720, Number(v)) : d); // hours; fractions allowed
  const cur = checkinSettings(ctx.db());
  const next = { pm: n(b?.pm, cur.pm), members: n(b?.members, cur.members), user: n(b?.user, cur.user) };
  if (!(next.pm < next.members && next.members < next.user) || next.pm < 0.0001) throw new HttpError(400, 'each step must be later than the one before (PM < members < you)');
  putSetting(ctx.db(), 'brain.checkins', next);
  ctx.json(res, 200, next);
});

// ── delegation: the Main agent hands work to members ──

on('POST', '/api/delegate', async (req, res, _u, ctx) => {
  const db = ctx.db();
  const b = await ctx.readBody(req);
  const ids: string[] = (Array.isArray(b?.members) ? b.members : []).map((m: string) => {
    const role = listRoles(db).find((r) => r.id === String(m).toLowerCase() || r.name.toLowerCase() === String(m).toLowerCase());
    if (!role) throw new HttpError(400, `${m} is not on the team; propose them first with propose_team_member`);
    return role.id;
  });
  if (!ids.length) throw new HttpError(400, 'members required');
  const text = String(b?.message ?? '').trim();
  if (!text) throw new HttpError(400, 'message required');
  let conv: string;
  if (b?.conversation && getConversation(db, b.conversation)) conv = b.conversation;
  else {
    const ref = b?.project_id ? project(db, b.project_id) : null;
    const topic = String(b?.topic ?? 'tasks').trim() || 'tasks';
    const id = `ch:${ref ? `${ref.slug}-` : ''}${slugify(topic)}`;
    conv = getConversation(db, id) ? id : createChannel(db, topic, ids, ref?.id ?? null, ref?.slug ?? null).id;
    const add = db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, role_id) VALUES (?, ?)');
    for (const r of ids) add.run(conv, r);
  }
  const names = ids.map((r) => `@${getRole(db, r)!.name}`).join(' ');
  const m = addMessage(db, conv, String(b?.from ?? 'main'), `${names} ${text}`);
  ctx.broadcast({ type: 'conversations' });
  ctx.broadcast({ type: 'chat', conversation: conv, message: m });
  respond(conv, m.body);
  ctx.json(res, 200, { conversation: conv });
});

/** For the Main agent: recent messages and status of a thread. */
on('GET', '/api/threads/:id', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  const c = getConversation(db, p.id);
  if (!c) throw new HttpError(404, 'unknown thread');
  const msgs = listMessages(db, p.id, 30).filter((m) => m.kind !== 'tool').map((m) => ({ author: m.author, kind: m.kind, body: m.body.slice(0, 600), at: m.created_at }));
  ctx.json(res, 200, { id: c.id, name: c.name, project_id: c.project_id, members: convMembers(db, p.id), working: activeRuns().find((r) => r.conversation === p.id)?.role ?? null, messages: msgs });
});

/** Run one check-in pass now (Settings "Check now"; also used by tests). */
on('POST', '/api/checkins/run', (_q, res, _u, ctx) => ctx.json(res, 200, { done: runCheckins(ctx.db()) }));
/** One auto-mode pass now (it also runs every five minutes); `at` stands in for the clock in tests. */
on('POST', '/api/auto/run', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  runAuto(ctx.db(), Number(b?.at) || Date.now());
  ctx.json(res, 200, { ok: true });
});
