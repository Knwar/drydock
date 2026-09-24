const LANES = ['backlog', 'queued', 'in_progress', 'in_review', 'done'];
const LANE_LABELS = { backlog: 'Backlog', queued: 'Queued', in_progress: 'In Progress', in_review: 'In Review', done: 'Done' };

// tags are stored as ui/api/db/infra; viewers see teams
const TEAMS = {
  ui: { name: 'Frontend', color: '#c678dd' },
  api: { name: 'Backend', color: '#61afef' },
  db: { name: 'Database', color: '#e5c07b' },
  infra: { name: 'Infra', color: '#56b6c2' },
  _none: { name: 'General', color: '#8b93a7' },
  _qc: { name: 'QC', color: '#d19a66' }, // in_review cards, grouped regardless of tag
};
const team = (tag) => TEAMS[tag] ?? TEAMS._none;

const cards = new Map(); // id -> {id,title,lane,tag,agent,phase_id}
let phases = []; // roadmap: [{id,title,goal,status,position,progress}]

const boardEl = document.getElementById('board');
const headlineEl = document.getElementById('headline');
const connEl = document.getElementById('conn');
const statsEl = document.getElementById('stats');
const timerEl = document.getElementById('timer');

// ── timer + stats ───────────────────────────────────────────────────
let startedAt = null; // daemon start (ms) — survives overlay reloads
const reviews = { pass: 0, fail: 0 };

// Browsers — and OBS browser sources — throttle setInterval/setTimeout in a
// backgrounded or hidden page, which freezes time-based UI on stream. A Web
// Worker is exempt, so every 1s tick is driven from one. Attach with tick.add.
const tick = (() => {
  const fns = new Set();
  try {
    const blob = new Blob(['setInterval(()=>postMessage(0),1000)'], { type: 'text/javascript' });
    new Worker(URL.createObjectURL(blob)).onmessage = () => fns.forEach((f) => f());
  } catch {
    setInterval(() => fns.forEach((f) => f()), 1000); // fallback if Worker is unavailable
  }
  return { add: (f) => fns.add(f) };
})();

tick.add(() => {
  if (startedAt === null) return;
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  timerEl.textContent = `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
});

function renderStats() {
  const all = [...cards.values()];
  const done = all.filter((c) => c.lane === 'done').length;
  const flight = all.filter((c) => c.lane === 'in_progress' || c.lane === 'in_review').length;
  statsEl.innerHTML =
    `<span class="n">${done}</span> done · <span class="n">${flight}</span> in flight` +
    ` · reviews <span class="pass">${reviews.pass}✓</span>/<span class="fail">${reviews.fail}✗</span>`;
}

// ── websocket ───────────────────────────────────────────────────────
function connect() {
  const project = new URLSearchParams(location.search).get('project');
  const ws = new WebSocket(`ws://${location.host}/ws${project ? `?project=${project}` : ''}`);
  ws.onopen = () => setConn(true);
  ws.onmessage = (e) => applyEvent(JSON.parse(e.data));
  ws.onclose = () => {
    setConn(false);
    setTimeout(connect, 2000);
  };
}

function setConn(online) {
  connEl.textContent = online ? 'live' : 'offline';
  connEl.className = `conn ${online ? 'online' : 'offline'}`;
  document.body.classList.toggle('offline', !online);
}

// ── project switcher ────────────────────────────────────────────────
const projectBtn = document.getElementById('project-btn');
const projectMenu = document.getElementById('project-menu');

function setProject(project) {
  document.getElementById('project-name').textContent = project?.name ?? 'no project yet';
  document.title = project?.name ? `${project.name} - KanKanBan` : 'KanKanBan';
}

// Turn the name into a dropdown only when more than one project lives on this daemon.
async function loadProjects() {
  let list = [];
  try {
    list = await (await fetch('/projects')).json();
  } catch {
    /* daemon hiccup — leave the switcher as plain text */
  }
  projectBtn.classList.add('multi'); // always a dropdown so "+ New Project" is reachable
  projectMenu.innerHTML =
    list
      .map(
        (p) =>
          `<div class="pm-item${p.id === projectId ? ' current' : ''}" data-id="${esc(p.id)}"><span class="pm-name">${esc(p.name)}</span><button class="pm-del" data-del="${esc(p.id)}" title="Remove from board">✕</button></div>`,
      )
      .join('') + '<div class="pm-new">+ New Project</div>';
}

// Add a project from the UI: pick a folder (native dialog / typed path), optionally
// attach a GitHub repo, then set up the kit and switch to it.
async function newProject() {
  projectMenu.classList.add('hidden');
  let path;
  try {
    const pick = await (await fetch('/project/pick', { method: 'POST' })).json();
    if (pick.cancelled) return;
    if (pick.needs_path) {
      path = (prompt('Path to the project folder (created if it doesn’t exist):') || '').trim();
      if (!path) return;
    } else {
      path = pick.path;
    }
  } catch {
    return alert('Could not reach the daemon.');
  }
  const repo = (prompt('Attach a GitHub repo? Paste its URL, or leave blank to skip:') || '').trim();
  try {
    const out = await (await fetch('/project/new', { method: 'POST', body: JSON.stringify({ path, repo }) })).json();
    if (out.error) return alert(`Could not set up the project: ${out.error}`);
    if (out.project_id) location.search = `?project=${out.project_id}`;
  } catch {
    alert('Setup failed — is the daemon running?');
  }
}

async function removeProject(id) {
  if (!confirm('Remove this project from the board? The folder on disk is kept.')) return;
  try {
    await fetch(`/project/${id}`, { method: 'DELETE' });
  } catch {
    return alert('Could not reach the daemon.');
  }
  if (id === projectId) location.search = ''; // current removed → fall back to default
  else loadProjects();
}

projectBtn.onclick = (e) => {
  if (!projectBtn.classList.contains('multi')) return;
  e.stopPropagation();
  projectMenu.classList.toggle('hidden');
};
projectMenu.onclick = (e) => {
  const del = e.target.closest('.pm-del');
  if (del) {
    e.stopPropagation();
    return removeProject(del.dataset.del);
  }
  if (e.target.closest('.pm-new')) return newProject();
  const item = e.target.closest('.pm-item');
  if (item) location.search = `?project=${item.dataset.id}`;
};
document.addEventListener('click', (e) => {
  const sw = document.getElementById('project-switcher');
  if (!projectMenu.classList.contains('hidden') && !sw.contains(e.target)) projectMenu.classList.add('hidden');
});

// ── state ───────────────────────────────────────────────────────────
function applyEvent(msg) {
  if (msg.type === 'init') {
    cards.clear();
    for (const card of msg.board) cards.set(card.id, card);
    phases = msg.phases ?? [];
    setProject(msg.project);
    projectId = msg.project?.id ?? null;
    initDashboard();
    loadProjects();
    refreshScmBadge();
    seedHeadline(msg.events);
    startedAt = msg.stats?.started_at ?? Date.now();
    reviews.pass = msg.stats?.reviews.pass ?? 0;
    reviews.fail = msg.stats?.reviews.fail ?? 0;
    renderUsage(msg.usage);
    renderBoard();
    renderPhaseList();
    refreshAttention();
    openCardFromUrl();
  } else if (msg.type === 'phases') {
    phases = msg.phases;
    renderBoard(); // active phase may have changed → board scope shifts
    renderPhaseList();
    refreshAttention();
  } else if (msg.type === 'card') {
    cards.set(msg.card.id, msg.card);
    renderBoard();
    renderPhaseList();
    refreshAttention();
    if (activeView === 'scm') refreshFiles();
    else refreshScmBadge();
    if (msg.card.id === openCardId) refreshCardModal();
  } else if (msg.type === 'card_removed') {
    cards.delete(msg.card_id);
    renderBoard();
    renderPhaseList();
    refreshAttention();
    if (msg.card_id === openCardId) closeCardModal();
  } else if (msg.type === 'project_removed') {
    if (msg.project_id === projectId) location.search = ''; // the project we're viewing is gone

  } else if (msg.type === 'event') {
    pushHeadline(msg.event);
    const ev = msg.event;
    if (ev.type === 'review') {
      const verdict = ev.payload && JSON.parse(ev.payload).verdict;
      if (verdict in reviews) reviews[verdict] += 1;
      renderStats();
      refreshAttention();
    }
    if (['tool', 'build_start', 'build_end', 'check'].includes(ev.type)) pulse(ev.task_id);
  } else if (msg.type === 'status') {
    setStatus(msg.status);
  } else if (msg.type === 'usage') {
    renderUsage(msg.usage);
  } else if (msg.type === 'verticals') {
    onVerticals(msg);
  }
}

// ── subscription usage bars (fed by the statusline script) ─────────
function renderUsage(usage) {
  const windows = [
    ['usage-5h', usage?.five_hour],
    ['usage-wk', usage?.seven_day],
  ];
  for (const [id, win] of windows) {
    const el = document.getElementById(id);
    const pct = win?.used_percentage;
    if (typeof pct !== 'number') {
      el.querySelector('.upct').textContent = '—';
      el.querySelector('.ufill').style.width = '0';
      el.className = 'usage';
      el.title = '';
      continue;
    }
    el.querySelector('.upct').textContent = `${Math.round(pct)}%`;
    el.querySelector('.ufill').style.width = `${Math.min(100, pct)}%`;
    el.className = `usage${pct >= 85 ? ' hot' : pct >= 60 ? ' warn' : ''}`;
    el.title = win.resets_at
      ? `resets ${new Date(win.resets_at * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
      : '';
  }
}

// ── live agent status (ephemeral, decays to thinking…) ─────────────
const statusEl = document.getElementById('agent-status');
let statusAt = 0;
let statusIdle = true;
let lastAgent = '';

function setStatus({ agent, verb, detail, task_id }) {
  statusAt = Date.now();
  // idle and 'needs you' are sticky: no 8s decay to thinking… while blocked on the user
  statusIdle = verb === 'idle' || verb === 'needs you';
  lastAgent = agent;
  statusEl.className = verb === 'idle' ? 'idle' : verb === 'needs you' ? 'needs-you' : '';
  statusEl.innerHTML = `● <span class="who">${esc(agent)}</span> — ${esc(verb)}${detail ? ` ${esc(detail)}` : ''}`;
  if (task_id) pulse(task_id);
}

tick.add(() => {
  // no signal for a while but not idle → the agent is between tools: thinking
  if (!statusIdle && statusAt && Date.now() - statusAt > 8000) {
    statusEl.className = 'thinking';
    statusEl.innerHTML = `● <span class="who">${esc(lastAgent)}</span> — thinking…`;
  }
});

/** Brief glow on a card when its agent does something. */
function pulse(cardId) {
  const el = boardEl.querySelector(`.card[data-id="${cardId}"]`);
  if (!el) return;
  el.classList.remove('pulse');
  void el.offsetWidth; // restart the animation
  el.classList.add('pulse');
}

// ── lane collapse: horizontal strips on desktop, accordion on mobile ──
// Two persisted sets because the defaults differ by viewport: desktop lanes
// start expanded (user collapses to a strip); mobile lanes start closed.
const collapsedLanes = new Set(JSON.parse(localStorage.getItem('board.collapsed') || '[]'));
const openLanes = new Set(JSON.parse(localStorage.getItem('board.open') || '[]'));
const laneIsMobile = () => window.matchMedia('(max-width: 720px)').matches;

function applyLaneState(laneEl, lane) {
  laneEl.classList.toggle('collapsed', collapsedLanes.has(lane));
  laneEl.classList.toggle('open', openLanes.has(lane));
}

function toggleLane(lane, laneEl) {
  const mobile = laneIsMobile();
  const set = mobile ? openLanes : collapsedLanes;
  set.has(lane) ? set.delete(lane) : set.add(lane);
  localStorage.setItem(mobile ? 'board.open' : 'board.collapsed', JSON.stringify([...set]));
  applyLaneState(laneEl, lane);
}

// ── board render (FLIP) ─────────────────────────────────────────────
function renderBoard() {
  // First: capture where every card currently is.
  const before = new Map();
  for (const el of boardEl.querySelectorAll('.card')) {
    before.set(el.dataset.id, el.getBoundingClientRect());
  }

  boardEl.replaceChildren(
    ...LANES.map((lane) => {
      const inLane = visibleCards().filter((c) => c.lane === lane);
      if (lane === 'done') inLane.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)); // freshest first
      const laneEl = document.createElement('div');
      laneEl.className = 'lane';
      laneEl.dataset.lane = lane;
      laneEl.innerHTML = `<div class="lane-head"><span class="lane-chevron"></span><span class="lane-name">${LANE_LABELS[lane]}</span><span class="lane-count">${inLane.length}</span></div>`;
      applyLaneState(laneEl, lane);
      laneEl.querySelector('.lane-head').addEventListener('click', () => toggleLane(lane, laneEl));
      const cardsEl = document.createElement('div');
      cardsEl.className = 'cards';
      cardsEl.append(...inLane.map(cardEl));
      laneEl.append(cardsEl);
      return laneEl;
    }),
  );

  // Last + Invert + Play: slide moved cards from their old position.
  for (const el of boardEl.querySelectorAll('.card')) {
    const prev = before.get(el.dataset.id);
    if (!prev) continue;
    const next = el.getBoundingClientRect();
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (!dx && !dy) continue;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 400, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }

  renderStats();
  renderTeams();
}

// ── teams: counter + peek panel ─────────────────────────────────────
const teamsBtn = document.getElementById('teams-btn');
const teamsPeek = document.getElementById('teams-peek');

function activeTeams() {
  const byTag = new Map();
  for (const card of cards.values()) {
    if (card.lane !== 'in_progress' && card.lane !== 'in_review') continue;
    const key = card.lane === 'in_review' ? '_qc' : (card.tag ?? '_none');
    if (!byTag.has(key)) byTag.set(key, []);
    byTag.get(key).push(card);
  }
  return byTag;
}

function renderTeams() {
  const n = activeTeams().size;
  teamsBtn.textContent = `${n} team${n === 1 ? '' : 's'} active`;
  teamsBtn.classList.toggle('on', n > 0);
  if (!teamsPeek.classList.contains('hidden')) renderPeek();
}

function renderPeek() {
  const groups = activeTeams();
  if (groups.size === 0) {
    teamsPeek.innerHTML = '<div class="tp-empty">No teams working right now</div>';
    return;
  }
  teamsPeek.innerHTML = [...groups.entries()]
    .map(([tag, list]) => {
      const t = team(tag === '_none' ? null : tag);
      const rows = list
        .map((c) => {
          const prog = c.subs ? ` · ${c.subs.done}/${c.subs.total}` : '';
          return `<div class="tp-card">${esc(c.title)}<span class="tp-sub">${esc(c.agent ?? 'unassigned')}${prog}</span></div>`;
        })
        .join('');
      return `<div class="tp-team"><div class="tp-head"><span class="tp-dot" style="background:${t.color}"></span>${esc(t.name)} team</div>${rows}</div>`;
    })
    .join('');
}

teamsBtn.onclick = (e) => {
  e.stopPropagation();
  teamsPeek.classList.toggle('hidden');
  if (!teamsPeek.classList.contains('hidden')) renderPeek();
};
document.addEventListener('click', (e) => {
  if (!teamsPeek.classList.contains('hidden') && !teamsPeek.contains(e.target)) {
    teamsPeek.classList.add('hidden');
  }
});

// ── board scoping by active phase ───────────────────────────────────
const activePhaseId = () => phases.find((p) => p.status === 'active')?.id ?? null;

// The board shows the active phase only — but only once phases exist. Flat /
// legacy projects (no phases) keep showing every card.
function visibleCards() {
  const apid = activePhaseId();
  const all = [...cards.values()];
  return phases.length && apid ? all.filter((c) => c.phase_id === apid) : all;
}

// ── activity rail: view switcher (Attention / Kanban / Git / Phases) ─
const railAttention = document.getElementById('rail-attention');
const railKanban = document.getElementById('rail-kanban');
const railScm = document.getElementById('rail-scm');
const railPhases = document.getElementById('rail-phases');
const railStats = document.getElementById('rail-stats');
const railDashboard = document.getElementById('rail-dashboard');
const attentionView = document.getElementById('attention-view');
const scmView = document.getElementById('scm-view');
const phasesView = document.getElementById('phases-view');
const statsView = document.getElementById('stats-view');
const dashboardView = document.getElementById('dashboard-view');
let activeView = 'kanban'; // 'attention' | 'kanban' | 'scm' | 'phases' | 'stats' | 'dashboard'

// Non-kanban views take over the whole board area (full-screen).
function setView(name) {
  activeView = name;
  railAttention.classList.toggle('active', name === 'attention');
  railKanban.classList.toggle('active', name === 'kanban');
  railScm.classList.toggle('active', name === 'scm');
  railPhases.classList.toggle('active', name === 'phases');
  railStats.classList.toggle('active', name === 'stats');
  railDashboard.classList.toggle('active', name === 'dashboard');
  attentionView.classList.toggle('hidden', name !== 'attention');
  boardEl.classList.toggle('hidden', name !== 'kanban');
  scmView.classList.toggle('hidden', name !== 'scm');
  phasesView.classList.toggle('hidden', name !== 'phases');
  statsView.classList.toggle('hidden', name !== 'stats');
  dashboardView.classList.toggle('hidden', name !== 'dashboard');
  if (name === 'scm') refreshFiles();
  if (name === 'phases') renderPhaseDetail();
  if (name === 'attention') renderAttention();
  if (name === 'stats') loadStats();
  if (name === 'dashboard') openDashboard();
  else closeDashboard();
}

railAttention.onclick = () => setView('attention');
railKanban.onclick = () => setView('kanban');
railScm.onclick = () => setView('scm');
railPhases.onclick = () => setView('phases');
railStats.onclick = () => setView('stats');
railDashboard.onclick = () => setView('dashboard');

// ── project stats: tokens / lines / time, per agent ─────────────────
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n | 0));
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function loadStats() {
  let stats;
  try {
    stats = await (await fetch(`/stats?project=${encodeURIComponent(projectId ?? '')}`)).json();
  } catch {
    stats = null;
  }
  const host = document.getElementById('stats-body');
  if (!stats || !stats.totals || !stats.totals.cards) {
    host.innerHTML = '<div class="att-empty">No activity yet.<br>Stats appear once agents build cards.</div>';
    return;
  }
  const t = stats.totals;
  const cardBox = (label, val, sub) =>
    `<div class="stat-card"><div class="stat-val">${val}</div><div class="stat-label">${label}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;
  const totals = `<div class="stats-totals">
    ${cardBox('Tokens', fmtTokens(t.tokens), `${fmtTokens(t.tokens_out)} output`)}
    ${cardBox('Lines', `<span class="add">+${t.lines_added}</span> <span class="del">−${t.lines_removed}</span>`)}
    ${cardBox('Time', fmtDur(t.ms))}
    ${cardBox('Cards', t.cards)}
  </div>`;
  const rows = stats.agents
    .map(
      (a) =>
        `<div class="stat-row"><div class="stat-agent">${esc(a.agent)}</div><div class="stat-cols"><span>${a.cards} card${a.cards === 1 ? '' : 's'}</span><span>${fmtDur(a.ms)}</span><span class="add">+${a.lines_added}</span><span class="del">−${a.lines_removed}</span><span class="tok">${fmtTokens(a.tokens)} tok</span></div></div>`,
    )
    .join('');
  host.innerHTML = `${totals}<div class="stats-h">By agent</div><div class="st-list">${rows}</div>`;
}

// stall/grace signals fire no WS event — poll so quiet agents still surface.
setInterval(refreshAttention, 30000);

// ── attention queue: the "needs you now" list ───────────────────────
let attentionItems = [];
let initialViewSet = false;
const SEV_LABEL = { blocker: 'Blockers', warn: 'Needs attention', info: 'FYI' };

async function refreshAttention() {
  if (!projectId) return;
  try {
    attentionItems = await (await gitApi(`/attention?project=${projectId}`)).json();
  } catch {
    attentionItems = [];
  }
  const blockers = attentionItems.filter((i) => i.severity === 'blocker').length;
  const warns = attentionItems.filter((i) => i.severity === 'warn').length;
  railAttention.dataset.count = blockers || warns || '';
  railAttention.dataset.sev = blockers ? 'blocker' : warns ? 'warn' : '';
  if (activeView === 'attention') renderAttention();
  // default view on first load, honoring the user's Settings choice — unless
  // ?view=dashboard is pending the workspace probe (it wins if the dashboard opens).
  if (!initialViewSet) {
    if (URL_VIEW === 'dashboard') await dashProbe;
    if (initialViewSet) return;
    initialViewSet = true;
    const dv = SETTINGS.defaultView;
    if (dv === 'attention' || (dv === 'smart' && blockers)) setView('attention');
  }
}

function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function renderAttention() {
  const office = SETTINGS.office;
  document.getElementById('attention-list').classList.toggle('hidden', office);
  document.getElementById('office').classList.toggle('hidden', !office);
  if (office) return renderOffice();
  const host = document.getElementById('attention-list');
  if (attentionItems.length === 0) {
    host.innerHTML = '<div class="att-empty">All clear — nothing needs you.</div>';
    return;
  }
  host.replaceChildren(
    ...['blocker', 'warn', 'info'].flatMap((sev) => {
      const rows = attentionItems.filter((i) => i.severity === sev);
      if (!rows.length) return [];
      const head = document.createElement('div');
      head.className = 'att-group';
      head.textContent = SEV_LABEL[sev];
      return [
        head,
        ...rows.map((i) => {
          const meta = [`${ago(i.since)} in state`];
          if (i.blocking) meta.push(`<span class="att-blocks">blocks ${i.blocking}</span>`);
          if (i.agent) meta.push(esc(i.agent));
          const b = document.createElement('button');
          b.className = `att-row ${esc(i.severity)}`;
          b.innerHTML = `<span class="att-dot"></span><span class="att-main"><span class="att-title">${esc(i.title)}</span><span class="att-reason">${esc(i.reason)}</span></span><span class="att-meta">${meta.join(' · ')}</span><span class="att-arrow">→</span>`;
          b.onclick = () => openCardModal(i.card_id);
          return b;
        }),
      ];
    }),
  );
}

// ── office simulation: agents mill about; attention items on the right ──
// world layout in px (matches the SVG floorplan viewBox 1400×880)
const WS_RECT = { x: 110, y: 388, w: 770, h: 184 }; // workspace desks (in the walkway band)
const DOORS = { A: { x: 380, y: 372 }, B: { x: 1020, y: 372 }, L: { x: 700, y: 590 } };
const MEET_SEATS = {
  A: [{ x: 318, y: 140 }, { x: 438, y: 140 }, { x: 318, y: 278 }, { x: 438, y: 278 }, { x: 238, y: 206 }, { x: 518, y: 206 }],
  B: [{ x: 958, y: 140 }, { x: 1078, y: 140 }, { x: 958, y: 278 }, { x: 1078, y: 278 }, { x: 878, y: 206 }, { x: 1158, y: 206 }],
};
const LOUNGE_SEATS = [{ x: 171, y: 756 }, { x: 275, y: 756 }, { x: 379, y: 756 }, { x: 1021, y: 756 }, { x: 1125, y: 756 }, { x: 1229, y: 756 }];
const WANDER = { x: 920, y: 400, w: 400, h: 160 };
let OFFICE_SCALE = 1;

function packZone(n, r) {
  if (n <= 0) return [];
  const cols = Math.max(1, Math.round(Math.sqrt(n * (r.w / r.h))));
  const rows = Math.ceil(n / cols);
  const cw = r.w / cols;
  const ch = r.h / rows;
  const out = [];
  for (let i = 0; i < n; i++) out.push({ x: r.x + cw * ((i % cols) + 0.5), y: r.y + ch * (Math.floor(i / cols) + 0.5) });
  return out;
}

function deskSVG(x, y) {
  return `<g transform="translate(${x.toFixed(0)},${y.toFixed(0)})"><rect x="-58" y="-64" width="116" height="54" rx="8" fill="#2b3242"/><rect x="-58" y="-64" width="116" height="9" rx="5" fill="#39425a"/><rect x="-24" y="-58" width="48" height="32" rx="4" fill="#0f1219"/><rect x="-19" y="-54" width="38" height="24" rx="2" fill="url(#screen)"/><rect x="-17" y="-22" width="34" height="9" rx="3" fill="#222836"/><rect x="-15" y="-4" width="30" height="26" rx="9" fill="#3a4356"/><rect x="-15" y="-8" width="30" height="8" rx="4" fill="#454f68"/></g>`;
}

// ── walking: a single rAF loop steps every agent along its waypoint path ──
function pathTo(fromZone, toZone, x, y) {
  const wps = [];
  if (fromZone === 'A' || fromZone === 'B' || fromZone === 'L') wps.push(DOORS[fromZone]); // exit a room through its door
  if (toZone === 'A' || toZone === 'B' || toZone === 'L') wps.push(DOORS[toZone]); // enter through the door
  wps.push({ x, y });
  return wps;
}
function setAgentXform(el) {
  el.style.transform = `translate(${(el._px - 24).toFixed(1)}px, ${(el._py - 46).toFixed(1)}px) scale(${OFFICE_SCALE})`;
}
let officeRAF = null;
let officeLastT = 0;
function officeAnimate(t) {
  const dt = officeLastT ? Math.min(0.05, (t - officeLastT) / 1000) : 0.016;
  officeLastT = t;
  const host = document.getElementById('office-agents');
  const SPEED = 240; // px/sec
  for (const el of host.children) {
    if (!el.dataset.name || !el._path) continue;
    const wp = el._path[el._pathI];
    if (!wp) { el._path = null; el.classList.remove('walking'); continue; }
    const dx = wp.x - el._px;
    const dy = wp.y - el._py;
    const d = Math.hypot(dx, dy);
    const step = SPEED * dt;
    if (d <= step) {
      el._px = wp.x;
      el._py = wp.y;
      if (++el._pathI >= el._path.length) { el._path = null; el.classList.remove('walking'); }
    } else {
      el._px += (dx / d) * step;
      el._py += (dy / d) * step;
      el.classList.add('walking');
    }
    setAgentXform(el);
  }
  officeRAF = activeView === 'attention' && SETTINGS.office && host.children.length ? requestAnimationFrame(officeAnimate) : null;
}
function startOfficeAnim() {
  if (!officeRAF) { officeLastT = 0; officeRAF = requestAnimationFrame(officeAnimate); }
}

const accentFor = (name) => ACCENTS[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % ACCENTS.length];
function officeCharSVG(color) {
  return `<svg viewBox="0 0 40 50" width="40" height="50" aria-hidden="true"><ellipse cx="20" cy="46" rx="11" ry="3.4" fill="rgba(0,0,0,0.4)"/><rect x="10" y="23" width="20" height="20" rx="8" fill="${esc(color)}"/><rect x="10" y="23" width="20" height="7" rx="3.5" fill="rgba(255,255,255,0.14)"/><circle cx="20" cy="15" r="11" fill="#f2d6ba"/><path d="M9.4 13.5 a10.6 10.6 0 0 1 21.2 0 q-10.6 -7.5 -21.2 0 z" fill="#2e2820"/><circle cx="16" cy="15.5" r="1.5" fill="#2b2b2b"/><circle cx="24" cy="15.5" r="1.5" fill="#2b2b2b"/><path d="M17 19 q3 2 6 0" stroke="#cc9988" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>`;
}

// the Claude teammate: clay body + a little antenna, so it reads as an AI worker
function claudeCharSVG() {
  return `<svg viewBox="0 0 40 50" width="40" height="50" aria-hidden="true"><ellipse cx="20" cy="46" rx="11" ry="3.4" fill="rgba(0,0,0,0.4)"/><line x1="20" y1="6" x2="20" y2="1.8" stroke="#b0532f" stroke-width="1.4"/><circle cx="20" cy="1.4" r="1.8" fill="#d97757"/><rect x="10" y="23" width="20" height="20" rx="8" fill="#d97757"/><rect x="10" y="23" width="20" height="7" rx="3.5" fill="rgba(255,255,255,0.18)"/><circle cx="20" cy="15" r="11" fill="#f2d6ba"/><path d="M9.4 13.5 a10.6 10.6 0 0 1 21.2 0 q-10.6 -7.5 -21.2 0 z" fill="#d97757"/><circle cx="16" cy="15.5" r="1.5" fill="#2b2b2b"/><circle cx="24" cy="15.5" r="1.5" fill="#2b2b2b"/><path d="M17 19 q3 2 6 0" stroke="#c15f3c" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>`;
}

// one Claude companion per room so a meeting is never a solo monologue
const phantoms = {};
function syncPhantom(room, seat) {
  const host = document.getElementById('office-agents');
  let el = phantoms[room];
  if (el && !el.isConnected) el = phantoms[room] = null; // a roster rebuild dropped it
  if (!seat) { if (el) el.style.display = 'none'; return; }
  if (!el) {
    el = document.createElement('div');
    el.className = 'office-agent office-phantom';
    el.innerHTML = `${claudeCharSVG()}<div class="oa-label">Claude</div>`;
    host.appendChild(el);
    phantoms[room] = el;
  }
  el.style.display = '';
  el._px = seat.x;
  el._py = seat.y;
  setAgentXform(el);
}

let officeTimer = null;
let officeAgentKey = '';

function officeStateOf(name) {
  let meeting = false;
  for (const c of cards.values()) {
    if (c.agent !== name) continue;
    if (c.lane === 'in_progress') return 'working';
    if (c.lane === 'in_review') meeting = true;
  }
  return meeting ? 'meeting' : 'idle';
}

// an agent with a blocked card is stuck waiting on the human — raise its hand
function officeBlockedOf(name) {
  for (const c of cards.values()) if (c.agent === name && c.blocked) return true;
  return false;
}

let lastDeskCount = -1;
function layoutOffice() {
  const kids = [...document.getElementById('office-agents').children].filter((el) => el.dataset.name);
  // stable desk slot per agent — DOM order holds steady until the roster changes, so
  // an agent always owns (and walks back to) the same workstation.
  kids.forEach((el, i) => { el._slot = i; });
  const working = [];
  const review = [];
  const idle = [];
  for (const el of kids) {
    const st = officeStateOf(el.dataset.name);
    const blocked = officeBlockedOf(el.dataset.name);
    el.classList.toggle('working', st === 'working');
    el.classList.toggle('meeting', st === 'meeting');
    el.classList.toggle('blocked', blocked);
    const bubble = el.querySelector('.oa-bubble');
    if (bubble) bubble.textContent = blocked ? '✋' : '💭';
    (st === 'working' ? working : st === 'meeting' ? review : idle).push(el);
  }
  OFFICE_SCALE = kids.length <= 8 ? 1 : kids.length <= 14 ? 0.85 : kids.length <= 22 ? 0.72 : 0.6;

  // one PERMANENT desk per agent — count tracks the whole roster, not who's currently
  // working, so workstations never appear/disappear as agents come and go.
  const deskN = Math.min(Math.max(kids.length, 3), 15);
  const deskPos = packZone(deskN, WS_RECT);
  if (deskN !== lastDeskCount) {
    lastDeskCount = deskN;
    document.getElementById('fp-desks').innerHTML = deskPos.map((p) => deskSVG(p.x, p.y)).join('');
  }

  // send each agent to its spot: new ones appear instantly, the rest walk (path via doors)
  const target = (el, zone, x, y) => {
    if (el._px === undefined) { el._zone = zone; el._tx = x; el._ty = y; el._px = x; el._py = y; el._path = null; setAgentXform(el); return; }
    if (el._zone === zone && Math.hypot((el._tx ?? x) - x, (el._ty ?? y) - y) < 10) return;
    el._path = pathTo(el._zone, zone, x, y);
    el._pathI = 0;
    el._zone = zone;
    el._tx = x;
    el._ty = y;
  };
  // each worker returns to its own assigned desk (its stable slot)
  working.forEach((el) => { const p = deskPos[Math.min(el._slot, deskPos.length - 1)]; target(el, 'work', p.x, p.y - 4); });

  // meetings: group agents by room, then never leave anyone meeting alone
  const roomAgents = { A: [], B: [] };
  review.forEach((el, i) => { roomAgents[i % 2 === 0 ? 'A' : 'B'].push(el); });
  for (const room of ['A', 'B']) {
    const seats = MEET_SEATS[room];
    roomAgents[room].forEach((el, j) => { const s = seats[j % seats.length]; target(el, room, s.x, s.y); });
    // a lone agent gets a Claude companion across the table so it looks like a discussion
    syncPhantom(room, roomAgents[room].length === 1 ? seats[3] : null);
  }

  let l = 0;
  idle.forEach((el) => {
    if (l < LOUNGE_SEATS.length) { target(el, 'L', LOUNGE_SEATS[l].x, LOUNGE_SEATS[l].y); l++; }
    // wanderers: only pick a new spot once they've arrived, so we don't reset a walk mid-stride
    else if (el._zone !== 'open' || (!el._path && Math.random() < 0.5)) {
      target(el, 'open', WANDER.x + Math.random() * WANDER.w, WANDER.y + Math.random() * WANDER.h);
    }
  });
  startOfficeAnim();
}

function renderOfficeAttn() {
  const items = attentionItems || [];
  const blockers = items.filter((i) => i.severity === 'blocker').length;
  document.getElementById('oa-count').textContent = items.length || '';
  document.getElementById('office-attn').classList.toggle('alert', blockers > 0);
  document.getElementById('office-attn-list').replaceChildren(
    ...items.map((i) => {
      const el = document.createElement('div');
      el.className = `oa-item ${esc(i.severity)}`;
      el.innerHTML = `<div class="oai-title">${esc(i.title)}</div><div class="oai-reason">${esc(i.reason)}</div>`;
      el.onclick = () => openCardModal(i.card_id);
      return el;
    }),
  );
}

async function renderOffice() {
  let team = [];
  try {
    team = await (await fetch('/team')).json();
  } catch {
    /* fall back to agents already on cards */
  }
  const map = new Map();
  for (const m of team) map.set(m.name, m.color || accentFor(m.name));
  for (const c of cards.values()) if (c.agent && !map.has(c.agent)) map.set(c.agent, accentFor(c.agent));
  const key = [...map.keys()].sort().join('|');
  const host = document.getElementById('office-agents');
  if (key !== officeAgentKey) {
    officeAgentKey = key;
    if (map.size === 0) {
      host.innerHTML = '<div class="office-empty">The office is quiet.<br>Add team members in Settings → Team to bring it to life.</div>';
    } else {
      host.replaceChildren(
        ...[...map.entries()].map(([name, color]) => {
          const el = document.createElement('div');
          el.className = 'office-agent';
          el.dataset.name = name;
          el.innerHTML = `<div class="oa-bubble">💭</div>${officeCharSVG(color)}<div class="oa-label">${esc(name)}</div>`;
          return el;
        }),
      );
    }
  }
  layoutOffice();
  renderOfficeAttn();
  if (!officeTimer) {
    officeTimer = setInterval(() => {
      if (activeView === 'attention' && SETTINGS.office) layoutOffice();
    }, 3400);
  }
}

document.getElementById('office-attn-tab').onclick = () =>
  document.getElementById('office-attn').classList.toggle('collapsed');

// ── phases: master list (left) + detail reading pane (right) ────────
let selectedPhaseId = null;

function cardsByPhase() {
  const by = new Map();
  for (const c of cards.values()) {
    if (!c.phase_id) continue;
    if (!by.has(c.phase_id)) by.set(c.phase_id, []);
    by.get(c.phase_id).push(c);
  }
  return by;
}

function renderPhaseList() {
  document.getElementById('drawer-count').textContent = phases.length
    ? `${phases.length} phase${phases.length === 1 ? '' : 's'}`
    : '';
  const list = document.getElementById('phase-list');
  if (phases.length === 0) {
    selectedPhaseId = null;
    list.innerHTML = '<div class="pd-empty">No planned phases.</div>';
    return renderPhaseDetail();
  }
  if (!phases.some((p) => p.id === selectedPhaseId)) {
    selectedPhaseId = (phases.find((p) => p.status === 'active') ?? phases[0]).id;
  }
  const by = cardsByPhase();
  list.replaceChildren(
    ...phases.map((p) => {
      const pc = by.get(p.id) ?? [];
      const done = pc.filter((c) => c.lane === 'done').length;
      const btn = document.createElement('button');
      btn.className = `pl-item ${esc(p.status)}${p.id === selectedPhaseId ? ' sel' : ''}`;
      btn.innerHTML = `<span class="pl-dot"></span><span class="pl-name">${esc(p.title)}</span><span class="pl-prog">${done}/${pc.length}</span>`;
      btn.onclick = () => {
        selectedPhaseId = p.id;
        renderPhaseList();
      };
      return btn;
    }),
  );
  renderPhaseDetail();
}

function renderPhaseDetail() {
  const detail = document.getElementById('phase-detail');
  const p = phases.find((x) => x.id === selectedPhaseId);
  if (!p) {
    detail.innerHTML = `<div class="pd-empty">${phases.length ? 'Select a phase.' : 'No planned phases.'}</div>`;
    return;
  }
  const pc = cardsByPhase().get(p.id) ?? [];
  const done = pc.filter((c) => c.lane === 'done').length;
  const rows = pc.length
    ? pc
        .map(
          (c) =>
            `<li class="pd-card ${c.lane === 'done' ? 'done' : ''}"><span class="pd-check">${c.lane === 'done' ? '✓' : '○'}</span><span>${esc(c.title)}</span></li>`,
        )
        .join('')
    : '<li class="pd-card empty">no cards yet</li>';
  detail.innerHTML = `<div class="pd-detail"><div class="pd-detail-head"><span class="pd-detail-title">${esc(p.title)}</span><span class="pd-badge ${esc(p.status)}">${esc(p.status)}</span></div>${p.goal ? `<div class="pd-detail-goal">${esc(p.goal)}</div>` : ''}<h4>Cards ${done}/${pc.length}</h4><ul class="pd-cards">${rows}</ul></div>`;
}

function cardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = card.id;
  if (card.tag) el.dataset.tag = card.tag;
  if (card.blocked) el.classList.add('blocked');
  const meta = [
    card.blocked && `<span class="blocked-pill" title="${esc(card.blocked_reason ?? '')}">✋ blocked</span>`,
    card.tag && `<span class="tag">${esc(team(card.tag).name)}</span>`,
    card.agent && `<span class="agent">${esc(card.agent)}</span>`,
    card.skill && `<span class="skill">✦ ${esc(card.skill)}</span>`,
    card.rounds > 0 && `<span class="rounds${card.rounds >= 2 ? ' cap' : ''}">R${card.rounds}</span>`,
    card.subs && `<span class="subs">${card.subs.done}/${card.subs.total}</span>`,
  ].filter(Boolean).join('');
  const bar = card.subs
    ? `<div class="bar"><div class="bar-fill" style="width:${(100 * card.subs.done) / card.subs.total}%"></div></div>`
    : '';
  el.innerHTML = `<div class="title">${esc(card.title)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}${bar}`;
  el.onclick = () => openCardModal(card.id);
  return el;
}

// ── headline ticker: one plain-English event at a time ─────────────
// tool events are excluded — the live status (left) owns "doing right now";
// the headline owns "what just happened".
const HOLD_MS = 5000;
const QUEUE_MAX = 4;
const hq = [];
let headlineBusy = false;

function headline(ev) {
  const p = ev.payload ? JSON.parse(ev.payload) : {};
  const title = (id) => `“<span class="hl-title">${esc(cards.get(id)?.title ?? p.title ?? id ?? 'a card')}</span>”`;
  switch (ev.type) {
    case 'create': return `📋 New task: ${title(ev.task_id)}`;
    case 'move':
      if (p.to === 'done') return `🎉 ${title(ev.task_id)} is Done!`;
      return `➡️ ${title(ev.task_id)} moved to ${esc(LANE_NAME(p.to))}`;
    case 'assign': return `👷 ${title(ev.task_id)} assigned to ${esc(ev.agent ?? 'an agent')}`;
    case 'build_start': return `🔨 ${esc(ev.agent ?? 'builder')} started building ${title(ev.task_id)}`;
    case 'build_end': return `🔨 ${esc(ev.agent ?? 'builder')} finished building ${title(ev.task_id)}`;
    case 'review':
      return p.verdict === 'pass'
        ? `🔍 Review passed — ${title(ev.task_id)}`
        : `🔍 Review found issues on ${title(ev.task_id)} (round ${p.round ?? '?'})`;
    case 'subtasks': return `🧩 ${p.total ?? '?'} acceptance criteria set for ${title(ev.task_id)}`;
    case 'check':
      return `✅ Step ${p.progress ? `${p.progress.done} of ${p.progress.total}` : 'done'} on ${title(ev.task_id)}: ${esc(p.text ?? '')}`;
    case 'note': return p.msg ? `💬 ${esc(p.msg)}` : null;
    default: return null; // tool + anything unmappable: skip
  }
}

function pushHeadline(ev) {
  if (ev.type === 'tool') return;
  const html = headline(ev);
  if (!html) return;
  hq.push(html);
  if (hq.length > QUEUE_MAX) hq.shift(); // burst: drop oldest, never lag behind
  if (!headlineBusy) drainHeadlines();
}

function drainHeadlines() {
  if (hq.length === 0) {
    headlineBusy = false;
    return; // keep the last headline on screen until something new happens
  }
  headlineBusy = true;
  const html = hq.shift();
  headlineEl.classList.add('fade');
  setTimeout(() => {
    headlineEl.innerHTML = html;
    headlineEl.classList.remove('fade');
    setTimeout(drainHeadlines, HOLD_MS);
  }, 250);
}

function seedHeadline(events) {
  const last = events
    .slice()
    .reverse()
    .find((ev) => ev.type !== 'tool' && headline(ev));
  if (last) headlineEl.innerHTML = headline(last);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Inline formatting on already-escaped text: `code` and **bold**.
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// Tiny, safe markdown for card descriptions — headings, bullet/numbered
// lists, and paragraphs. Escapes first, so no HTML can slip through.
function renderMarkdown(src) {
  const lines = esc(src ?? '').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if (!line) { flushPara(); flushList(); }
    else if ((m = /^#{1,3}\s+(.*)$/.exec(line))) { flushPara(); flushList(); out.push(`<div class="md-h">${inlineMd(m[1])}</div>`); }
    else if ((m = /^[-*]\s+(.*)$/.exec(line))) { flushPara(); if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inlineMd(m[1])}</li>`); }
    else if ((m = /^\d+\.\s+(.*)$/.exec(line))) { flushPara(); if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inlineMd(m[1])}</li>`); }
    else { flushList(); para.push(inlineMd(line)); }
  }
  flushPara();
  flushList();
  return out.join('');
}

// ── card detail modal ───────────────────────────────────────────────
let openCardId = null;

const LANE_NAME = (l) => ({ backlog: 'Backlog', queued: 'Queued', in_progress: 'In Progress', in_review: 'In Review', done: 'Done' })[l] ?? l;

// One-shot ?card=<id> (e.g. from the dashboard's cross-board attention list):
// open that card once the board init has arrived, then drop the param.
let pendingCardParam = new URLSearchParams(location.search).get('card');
function openCardFromUrl() {
  if (!pendingCardParam) return;
  const id = pendingCardParam;
  pendingCardParam = null;
  const url = new URL(location.href);
  url.searchParams.delete('card');
  history.replaceState(null, '', url);
  if (cards.has(id)) openCardModal(id); // only this board's cards; anything else is dropped
}

async function openCardModal(cardId) {
  openCardId = cardId;
  document.getElementById('card-modal').classList.remove('hidden');
  await refreshCardModal();
}

function closeCardModal() {
  openCardId = null;
  document.getElementById('card-modal').classList.add('hidden');
}

async function refreshCardModal() {
  if (!openCardId) return;
  const res = await fetch(`/task/${openCardId}`);
  if (!res.ok) return closeCardModal();
  const task = await res.json();
  document.getElementById('card-title').textContent = task.title;
  const meta = [
    task.tag && `${team(task.tag).name} team`,
    LANE_NAME(task.lane),
    task.assigned_agent && `● ${task.assigned_agent}`,
    task.skill && `✦ ${task.skill}`,
    task.review_rounds > 0 && `review round ${task.review_rounds}`,
    task.branch,
  ].filter(Boolean);
  const act = task.activity;
  if (act && (act.tokens || act.lines_added || act.lines_removed)) {
    meta.push(`${fmtTokens(act.tokens)} tokens · ${fmtTokens(act.tokens_out)} out`);
    meta.push(`+${act.lines_added} −${act.lines_removed} lines`);
    if (act.ms) meta.push(fmtDur(act.ms));
  }
  document.getElementById('card-meta').innerHTML = meta.map((m) => `<span>${esc(m)}</span>`).join('');
  const blockedBox = document.getElementById('card-blocked');
  blockedBox.classList.toggle('hidden', !task.blocked_at);
  if (task.blocked_at) {
    document.getElementById('card-blocked-reason').textContent = task.blocked_reason ?? 'Needs your decision';
  }
  document.getElementById('card-desc').innerHTML = renderMarkdown(task.requirements);
  const subs = task.subtasks ?? [];
  const total = subs.length;
  const done = subs.filter((s) => s.done).length;
  const pct = total ? Math.round((100 * done) / total) : 0;
  document.getElementById('card-progress').textContent = total ? `${done} of ${total}` : '';
  document.getElementById('card-progressbar').style.display = total ? '' : 'none';
  document.getElementById('card-progressfill').style.width = `${pct}%`;
  // while a builder is on the card, flag the first unchecked criterion as "working"
  const activeIdx = task.lane === 'in_progress' ? subs.findIndex((s) => !s.done) : -1;
  document.getElementById('card-subs').innerHTML = total
    ? subs
        .map(
          (s, i) =>
            `<li class="${s.done ? 'done' : ''}${i === activeIdx ? ' active' : ''}"><span class="ck">${s.done ? '✓' : ''}</span><span class="txt">${esc(s.text)}</span>${i === activeIdx ? '<span class="sub-now">working</span>' : ''}</li>`,
        )
        .join('')
    : '<li class="empty">No acceptance criteria yet</li>';
}

document.getElementById('card-unblock').onclick = async () => {
  if (!openCardId) return;
  await fetch(`/task/${openCardId}/unblock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'resolved from overlay' }),
  });
  refreshCardModal();
};
document.getElementById('card-close').onclick = closeCardModal;
document.getElementById('card-modal').onclick = (e) => {
  if (e.target === document.getElementById('card-modal')) closeCardModal();
};

// ── git: source-control panel ───────────────────────────────────────
let projectId = null;
let selectedFile = null;

const $ = (id) => document.getElementById(id);

async function gitApi(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res;
}

// Lightweight change-count badge on the SCM rail icon (always visible).
async function refreshScmBadge() {
  if (!projectId) return void (railScm.dataset.count = '');
  try {
    const { files } = await (await gitApi(`/git/status?project=${projectId}`)).json();
    railScm.dataset.count = files.length ? String(files.length) : '';
  } catch {
    railScm.dataset.count = ''; // not a git repo / daemon hiccup
  }
}

async function refreshFiles() {
  const { branch, files, remote } = await (await gitApi(`/git/status?project=${projectId}`)).json();
  $('scm-branch').textContent = `${files.length} change${files.length === 1 ? '' : 's'} · ${branch}`;
  $('scm-attach').classList.toggle('hidden', !!remote);
  railScm.dataset.count = files.length ? String(files.length) : '';
  const list = $('git-files');
  list.replaceChildren(
    ...files.map((f) => {
      const li = document.createElement('li');
      const st = f.status === '??' ? 'U' : f.status[0];
      li.innerHTML = `<span class="st ${esc(st)}">${esc(st)}</span><span>${esc(f.path)}</span>`;
      li.onclick = () => selectFile(f.path, li);
      return li;
    }),
  );
  if (files.length) selectFile(files[0].path, list.firstChild);
  else $('git-diff').innerHTML = '<div class="dl meta"><span class="ln"></span><span class="ln"></span><span class="dt">working tree clean</span></div>';
}

async function selectFile(path, li) {
  selectedFile = path;
  for (const el of $('git-files').children) el.classList.toggle('sel', el === li);
  const diff = await (await gitApi(`/git/diff?project=${projectId}&file=${encodeURIComponent(path)}`)).text();
  $('git-diff').innerHTML = renderDiff(diff);
}

// GitHub-style unified diff: line-number gutters + green/red rows
function renderDiff(text) {
  let oldN = 0;
  let newN = 0;
  const row = (cls, o, n, t) =>
    `<div class="dl ${cls}"><span class="ln">${o}</span><span class="ln">${n}</span><span class="dt">${esc(t)}</span></div>`;
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => {
      if (line.startsWith('@@')) {
        const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (m) [oldN, newN] = [Number(m[1]), Number(m[2])];
        return row('hunk', '', '', line);
      }
      if (/^(diff |index |--- |\+\+\+ |new file|deleted file|rename |similarity |\\)/.test(line))
        return row('meta', '', '', line);
      if (line.startsWith('+')) return row('add', '', newN++, line);
      if (line.startsWith('-')) return row('del', oldN++, '', line);
      return row('ctx', oldN++, newN++, line);
    })
    .join('');
}

async function commitAndPush() {
  const message = $('commit-msg').value.trim();
  const result = $('git-result');
  if (!message) {
    result.textContent = 'commit message required';
    result.className = 'err';
    return;
  }
  const btn = $('commit-btn');
  btn.disabled = true;
  result.textContent = 'committing…';
  result.className = '';
  try {
    const out = await (
      await gitApi('/git/commit', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, message, description: $('commit-desc').value.trim() }),
      })
    ).json();
    result.textContent = out.pushed ? 'committed and pushed ✓' : `committed ✓ — push failed: ${out.push_error}`;
    result.className = out.pushed ? 'ok' : 'err';
    if (out.ok) {
      $('commit-msg').value = '';
      $('commit-desc').value = '';
    }
    await refreshFiles();
  } catch (err) {
    result.textContent = err.message;
    result.className = 'err';
  } finally {
    btn.disabled = false;
  }
}

$('commit-btn').onclick = commitAndPush;
$('scm-attach-btn').onclick = async () => {
  const url = (prompt('GitHub repo URL to attach:') || '').trim();
  if (!url) return;
  const out = await (await fetch(`/project/${projectId}/repo`, { method: 'POST', body: JSON.stringify({ url }) })).json();
  if (!out.ok) return alert(out.error || 'Could not attach the repo.');
  refreshFiles();
};

// ── embedded terminal (opt-in; VS Code-style bottom panel) ──────────
// One xterm + /pty socket per tab, created lazily and kept alive (hidden) when
// switching. A standalone project has a single tab rendered straight into
// #term-host; a workspace gets a tab strip — Main + one per vertical — with each
// tab in its own pane.
const term = { enabled: false, token: null, open: false, tabs: new Map(), active: null, workspace: null };
const termPanel = $('terminal-panel');
const termBtn = $('term-btn');

const currentProject = () => new URLSearchParams(location.search).get('project') || projectId;
const activeTab = () => term.tabs.get(term.active) ?? null;
const ptyQuery = (project) => `project=${encodeURIComponent(project)}&token=${encodeURIComponent(term.token)}`;

let connFlash = null; // timer while a transient message (Start agent result) owns #term-conn

function renderTermConn() {
  if (connFlash) return;
  const tab = activeTab();
  const el = $('term-conn');
  el.textContent = tab ? tab.conn.text : 'waiting for project…';
  el.className = `term-conn ${tab ? tab.conn.cls : ''}`;
}

function setTermConn(tab, text, cls = '') {
  tab.conn = { text, cls };
  if (tab.id === term.active) renderTermConn();
}

function flashTermConn(text, cls = '') {
  clearTimeout(connFlash);
  const el = $('term-conn');
  el.textContent = text;
  el.className = `term-conn ${cls}`;
  connFlash = setTimeout(() => {
    connFlash = null;
    renderTermConn();
  }, 4000);
}

async function initTerminal() {
  let cfg;
  try {
    cfg = await (await fetch('/config')).json();
  } catch {
    return; // daemon hiccup — leave the terminal off
  }
  if (!cfg.terminal) return;
  term.enabled = true;
  term.token = cfg.token;
  termBtn.classList.remove('hidden');
  const h = Number(localStorage.getItem('term.height'));
  if (h) termPanel.style.height = `${h}px`;
  if (localStorage.getItem('term.open') === '1') openTerm();
  if (activeView === 'dashboard') renderDashboard(); // tiles gain their ❯_ buttons
}

function makeTab(id, name) {
  return { id, name, xterm: null, fit: null, ws: null, pane: null, btn: null, conn: { text: 'connecting…', cls: '' }, dead: false };
}

// A tab's own pane inside #term-host (workspace mode only). Moves an xterm that
// was opened standalone into it, for when a project gains its first vertical.
function ensurePane(tab) {
  if (!tab.pane) {
    tab.pane = document.createElement('div');
    tab.pane.className = 'term-pane';
    $('term-host').appendChild(tab.pane);
    if (tab.xterm?.element) tab.pane.appendChild(tab.xterm.element);
  }
  return tab.pane;
}

function ensureXterm(tab) {
  if (tab.xterm) return;
  const xterm = new Terminal({
    fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0b0d12', foreground: '#e8eaf0', cursor: '#5dd3a8', selectionBackground: 'rgba(93,211,168,0.3)' },
  });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(term.workspace ? ensurePane(tab) : $('term-host'));
  xterm.onData((d) => tab.ws?.readyState === 1 && tab.ws.send(JSON.stringify({ t: 'i', d })));
  tab.xterm = xterm;
  tab.fit = fit;
}

function disposeTab(tab) {
  tab.dead = true;
  tab.ws?.close();
  tab.xterm?.dispose();
  tab.pane?.remove();
  tab.btn?.remove();
}

// fit + resize frame apply to the visible (active) tab only
function fitAndResize() {
  const tab = activeTab();
  if (!tab?.fit || termPanel.classList.contains('hidden')) return;
  try {
    tab.fit.fit();
  } catch {
    return;
  }
  if (tab.ws?.readyState === 1) tab.ws.send(JSON.stringify({ t: 'r', c: tab.xterm.cols, r: tab.xterm.rows }));
}

function termConnect(tab) {
  if (tab.dead) return;
  const ws = new WebSocket(`ws://${location.host}/pty?${ptyQuery(tab.id)}`);
  tab.ws = ws;
  setTermConn(tab, 'connecting…');
  ws.onopen = () => {
    setTermConn(tab, 'live', 'live');
    if (tab.id === term.active) fitAndResize();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t === 'o') tab.xterm.write(msg.d);
    else if (msg.t === 'x') tab.xterm.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
  };
  ws.onclose = () => {
    if (tab.ws === ws) tab.ws = null;
    if (tab.dead) return;
    setTermConn(tab, 'disconnected', 'dead');
    if (term.open) setTimeout(() => !tab.ws && termConnect(tab), 1500); // resume the shared session
  };
}

function renderTermTabs() {
  const strip = $('term-tabs');
  for (const tab of term.tabs.values()) tab.btn = null;
  strip.replaceChildren();
  strip.classList.toggle('hidden', !term.workspace);
  if (!term.workspace) return;
  for (const tab of term.tabs.values()) {
    const b = document.createElement('button');
    b.className = `term-tab${tab.id === term.active ? ' active' : ''}`;
    b.textContent = tab.name;
    b.title = tab.name === 'Main' ? 'Workspace shell' : `${tab.name} shell`;
    b.onclick = () => showTab(tab.id);
    tab.btn = b;
    strip.appendChild(b);
  }
  term.tabs.get(term.active)?.btn?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Sync tabs to a workspace's verticals: Main (the workspace) + one per vertical.
// No verticals → a single untabbed terminal (standalone behavior).
function setTermTabs(workspaceId, verticals) {
  const want = [{ id: workspaceId, name: 'Main' }, ...verticals.map((v) => ({ id: v.id, name: v.name }))];
  for (const [id, tab] of term.tabs) if (!want.some((w) => w.id === id)) disposeTab(tab); // vertical removed
  const next = new Map();
  for (const w of want) {
    const tab = term.tabs.get(w.id) ?? makeTab(w.id, w.name);
    tab.name = w.name;
    next.set(w.id, tab);
  }
  term.tabs = next;
  term.workspace = verticals.length ? workspaceId : null;
  if (term.workspace) for (const tab of term.tabs.values()) if (tab.xterm) ensurePane(tab);
  let remembered = null;
  if (term.workspace) {
    try {
      remembered = localStorage.getItem(`term.tab.${term.workspace}`);
    } catch {
      /* storage unavailable — fall back to the current project */
    }
  }
  const prev = term.active;
  term.active = [prev, remembered, currentProject(), workspaceId].find((id) => id && term.tabs.has(id));
  renderTermTabs();
  if (term.open && prev && term.active !== prev) showTab(term.active); // the active vertical went away
}

async function refreshTermTabs() {
  const project = currentProject();
  if (!project) return;
  let view = null;
  try {
    const res = await fetch(`/workspace?project=${encodeURIComponent(project)}`);
    if (res.ok) view = await res.json();
  } catch {
    // daemon hiccup — keep whatever tabs we have
  }
  if (view) setTermTabs(view.workspace.id, view.verticals);
  else if (!term.tabs.size) setTermTabs(project, []);
}

function showTab(id) {
  const tab = term.tabs.get(id);
  if (!tab) return;
  term.active = id;
  if (term.workspace) {
    try {
      localStorage.setItem(`term.tab.${term.workspace}`, id);
    } catch {
      /* storage unavailable — just don't remember */
    }
  }
  ensureXterm(tab);
  for (const t of term.tabs.values()) {
    t.pane?.classList.toggle('hidden', t !== tab);
    t.btn?.classList.toggle('active', t === tab);
  }
  tab.btn?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  clearTimeout(connFlash);
  connFlash = null;
  renderTermConn();
  if (!tab.ws) termConnect(tab);
  requestAnimationFrame(() => {
    if (tab.id !== term.active) return;
    fitAndResize(); // refit on switch — the pane was hidden, so the shell may be stale-sized
    tab.xterm.focus();
  });
}

// board WS: a vertical was created/deleted in this workspace
function onVerticals(msg) {
  if (!term.enabled || msg.project_id !== (term.workspace ?? currentProject())) return;
  setTermTabs(msg.project_id, msg.verticals ?? []);
}

async function openTerm() {
  termPanel.classList.remove('hidden');
  termBtn.classList.add('on');
  term.open = true;
  localStorage.setItem('term.open', '1');
  await refreshTermTabs(); // also catches verticals added while the board WS watched a vertical's channel
  if (!term.open) return;
  if (!term.active) {
    renderTermConn();
    setTimeout(() => term.open && !term.active && openTerm(), 1000); // init WS hasn't landed yet
    return;
  }
  showTab(term.active);
}

function closeTerm() {
  // detach the view but keep the shared shells (and their ws) alive server-side
  termPanel.classList.add('hidden');
  termBtn.classList.remove('on');
  term.open = false;
  localStorage.setItem('term.open', '0');
}

function toggleTerm() {
  if (!term.enabled) return;
  termPanel.classList.contains('hidden') ? openTerm() : closeTerm();
}

// Kill the active tab's shell and reattach to a fresh one (deliberate reset).
async function newTermSession() {
  const tab = activeTab();
  if (!tab) return;
  try {
    await fetch(`/pty/reset?${ptyQuery(tab.id)}`, { method: 'POST' });
  } catch {
    // ignore — reconnecting still spawns a fresh shell if the old one is gone
  }
  tab.xterm?.reset();
  if (tab.ws?.readyState === 1) tab.ws.close(); // onclose auto-reconnects → fresh session
  else termConnect(tab);
}

// Launch `claude` in the active tab's shell (the daemon only types into an idle shell).
async function startTermAgent() {
  const tab = activeTab();
  if (!tab) return;
  const btn = $('term-agent');
  btn.disabled = true;
  let text;
  let cls = 'dead';
  try {
    const res = await fetch(`/pty/agent?${ptyQuery(tab.id)}`, { method: 'POST' });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) text = out.error || `error ${res.status}`;
    else if (out.started) [text, cls] = ['agent started', 'live'];
    else text = `busy: ${out.foreground || out.reason || 'shell'}`;
  } catch {
    text = 'agent start failed';
  }
  btn.disabled = false;
  if (tab.id !== term.active) return; // switched away meanwhile
  flashTermConn(text, cls);
  tab.xterm?.focus();
}

termBtn.onclick = toggleTerm;
$('term-new').onclick = newTermSession;
$('term-agent').onclick = startTermAgent;
$('term-hide').onclick = closeTerm;
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleTerm(); }
});
window.addEventListener('resize', fitAndResize);

// Guard against dropping a live terminal session by an accidental close/reload.
// (The shell survives server-side, but the tab loses its view — so confirm.)
window.addEventListener('beforeunload', (e) => {
  if (term.open && [...term.tabs.values()].some((t) => t.ws?.readyState === 1)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// drag the top edge to resize the panel
$('term-resize').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startH = termPanel.getBoundingClientRect().height;
  const onMove = (ev) => {
    termPanel.style.height = `${Math.max(90, Math.min(window.innerHeight - 160, startH + (startY - ev.clientY)))}px`;
    fitAndResize();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    localStorage.setItem('term.height', String(Math.round(termPanel.getBoundingClientRect().height)));
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// ── settings: appearance, skills, team ──────────────────────────────
const SETTINGS = {
  accent: localStorage.getItem('settings.accent') || '#5dd3a8',
  reduceMotion: localStorage.getItem('settings.reduceMotion') === '1',
  defaultView: localStorage.getItem('settings.defaultView') || 'smart',
  office: localStorage.getItem('settings.office') === '1',
};
const ACCENTS = ['#5dd3a8', '#61afef', '#b57edc', '#e5c07b', '#e06c75', '#56b6c2'];

function applySettings() {
  document.documentElement.style.setProperty('--accent', SETTINGS.accent);
  document.body.classList.toggle('reduce-motion', SETTINGS.reduceMotion);
}
applySettings();

function showSettingsTab(tab) {
  for (const b of document.querySelectorAll('.st-tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('.st-panel')) p.classList.toggle('hidden', p.dataset.panel !== tab);
  if (tab === 'skills') loadSkills();
  if (tab === 'team') loadTeam();
}

function renderGeneral() {
  $('accent-swatches').replaceChildren(
    ...ACCENTS.map((c) => {
      const b = document.createElement('button');
      b.className = `swatch${c === SETTINGS.accent ? ' sel' : ''}`;
      b.style.background = c;
      b.title = c;
      b.onclick = () => {
        SETTINGS.accent = c;
        localStorage.setItem('settings.accent', c);
        applySettings();
        renderGeneral();
      };
      return b;
    }),
  );
  const rm = $('opt-reduce-motion');
  rm.checked = SETTINGS.reduceMotion;
  rm.onchange = () => {
    SETTINGS.reduceMotion = rm.checked;
    localStorage.setItem('settings.reduceMotion', rm.checked ? '1' : '0');
    applySettings();
  };
  const dv = $('opt-default-view');
  dv.value = SETTINGS.defaultView;
  dv.onchange = () => {
    SETTINGS.defaultView = dv.value;
    localStorage.setItem('settings.defaultView', dv.value);
  };
  const off = $('opt-office');
  off.checked = SETTINGS.office;
  off.onchange = () => {
    SETTINGS.office = off.checked;
    localStorage.setItem('settings.office', off.checked ? '1' : '0');
    if (activeView === 'attention') renderAttention();
  };
}

let skillsCache = [];

// The header's primary action is contextual: create from the list, edit from a
// detail, hidden while editing.
function setSkillHeadAction(mode, skill) {
  const btn = $('skill-new-btn');
  btn.classList.toggle('hidden', mode === 'editor');
  if (mode === 'detail') {
    btn.textContent = 'Edit skill';
    btn.onclick = () => openSkillEditor(skill);
  } else {
    btn.textContent = 'New skill';
    btn.onclick = () => openSkillEditor(null);
  }
}

// minimal markdown → HTML for the skill body (headings, code, inline code, bold)
function mdToHtml(md) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const lines = String(md ?? '').split('\n');
  let html = '';
  let inCode = false;
  let para = [];
  const flush = () => {
    if (para.length) html += `<p>${inline(para.join(' '))}</p>`;
    para = [];
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) html += '</code></pre>';
      else { flush(); html += '<pre><code>'; }
      inCode = !inCode;
      continue;
    }
    if (inCode) { html += esc(line) + '\n'; continue; }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { flush(); html += `<h3>${inline(h[1])}</h3>`; continue; }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  if (inCode) html += '</code></pre>';
  flush();
  return html;
}

async function loadSkills() {
  try {
    skillsCache = await (await fetch(`/skills?project=${encodeURIComponent(projectId ?? '')}`)).json();
  } catch {
    skillsCache = [];
  }
  $('skill-detail').classList.add('hidden');
  const list = $('skills-list');
  list.classList.remove('hidden');
  setSkillHeadAction('list');
  if (!skillsCache.length) {
    list.innerHTML = '<div class="st-empty">No skills found in ~/.claude/skills or this project.<br>Create one to get started.</div>';
  } else {
    list.replaceChildren(
      ...skillsCache.map((s) => {
        const b = document.createElement('button');
        b.className = 'sk-row';
        b.innerHTML = `<span class="sk-icon">✦</span><span class="sk-info"><div class="sk-name">${esc(s.name)}</div><div class="sk-desc">${esc(s.description)}</div></span><span class="sk-src">${esc(s.source)}</span><span class="sk-chevron">›</span>`;
        b.onclick = () => openSkillDetail(s.name);
        return b;
      }),
    );
  }
  populateSkillSelect();
}

async function openSkillDetail(name) {
  let skill;
  try {
    skill = await (await fetch(`/skills/${encodeURIComponent(name)}?project=${encodeURIComponent(projectId ?? '')}`)).json();
  } catch {
    return;
  }
  $('skills-list').classList.add('hidden');
  const d = $('skill-detail');
  d.classList.remove('hidden');
  d.innerHTML = `<button class="st-back">‹ All skills</button>
    <div class="sd-title">${esc(skill.name)}</div>
    <div class="sd-desc">${esc(skill.description)}</div>
    <div class="sd-body">${mdToHtml(skill.body)}</div>`;
  d.querySelector('.st-back').onclick = loadSkills;
  setSkillHeadAction('detail', skill);
}

function openSkillEditor(skill) {
  const editing = !!skill;
  $('skills-list').classList.add('hidden');
  const d = $('skill-detail');
  d.classList.remove('hidden');
  setSkillHeadAction('editor');
  d.innerHTML = `<button class="st-back">‹ ${editing ? 'Back' : 'All skills'}</button>
    <div class="sd-edit">
      <label>Name</label>
      <input id="sk-name" value="${editing ? esc(skill.name) : ''}" ${editing ? 'disabled' : ''} placeholder="my-skill" />
      <label>Description — one line: what it does and when to use it</label>
      <input id="sk-desc" value="${editing ? esc(skill.description) : ''}" placeholder="Short summary…" />
      <label>Instructions (markdown)</label>
      <textarea id="sk-body" placeholder="Step-by-step guidance for this skill…">${editing ? esc(skill.body) : ''}</textarea>
      <div class="sd-actions">
        <button class="st-ghost" id="sk-cancel">Cancel</button>
        <button class="st-primary" id="sk-save">${editing ? 'Save changes' : 'Create skill'}</button>
      </div>
    </div>`;
  d.querySelector('.st-back').onclick = loadSkills;
  $('sk-cancel').onclick = loadSkills;
  $('sk-save').onclick = async () => {
    const name = $('sk-name').value.trim();
    if (!name) return;
    const payload = { name, description: $('sk-desc').value.trim(), body: $('sk-body').value };
    if (editing) {
      await fetch(`/skills/${encodeURIComponent(skill.name)}?project=${encodeURIComponent(projectId ?? '')}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await fetch('/skills', { method: 'POST', body: JSON.stringify(payload) });
    }
    await loadSkills();
  };
}

function populateSkillSelect() {
  const sel = $('team-skill');
  if (!sel) return;
  const cur = sel.value;
  const opt = (v, t) => Object.assign(document.createElement('option'), { value: v, textContent: t });
  sel.replaceChildren(opt('', 'No skill'), ...skillsCache.map((s) => opt(s.name, s.name)));
  sel.value = cur;
}

async function loadTeam() {
  if (!skillsCache.length) await loadSkills();
  let team = [];
  try {
    team = await (await fetch('/team')).json();
  } catch {
    team = [];
  }
  const host = $('team-list');
  if (!team.length) {
    host.innerHTML = '<div class="st-empty">No team members yet.<br>Add one to build your roster.</div>';
    return;
  }
  host.replaceChildren(
    ...team.map((m) => {
      const el = document.createElement('div');
      el.className = 'member';
      const initial = esc(((m.name || '?').trim()[0] ?? '?').toUpperCase());
      el.innerHTML = `<span class="m-avatar" style="background:${esc(m.color || '#5dd3a8')}">${initial}</span><span class="m-main"><div class="m-name">${esc(m.name)}</div><div class="m-id">${esc(m.id)}</div></span><span class="m-skill${m.skill ? '' : ' none'}">${m.skill ? esc(m.skill) : 'no skill'}</span><button class="m-del" title="Remove">✕</button>`;
      el.querySelector('.m-del').onclick = async () => {
        await fetch(`/team/${m.id}`, { method: 'DELETE' });
        loadTeam();
      };
      return el;
    }),
  );
}

async function addTeamMember() {
  const name = $('team-name').value.trim();
  if (!name) return;
  const skill = $('team-skill').value || null;
  const color = ACCENTS[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % ACCENTS.length];
  await fetch('/team', { method: 'POST', body: JSON.stringify({ name, skill, color }) });
  $('team-name').value = '';
  $('team-form').classList.add('hidden');
  loadTeam();
}

$('settings-btn').onclick = () => {
  $('settings-modal').classList.remove('hidden');
  showSettingsTab('general');
  renderGeneral();
};
$('settings-close').onclick = () => $('settings-modal').classList.add('hidden');
$('settings-modal').onclick = (e) => { if (e.target === $('settings-modal')) $('settings-modal').classList.add('hidden'); };
for (const b of document.querySelectorAll('.st-tab')) b.onclick = () => showSettingsTab(b.dataset.tab);
$('team-add-toggle').onclick = () => $('team-form').classList.toggle('hidden');
$('team-cancel').onclick = () => $('team-form').classList.add('hidden');
$('team-add-btn').onclick = addTeamMember;

// ── workspace dashboard: one live tile per board (Main + verticals) ───
// Also its own URL for an OBS scene: ?project=<id>&view=dashboard[&embed=1].
// Every user-controlled string goes in via textContent (node() below) — never innerHTML.
const URL_VIEW = new URLSearchParams(location.search).get('view');
const EMBED = new URLSearchParams(location.search).get('embed') === '1';
const dash = { checked: false, workspace: null, summary: null, failed: false, fetchRetry: 1000, ids: new Set(), ws: null, retry: 1000, retryTimer: null, refetchTimer: null, skipOpenFetch: false };
const DASH_LANES = [['backlog', 'backlog'], ['queued', 'queued'], ['in_progress', 'in prog'], ['in_review', 'review'], ['done', 'done']];
const DASH_STATE = { working: 'working', idle: 'idle', needs_you: '⚠ needs you', offline: 'offline' };
const DASH_MAX_CARDS = 5;

if (EMBED) document.body.classList.add('embed');
// Resolves once initDashboard's /workspace probe has settled; refreshAttention
// waits on it before applying the default view when ?view=dashboard is set.
let dashProbeDone;
const dashProbe = new Promise((r) => (dashProbeDone = r));

function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

// Once per page: is the current project part of a workspace? Shows the rail
// button, and honors ?view=dashboard.
async function initDashboard() {
  if (dash.checked) return;
  const project = currentProject();
  if (!project) return dashProbeDone();
  dash.checked = true;
  let view = null;
  try {
    const res = await fetch(`/workspace?project=${encodeURIComponent(project)}`);
    if (res.ok) view = await res.json();
  } catch {
    /* daemon hiccup — no dashboard button */
  }
  const inWorkspace = !!view && (view.verticals.length > 0 || view.workspace.id !== project);
  if (view) dash.workspace = view.workspace.id;
  railDashboard.classList.toggle('hidden', !inWorkspace);
  if (URL_VIEW === 'dashboard' && inWorkspace && !initialViewSet) {
    initialViewSet = true; // the URL wins over the default-view setting
    setView('dashboard');
  }
  dashProbeDone();
}

async function loadDashboard() {
  const project = dash.workspace ?? currentProject();
  if (!project) return;
  try {
    const res = await fetch(`/workspace/summary?project=${encodeURIComponent(project)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dash.summary = await res.json();
  } catch {
    dash.failed = true;
    if (activeView !== 'dashboard') return;
    if (dash.summary) renderDashHead(); // keep the stale tiles; flag "reconnecting…"
    else renderDashboard(); // "retrying…"
    clearTimeout(dash.refetchTimer);
    dash.refetchTimer = setTimeout(loadDashboard, dash.fetchRetry);
    dash.fetchRetry = Math.min(dash.fetchRetry * 2, 10000);
    return;
  }
  dash.failed = false;
  dash.fetchRetry = 1000;
  dash.workspace = dash.summary.workspace.id;
  dash.ids = new Set(dash.summary.boards.map((b) => b.project.id));
  if (activeView === 'dashboard') renderDashboard();
}

function scheduleDashboardRefetch() {
  clearTimeout(dash.refetchTimer);
  dash.refetchTimer = setTimeout(loadDashboard, 400);
}

function dashConnect() {
  const ws = new WebSocket(`ws://${location.host}/ws`); // no ?project= → every project
  dash.ws = ws;
  ws.onopen = () => {
    dash.retry = 1000;
    // openDashboard() already fetched on entry; refetch on RE-connects (catch
    // anything missed while disconnected) or when that fetch failed.
    const skip = dash.skipOpenFetch && !dash.failed;
    dash.skipOpenFetch = false;
    if (!skip) loadDashboard();
  };
  ws.onmessage = (e) => onDashboardMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (dash.ws !== ws) return; // closed on purpose (left the view)
    dash.ws = null;
    dash.retryTimer = setTimeout(dashConnect, dash.retry);
    dash.retry = Math.min(dash.retry * 2, 10000);
  };
}

function onDashboardMessage(msg) {
  const pid = msg.type === 'event' ? msg.event?.project_id : msg.project_id;
  if (!pid || !dash.ids.has(pid)) return;
  if (msg.type === 'status') {
    const b = dash.summary?.boards.find((x) => x.project.id === pid);
    if (!b || !msg.session) return;
    b.session = msg.session;
    const old = $('dashboard-body').querySelector(`.dash-tile[data-id="${CSS.escape(pid)}"]`);
    if (old) old.replaceWith(dashTile(b, dash.summary.boards.indexOf(b) === 0));
    renderDashHead();
    renderDashAttn();
  } else if (['card', 'card_removed', 'phases', 'verticals', 'event'].includes(msg.type)) {
    scheduleDashboardRefetch();
  }
}

function openDashboard() {
  renderDashboard(); // last good summary, or the loading state
  loadDashboard();
  if (!dash.ws && !dash.retryTimer) {
    dash.skipOpenFetch = true;
    dashConnect();
  }
}

function closeDashboard() {
  clearTimeout(dash.retryTimer);
  clearTimeout(dash.refetchTimer);
  dash.retryTimer = null;
  dash.retry = 1000;
  dash.fetchRetry = 1000;
  const ws = dash.ws;
  dash.ws = null;
  ws?.close();
}

function renderDashHead() {
  const head = $('dashboard-body').querySelector('.dash-head');
  if (!head || !dash.summary) return;
  const boards = dash.summary.boards;
  const count = (st) => boards.filter((b) => b.session?.state === st).length;
  const working = count('working');
  const needs = count('needs_you');
  const stats = node('span', 'dash-head-stats');
  stats.append(node('span', '', `${boards.length} board${boards.length === 1 ? '' : 's'}`));
  if (working) stats.append(node('span', 'dh-working', `${working} working`));
  if (needs) stats.append(node('span', 'dh-needs', `⚠ ${needs} need${needs === 1 ? 's' : ''} you`));
  if (dash.failed) stats.append(node('span', 'dh-reconnecting', 'reconnecting…'));
  head.replaceChildren(node('span', 'dash-head-name', dash.summary.workspace.name), stats);
}

function renderDashboard() {
  const host = $('dashboard-body');
  if (!dash.summary) {
    host.replaceChildren(node('div', 'att-empty', dash.failed ? 'Couldn’t load workspace — retrying…' : 'Loading workspace…'));
    return;
  }
  const grid = node('div', 'dash-grid');
  grid.append(...dash.summary.boards.map((b, i) => dashTile(b, i === 0)));
  const layout = node('div', 'dash-layout');
  layout.append(grid, node('aside', 'dash-attn'));
  host.replaceChildren(node('div', 'dash-head'), layout);
  renderDashHead();
  renderDashAttn();
}

const dashBoardName = (pid, name) => (pid === dash.summary?.workspace.id ? 'Main' : name);

// Point the workspace terminal at a board's tab and open the panel (tile ❯_ + needs-you rows).
function openBoardTerminal(pid) {
  try {
    localStorage.setItem(`term.tab.${dash.workspace}`, pid);
  } catch {
    /* storage unavailable */
  }
  if (term.tabs.has(pid)) term.active = pid;
  openTerm();
}

// The one "needs a human" queue across every board: waiting sessions first,
// then the summary's attention items (already ordered blocker > warn > info).
function renderDashAttn() {
  const panel = $('dashboard-body').querySelector('.dash-attn');
  if (!panel || !dash.summary) return;
  const clickable = !EMBED;
  const waiting = dash.summary.boards.filter((b) => b.session?.state === 'needs_you');
  const items = dash.summary.attention ?? [];
  const total = waiting.length + items.length;

  const head = node('div', 'da-head');
  head.append(node('span', 'da-title', 'Needs you'));
  if (total) head.append(node('span', `da-count${waiting.length || items.some((i) => i.severity === 'blocker') ? ' hot' : ''}`, total));
  const list = node('div', 'da-list');

  for (const b of waiting) {
    const name = dashBoardName(b.project.id, b.project.name);
    const detail = b.session.main?.detail;
    const canOpen = clickable && term.enabled;
    const row = node(canOpen ? 'button' : 'div', 'da-row da-waiting');
    row.append(node('span', 'da-warn', '⚠'));
    const main = node('span', 'att-main');
    main.append(node('span', 'att-title', `${name} is waiting for you`));
    if (detail) main.append(node('span', 'att-reason', detail));
    row.append(main);
    if (canOpen) {
      row.append(node('span', 'att-arrow', '❯_'));
      row.title = `Open ${name}’s terminal tab`;
      row.onclick = () => openBoardTerminal(b.project.id);
    }
    list.append(row);
  }

  for (const i of items) {
    const row = node(clickable ? 'button' : 'div', `da-row att-row ${i.severity}`);
    row.append(node('span', 'att-dot'));
    const main = node('span', 'att-main');
    const top = node('span', 'da-top');
    top.append(node('span', 'da-chip', dashBoardName(i.project_id, i.project_name)), node('span', 'att-title', i.title));
    main.append(top, node('span', 'att-reason', i.reason));
    row.append(main);
    if (clickable) {
      row.append(node('span', 'att-arrow', '→'));
      row.onclick = () => {
        if (i.project_id === projectId) openCardModal(i.card_id);
        else location.search = `?project=${encodeURIComponent(i.project_id)}&card=${encodeURIComponent(i.card_id)}`;
      };
    }
    list.append(row);
  }

  if (!total) list.append(node('div', 'da-empty', 'Nothing needs you.'));
  panel.replaceChildren(head, list);
}

function dashTile(b, isMain) {
  const s = b.session ?? { state: 'offline', main: null, agents: [] };
  const tile = node('div', 'dash-tile');
  tile.dataset.id = b.project.id;
  tile.dataset.state = s.state;
  tile.title = `Open ${isMain ? 'Main' : b.project.name} board`;
  tile.onclick = () => (location.search = `?project=${encodeURIComponent(b.project.id)}`);

  // head: name · state pill · terminal shortcut
  const head = node('div', 'dt-head');
  const name = node('div', 'dt-name', isMain ? 'Main' : b.project.name);
  if (isMain) name.append(node('span', 'dt-kind', 'workspace'));
  const pill = node('span', 'dt-pill');
  pill.append(node('span', 'dt-dot'), node('span', '', DASH_STATE[s.state] ?? s.state));
  head.append(name, pill);
  if (!EMBED && term.enabled) {
    const tb = node('button', 'dt-term', '❯_');
    tb.title = 'Open this board’s terminal tab';
    tb.onclick = (e) => {
      e.stopPropagation();
      openBoardTerminal(b.project.id);
    };
    head.append(tb);
  }
  tile.append(head);

  // subtitle: what the main session is doing (+N subagents)
  const sub = node('div', 'dt-sub');
  const what = s.main ? `${s.main.verb} ${s.main.detail ?? ''}`.trim() : s.state === 'offline' ? 'no session' : '—';
  sub.append(node('span', 'dt-what', what));
  if (s.agents?.length) sub.append(node('span', 'dt-agents', `+${s.agents.length} agent${s.agents.length === 1 ? '' : 's'}`));
  tile.append(sub);

  // lane counts
  const lanes = node('div', 'dt-lanes');
  for (const [lane, label] of DASH_LANES) {
    const l = node('div', 'dt-lane');
    l.dataset.lane = lane;
    l.append(node('span', 'dt-lane-n', b.lanes?.[lane] ?? 0), node('span', 'dt-lane-l', label));
    lanes.append(l);
  }
  tile.append(lanes);

  // active phase
  if (b.phase) {
    const ph = node('div', 'dt-phase');
    const row = node('div', 'dt-phase-row');
    row.append(node('span', 'dt-phase-title', b.phase.title), node('span', 'dt-phase-n', `${b.phase.done}/${b.phase.total}`));
    const bar = node('div', 'dt-bar');
    const fill = node('span', 'dt-bar-fill');
    fill.style.width = `${b.phase.total ? Math.round((100 * b.phase.done) / b.phase.total) : 0}%`;
    bar.append(fill);
    ph.append(row, bar);
    tile.append(ph);
  }

  // active cards
  const list = node('div', 'dt-cards');
  const active = b.active ?? [];
  if (!active.length) list.append(node('div', 'dt-empty', 'nothing in flight'));
  for (const c of active.slice(0, DASH_MAX_CARDS)) {
    const row = node('div', `dt-card${c.blocked ? ' blocked' : ''}`);
    row.dataset.lane = c.lane;
    row.append(node('span', 'dt-card-mark'), node('span', 'dt-card-title', c.title));
    if (c.blocked) {
      const flag = node('span', 'dt-card-blocked', '✋');
      flag.title = 'blocked';
      flag.append(node('span', 'word', ' blocked'));
      row.append(flag);
    }
    if (c.agent) row.append(node('span', 'dt-card-agent', c.agent));
    list.append(row);
  }
  if (active.length > DASH_MAX_CARDS) list.append(node('div', 'dt-more', `+${active.length - DASH_MAX_CARDS} more`));
  tile.append(list);

  // footer: tokens · lines · blocked
  const t = b.totals ?? {};
  const foot = node('div', 'dt-foot');
  foot.append(
    node('span', 'dt-tok', `${fmtTokens(t.tokens ?? 0)} tok`),
    node('span', 'add', `+${t.lines_added ?? 0}`),
    node('span', 'del', `−${t.lines_removed ?? 0}`),
  );
  const blocked = node('span', `dt-blocked${b.blocked ? ' on' : ''}`, `${b.blocked ?? 0} blocked`);
  foot.append(blocked);
  tile.append(foot);
  return tile;
}

connect();
if (!EMBED) initTerminal(); // an OBS scene gets no terminal (and no pty sockets)
