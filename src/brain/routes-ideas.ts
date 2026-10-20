// /api/ideas: the Idea board (capture, shape in one chat, promote), brands,
// UI mockups, and change requests (a PM proposes a change to what was
// settled; the user approves it on a card).
import { addMessage, getConversation, getMessage, members, recordDecision, updateMessageMeta } from './chat.js';
import { getBus } from './bus.js';
import {
  analysisByKind,
  ANALYSES,
  FEATURE_ANALYSES,
  listFeatureIdeas,
  answerQuestion,
  askQuestion,
  confirmFeatures,
  listFeatures,
  listQuestions,
  listSections,
  markSectionRunning,
  markSectionStalled,
  removeFeature,
  saveFeatures,
  saveSection,
  captureIdea,
  deleteIdea,
  getBrand,
  getIdea,
  ideaSummary,
  ideaThread,
  listBrands,
  listIdeas,
  removeScreen,
  saveBrand,
  saveScreen,
  screenHtml,
  updateIdea,
  useBrand,
} from './ideas.js';
import { listRequirements, NeedsRole, projectRef, promoteIdea, saveRequirements } from './pipeline.js';
import { getRole } from './roles.js';
import { FEATURE_FIRST_PASS, featureIntake, FIRST_PASS, ideaIntake } from './contracts.js';
import { addToProject, captureFeatureIdea, makeOwnIdea } from './feature-ideas.js';
import { HttpError, on } from './router.js';
import { activeRuns, respond } from './runner.js';

const need = (db: any, id: string) => {
  const idea = getIdea(db, id);
  if (!idea) throw new HttpError(404, 'unknown idea');
  return idea;
};
const bad = (err: unknown) => (err instanceof HttpError ? err : err instanceof NeedsRole ? new HttpError(409, err.message, { needs_role: err.role }) : new HttpError(400, (err as Error).message));
const attempt = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (err) {
    throw bad(err);
  }
};

/** A card's worth of an idea: what exists so far, and whether its chat is busy. */
function card(db: any, id: string) {
  const s = ideaSummary(db, id);
  const working = Boolean(s.idea.conversation_id && activeRuns().some((r) => r.conversation === s.idea.conversation_id));
  return { ...s.idea, requirementsVersion: s.requirementsVersion, designElements: s.designElements, brand: s.brand ? { id: s.brand.id, name: s.brand.name } : null, screens: s.screens.length, features: s.features, mvpFeatures: s.mvpFeatures, missing: s.missing, working };
}

on('GET', '/api/ideas', (_q, res, url, ctx) => {
  const db = ctx.db();
  ctx.json(res, 200, listIdeas(db, { all: url.searchParams.get('all') === '1' }).map((i) => card(db, i.id)));
});

/** Letters and digits only, for comparing names ("Quick Video Cutter v2" ~ "quick-video-cutter"). */
const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const sameThing = (a: string, b: string) => {
  const [x, y] = [plain(a), plain(b)];
  return x.length >= 4 && y.length >= 4 && (x === y || x.includes(y) || y.includes(x));
};

/** The first thinking (from the chat it came up in) becomes its starting requirements. */
function startingNotes(ctx: any, idea: { id: string; title: string }, b: any): void {
  if (typeof b.notes === 'string' && b.notes.trim()) attempt(() => saveRequirements(ctx.db(), idea.id, /^#\s/.test(b.notes.trim()) ? b.notes : `# ${idea.title}\n\n${b.notes}`, String(b.role ?? 'main')));
}

/** An agent captured it while you were talking to it: the app switches to its board. */
function openIfTalking(ctx: any, source: unknown, open: Record<string, string>): void {
  if (!source) return;
  const said = ctx.db().prepare("SELECT MAX(created_at) AS at FROM messages WHERE conversation_id = ? AND author = 'user'").get(String(source)) as { at: number | null };
  if (said.at && Date.now() - said.at < 10 * 60_000) ctx.broadcast({ type: 'idea_opened', ...open });
}

on('POST', '/api/ideas', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (!b?.title) throw new HttpError(400, 'title required');
  const db = ctx.db();
  // an agent about to capture something that already exists is told so (the user, typing a title, is not stopped)
  if (b.source && !b.different) {
    const project = (db.prepare('SELECT id, name FROM projects').all() as { id: string; name: string }[]).find((p) => sameThing(p.name, String(b.title)));
    if (project) throw new HttpError(409, `This looks like the existing project "${project.name}" (project_id ${project.id}). If it adds to that app, call capture_feature_idea with that project_id instead; its PM shapes it there. If it really is a separate product, call capture_idea again with different: true.`);
    const twin = listIdeas(db).find((i) => sameThing(i.title, String(b.title)));
    if (twin) throw new HttpError(409, `This looks like the idea "${twin.title}" (idea_id ${twin.id}) already on the Idea board. Add to that one instead; if it really is a different idea, call capture_idea again with different: true.`);
  }
  const idea = attempt(() => captureIdea(db, { title: String(b.title), pitch: b.pitch, type: b.type, source: b.source ?? null }));
  startingNotes(ctx, idea, b);
  openIfTalking(ctx, b.source, { idea_id: idea.id });
  ctx.json(res, 200, card(db, idea.id));
});

// ── feature ideas: new ideas for a project that exists, shaped inside it ──

on('GET', '/api/projects/:id/ideas', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  ctx.json(res, 200, listFeatureIdeas(db, p.id).map((i) => card(db, i.id)));
});

on('POST', '/api/projects/:id/ideas', async (req, res, _u, ctx, p) => {
  const b = await ctx.readBody(req);
  if (!b?.title) throw new HttpError(400, 'title required');
  const db = ctx.db();
  const idea = attempt(() => captureFeatureIdea(db, p.id, { title: String(b.title), pitch: b.pitch, source: b.source ?? null }));
  startingNotes(ctx, idea, b);
  openIfTalking(ctx, b.source, { idea_id: idea.id, project_id: p.id });
  ctx.json(res, 200, card(db, idea.id));
});

/** The user's approval: the feature joins the project and goes to its roadmap. The app confirms first. */
on('POST', '/api/ideas/:id/add-to-project', (_q, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  const r = attempt(() => addToProject(ctx.db(), p.id));
  ctx.broadcast({ type: 'conversations' });
  ctx.json(res, 200, r);
});

/** A feature idea that turned out to be a product of its own moves to the Idea board. */
on('POST', '/api/ideas/:id/own-idea', (_q, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  const idea = attempt(() => makeOwnIdea(ctx.db(), p.id));
  ctx.json(res, 200, card(ctx.db(), idea.id));
});

on('GET', '/api/ideas/:id', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  need(db, p.id);
  const s = ideaSummary(db, p.id);
  const conv = s.idea.conversation_id;
  const decisions = conv ? (db.prepare('SELECT id, title, why, created_at FROM brain_decisions WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 20').all(conv) as any[]) : [];
  ctx.json(res, 200, { ...card(db, p.id), requirements: listRequirements(db, p.id)[0] ?? null, brand: s.brand, screenList: s.screens, sections: listSections(db, p.id), featureList: listFeatures(db, p.id), questions: listQuestions(db, p.id), decisions });
});

on('POST', '/api/ideas/:id', async (req, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  attempt(() => updateIdea(ctx.db(), p.id, b ?? {}));
  ctx.json(res, 200, card(ctx.db(), p.id));
});

on('DELETE', '/api/ideas/:id', (_q, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  attempt(() => deleteIdea(ctx.db(), p.id));
  ctx.broadcast({ type: 'conversations' });
  ctx.json(res, 200, { ok: true });
});

/** The idea's one shaping chat (opened on first use). */
on('POST', '/api/ideas/:id/thread', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  const idea = need(db, p.id);
  const fresh = !idea.conversation_id;
  const conv = attempt(() => ideaThread(db, p.id));
  // a new idea's chat opens with the intake: the lead asks the missing basics (or lays it out if nothing is missing)
  if (fresh && idea.status !== 'promoted' && idea.status !== 'added') {
    const m = addMessage(db, conv, 'system', idea.parent_project_id ? featureIntake(p.id) : ideaIntake(p.id));
    ctx.broadcast({ type: 'chat', conversation: conv, message: m });
    respond(conv, '');
  }
  ctx.json(res, 200, { conversation: conv });
});

/** The last intake answer is in: one message with all of them, and the first pass starts. */
function startFirstPass(ctx: any, ideaId: string): void {
  const db = ctx.db();
  const conv = attempt(() => ideaThread(db, ideaId));
  const basics = listQuestions(db, ideaId).filter((q) => q.kind === 'intake' && q.status === 'answered');
  const m = addMessage(db, conv, 'user', [`The basics:`, ...basics.map((q) => `- ${q.text} ${q.answer}`), '', getIdea(db, ideaId)?.parent_project_id ? FEATURE_FIRST_PASS : FIRST_PASS].join('\n'));
  ctx.broadcast({ type: 'chat', conversation: conv, message: m });
  respond(conv, '');
}

/** Skip the rest of the intake: the lead uses its best guesses (and says which in the assumptions). */
on('POST', '/api/ideas/:id/intake/skip', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  const idea = need(db, p.id);
  if (idea.status === 'promoted') throw new HttpError(400, 'this idea is already a project');
  const open = listQuestions(db, p.id).filter((q) => q.kind === 'intake' && q.status === 'open');
  if (!open.length) throw new HttpError(400, 'no basics left to answer');
  for (const q of open) answerQuestion(db, p.id, q.id, 'no preference: use your best guess and note it as an assumption');
  startFirstPass(ctx, p.id);
  ctx.json(res, 200, { skipped: open.length });
});

on('POST', '/api/ideas/:id/promote', async (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  if (need(db, p.id).parent_project_id) throw new HttpError(400, 'a feature idea is added to its project, not promoted');
  try {
    const ref = await promoteIdea(db, p.id);
    ctx.broadcast({ type: 'conversations' });
    ctx.json(res, 200, { project_id: ref.id, root: ref.root });
  } catch (err) {
    throw bad(err);
  }
});

// ── analyses and features ──

on('GET', '/api/idea-analyses', (_q, res, url, ctx) => ctx.json(res, 200, url.searchParams.get('feature') === '1' ? FEATURE_ANALYSES : ANALYSES));

/** A pill: ask the idea's lead for one analysis; its card shows as working until the result is saved. */
on('POST', '/api/ideas/:id/sections/:kind/run', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  const idea = need(db, p.id);
  const a = analysisByKind(p.kind);
  if (!a) throw new HttpError(404, 'unknown analysis');
  if (idea.status === 'promoted') throw new HttpError(400, 'this idea is already a project');
  if (idea.status === 'added') throw new HttpError(400, 'this feature is already added to its project');
  const conv = attempt(() => ideaThread(db, p.id));
  markSectionRunning(db, p.id, a.kind);
  const save = a.kind === 'features'
    ? `Save every feature with save_features, then a short overview with save_idea_section (kind "${a.kind}").`
    : `Save the result with save_idea_section (kind "${a.kind}"): a one-line summary and the full write-up in Markdown.`;
  const m = addMessage(db, conv, 'user', `**${a.label}**: ${a.ask}\n\n${save} Then reply here in two or three lines.`);
  ctx.broadcast({ type: 'chat', conversation: conv, message: m });
  // the impact of a feature idea is the Architect's to assess
  respond(conv, a.kind === 'impact' && members(db, conv).includes('architect') ? '@Architect' : '', { onDone: () => markSectionStalled(getBus().db(), p.id, a.kind) });
  ctx.json(res, 200, { conversation: conv, kind: a.kind });
});

on('POST', '/api/ideas/:id/sections', async (req, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  ctx.json(res, 200, attempt(() => saveSection(ctx.db(), p.id, String(b?.kind ?? ''), { summary: String(b?.summary ?? ''), markdown: String(b?.markdown ?? '') })));
});

on('POST', '/api/ideas/:id/features', async (req, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  if (!Array.isArray(b?.features) || !b.features.length) throw new HttpError(400, 'features: a list');
  ctx.json(res, 200, attempt(() => saveFeatures(ctx.db(), p.id, b.features)));
});

/**
 * The user's story review from the Board: confirmed ones are marked; changed and
 * dropped ones go to the lead in one message, so a whole review costs one turn.
 */
on('POST', '/api/ideas/:id/features/review', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  const idea = need(db, p.id);
  if (idea.status === 'promoted') throw new HttpError(400, 'this idea is already a project');
  const b = await ctx.readBody(req);
  const items: { id: string; verdict: string; reason?: string }[] = Array.isArray(b?.items) ? b.items : [];
  const known = new Map(listFeatures(db, p.id).map((f) => [f.id, f]));
  const ok = items.filter((i) => i.verdict === 'ok' && known.has(i.id)).map((i) => i.id);
  const changed = items.filter((i) => i.verdict === 'change' && known.has(i.id));
  const dropped = items.filter((i) => i.verdict === 'drop' && known.has(i.id));
  if (!ok.length && !changed.length && !dropped.length) throw new HttpError(400, 'nothing to review');
  if (ok.length) confirmFeatures(db, p.id, ok);
  if (changed.length || dropped.length) {
    const conv = attempt(() => ideaThread(db, p.id));
    const line = (i: { id: string; reason?: string }) => `- ${i.id} ${known.get(i.id)!.title}${i.reason ? `: ${String(i.reason).slice(0, 300)}` : ''}`;
    const text = [
      'Story review from the Board.',
      ...(changed.length ? ['Change these (rewrite the stories and checks to fix what I said; they come back to me as drafts):', ...changed.map(line)] : []),
      ...(dropped.length ? ['Not wanted (remove them with remove_feature and update the requirements):', ...dropped.map(line)] : []),
    ].join('\n');
    const m = addMessage(db, conv, 'user', text);
    ctx.broadcast({ type: 'chat', conversation: conv, message: m });
    respond(conv, '');
  }
  ctx.json(res, 200, { confirmed: ok.length, changed: changed.length, dropped: dropped.length });
});

// ── open questions: the lead asks with likely answers; a tap answers ──

on('POST', '/api/ideas/:id/questions', async (req, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  ctx.json(res, 200, attempt(() => askQuestion(ctx.db(), p.id, { text: b?.text, options: b?.options, affects: b?.affects, intake: Boolean(b?.intake) })));
});

/** The user's answer (a tapped option or their own words): the lead updates what it affects. */
on('POST', '/api/ideas/:id/questions/:qid/answer', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  const idea = need(db, p.id);
  const b = await ctx.readBody(req);
  const q = attempt(() => answerQuestion(db, p.id, p.qid, String(b?.answer ?? '')));
  // the basics are collected quietly; the last one starts the first pass (one turn for the whole intake)
  if (q.kind === 'intake') {
    const left = listQuestions(db, p.id).some((x) => x.kind === 'intake' && x.status === 'open');
    if (!b?.quiet && !left && idea.status !== 'promoted') startFirstPass(ctx, p.id);
    return ctx.json(res, 200, q);
  }
  // answered by the lead after the user replied in the chat: nothing more to do
  if (!b?.quiet && idea.status !== 'promoted') {
    const conv = attempt(() => ideaThread(db, p.id));
    const m = addMessage(db, conv, 'user', `Answer to "${q.text}": ${q.answer}.${q.affects.length ? ` Update ${q.affects.join(', ')} and the requirements to match.` : ' Update what it affects.'}`);
    ctx.broadcast({ type: 'chat', conversation: conv, message: m });
    respond(conv, '');
  }
  ctx.json(res, 200, q);
});

on('DELETE', '/api/ideas/:id/features/:fid', (_q, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  removeFeature(ctx.db(), p.id, p.fid);
  ctx.json(res, 200, { ok: true });
});

// ── next steps: the lead offers to build the system design or the UI once the idea is ready; the user starts it with a button ──

const STEPS: Record<string, { label: string; ask: string; software: boolean }> = {
  design: {
    label: 'Build the system design',
    ask: 'Draw the system design for this idea from the requirements and features so far, loading the C4 skill: the containers, the main components and how they connect, and the tech choices with the reason for each. Use the design tools with the idea_id. Then reply here in two or three lines, with anything the design left open.',
    software: true,
  },
  ui: {
    label: 'Build the UI mockups',
    ask: 'Make the UI mockups for this idea: the main screens of the MVP features, one save_screen call each, static and clickable, following the brand (if there is no brand yet, draft one first with save_brand). Then reply here in two or three lines: which screens, and anything the requirements left open.',
    software: true,
  },
};

on('POST', '/api/ideas/:id/offers', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  const idea = need(db, p.id);
  const b = await ctx.readBody(req);
  const step = STEPS[String(b?.step ?? '')];
  if (!step) throw new HttpError(400, `step must be one of ${Object.keys(STEPS).join(', ')}`);
  if (idea.status === 'promoted') throw new HttpError(400, 'this idea is already a project');
  if (step.software && idea.type !== 'software') throw new HttpError(400, 'only software ideas get a system design and UI mockups');
  const conv = attempt(() => ideaThread(db, p.id));
  // one open offer per step: a newer one replaces it
  const open = db.prepare(`SELECT id FROM messages WHERE conversation_id = ? AND kind = 'offer' AND json_extract(meta, '$.step') = ? AND json_extract(meta, '$.status') = 'pending'`).all(conv, b.step) as { id: number }[];
  for (const o of open) {
    const old = getMessage(db, o.id)!;
    ctx.broadcast({ type: 'chat_update', conversation: conv, message: updateMessageMeta(db, o.id, { ...old.meta, status: 'replaced' }) });
  }
  const m = addMessage(db, conv, String(b?.role ?? 'main'), step.label, 'offer', { status: 'pending', idea_id: p.id, step: b.step, reason: String(b?.reason ?? '').trim() || null });
  ctx.broadcast({ type: 'chat', conversation: conv, message: m });
  ctx.json(res, 200, { status: 'offered', message_id: m.id });
});

on('POST', '/api/ideas/:id/offers/:mid', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  const idea = need(db, p.id);
  const m = getMessage(db, Number(p.mid));
  if (!m || m.kind !== 'offer' || m.meta?.idea_id !== p.id) throw new HttpError(404, 'unknown offer');
  if (m.meta.status !== 'pending') throw new HttpError(409, `already ${m.meta.status}`);
  const b = await ctx.readBody(req);
  const conv = m.conversation_id;
  const accept = Boolean(b?.accept);
  if (accept && idea.status === 'promoted') throw new HttpError(400, 'this idea is already a project');
  const updated = updateMessageMeta(db, m.id, { ...m.meta, status: accept ? 'started' : 'declined' });
  ctx.broadcast({ type: 'chat_update', conversation: conv, message: updated });
  if (accept) {
    const step = STEPS[m.meta.step];
    const ask = addMessage(db, conv, 'user', `**${step.label}**: ${step.ask}`);
    ctx.broadcast({ type: 'chat', conversation: conv, message: ask });
    respond(conv, '');
  } else {
    const note = addMessage(db, conv, 'system', `The user said not now to "${STEPS[m.meta.step].label}". Keep shaping; offer it again only when the user brings it up or something important has changed.`);
    ctx.broadcast({ type: 'chat', conversation: conv, message: note });
  }
  ctx.json(res, 200, { status: updated.meta.status });
});

// ── brand ──

on('GET', '/api/brands', (_q, res, _u, ctx) => ctx.json(res, 200, listBrands(ctx.db())));

on('POST', '/api/ideas/:id/brand', async (req, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  if (b?.tokens !== undefined && (typeof b.tokens !== 'object' || Array.isArray(b.tokens))) throw new HttpError(400, 'tokens must be an object');
  ctx.json(res, 200, attempt(() => saveBrand(ctx.db(), p.id, { name: b?.name, guidelines: b?.guidelines, tokens: b?.tokens })));
});

on('POST', '/api/ideas/:id/brand/use', async (req, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  attempt(() => useBrand(ctx.db(), p.id, b?.brand_id ?? null));
  ctx.json(res, 200, getBrand(ctx.db(), b?.brand_id ?? null));
});

// ── UI mockups ──

on('POST', '/api/ideas/:id/screens', async (req, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  if (typeof b?.html !== 'string') throw new HttpError(400, 'html required');
  ctx.json(res, 200, attempt(() => saveScreen(ctx.db(), p.id, { id: String(b.id ?? ''), title: String(b.title ?? ''), html: b.html, position: b.position })));
});

on('DELETE', '/api/ideas/:id/screens/:screen', (_q, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  attempt(() => removeScreen(ctx.db(), p.id, p.screen));
  ctx.json(res, 200, { ok: true });
});

/**
 * A mockup screen, served so it can only be looked at: no scripts, nothing
 * fetched from anywhere (inline styles, data: images), framed by the app only.
 * Links between screens are relative (settings.html), so they resolve here.
 */
on('GET', '/api/ideas/:id/ui/:screen', (_q, res, _u, ctx, p) => {
  need(ctx.db(), p.id);
  const html = screenHtml(ctx.db(), p.id, p.screen.replace(/\.html$/, ''));
  if (html === null) throw new HttpError(404, 'no such screen');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(html);
});

// ── change requests: what was settled changes only with the user's yes ──

const AREAS = ['requirements', 'design', 'brand', 'ui'] as const;
/** Who applies an approved change to each area (falls back to the Main agent). */
const OWNER: Record<string, string> = { design: 'architect', brand: 'designer', ui: 'designer', requirements: 'main' };

on('POST', '/api/change-requests', async (req, res, _u, ctx) => {
  const db = ctx.db();
  const b = await ctx.readBody(req);
  const conversation = b?.conversation && getConversation(db, b.conversation) ? String(b.conversation) : null;
  if (!conversation) throw new HttpError(400, 'conversation required');
  if (!AREAS.includes(b?.area)) throw new HttpError(400, `area must be one of ${AREAS.join(', ')}`);
  if (!String(b?.summary ?? '').trim()) throw new HttpError(400, 'say what should change');
  try {
    projectRef(db, String(b?.project_id ?? ''));
  } catch {
    throw new HttpError(404, 'unknown project');
  }
  if (b.area === 'requirements' && typeof b.requirements_markdown !== 'string') throw new HttpError(400, 'a requirements change needs the full new requirements as requirements_markdown');
  const meta = { status: 'pending', project_id: b.project_id, area: b.area, summary: String(b.summary).trim(), why: b.why ?? null, requirements_markdown: b.requirements_markdown ?? null, proposer: b.role ?? null };
  const m = addMessage(db, conversation, String(b.role ?? 'pm'), `Change the ${b.area === 'ui' ? 'UI' : b.area}: ${meta.summary}`, 'change_request', meta);
  ctx.broadcast({ type: 'chat', conversation, message: m });
  ctx.json(res, 200, { status: 'proposed', message_id: m.id });
});

on('POST', '/api/change-requests/:id', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  const m = getMessage(db, Number(p.id));
  if (!m || m.kind !== 'change_request') throw new HttpError(404, 'unknown change request');
  if (m.meta?.status !== 'pending') throw new HttpError(409, `already ${m.meta?.status}`);
  const b = await ctx.readBody(req);
  const mt = m.meta;
  const conv = m.conversation_id;
  if (!b?.accept) {
    const updated = updateMessageMeta(db, m.id, { ...mt, status: 'declined' });
    ctx.broadcast({ type: 'chat_update', conversation: conv, message: updated });
    const note = addMessage(db, conv, 'system', `The user declined the change to the ${mt.area}: ${mt.summary}. Keep to what was settled.`);
    ctx.broadcast({ type: 'chat', conversation: conv, message: note });
    return ctx.json(res, 200, { status: 'declined' });
  }
  const ref = projectRef(db, mt.project_id);
  let applied = '';
  if (mt.area === 'requirements') {
    try {
      // unlock for the new version without moving the project's stage back
      db.prepare('UPDATE requirements SET final = 0 WHERE project_id = ?').run(ref.id);
      const v = saveRequirements(db, ref.id, mt.requirements_markdown, mt.proposer ?? 'pm');
      // final again, without re-running the team step (the project is past it)
      db.prepare('UPDATE requirements SET final = 1 WHERE project_id = ? AND version = ?').run(ref.id, v.version);
      applied = `Requirements v${v.version} are now final.`;
    } catch (err) {
      throw bad(err);
    }
  }
  recordDecision(db, { conversationId: conv, projectId: ref.id, roleId: mt.proposer, title: `Change to the ${mt.area}: ${mt.summary}`, why: mt.why, followUps: [] });
  const updated = updateMessageMeta(db, m.id, { ...mt, status: 'approved' });
  ctx.broadcast({ type: 'chat_update', conversation: conv, message: updated });
  ctx.broadcast({ type: 'decisions' });
  if (applied) {
    const note = addMessage(db, conv, 'system', `Approved: ${mt.summary}. ${applied}`);
    ctx.broadcast({ type: 'chat', conversation: conv, message: note });
  } else {
    // design, brand and UI changes go to whoever owns them; they apply it and report back here
    const owner = getRole(db, OWNER[mt.area]) ? OWNER[mt.area] : 'main';
    db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, role_id) VALUES (?, ?)').run(conv, owner);
    const name = getRole(db, owner)?.name ?? 'Main agent';
    const where = mt.area === 'design' ? `the design model (get_design / set_element, project_id ${ref.id})` : `docs/${mt.area === 'brand' ? 'brand.md and docs/brand-tokens.json' : 'ui/ (one HTML file per screen; keep index.html linking them)'} in the project folder`;
    const note = addMessage(db, conv, 'system', `The user approved a change to the ${mt.area === 'ui' ? 'UI' : mt.area}: ${mt.summary}${mt.why ? ` (why: ${mt.why})` : ''}. @${name}: apply it to ${where}, then reply here with what changed.`);
    ctx.broadcast({ type: 'chat', conversation: conv, message: note });
    if (members(db, conv).includes(owner)) respond(conv, `@${name}`);
  }
  ctx.json(res, 200, { status: 'approved' });
});
