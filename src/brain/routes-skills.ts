// /api/skills: the skill library as the user sees it (their editable copies,
// where each came from, what was changed) with edit, reset and compare.
import { listSkills, resetSkill, saveSkill, skillState, skillTexts } from './skills.js';
import { HttpError, on } from './router.js';
import { currentWorkspace } from './workspace.js';

const dataDir = () => {
  const ws = currentWorkspace();
  if (!ws) throw new HttpError(400, 'set up a workspace first');
  return ws.data;
};

on('GET', '/api/skills', (_q, res, _u, ctx) => ctx.json(res, 200, listSkills(dataDir())));

on('GET', '/api/skills/:id', (_q, res, _u, ctx, p) => {
  const state = skillState(dataDir(), p.id);
  if (!state) throw new HttpError(404, 'unknown skill');
  ctx.json(res, 200, { ...state, ...skillTexts(dataDir(), p.id) });
});

on('POST', '/api/skills/:id', async (req, res, _u, ctx, p) => {
  const b = await ctx.readBody(req);
  if (typeof b?.text !== 'string') throw new HttpError(400, 'text required');
  try {
    ctx.json(res, 200, saveSkill(dataDir(), p.id, b.text));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  ctx.broadcast({ type: 'skills' });
});

on('POST', '/api/skills/:id/reset', (_q, res, _u, ctx, p) => {
  if (!skillState(dataDir(), p.id)) throw new HttpError(404, 'unknown skill');
  ctx.json(res, 200, resetSkill(dataDir(), p.id));
  ctx.broadcast({ type: 'skills' });
});
