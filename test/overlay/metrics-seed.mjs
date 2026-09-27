// Seed a scratch daemon with ~8 weeks of backdated metrics data.
// Usage: node test/overlay/metrics-seed.mjs <scratch dir> <port> <repo root>   (prints {ws, web, api, mobile, empty, phases} as JSON)
// Used by test/overlay/filters.check.mjs; writes only to the scratch dir and the daemon on <port>.
// Boards via the HTTP API (workspace "shop" + verticals web/api, phases, a budget, a /usage push),
// then backdated history written straight into the scratch DB (the daemon only reads it back):
// task_events (create/move/assign/review/block/unblock), reviews, card_activity (usage breakdowns +
// legacy estimated rows) and wait_intervals (closed needs_you waits + one open). Deterministic (seeded PRNG).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const [S, PORT, TREE] = process.argv.slice(2);
const base = `http://127.0.0.1:${PORT}`;
const require = createRequire(`${TREE}/package.json`);
const Database = require('better-sqlite3');

const j = async (m, p, b) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) });
  const t = await r.json();
  if (!r.ok) throw new Error(`${p} ${JSON.stringify(t)}`);
  return t;
};

mkdirSync(`${S}/shop/apps/web`, { recursive: true });
mkdirSync(`${S}/shop/apps/api`, { recursive: true });
mkdirSync(`${S}/shop/apps/mobile`, { recursive: true });
mkdirSync(`${S}/fresh`, { recursive: true });
const ws = (await j('GET', `/project?root=${encodeURIComponent(`${S}/shop`)}&name=shop`)).project_id;
const web = (await j('POST', '/vertical', { workspace_id: ws, name: 'web', root: `${S}/shop/apps/web` })).project_id;
const api = (await j('POST', '/vertical', { workspace_id: ws, name: 'api', root: `${S}/shop/apps/api` })).project_id;
const mobile = (await j('POST', '/vertical', { workspace_id: ws, name: 'mobile', root: `${S}/shop/apps/mobile` })).project_id;
const empty = (await j('GET', `/project?root=${encodeURIComponent(`${S}/fresh`)}&name=fresh`)).project_id;

const phase = async (project_id, title, status) => {
  const id = (await j('POST', '/phase', { project_id, title })).phase_id;
  if (status) await j('POST', `/phase/${id}`, { status });
  return id;
};
const P = {
  foundations: await phase(ws, 'Foundations', 'done'),
  checkout: await phase(ws, 'Checkout', 'active'),
  webCheckout: await phase(web, 'Web checkout', 'active'),
  apiV1: await phase(api, 'API v1', 'active'),
  launch: await phase(mobile, 'Launch', 'active'),
};
await j('PUT', `/phase/${P.checkout}/budget`, { budget_usd: 60 });
for (const name of ['Ada', 'Inder', 'NodeDev', 'Knwar']) await j('POST', '/team', { name });

const now = Date.now();
const H = 3_600_000;
const D = 24 * H;
let seed = 42;
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const db = new Database(`${S}/data/board.db`);
db.pragma('busy_timeout = 5000');
const insTask = db.prepare(
  `INSERT INTO tasks (id, project_id, phase_id, title, lane, tag, assigned_agent, blocked_at, blocked_reason, review_rounds, position, created_at, updated_at, subtasks)
   VALUES (@id, @project_id, @phase_id, @title, @lane, @tag, @agent, @blocked_at, @blocked_reason, @rounds, @position, @created_at, @updated_at, '[]')`,
);
const insEv = db.prepare('INSERT INTO task_events (project_id, task_id, type, payload, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const insReview = db.prepare('INSERT INTO reviews (task_id, round, verdict, findings, created_at) VALUES (?, ?, ?, ?, ?)');
const insAct = db.prepare(
  `INSERT INTO card_activity (project_id, task_id, agent, role, tokens, tokens_out, ms, usage, cost_estimated, created_at)
   VALUES (?, ?, ?, 'builder', ?, ?, ?, ?, ?, ?)`,
);
const insWait = db.prepare(
  `INSERT INTO wait_intervals (project_id, agent_id, task_id, kind, started_at, ended_at, reason, closed_by) VALUES (?, ?, ?, 'needs_you', ?, ?, ?, ?)`,
);

const TITLES = [
  'Saved payment methods', 'Order history screen', 'Payments API: idempotency keys', 'Checkout page', 'Orders endpoint',
  'Cart icon badge', 'Orders API contract', 'Address form validation', 'Tax rounding fix', 'Release notes draft',
  'Product search', 'Inventory sync job', 'Coupon codes', 'Refund flow', 'Shipping rates API', 'Guest checkout',
  'Email receipts', 'Rate limiting', 'Session cookies', 'Wishlist', 'Price formatting', 'Webhooks retry',
  'Admin dashboard', 'Stock alerts', 'Image CDN', 'Login with passkeys', 'Currency switcher', 'Audit log',
];
const boardsOf = [
  { id: ws, w: 0.3 },
  { id: web, w: 0.35 },
  { id: api, w: 0.35 },
];
const cardsOut = [];
let n = 0;
let pos = 0;
const mkId = () => `c${String(++n).padStart(3, '0')}${Math.floor(rand() * 1e6).toString(36)}`;

function makeCard({ board, createdAt, stopAt = now - 60_000, forceLane = null }) {
  createdAt = Math.round(createdAt); // epoch ms are integers
  const id = mkId();
  const title = `${pick(TITLES)} ${n}`;
  const tag = board === web ? pick(['ui', 'ui', 'infra']) : board === api ? pick(['api', 'db', 'api']) : pick(['infra', 'api', 'ui', 'db']);
  const agent = board === web ? pick(['Ada', 'Inder']) : board === api ? pick(['NodeDev', 'Knwar']) : pick(['Knwar', 'Ada']);
  const phaseId = board === ws ? (createdAt < now - 30 * D ? P.foundations : P.checkout) : board === web ? P.webCheckout : P.apiV1;
  const ev = [];
  let lane = 'backlog';
  let t = createdAt;
  let rounds = 0;
  const push = (type, payload, at, who = null) => ev.push({ type, payload, at, who });
  push('create', { title, phase_id: phaseId }, t);
  const step = (to, gap, who = null) => {
    const at = t + gap;
    if (at > stopAt) return false;
    t = at;
    push('move', { from: lane, to }, t, who);
    lane = to;
    return true;
  };
  const reviews = [];
  const run = () => {
    if (forceLane === 'backlog') return;
    if (!step('queued', (0.2 + rand() * 1.5) * D)) return;
    if (forceLane === 'queued') return;
    if (t + H > stopAt) return;
    t += 5 * 60_000;
    push('assign', { worktree: `.trees/${id}`, branch: `card/${id}`, skill: null }, t, agent);
    if (!step('in_progress', (0.05 + rand() * 0.6) * D, agent)) return;
    if (forceLane === 'in_progress') return;
    for (let round = 1; round <= 3; round++) {
      if (!step('in_review', (0.1 + rand() * 0.9) * D * (rand() < 0.15 ? 3 : 1), agent)) return;
      const rt = t + (0.5 + rand() * 3) * H;
      if (rt > stopAt || forceLane === 'in_review') return;
      t = rt;
      const verdict = round === 3 || rand() > (round === 1 ? 0.27 : 0.4) ? 'pass' : 'fail';
      rounds = round;
      push('review', { verdict, round, findings: verdict === 'fail' ? [{ note: 'missing test' }] : [] }, t, 'reviewer');
      reviews.push({ round, verdict, at: t });
      if (verdict === 'pass') {
        step('done', 0.2 * H);
        return;
      }
      if (!step('in_progress', 0.3 * H, agent)) return;
    }
  };
  run();
  return { id, board, title, tag, agent: lane === 'backlog' ? null : agent, phaseId, lane, ev, reviews, rounds, createdAt, updatedAt: t };
}

// ~70 cards created over 60 days (a steadier stream lately), plus fresh backlog
for (let i = 0; i < 72; i++) {
  const board = rand() < 0.3 ? ws : rand() < 0.5 ? web : api;
  const createdAt = Math.round(now - Math.pow(rand(), 0.8) * 60 * D);
  cardsOut.push(makeCard({ board, createdAt }));
}
for (let i = 0; i < 8; i++) cardsOut.push(makeCard({ board: pick([ws, web, api]), createdAt: now - rand() * 5 * D, forceLane: 'backlog' }));
// in-flight cards, one of them blocked (open blocker)
const blockedCard = makeCard({ board: api, createdAt: now - 2 * D, forceLane: 'in_progress' });
cardsOut.push(blockedCard);
cardsOut.push(makeCard({ board: web, createdAt: now - 1.5 * D, forceLane: 'in_review' }));
for (const [lane, k] of [['queued', 4], ['in_progress', 3], ['in_review', 2]])
  for (let i = 0; i < k; i++) cardsOut.push(makeCard({ board: pick([ws, web, api]), createdAt: now - (2 + rand() * 4) * D, forceLane: lane }));

db.transaction(() => {
  for (const c of cardsOut) {
    let blocked_at = null;
    let blocked_reason = null;
    if (c === blockedCard) {
      blocked_at = now - 3 * H;
      blocked_reason = 'Which payment provider: Stripe or Adyen?';
      c.ev.push({ type: 'block', payload: { reason: blocked_reason }, at: blocked_at, who: c.agent });
      c.updatedAt = Math.max(c.updatedAt, blocked_at);
    }
    insTask.run({
      id: c.id,
      project_id: c.board,
      phase_id: c.phaseId,
      title: c.title,
      lane: c.lane,
      tag: c.tag,
      agent: c.agent,
      blocked_at,
      blocked_reason,
      rounds: c.rounds,
      position: pos++,
      created_at: c.createdAt,
      updated_at: Math.round(c.updatedAt),
    });
    c.ev.sort((a, b) => a.at - b.at);
    for (const e of c.ev) insEv.run(c.board, c.id, e.type, JSON.stringify(e.payload), e.who, Math.round(e.at));
    for (const r of c.reviews) insReview.run(c.id, r.round, r.verdict, '[]', Math.round(r.at));
    // build runs: one per review round (or one for an in-flight card); old cards are legacy (estimated) rows
    if (c.lane !== 'backlog') {
      const runs = Math.max(1, c.reviews.length);
      for (let r = 0; r < runs; r++) {
        const at = Math.round(c.reviews[r]?.at ?? c.updatedAt) - 10 * 60_000;
        const legacy = c.createdAt < now - 45 * D;
        const input = Math.round(2e4 + rand() * 4e4);
        const output = Math.round(1e4 + rand() * 3e4);
        const cacheRead = Math.round(3e5 + rand() * 9e5);
        const cacheCreation = Math.round(2e4 + rand() * 6e4);
        const total = input + output + cacheRead + cacheCreation;
        const usage = legacy ? null : JSON.stringify({ 'claude-opus-5-5': { input, output, cache_read: cacheRead, cache_creation: cacheCreation } });
        insAct.run(c.board, c.id, c.agent, legacy ? Math.round(total * 1.97) : total, legacy ? Math.round(output * 1.97) : output, Math.round(20 * 60_000 + rand() * 90 * 60_000), usage, legacy ? 1 : 0, at);
      }
    }
  }
  // a resolved blocker 10 days ago on a done card
  const done = cardsOut.filter((c) => c.lane === 'done' && c.updatedAt < now - 12 * D && c.updatedAt > now - 20 * D)[0];
  if (done) {
    const inProg = done.ev.find((e) => e.type === 'move' && e.payload.to === 'in_progress');
    insEv.run(done.board, done.id, 'block', JSON.stringify({ reason: 'Need the API key' }), done.agent, Math.round(inProg.at + 60_000));
    insEv.run(done.board, done.id, 'unblock', JSON.stringify({ note: 'key added' }), null, Math.round(inProg.at + 2 * H));
  }
  // needs_you waits: closed ones over the 8 weeks, and one open now (47m)
  for (let i = 0; i < 18; i++) {
    const start = now - (1 + rand() * 55) * D;
    const len = (3 + rand() * 60) * 60_000;
    insWait.run(pick([ws, web, api]), 'orchestrator', null, Math.round(start), Math.round(start + len), 'permission prompt', 'working');
  }
  insWait.run(web, 'orchestrator', null, now - 47 * 60_000, null, 'a permission prompt: Bash(npm test)', null);
})();
// the sparse board (insufficient history): mobile, first card 6 days ago, 3 done this week, 2 not done
db.transaction(() => {
  const today = new Date(now);
  const dow = (today.getDay() + 6) % 7; // days since Monday (local)
  const mk = (i, created, doneAgo) => {
    const id = `m${i}${Math.floor(rand() * 1e6).toString(36)}`;
    const title = `Mobile screen ${i}`;
    const createdAt = Math.round(now - created * D);
    const ev = [['create', { title, phase_id: P.launch }, createdAt, null]];
    let lane = 'backlog';
    if (doneAgo !== null) {
      const doneAt = Math.round(now - doneAgo * D);
      const span = doneAt - createdAt;
      ev.push(['move', { from: 'backlog', to: 'queued' }, createdAt + span * 0.2, null]);
      ev.push(['move', { from: 'queued', to: 'in_progress' }, createdAt + span * 0.4, 'Ada']);
      ev.push(['move', { from: 'in_progress', to: 'in_review' }, createdAt + span * 0.7, 'Ada']);
      ev.push(['review', { verdict: 'pass', round: 1, findings: [] }, createdAt + span * 0.9, 'reviewer']);
      ev.push(['move', { from: 'in_review', to: 'done' }, doneAt, null]);
      lane = 'done';
    }
    insTask.run({ id, project_id: mobile, phase_id: P.launch, title, lane, tag: 'ui', agent: doneAgo !== null ? 'Ada' : null, blocked_at: null, blocked_reason: null, rounds: doneAgo !== null ? 1 : 0, position: pos++, created_at: createdAt, updated_at: Math.round(ev[ev.length - 1][2]) });
    for (const [type, payload, at, who] of ev) insEv.run(mobile, id, type, JSON.stringify(payload), who, Math.round(at));
    for (const [type, payload, at] of ev) if (type === 'review') insReview.run(id, 1, 'pass', '[]', Math.round(at));
  };
  // done inside the current (partial) week, so the complete weeks' numbers stay the same
  const inWeek = (k) => Math.max(0.05, Math.min(dow, 6) * k);
  mk(1, 6, inWeek(0.2));
  mk(2, 5.5, inWeek(0.5));
  mk(3, 5, inWeek(0.8));
  mk(4, 4, null);
  mk(5, 2, null);
})();
db.close();

// a weekly-limit push: 71% used, resets in ~2.5 days (burn projection vs the phase forecast)
await j('POST', '/usage', {
  five_hour: { used_percentage: 52, resets_at: Math.round((now + 2 * H) / 1000) },
  seven_day: { used_percentage: 71, resets_at: Math.round((now + 2.5 * D) / 1000) },
});

console.log(JSON.stringify({ ws, web, api, mobile, empty, phases: P, cards: cardsOut.length }));
