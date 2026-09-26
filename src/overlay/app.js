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
  if (!EMBED) {
    const merge = node('div', 'pm-merge hidden', 'Merge verticals…');
    projectMenu.insertBefore(merge, projectMenu.querySelector('.pm-new'));
    refreshMergeMenuItem();
  }
}

// "Merge verticals…" shows only while the current project's workspace has 2+ verticals.
async function refreshMergeMenuItem() {
  const item = projectMenu.querySelector('.pm-merge');
  const project = currentProject();
  if (!item || !project) return;
  let n = 0;
  try {
    const res = await fetch(`/workspace?project=${encodeURIComponent(project)}`);
    if (res.ok) n = (await res.json()).verticals.length;
  } catch {
    /* daemon hiccup — leave it as it was */
    return;
  }
  item.classList.toggle('hidden', n < 2);
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
  if (!projectMenu.classList.contains('hidden')) refreshMergeMenuItem();
};
projectMenu.onclick = (e) => {
  const del = e.target.closest('.pm-del');
  if (del) {
    e.stopPropagation();
    return removeProject(del.dataset.del);
  }
  if (e.target.closest('.pm-new')) return newProject();
  if (e.target.closest('.pm-merge')) {
    projectMenu.classList.add('hidden');
    return openMergeDialog();
  }
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
    if (activeView === 'planner' && !plan.project) openPlanner(); // ?view=planner opened before the project was known
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
    // the project we're viewing is gone — merged away → land on the merged board
    if (msg.project_id === projectId) {
      const merged = mergeRedirect?.from === projectId;
      if (merged) svFlashAfterReload(mergeRedirect.flash);
      location.search = merged ? mvRedirectSearch(mergeRedirect.into) : '';
    }

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
  if (activeView === 'home') onHomeMessage(msg);
  if (mergeDlg && MV_REFRESH_ON.includes(msg.type)) mergeDlg.refresh();
}

// ── subscription usage bars (fed by the statusline script) ─────────
let lastUsage = null;
function renderUsage(usage) {
  lastUsage = usage ?? null;
  if (activeView === 'home') renderHomeHead();
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
const railHome = document.getElementById('rail-home');
const railPlanner = document.getElementById('rail-planner');
const plannerView = document.getElementById('planner-view');
const homeView = document.getElementById('home-view');
const attentionView = document.getElementById('attention-view');
const scmView = document.getElementById('scm-view');
const phasesView = document.getElementById('phases-view');
const statsView = document.getElementById('stats-view');
const dashboardView = document.getElementById('dashboard-view');
let activeView = 'kanban'; // 'home' | 'attention' | 'kanban' | 'scm' | 'phases' | 'stats' | 'dashboard' | 'planner'

// Non-kanban views take over the whole board area (full-screen).
function setView(name) {
  const prev = activeView;
  activeView = name;
  railAttention.classList.toggle('active', name === 'attention');
  railKanban.classList.toggle('active', name === 'kanban');
  railScm.classList.toggle('active', name === 'scm');
  railPhases.classList.toggle('active', name === 'phases');
  railStats.classList.toggle('active', name === 'stats');
  railDashboard.classList.toggle('active', name === 'dashboard');
  railHome.classList.toggle('active', name === 'home');
  railPlanner.classList.toggle('active', name === 'planner');
  attentionView.classList.toggle('hidden', name !== 'attention');
  boardEl.classList.toggle('hidden', name !== 'kanban');
  scmView.classList.toggle('hidden', name !== 'scm');
  phasesView.classList.toggle('hidden', name !== 'phases');
  statsView.classList.toggle('hidden', name !== 'stats');
  dashboardView.classList.toggle('hidden', name !== 'dashboard');
  homeView.classList.toggle('hidden', name !== 'home');
  plannerView.classList.toggle('hidden', name !== 'planner');
  if (name === 'scm') refreshFiles();
  if (name === 'phases') renderPhaseDetail();
  if (name === 'attention') renderAttention();
  if (name === 'stats') loadStats();
  if (name === 'dashboard') openDashboard();
  else if (!(name === 'home' && prev === 'home')) closeDashboard(); // also drops Home's all-projects socket on leave
  if (name === 'home' && prev !== 'home') openHome();
  if (name === 'planner' && prev !== 'planner') openPlanner();
  else if (name !== 'planner' && prev === 'planner') closePlanner();
}

railAttention.onclick = () => setView('attention');
railKanban.onclick = () => setView('kanban');
railScm.onclick = () => setView('scm');
railPhases.onclick = () => setView('phases');
railStats.onclick = () => setView('stats');
railDashboard.onclick = () => setView('dashboard');
railHome.onclick = () => setView('home');
railPlanner.onclick = () => setView('planner');

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
    if (URL_VIEW && URL_VIEW !== 'dashboard' && URL_VIEWS.includes(URL_VIEW)) return setView(URL_VIEW); // ?view= wins
    const dv = SETTINGS.defaultView;
    if (dv === 'home') setView('home');
    else if (dv === 'attention' || (dv === 'smart' && blockers)) setView('attention');
  }
}

function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function renderAttention() {
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

const accentFor = (name) => ACCENTS[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % ACCENTS.length];

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
  // never block the modal on a slow /team: fall back to plain "● name" chips
  await Promise.race([teamCacheLoad, new Promise((r) => setTimeout(r, 1500))]);
  document.getElementById('card-title').textContent = task.title;
  const meta = [
    task.tag && `${team(task.tag).name} team`,
    LANE_NAME(task.lane),
    task.assigned_agent && { agent: task.assigned_agent },
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
  document.getElementById('card-meta').replaceChildren(
    ...meta.map((m) => {
      if (typeof m === 'string') return node('span', '', m);
      const member = teamByName.get(m.agent);
      if (!member) return node('span', '', `● ${m.agent}`);
      const chip = node('span', 'cm-agent');
      chip.append(avatarEl(member, 14), node('span', '', m.agent));
      return chip;
    }),
  );
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
  if (!cfg.terminal || !cfg.token) return; // no token → not on this machine
  term.enabled = true;
  term.token = cfg.token;
  termBtn.classList.remove('hidden');
  const h = Number(localStorage.getItem('term.height'));
  if (h) termPanel.style.height = `${h}px`;
  if (localStorage.getItem('term.open') === '1') openTerm();
  if (activeView === 'dashboard') renderDashboard(); // tiles gain their ❯_ buttons
  if (activeView === 'home') renderHome(); // Send to agent + Watch terminal appear
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
  defaultView: localStorage.getItem('settings.defaultView') || 'home', // never changed → Home
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
  setTeamCache(team);
  const host = $('team-list');
  if (!team.length) {
    host.innerHTML = '<div class="st-empty">No team members yet.<br>Add one to build your roster.</div>';
    return;
  }
  host.replaceChildren(
    ...team.map((m) => {
      const el = node('div', 'member');
      const main = node('span', 'm-main');
      main.append(node('div', 'm-name', m.name), node('div', 'm-id', m.id));
      const del = node('button', 'm-del', '✕');
      del.title = 'Remove';
      el.append(avatarEl(m, 32), main, node('span', `m-skill${m.skill ? '' : ' none'}`, m.skill || 'no skill'), del);
      del.onclick = async () => {
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
const URL_VIEWS = ['home', 'attention', 'kanban', 'scm', 'phases', 'stats', 'planner'];
const EMBED = new URLSearchParams(location.search).get('embed') === '1';
const dash = { checked: false, workspace: null, summary: null, failed: false, fetchRetry: 1000, ids: new Set(), ws: null, retry: 1000, retryTimer: null, refetchTimer: null, refetchFirst: null, skipOpenFetch: false, nudged: new Map() };
const DASH_LANES = [['backlog', 'backlog'], ['queued', 'queued'], ['in_progress', 'in prog'], ['in_review', 'review'], ['done', 'done']];
const DASH_STATE = { working: 'working', idle: 'idle', needs_you: '⚠ needs you', offline: 'offline' };
const DASH_MAX_CARDS = 5;
const DASH_NUDGE_PULSE_MS = 2400;

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

// Debounced refetch of whichever socket-fed view is showing (dashboard or Home):
// 400ms after the last trigger, but never later than 1.5s after the first
// pending one, so steady traffic can't starve the refetch.
const REFETCH_DEBOUNCE_MS = 400;
const REFETCH_MAX_WAIT_MS = 1500;
function scheduleDashboardRefetch() {
  clearTimeout(dash.refetchTimer);
  const now = Date.now();
  dash.refetchFirst ??= now;
  const wait = Math.max(0, Math.min(REFETCH_DEBOUNCE_MS, dash.refetchFirst + REFETCH_MAX_WAIT_MS - now));
  dash.refetchTimer = setTimeout(() => {
    dash.refetchFirst = null;
    (activeView === 'home' ? loadHome : loadDashboard)();
  }, wait);
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
    if (!skip) (activeView === 'home' ? loadHome : loadDashboard)();
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
  if (mergeDlg && MV_REFRESH_ON.includes(msg.type)) mergeDlg.refresh();
  // the current project's messages come in on the board socket already
  if (activeView === 'home') return void (pid !== projectId && onHomeMessage(msg));
  if (msg.type === 'status') {
    const b = dash.summary?.boards.find((x) => x.project.id === pid);
    if (!b || !msg.session) return;
    b.session = msg.session;
    dash.nudged.delete(pid); // a real status replaces "nudged just now"
    replaceDashTile(b);
    renderDashHead();
    renderDashAttn();
  } else if (msg.type === 'autopilot') {
    const b = dash.summary?.boards.find((x) => x.project.id === pid);
    if (!b) return;
    b.project.autopilot = msg.on ? 1 : 0;
    if (!msg.on) dash.nudged.delete(pid); // no "nudged just now" without a badge
    replaceDashTile(b);
  } else if (msg.type === 'autopilot_nudge') {
    const b = dash.summary?.boards.find((x) => x.project.id === pid);
    if (!b) return;
    b.project.autopilot = 1; // only autopilot boards get nudged
    dash.nudged.set(pid, Date.now());
    replaceDashTile(b);
    setTimeout(() => {
      $('dashboard-body').querySelector(`.dash-tile[data-id="${CSS.escape(pid)}"] .dt-autopilot`)?.classList.remove('nudged');
    }, DASH_NUDGE_PULSE_MS);
  } else if (['card', 'card_removed', 'phases', 'verticals', 'event'].includes(msg.type)) {
    scheduleDashboardRefetch();
  }
}

function replaceDashTile(b) {
  const old = $('dashboard-body').querySelector(`.dash-tile[data-id="${CSS.escape(b.project.id)}"]`);
  if (old) old.replaceWith(dashTile(b, dash.summary.boards.indexOf(b) === 0));
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
  dash.nudged.clear(); // the socket closes → the clearing status could be missed
  clearTimeout(dash.retryTimer);
  clearTimeout(dash.refetchTimer);
  dash.refetchFirst = null;
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
function openBoardTerminal(pid, workspace = dash.workspace) {
  try {
    localStorage.setItem(`term.tab.${workspace}`, pid);
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
  if (!isMain) {
    const mb = mergeButton(b.project.id, b.project.name, dash.summary.boards.length - 1);
    if (mb) head.append(mb);
  }
  if (b.project.autopilot) {
    const ap = node('span', 'dt-autopilot', 'autopilot');
    ap.title = 'Autopilot on — prompts this board when idle with queued cards; pauses at 80% usage';
    const at = dash.nudged.get(b.project.id);
    if (at && Date.now() - at < DASH_NUDGE_PULSE_MS) ap.classList.add('nudged');
    head.append(ap);
  }
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
  const nudged = dash.nudged.has(b.project.id);
  const what = nudged ? 'nudged just now' : s.main ? `${s.main.verb} ${s.main.detail ?? ''}`.trim() : s.state === 'offline' ? 'no session' : '—';
  sub.append(node('span', `dt-what${nudged ? ' nudged' : ''}`, what));
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
    if (c.agent) {
      const member = teamByName.get(c.agent);
      if (!member) row.append(node('span', 'dt-card-agent', c.agent));
      else {
        const chip = node('span', 'dt-card-agent has-av');
        chip.append(avatarEl(member, 14), node('span', 'dt-card-agent-name', c.agent));
        row.append(chip);
      }
    }
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

// ── Home: default landing — now building, verticals, agents, up next, send ──
// One read (GET /home) re-fetched on live board messages; status messages are
// applied in place first. Every user-controlled string goes in via node().
const home = { data: null, failed: false, sessions: new Map(), target: null };
// status is applied in place (applyHomeStatus), never refetched; init = board socket (re)connected
const HOME_REFETCH = ['init', 'card', 'card_removed', 'phases', 'event', 'verticals', 'autopilot'];
const HOME_MAX_UP_NEXT = 3;

function fmtElapsed(since) {
  const m = Math.max(0, Math.floor((Date.now() - since) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}
tick.add(() => {
  if (activeView !== 'home') return;
  for (const el of homeView.querySelectorAll('[data-since]')) el.textContent = fmtElapsed(Number(el.dataset.since));
});

function openHome() {
  renderHome(); // last good data, or the loading state
  loadHome();
}

async function loadHome() {
  const project = currentProject();
  if (!project) return;
  let data;
  try {
    const res = await fetch(`/home?project=${encodeURIComponent(project)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    home.sessions = new Map(data.verticals.map((v) => [v.project.id, v.session]));
    if (!data.verticals.length) {
      // standalone: /home carries no session → read it for the Send box's state
      const s = await fetch(`/session?project=${encodeURIComponent(data.project.id)}`);
      if (s.ok) home.sessions.set(data.project.id, await s.json());
    }
  } catch {
    home.failed = true;
    if (activeView !== 'home') return;
    renderHome();
    clearTimeout(dash.refetchTimer);
    dash.refetchTimer = setTimeout(loadHome, dash.fetchRetry);
    dash.fetchRetry = Math.min(dash.fetchRetry * 2, 10000);
    return;
  }
  home.failed = false;
  dash.fetchRetry = 1000;
  home.data = data;
  setTeamCache(data.agents); // /home carries the roster: keeps chips fresh after outside edits
  if (activeView !== 'home') return;
  renderHome();
  loadSuggestions();
  // in a workspace, the other boards' traffic arrives on the all-projects socket
  if (data.verticals.length) {
    dash.ids = new Set(data.verticals.map((v) => v.project.id));
    if (!dash.ws && !dash.retryTimer) {
      dash.skipOpenFetch = true;
      dashConnect();
    }
  }
}

// Board WS (this project) and the all-projects socket (workspace boards) both land here.
function onHomeMessage(msg) {
  if (msg.type === 'status') applyHomeStatus(msg);
  if (HOME_REFETCH.includes(msg.type)) scheduleDashboardRefetch();
}

// Cheap in-place update: session state (pills, Send box) + activity text.
function applyHomeStatus(msg) {
  const d = home.data;
  if (!d || !msg.status) return;
  const pid = msg.project_id;
  if (msg.session && pid) {
    home.sessions.set(pid, msg.session);
    const v = d.verticals.find((x) => x.project.id === pid);
    if (v) v.session = msg.session;
  }
  const st = msg.status;
  const act = `${st.verb} ${st.detail ?? ''}`.trim();
  for (const nb of d.now_building) {
    if (nb.id !== st.task_id) continue;
    nb.activity = act;
    for (const a of d.agents) if (nb.agent && a.name === nb.agent) a.now = act;
  }
  renderHome();
}

const homeBoardName = (board) => (board.id === home.data?.workspace?.workspace.id ? 'Main' : board.name);

function homeChip(cls, text, color) {
  const c = node('span', `home-pill ${cls}`, text);
  if (color) c.style.setProperty('--chip', color);
  return c;
}
const homeLaneChip = (lane) => {
  const c = homeChip('home-lane', LANE_NAME(lane));
  c.dataset.lane = lane;
  return c;
};
const homeBoardChip = (board) => homeChip('board', homeBoardName(board), accentFor(board.name));

function homeLabel(text, extra) {
  const el = node('div', 'home-label', text);
  if (extra) el.append(node('span', 'home-label-n', extra));
  return el;
}

function homeOpenCard(card) {
  if (card.board.id === projectId) openCardModal(card.id);
  else location.search = `?project=${encodeURIComponent(card.board.id)}&card=${encodeURIComponent(card.id)}`;
}

async function homeQueue(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Queuing…';
  btn.parentElement.querySelector('.home-qerr')?.remove();
  let error = null;
  try {
    const res = await fetch(`/task/${encodeURIComponent(id)}/move`, { method: 'POST', body: JSON.stringify({ lane: 'queued' }) });
    if (!res.ok) error = (await res.json().catch(() => ({}))).error || 'Couldn’t queue — try again';
  } catch {
    error = 'Couldn’t queue — try again';
  }
  if (error) {
    btn.disabled = false;
    btn.textContent = 'Queue it';
    btn.before(node('span', 'home-qerr', error));
    return;
  }
  scheduleDashboardRefetch();
}

function homeQueueBtn(item) {
  if (!item.ready || item.lane !== 'backlog') return null;
  const b = node('button', 'home-btn', 'Queue it');
  b.onclick = () => homeQueue(item.id, b);
  return b;
}

// ── team avatars + agent editor ─────────────────────────────────────
// Latest /team roster by name, so card/dashboard chips can show avatars.
const teamByName = new Map();
let teamCacheLoad = null; // the first load, awaited by the card modal

async function loadTeamCache() {
  try {
    const res = await fetch('/team');
    if (!res.ok) return;
    setTeamCache(await res.json());
  } catch {
    /* keep the last roster */
  }
}

function setTeamCache(team) {
  teamByName.clear();
  for (const m of team) teamByName.set(m.name, m);
}

// One avatar for every team member chip: the uploaded image, else the initial
// on the member's colour.
function avatarEl(m, size) {
  const av = node('span', 'avatar');
  av.style.width = av.style.height = `${size}px`;
  av.style.fontSize = `${Math.max(6, Math.round(size * 0.41))}px`;
  if (m.avatar) {
    const img = document.createElement('img');
    img.src = `/avatars/${encodeURIComponent(m.avatar)}`;
    img.alt = '';
    av.append(img);
  } else {
    av.textContent = ((m.name || '?').trim()[0] ?? '?').toUpperCase();
    av.style.background = m.color || accentFor(m.name);
  }
  return av;
}

// Re-render everything that shows team data after an edit.
async function refreshTeamViews() {
  await loadTeamCache();
  await loadHome();
  if (!$('settings-modal').classList.contains('hidden')) loadTeam();
  if (openCardId) refreshCardModal();
  if (activeView === 'dashboard') renderDashboard();
}

const AE_COLOURS = [
  ['#c678dd', 'Violet'],
  ['#61afef', 'Blue'],
  ['#5dd3a8', 'Mint'],
  ['#e5c07b', 'Amber'],
  ['#e06c75', 'Rose'],
  ['#aab2c5', 'Grey'],
];
const AE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const AE_MAX_BYTES = 2 * 1024 * 1024;

function openAgentEditor(member) {
  if (document.querySelector('.ae-backdrop')) return;
  const opener = document.activeElement;
  let cur = member; // latest server copy (a partial save updates it)
  const st = {
    color: member.color || accentFor(member.name),
    mode: member.avatar ? 'image' : 'initials',
    file: null,
    url: null,
  };

  const backdrop = node('div', 'ae-backdrop');
  const dlg = node('div', 'ae-dialog');
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-labelledby', 'ae-title');
  backdrop.append(dlg);

  const title = node('h2', 'ae-title', 'Edit agent');
  title.id = 'ae-title';

  const preview = node('div', 'ae-preview');
  const previewAv = node('div', 'ae-preview-av');
  const previewName = node('div', 'ae-preview-name');
  const previewSkill = node('div', 'ae-preview-skill', member.skill ?? 'no skill');
  const previewId = node('div', 'ae-preview-id');
  previewId.append(previewName, previewSkill);
  preview.append(previewAv, previewId);

  // Initials / Image tabs
  const tabs = node('div', 'ae-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Avatar style');
  const mkTab = (mode, label) => {
    const t = node('button', 'ae-tab', label);
    t.type = 'button';
    t.id = `ae-tab-${mode}`;
    t.setAttribute('role', 'tab');
    t.setAttribute('aria-controls', `ae-panel-${mode}`);
    t.onclick = () => setMode(mode);
    return t;
  };
  const tabInitials = mkTab('initials', 'Initials');
  const tabImage = mkTab('image', 'Image');
  tabs.append(tabInitials, tabImage);
  tabs.onkeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setMode(st.mode === 'initials' ? 'image' : 'initials');
    (st.mode === 'initials' ? tabInitials : tabImage).focus();
  };

  // name
  const nameField = node('div', 'ae-field');
  const nameLabel = node('label', 'ae-label', 'Name');
  nameLabel.htmlFor = 'ae-name';
  const nameInput = document.createElement('input');
  nameInput.id = 'ae-name';
  nameInput.className = 'ae-input';
  nameInput.type = 'text';
  nameInput.autocomplete = 'off';
  nameInput.maxLength = 60;
  nameInput.value = member.name;
  nameInput.setAttribute('aria-describedby', 'ae-name-help');
  nameInput.oninput = renderPreview;
  const nameHelp = node('div', 'ae-help', 'Past cards and stats move to the new name.');
  nameHelp.id = 'ae-name-help';
  nameField.append(nameLabel, nameInput, nameHelp);

  // initials panel: colour swatches
  const panelInitials = node('div', 'ae-panel');
  panelInitials.id = 'ae-panel-initials';
  panelInitials.setAttribute('role', 'tabpanel');
  panelInitials.setAttribute('aria-labelledby', 'ae-tab-initials');
  const swLabel = node('div', 'ae-label', 'Colour');
  swLabel.id = 'ae-colour-label';
  const swatches = node('div', 'ae-swatches');
  swatches.setAttribute('role', 'group');
  swatches.setAttribute('aria-labelledby', 'ae-colour-label');
  const colours = [...AE_COLOURS];
  if (!colours.some(([c]) => c.toLowerCase() === st.color.toLowerCase())) colours.push([st.color, 'Current']);
  const swBtns = colours.map(([c, label]) => {
    const b = node('button', 'ae-swatch');
    b.type = 'button';
    b.dataset.color = c;
    b.style.setProperty('--sw', c);
    b.setAttribute('aria-label', `${label} avatar colour`);
    b.onclick = () => {
      st.color = c;
      renderPreview();
    };
    return b;
  });
  swatches.append(...swBtns);
  panelInitials.append(swLabel, swatches);

  // image panel: upload
  const panelImage = node('div', 'ae-panel');
  panelImage.id = 'ae-panel-image';
  panelImage.setAttribute('role', 'tabpanel');
  panelImage.setAttribute('aria-labelledby', 'ae-tab-image');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'ae-file';
  fileInput.className = 'ae-file';
  fileInput.accept = AE_TYPES.join(',');
  fileInput.setAttribute('aria-describedby', 'ae-file-hint');
  const upload = node('label', 'ae-upload');
  upload.htmlFor = 'ae-file';
  const uploadMain = node('span', 'ae-upload-main', 'Choose an image');
  const uploadHint = node('span', 'ae-upload-hint', 'PNG, JPEG or WebP · up to 2 MB');
  uploadHint.id = 'ae-file-hint';
  upload.append(uploadMain, uploadHint);
  panelImage.append(fileInput, upload);
  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    if (!AE_TYPES.includes(f.type)) return showError('That file isn’t a PNG, JPEG or WebP image.');
    if (f.size > AE_MAX_BYTES) return showError('That image is larger than 2 MB — pick a smaller one.');
    showError('');
    if (st.url) URL.revokeObjectURL(st.url);
    st.file = f;
    st.url = URL.createObjectURL(f);
    renderPreview();
  };

  const err = node('div', 'ae-error');
  err.setAttribute('role', 'alert');

  const foot = node('div', 'ae-foot');
  const cancel = node('button', 'home-btn', 'Cancel');
  cancel.type = 'button';
  const save = node('button', 'home-btn primary', 'Save');
  save.type = 'button';
  foot.append(cancel, save);

  dlg.append(title, preview, nameField, tabs, panelInitials, panelImage, err, foot);

  function showError(msg) {
    err.textContent = msg;
  }

  function imageUrl() {
    if (st.mode !== 'image') return null;
    if (st.url) return st.url;
    return cur.avatar ? `/avatars/${encodeURIComponent(cur.avatar)}` : null;
  }

  function renderPreview() {
    const name = nameInput.value.trim() || member.name;
    const url = imageUrl();
    const av = avatarEl({ name, color: st.color, avatar: null }, 72);
    if (url) {
      av.textContent = '';
      av.style.background = '';
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      av.append(img);
    }
    previewAv.replaceChildren(av);
    previewName.textContent = name;
    for (const b of swBtns) {
      const on = b.dataset.color === st.color;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    uploadMain.textContent = st.file ? st.file.name : cur.avatar ? 'Replace image' : 'Choose an image';
  }

  function setMode(mode) {
    st.mode = mode;
    for (const [t, m] of [[tabInitials, 'initials'], [tabImage, 'image']]) {
      t.setAttribute('aria-selected', String(m === mode));
      t.tabIndex = m === mode ? 0 : -1;
    }
    panelInitials.hidden = mode !== 'initials';
    panelImage.hidden = mode !== 'image';
    showError('');
    renderPreview();
  }

  function close() {
    if (st.url) URL.revokeObjectURL(st.url);
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (opener && opener.isConnected) opener.focus();
    else if (opener) {
      // Home re-rendered meanwhile: land on this member's (new) ✎ button
      const again = [...document.querySelectorAll('.home-edit')].find((b) => b.dataset.id === member.id);
      again?.focus();
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const f = [...dlg.querySelectorAll('button, input, [tabindex]')].filter(
      (el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[hidden]'),
    );
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (!dlg.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function errorOf(res, fallback) {
    if (res.status === 413) return 'That image is larger than 2 MB — pick a smaller one.';
    const body = await res.json().catch(() => ({}));
    return typeof body.error === 'string' && body.error ? body.error : fallback;
  }

  async function doSave() {
    const name = nameInput.value.trim();
    if (!name) return showError('Name can’t be empty.');
    showError('');
    save.disabled = cancel.disabled = true;
    save.textContent = 'Saving…';
    const base = `/team/${encodeURIComponent(member.id)}`;
    try {
      const patch = {};
      if (name !== cur.name) patch.name = name;
      if (st.color !== (cur.color || '')) patch.color = st.color;
      if (Object.keys(patch).length) {
        const res = await fetch(base, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
        if (!res.ok) return showError(await errorOf(res, 'Couldn’t save — try again.'));
        cur = await res.json();
      }
      if (st.mode === 'image' && st.file) {
        const res = await fetch(`${base}/avatar`, { method: 'POST', headers: { 'content-type': st.file.type }, body: st.file });
        if (!res.ok) return showError(await errorOf(res, 'Couldn’t upload the image — try again.'));
        cur = await res.json();
        st.file = null;
      } else if (st.mode === 'initials' && cur.avatar) {
        const res = await fetch(`${base}/avatar`, { method: 'DELETE' });
        if (!res.ok) return showError(await errorOf(res, 'Couldn’t remove the image — try again.'));
        cur = await res.json();
      }
    } catch {
      return showError('Couldn’t reach the daemon — try again.');
    } finally {
      save.disabled = cancel.disabled = false;
      save.textContent = 'Save';
      // a partial save still changed what other views show
      if (cur !== member && err.textContent) refreshTeamViews();
    }
    await refreshTeamViews();
    close();
  }

  cancel.onclick = close;
  save.onclick = doSave;
  nameInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSave();
    }
  };
  backdrop.onmousedown = (e) => {
    if (e.target === backdrop) close();
  };
  document.addEventListener('keydown', onKey, true);

  setMode(st.mode);
  document.body.append(backdrop);
  nameInput.focus();
  nameInput.select();
}
function renderHome() {
  const d = home.data;
  if (!d) {
    $('home-name').textContent = '';
    $('home-sub').textContent = home.failed ? 'Couldn’t load Home — retrying…' : 'Loading…';
    for (const id of ['home-now', 'home-verticals', 'home-agents', 'home-upnext']) $(id).replaceChildren();
    $('home-verticals').classList.add('hidden');
    $('home-send').classList.add('hidden');
    renderHomeSplit();
    return;
  }
  renderHomeHead();
  renderHomeNow();
  renderHomeVerticals();
  renderHomeAgents();
  renderHomeUpNext();
  renderHomeSend();
  renderHomeSplit();
}

function renderHomeHead() {
  const d = home.data;
  if (!d) return;
  $('home-name').textContent = d.project.name;
  const parts = [];
  if (d.workspace) {
    const n = d.workspace.verticals.length;
    parts.push(`workspace · ${n} vertical${n === 1 ? '' : 's'}`);
  }
  const i = phases.findIndex((p) => p.status === 'active');
  if (i >= 0) parts.push(`Phase ${i + 1} of ${phases.length}: ${phases[i].title}`);
  if (home.failed) parts.push('reconnecting…');
  $('home-sub').textContent = parts.join(' · ');
  const u = [];
  if (typeof lastUsage?.five_hour?.used_percentage === 'number') u.push(`5h ${Math.round(lastUsage.five_hour.used_percentage)}%`);
  if (typeof lastUsage?.seven_day?.used_percentage === 'number') u.push(`week ${Math.round(lastUsage.seven_day.used_percentage)}%`);
  $('home-usage').textContent = u.length ? `usage ${u.join(' · ')}` : '';
}

function renderHomeNow() {
  const d = home.data;
  const host = $('home-now');
  const [cur, ...rest] = d.now_building;
  host.replaceChildren(homeLabel('Now building', d.now_building.length > 1 ? `${d.now_building.length}` : null));
  host.classList.toggle('empty', !cur);
  if (!cur) {
    host.append(node('div', 'home-hero-title muted', 'Nothing in flight'));
    const top = d.up_next.items[0];
    if (top) {
      const row = node('div', 'home-hero-next');
      const txt = node('div', 'home-hero-next-txt');
      txt.append(node('span', 'home-dim', 'Up next: '), node('span', '', top.title));
      row.append(txt);
      const q = homeQueueBtn(top);
      if (q) row.append(q);
      host.append(row);
    }
    return;
  }
  const chips = node('div', 'home-chips-row');
  if (d.workspace) chips.append(homeBoardChip(cur.board));
  chips.append(homeLaneChip(cur.lane));
  if (cur.blocked) chips.append(homeChip('blocked', '✋ blocked'));
  const el = node('span', 'home-elapsed', fmtElapsed(cur.since));
  el.dataset.since = cur.since;
  chips.append(el);
  host.append(chips, node('div', 'home-hero-title', cur.title));

  const who = node('div', `home-activity${cur.activity ? ' on' : ''}`);
  who.append(node('span', 'home-dot'));
  const text = cur.agent
    ? cur.activity ? `${cur.agent} · ${cur.activity}` : cur.agent
    : cur.activity ? `unassigned · ${cur.activity}` : 'unassigned';
  who.append(node('span', '', text));
  host.append(who);

  const { done, total } = cur.subtasks;
  if (total) {
    const prog = node('div', 'home-progress');
    const bar = node('div', 'home-bar');
    const fill = node('span', 'home-bar-fill');
    fill.style.width = `${Math.round((100 * done) / total)}%`;
    bar.append(fill);
    prog.append(bar, node('span', 'home-progress-n', `${done}/${total}`));
    host.append(prog);
    if (cur.next_criterion) {
      const nx = node('div', 'home-next');
      nx.append(node('span', 'home-dim', 'Next up: '), node('span', '', cur.next_criterion));
      host.append(nx);
    }
  }

  const actions = node('div', 'home-actions');
  const open = node('button', 'home-btn primary', 'Open card');
  open.onclick = () => homeOpenCard(cur);
  actions.append(open);
  if (term.enabled) {
    const watch = node('button', 'home-btn', 'Watch terminal');
    watch.onclick = () => openBoardTerminal(cur.board.id);
    actions.append(watch);
  }
  host.append(actions);

  if (rest.length) {
    const list = node('div', 'home-others');
    for (const c of rest) {
      const row = node('button', 'home-other');
      if (d.workspace) row.append(homeBoardChip(c.board));
      row.append(node('span', 'home-other-title', c.title));
      if (c.blocked) row.append(node('span', 'home-blocked-mark', '✋'));
      row.append(homeLaneChip(c.lane));
      row.onclick = () => homeOpenCard(c);
      list.append(row);
    }
    host.append(list);
  }
}

function renderHomeVerticals() {
  const d = home.data;
  const host = $('home-verticals');
  const on = d.verticals.length > 0;
  host.classList.toggle('hidden', !on);
  $('home-top').classList.toggle('solo', !on);
  if (!on) return host.replaceChildren();
  const list = node('div', 'home-vlist');
  for (const v of d.verticals) {
    const s = v.session ?? { state: 'offline' };
    const row = node('div', 'home-vrow');
    row.dataset.state = s.state;
    const head = node('div', 'home-vhead');
    const pill = node('span', 'dt-pill');
    pill.append(node('span', 'dt-dot'), node('span', '', DASH_STATE[s.state] ?? s.state));
    head.append(node('span', 'home-vname', homeBoardName(v.project)), pill);
    const wsv = d.workspace?.verticals ?? [];
    const mb = wsv.some((x) => x.id === v.project.id) ? mergeButton(v.project.id, v.project.name, wsv.length) : null;
    if (mb) head.append(mb);
    const lanes = DASH_LANES.map(([lane, label]) => `${v.lanes?.[lane] ?? 0} ${label}`).join(' · ');
    row.append(head, node('div', 'home-vlanes', lanes));
    list.append(row);
  }
  const foot = node('button', 'home-link', 'Dashboard →');
  foot.onclick = () => setView('dashboard');
  host.replaceChildren(homeLabel('Verticals', `${d.verticals.length}`), list, foot);
}

function renderHomeAgents() {
  const d = home.data;
  const host = $('home-agents');
  if (!d.agents.length) {
    host.replaceChildren(node('div', 'home-empty', 'No team members yet — add them in Settings → Team.'));
    return;
  }
  host.replaceChildren(
    ...d.agents.map((m) => {
      const card = node('div', 'home-agent');
      const top = node('div', 'home-agent-top');
      const id = node('div', 'home-agent-id');
      id.append(node('div', 'home-agent-name', m.name), node('div', 'home-agent-skill', m.skill ?? 'no skill'));
      const edit = node('button', 'home-edit', '✎');
      edit.setAttribute('aria-label', `Edit ${m.name}`);
      edit.title = `Edit ${m.name}`;
      edit.dataset.id = m.id;
      edit.onclick = () => openAgentEditor(m);
      top.append(avatarEl(m, 44), id, edit);
      const stats = node('div', 'home-agent-stats');
      const stat = (val, label, cls) => {
        const s = node('div', 'home-stat');
        s.append(node('div', `home-stat-val ${cls ?? ''}`, val), node('div', 'home-stat-label', label));
        return s;
      };
      stats.append(stat(`+${m.lines_added}`, 'lines written', 'add'), stat(`${m.hours}`, 'hours worked'));
      const now = node('div', `home-activity${m.now ? ' on' : ''}`);
      now.append(node('span', 'home-dot'), node('span', 'home-agent-now', m.now ?? 'idle'));
      card.append(top, stats, now);
      return card;
    }),
  );
}

function renderHomeUpNext() {
  const d = home.data;
  const host = $('home-upnext');
  const items = d.up_next.items.slice(0, HOME_MAX_UP_NEXT);
  host.replaceChildren(homeLabel('Up next'));
  const list = node('div', 'home-uplist');
  if (!items.length) list.append(node('div', 'home-empty', 'Nothing waiting — the board is clear.'));
  for (const it of items) {
    const row = node('div', 'home-uprow');
    const main = node('div', 'home-upmain');
    const top = node('div', 'home-chips-row');
    if (d.workspace) top.append(homeBoardChip(it.board));
    top.append(homeLaneChip(it.lane));
    main.append(top, node('div', 'home-uptitle', it.title));
    let status;
    if (it.ready) status = node('div', 'home-status ready', 'Ready');
    else {
      const w = it.waiting_on
        .map((x) => (x.title == null ? 'an unknown card' : `${x.title} (${x.board_name})`))
        .join(', ');
      status = node('div', 'home-status waiting', w === 'an unknown card' ? 'Waiting on an unknown card' : `Waiting on: ${w}`);
    }
    main.append(status);
    row.append(main);
    const q = homeQueueBtn(it);
    if (q) row.append(q);
    list.append(row);
  }
  const all = node('button', 'home-link', `View all ${d.up_next.total_pending} in Kanban →`);
  all.onclick = () => setView('kanban');
  host.append(list, all);
}

// The Send box is static markup (so typing survives re-renders): only the
// target options, the needs-you gate and visibility are refreshed here.
function homeTargets() {
  const d = home.data;
  if (!d) return [];
  return d.verticals.length
    ? d.verticals.map((v) => ({ id: v.project.id, name: homeBoardName(v.project) }))
    : [{ id: d.project.id, name: d.project.name }];
}

function renderHomeSend() {
  const box = $('home-send');
  const on = term.enabled && !!term.token && !!home.data;
  box.classList.toggle('hidden', !on);
  $('home-bottom').classList.toggle('solo', !on);
  if (!on) return;
  const targets = homeTargets();
  if (!targets.some((t) => t.id === home.target)) {
    home.target = (targets.find((t) => t.id === currentProject()) ?? targets[0])?.id ?? null;
  }
  const sel = $('home-send-target');
  sel.replaceChildren(
    ...targets.map((t) => {
      const st = home.sessions.get(t.id)?.state ?? 'offline';
      return Object.assign(document.createElement('option'), { value: t.id, textContent: `${t.name} — ${DASH_STATE[st] ?? st}` });
    }),
  );
  sel.value = home.target ?? '';
  const needs = home.sessions.get(home.target)?.state === 'needs_you';
  $('home-send-btn').disabled = needs || home.sending === true;
  const res = $('home-send-result');
  if (needs) {
    res.textContent = 'Waiting for a decision — answer it in the terminal';
    res.className = 'warn';
  } else if (res.dataset.gate === '1') {
    res.textContent = '';
    res.className = '';
  }
  res.dataset.gate = needs ? '1' : '';
}

async function homeSend() {
  const text = $('home-send-text').value.trim();
  const res = $('home-send-result');
  if (!text || !home.target) return;
  home.sending = true;
  $('home-send-btn').disabled = true;
  res.textContent = 'Sending…';
  res.className = '';
  try {
    const post = () => fetch(`/pty/send?${ptyQuery(home.target)}`, { method: 'POST', body: JSON.stringify({ text }) });
    let r = await post();
    if (r.status === 403) {
      // daemon restarted → the cached token is stale: refresh it once and retry
      try {
        const cfg = await (await fetch('/config')).json();
        if (cfg.token) term.token = cfg.token;
      } catch {
        /* fall through to the retry, which reports the failure */
      }
      r = await post();
    }
    const out = await r.json().catch(() => ({}));
    if (r.status === 403) {
      res.textContent = 'Couldn’t reach the terminal — reload the page';
      res.className = 'err';
    } else if (r.ok && out.sent) {
      res.textContent = 'Sent';
      res.className = 'ok';
      $('home-send-text').value = '';
    } else {
      res.textContent = out.error || `error ${r.status}`;
      res.className = 'err';
    }
  } catch {
    res.textContent = 'Could not reach the daemon';
    res.className = 'err';
  }
  res.dataset.gate = '';
  home.sending = false;
  renderHomeSend();
}

$('home-send-target').onchange = (e) => {
  home.target = e.target.value;
  $('home-send-result').textContent = '';
  renderHomeSend();
};
for (const chip of document.querySelectorAll('#home-send .home-chip')) {
  chip.onclick = () => {
    $('home-send-text').value = chip.dataset.text;
    $('home-send-text').focus();
  };
}
$('home-send-btn').onclick = homeSend;

// ── Verticals: suggestion toast (Home) + Split dialog ──
// GET /project/:id/vertical-suggestions feeds the toast; the dialog drives
// POST split-preview (debounced) and POST split. Every string goes in via node().
const SV_PREVIEW_DEBOUNCE_MS = 300;
const SV_FLASH_MS = 4000;
const svDismissKey = (pid) => `verticals.toast.dismissed.${pid}`;
function svDismissed(pid) {
  try {
    return localStorage.getItem(svDismissKey(pid)) === '1';
  } catch {
    return false;
  }
}
function svDismiss(pid) {
  try {
    localStorage.setItem(svDismissKey(pid), '1');
  } catch {
    /* private mode — dismissed for this page only */
  }
  home.suggestDismissed = pid;
  renderHomeSplit();
}

async function loadSuggestions(force = false) {
  const pid = home.data?.project.id;
  if (!pid || (!force && home.suggestFor === pid)) return;
  home.suggestFor = pid;
  let list = null;
  try {
    const res = await fetch(`/project/${encodeURIComponent(pid)}/vertical-suggestions`);
    if (res.ok) list = (await res.json()).suggestions ?? [];
  } catch {
    /* no toast this time */
  }
  if (list === null && home.suggestFor === pid) home.suggestFor = null; // failed → retry on the next Home render
  if (home.data?.project.id !== pid || list === null) return;
  home.suggestions = list;
  renderHomeSplit();
}

// "Split into verticals…" (standalone boards and verticals) + the suggestion toast.
function renderHomeSplit() {
  const d = home.data;
  const canSplit = !EMBED && !!d && (!d.workspace || !!d.project.parent_id);
  $('home-split').classList.toggle('hidden', !canSplit);
  const host = $('sv-toast');
  const s = canSplit && home.suggestFor === d.project.id ? home.suggestions ?? [] : [];
  const on = s.length >= 2 && home.suggestDismissed !== d.project.id && !svDismissed(d.project.id);
  host.classList.toggle('hidden', !on);
  if (!on) return host.replaceChildren();
  const shown = s.slice(0, 3);
  const text = node('div', 'sv-toast-text');
  text.append('Found ');
  shown.forEach((x, i) => {
    if (i > 0) text.append(i === shown.length - 1 && s.length === shown.length ? ' and ' : ', ');
    text.append(node('span', 'sv-mono', x.folder));
  });
  if (s.length > shown.length) text.append(` and ${s.length - shown.length} more`);
  text.append('. Give each its own board and agent?');
  const close = node('button', 'sv-toast-x', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss vertical suggestion');
  close.onclick = () => svDismiss(d.project.id);
  const head = node('div', 'sv-toast-head');
  head.append(node('div', 'sv-toast-title', 'This repo has several sides'), close);
  const review = node('button', 'home-btn primary', 'Review verticals');
  review.type = 'button';
  review.onclick = () => openSplitDialog(s);
  const later = node('button', 'home-btn', 'Not now');
  later.type = 'button';
  later.onclick = () => svDismiss(d.project.id);
  const actions = node('div', 'sv-toast-actions');
  actions.append(review, later);
  host.replaceChildren(head, text, actions);
}

function svFlash(text) {
  const el = $('sv-flash');
  // Merge can confirm from any view; Kanban isn't a .view → pin it to the viewport
  const view = document.querySelector('.view:not(.hidden)') ?? document.body;
  if (el.parentElement !== view) view.append(el);
  el.classList.toggle('fixed', view === document.body);
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(home.flashTimer);
  home.flashTimer = setTimeout(() => {
    el.classList.remove('on');
    el.textContent = '';
  }, SV_FLASH_MS);
}

// A confirmation that must survive a navigation (merging away the viewed vertical).
const SV_FLASH_KEY = 'kankan.flash.pending';
function svFlashAfterReload(text) {
  try {
    sessionStorage.setItem(SV_FLASH_KEY, text);
  } catch {
    /* storage unavailable — the confirmation is lost with the page */
  }
}
function svFlashPending() {
  let text = null;
  try {
    text = sessionStorage.getItem(SV_FLASH_KEY);
    sessionStorage.removeItem(SV_FLASH_KEY);
  } catch {
    return;
  }
  if (text) svFlash(text);
}

$('home-split').onclick = () => openSplitDialog(home.suggestFor === home.data?.project.id ? home.suggestions ?? [] : []);

// Shared chrome for the vertical dialogs (Split, Merge): backdrop, focus trap,
// Esc/backdrop-click to close unless busy(), focus back to the opener. close()
// removes every listener it added; onClose clears the dialog's own timers.
let svModal = false; // a vertical dialog is open or opening (Merge claims it before its first read)
function openModal({ labelledBy, describedBy, busy, onClose, fallbackFocus }) {
  svModal = true;
  const opener = document.activeElement;
  const backdrop = node('div', 'sv-backdrop');
  const dlg = node('div', 'sv-dialog');
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-labelledby', labelledBy);
  dlg.setAttribute('aria-describedby', describedBy);
  backdrop.append(dlg);
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    svModal = false;
    onClose?.();
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (opener && opener.isConnected && opener !== document.body) opener.focus();
    else fallbackFocus?.()?.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!busy()) close();
      return;
    }
    if (e.key !== 'Tab') return;
    const f = [...dlg.querySelectorAll('button, input, select, [tabindex]')].filter(
      (el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[hidden]'),
    );
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (!dlg.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  backdrop.onmousedown = (e) => {
    if (e.target === backdrop && !busy()) close();
  };
  document.addEventListener('keydown', onKey, true);
  return { backdrop, dlg, close, mount: () => document.body.append(backdrop) };
}

let svUid = 0;
function openSplitDialog(prefill) {
  const d = home.data;
  if (!d || svModal) return;
  const pid = d.project.id;
  const standalone = !d.project.parent_id;
  const stayLabel = standalone ? 'Main (shared)' : `Stay on ${d.project.name}`;
  const st = {
    targets: prefill.map((x) => ({ uid: ++svUid, name: x.name, folder: x.folder })),
    preview: null, // last good preview: { uids, targets, placement }
    status: 'empty', // 'empty' | 'incomplete' | 'pending' | 'error' | 'ok'
    error: '',
    seq: 0,
    timer: null,
    choices: new Map(), // cardId → target uid | 'stay'
    touched: new Set(), // cards the user picked by hand (a new preview won't override them)
    creating: false,
  };

  const modal = openModal({
    labelledBy: 'sv-title',
    describedBy: 'sv-sub',
    busy: () => st.creating,
    onClose: () => {
      clearTimeout(st.timer);
      st.seq++;
    },
    fallbackFocus: () => $('home-split'),
  });
  const { dlg, close } = modal;

  const title = node('h2', 'sv-title', `Split ${d.project.name} into verticals`);
  title.id = 'sv-title';
  const sub = node('p', 'sv-sub', 'Each vertical gets its own board, terminal and agent. Cards go where their files live.');
  sub.id = 'sv-sub';

  const targetsEl = node('div', 'sv-targets');
  const add = node('button', 'sv-add', '+ Add a vertical');
  add.type = 'button';
  const targetsWrap = node('div', 'sv-targets-wrap');
  targetsWrap.append(targetsEl, add);
  const previewErr = node('div', 'sv-error');
  previewErr.setAttribute('role', 'alert');

  const listHead = node('div', 'sv-list-head');
  const listTitle = node('h3', 'sv-list-title', 'Where each open card goes');
  listTitle.id = 'sv-list-title';
  listHead.append(listTitle, node('span', 'sv-list-hint', 'suggested from the files each card touched'));
  const rowsEl = node('div', 'sv-rows');
  rowsEl.setAttribute('role', 'list');
  rowsEl.setAttribute('aria-labelledby', 'sv-list-title');

  const createErr = node('div', 'sv-error');
  createErr.setAttribute('role', 'alert');
  const foot = node('div', 'sv-foot');
  const note = node('span', 'sv-foot-note');
  const cancel = node('button', 'home-btn', 'Cancel');
  cancel.type = 'button';
  const create = node('button', 'home-btn primary', 'Create verticals');
  create.type = 'button';
  foot.append(note, cancel, create);

  dlg.append(title, sub, targetsWrap, previewErr, listHead, rowsEl, createErr, foot);

  const targetLabel = (t) => t.name.trim() || t.folder.trim() || 'Untitled vertical';
  const openCards = () => st.preview?.placement ?? [];
  const unplaced = () => openCards().filter((p) => !st.choices.has(p.card.id)).length;

  // Target cards are rebuilt only on add/remove, so typing never loses focus;
  // chips and kit notes are refreshed in place by renderMeta().
  function renderTargets() {
    targetsEl.replaceChildren(
      ...st.targets.map((t) => {
        const card = node('div', 'sv-target');
        card.dataset.uid = t.uid;
        const top = node('div', 'sv-target-top');
        const chip = node('span', 'home-pill sv-count');
        const rm = node('button', 'sv-remove', '✕');
        rm.type = 'button';
        rm.onclick = () => removeTarget(t.uid);
        top.append(chip, rm);
        const field = (key, label, cls) => {
          const id = `sv-${key}-${t.uid}`;
          const l = node('label', 'sv-label', label);
          l.htmlFor = id;
          const input = document.createElement('input');
          input.id = id;
          input.className = `sv-input ${cls}`;
          input.type = 'text';
          input.autocomplete = 'off';
          input.spellcheck = false;
          input.value = t[key];
          input.placeholder = key === 'name' ? 'web' : 'apps/web';
          input.oninput = () => {
            t[key] = input.value;
            renderMeta();
            renderRows();
            schedulePreview();
          };
          return [l, input];
        };
        card.append(top, ...field('name', 'Name', 'sv-name'), ...field('folder', 'Folder', 'sv-folder'), node('div', 'sv-kit'));
        return card;
      }),
    );
    renderMeta();
  }

  function renderMeta() {
    const counts = new Map();
    for (const c of st.choices.values()) counts.set(c, (counts.get(c) ?? 0) + 1);
    const kits = new Map(st.preview ? st.preview.uids.map((u, i) => [u, st.preview.targets[i].kit]) : []);
    for (const card of targetsEl.children) {
      const t = st.targets.find((x) => x.uid === Number(card.dataset.uid));
      card.style.setProperty('--chip', accentFor(targetLabel(t)));
      const n = counts.get(t.uid) ?? 0;
      card.querySelector('.sv-count').textContent = `${n} card${n === 1 ? '' : 's'}`;
      card.querySelector('.sv-remove').setAttribute('aria-label', `Remove vertical ${targetLabel(t)}`);
      const kit = kits.get(t.uid);
      const k = card.querySelector('.sv-kit');
      k.classList.toggle('warn', typeof kit === 'string' && kit.startsWith('skipped'));
      k.textContent =
        kit === 'installed'
          ? 'separate repo — kankan will be set up there'
          : typeof kit === 'string' && kit.startsWith('skipped')
            ? `⚠ ${kit.replace(/^skipped:\s*/, 'kankan setup skipped: ')}`
            : '';
    }
  }

  function renderRows() {
    const focused = document.activeElement?.dataset?.card;
    const rows = openCards();
    if (!rows.length) {
      const msg = !st.targets.length
        ? 'Add a vertical to see where each open card goes.'
        : st.status === 'ok'
          ? 'No open cards — nothing to move.'
          : st.status === 'pending'
            ? 'Working out where cards go…'
            : ''; // failed or incomplete: the error/hint above says why
      rowsEl.replaceChildren(node('div', 'sv-empty', msg));
    } else {
      rowsEl.replaceChildren(
        ...rows.map((p) => {
          const row = node('div', 'sv-row');
          row.setAttribute('role', 'listitem');
          const main = node('div', 'sv-row-main');
          main.append(node('div', 'sv-row-title', p.card.title), node('div', 'sv-mono sv-evidence', p.evidence));
          const sel = document.createElement('select');
          sel.className = 'st-select sv-select';
          sel.dataset.card = p.card.id;
          sel.setAttribute('aria-label', `Destination for ${p.card.title}`);
          const opt = (value, label, disabled) => Object.assign(document.createElement('option'), { value, textContent: label, disabled: !!disabled });
          sel.append(opt('', 'Choose…', true), ...st.targets.map((t) => opt(`t${t.uid}`, targetLabel(t))), opt('stay', stayLabel));
          const c = st.choices.get(p.card.id);
          sel.value = c === undefined ? '' : c === 'stay' ? 'stay' : `t${c}`;
          sel.classList.toggle('unplaced', c === undefined);
          sel.onchange = () => {
            st.choices.set(p.card.id, sel.value === 'stay' ? 'stay' : Number(sel.value.slice(1)));
            st.touched.add(p.card.id);
            sel.classList.remove('unplaced');
            renderMeta();
            renderFoot();
          };
          row.append(main, sel);
          return row;
        }),
      );
      if (focused) rowsEl.querySelector(`select[data-card="${CSS.escape(focused)}"]`)?.focus();
    }
    renderFoot();
  }

  function renderFoot() {
    const n = unplaced();
    const doneNote = `done cards stay on ${standalone ? 'Main' : d.project.name}`;
    note.textContent = n
      ? `${n} card${n === 1 ? ' needs' : 's need'} a choice · ${doneNote}`
      : st.status === 'ok' && openCards().length
        ? `Every open card has a destination · ${doneNote}`
        : `D${doneNote.slice(1)}`;
    const k = st.targets.length;
    create.textContent = st.creating ? 'Creating…' : k ? `Create ${k} vertical${k === 1 ? '' : 's'}` : 'Create verticals';
    create.disabled = st.creating || st.status !== 'ok' || n > 0;
    cancel.disabled = st.creating;
    for (const el of [add, ...targetsEl.querySelectorAll('input, button'), ...rowsEl.querySelectorAll('select')]) el.disabled = st.creating;
    previewErr.textContent =
      st.status === 'error' ? st.error : st.status === 'incomplete' ? 'Give each vertical a name and a folder.' : '';
    previewErr.classList.toggle('hint', st.status === 'incomplete');
  }

  function schedulePreview(delay = SV_PREVIEW_DEBOUNCE_MS) {
    clearTimeout(st.timer);
    st.seq++; // any in-flight preview is now stale
    createErr.textContent = '';
    if (!st.targets.length) st.status = 'empty';
    else if (st.targets.some((t) => !t.name.trim() || !t.folder.trim())) st.status = 'incomplete';
    else {
      st.status = 'pending';
      st.timer = setTimeout(runPreview, delay);
    }
    renderMeta();
    renderRows(); // the empty-list message follows the status
  }

  async function runPreview() {
    const seq = st.seq;
    const uids = st.targets.map((t) => t.uid);
    const body = { targets: st.targets.map((t) => ({ name: t.name.trim(), folder: t.folder.trim() })) };
    let res, out;
    try {
      res = await fetch(`/project/${encodeURIComponent(pid)}/split-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      out = await res.json().catch(() => ({}));
    } catch {
      if (seq !== st.seq) return;
      st.status = 'error';
      st.error = 'Couldn’t reach the daemon — try again.';
      return renderRows();
    }
    if (seq !== st.seq) return;
    if (!res.ok) {
      st.status = 'error';
      st.error = typeof out.error === 'string' && out.error ? out.error : `Couldn’t preview the split (HTTP ${res.status}).`;
      renderMeta();
      return renderRows();
    }
    st.status = 'ok';
    st.preview = { uids, targets: out.targets, placement: out.placement };
    const live = new Set(st.targets.map((t) => t.uid));
    for (const p of out.placement) {
      const id = p.card.id;
      const c = st.choices.get(id);
      if (st.touched.has(id) && (c === 'stay' || live.has(c))) continue;
      st.touched.delete(id);
      if (p.suggestion == null) st.choices.delete(id);
      else st.choices.set(id, uids[Number(p.suggestion)]);
    }
    const ids = new Set(out.placement.map((p) => p.card.id));
    for (const id of [...st.choices.keys()]) if (!ids.has(id)) st.choices.delete(id);
    renderMeta();
    renderRows();
  }

  function removeTarget(uid) {
    const i = st.targets.findIndex((t) => t.uid === uid);
    st.targets.splice(i, 1);
    for (const [id, c] of st.choices) {
      if (c !== uid) continue;
      st.choices.delete(id);
      st.touched.delete(id);
    }
    renderTargets();
    renderRows();
    schedulePreview();
    const cards = targetsEl.querySelectorAll('.sv-target');
    (cards[Math.min(i, cards.length - 1)]?.querySelector('.sv-remove') ?? add).focus();
  }

  add.onclick = () => {
    st.targets.push({ uid: ++svUid, name: '', folder: '' });
    renderTargets();
    renderRows();
    schedulePreview();
    targetsEl.lastElementChild.querySelector('.sv-name').focus();
  };

  async function doCreate() {
    const p = st.preview;
    if (!p || create.disabled) return;
    const assignments = {};
    for (const pl of p.placement) {
      const c = st.choices.get(pl.card.id);
      assignments[pl.card.id] = c === 'stay' ? 'stay' : p.uids.indexOf(c);
    }
    st.creating = true;
    createErr.textContent = '';
    renderFoot();
    let res, out;
    try {
      res = await fetch(`/project/${encodeURIComponent(pid)}/split`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targets: p.targets.map((t) => ({ name: t.name, root: t.root })), assignments }),
      });
      out = await res.json().catch(() => ({}));
    } catch {
      out = { error: 'Couldn’t reach the daemon — try again.' };
    }
    st.creating = false;
    if (res?.ok) {
      const n = out.verticals?.length ?? p.targets.length;
      close();
      home.suggestions = [];
      renderHomeSplit();
      svFlash(`Created ${n} vertical${n === 1 ? '' : 's'}`);
      loadHome();
      loadSuggestions(true);
      dash.checked = false;
      initDashboard(); // the rail's Dashboard button appears once there are verticals
      return;
    }
    const msg = typeof out.error === 'string' && out.error ? out.error : `Couldn’t create the verticals (HTTP ${res?.status}).`;
    const ids = Array.isArray(out.cardIds) ? out.cardIds : [];
    const byId = new Map(p.placement.map((pl) => [pl.card.id, pl.card]));
    const blocking = ids.map((id) => byId.get(id)).filter(Boolean);
    if (res?.status === 400 && blocking.length) {
      const inFlight = blocking.every((c) => c.lane === 'in_progress' || c.lane === 'in_review');
      const names = blocking.map((c) => `“${c.title}”`).join(', ');
      createErr.textContent = inFlight
        ? `${names} ${blocking.length === 1 ? 'is' : 'are'} in progress or in review — finish or send back first, or keep ${blocking.length === 1 ? 'it' : 'them'} on ${standalone ? 'Main' : d.project.name}.`
        : `${msg}: ${names}`;
    } else {
      if (res?.status === 400) schedulePreview(0); // the board changed under us — refresh the card list
      createErr.textContent = msg;
    }
    renderFoot();
  }

  cancel.onclick = close;
  create.onclick = doCreate;

  renderTargets();
  renderRows();
  schedulePreview(0);
  modal.mount();
  (targetsEl.querySelector('.sv-name') ?? add).focus();
}

// ── Merge verticals dialog ──
// Entry points: "Merge…" on Dashboard tiles and Home's verticals panel, and
// "Merge verticals…" in the workspace menu. Reads GET /workspace/summary (roots,
// lane counts, in-flight cards), POSTs /verticals/merge. Every string via node().
const MV_REFRESH_MS = 300;
const MV_REFRESH_ON = ['card', 'card_removed', 'verticals', 'project_removed'];
let mergeDlg = null; // the open dialog's { refresh } (live board traffic re-reads the summary)
let mergeRedirect = null; // { from, into } while a merge is in flight: project_removed(from) → go to into

// Absolute path → segments; the deepest common ancestor that is a strict
// ancestor of both roots (segment-wise, so apps/web vs apps/webhooks → apps).
const mvSegs = (p) => p.replace(/\/+$/, '').split('/');
function mvSharedParent(a, b) {
  const x = mvSegs(a);
  const y = mvSegs(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  if (n < 2 || n >= x.length || n >= y.length) return null; // '/' alone, or one root contains the other
  return x.slice(0, n).join('/');
}
const mvCount = (b) => DASH_LANES.reduce((n, [lane]) => n + (b.lanes?.[lane] ?? 0), 0);
const mvPlural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function openMergeDialog(pre = {}) {
  if (EMBED || svModal) return;
  svModal = true;
  mergeDlg = { refresh: () => {} }; // claim the slot while the first read is in flight
  const project = dash.workspace ?? currentProject();
  const read = async () => {
    const res = await fetch(`/workspace/summary?project=${encodeURIComponent(project)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  let summary;
  try {
    summary = await read();
  } catch {
    mergeDlg = null;
    svModal = false;
    return svFlash('Couldn’t load the workspace — try again.');
  }
  const verticalsOf = (s) => s.boards.filter((b) => b.project.parent_id);
  let vs = verticalsOf(summary);
  if (vs.length < 2) {
    mergeDlg = null;
    svModal = false;
    return svFlash('Merging needs two verticals.');
  }
  const wsRoot = summary.boards.find((b) => !b.project.parent_id)?.project.root_path?.replace(/\/+$/, '');
  const inWs = (p) => !!wsRoot && (p === wsRoot || p.startsWith(`${wsRoot}/`));
  const shown = (p) => (!inWs(p) ? p : p === wsRoot ? '.' : p.slice(wsRoot.length + 1)); // display only
  const has = (id) => vs.some((b) => b.project.id === id);
  const fromId = has(pre.from) ? pre.from : has(currentProject()) ? currentProject() : vs[0].project.id;
  const st = {
    from: fromId,
    into: has(pre.into) && pre.into !== fromId ? pre.into : vs.find((b) => b.project.id !== fromId).project.id,
    name: '',
    nameTouched: false,
    folder: null, // chosen absolute root
    phases: 'append',
    merging: false,
    error: '',
    errorCards: [],
    timer: null,
    seq: 0,
  };
  const board = (id) => vs.find((b) => b.project.id === id);

  const modal = openModal({
    labelledBy: 'mv-title',
    describedBy: 'mv-sub',
    busy: () => st.merging,
    onClose: () => {
      clearTimeout(st.timer);
      st.seq++;
      mergeDlg = null;
    },
    fallbackFocus: () => $('project-btn'),
  });
  const { dlg, close } = modal;
  dlg.classList.add('mv-dialog');

  const title = node('h2', 'sv-title', 'Merge verticals');
  title.id = 'mv-title';
  const sub = node('p', 'sv-sub', 'One board, one agent, one roadmap. Nothing on disk moves.');
  sub.id = 'mv-sub';

  const vSelect = (label) => {
    const sel = document.createElement('select');
    sel.className = 'st-select mv-select';
    sel.setAttribute('aria-label', label);
    return sel;
  };
  const fromSel = vSelect('Merge from');
  const intoSel = vSelect('Merge into');
  const fromCard = node('div', 'mv-card');
  const fromRoot = node('div', 'sv-mono mv-root');
  const fromMeta = node('div', 'mv-meta');
  fromCard.append(node('div', 'sv-label', 'From'), fromSel, fromRoot, fromMeta);
  const arrow = node('div', 'mv-arrow');
  arrow.setAttribute('aria-hidden', 'true');
  arrow.append(node('span', 'mv-arrow-glyph', '→'), node('span', 'mv-arrow-word', 'into'));
  const intoCard = node('div', 'mv-card mv-result');
  const intoRoot = node('div', 'sv-mono mv-root');
  const intoMeta = node('div', 'mv-meta');
  intoCard.append(node('div', 'sv-label', 'Into'), intoSel, intoRoot, intoMeta);
  const pair = node('div', 'mv-pair');
  pair.append(fromCard, arrow, intoCard);

  const nameIn = document.createElement('input');
  nameIn.id = 'mv-name';
  nameIn.className = 'sv-input sv-name';
  nameIn.type = 'text';
  nameIn.autocomplete = 'off';
  nameIn.spellcheck = false;
  const nameLabel = node('label', 'sv-label', 'Name');
  nameLabel.htmlFor = 'mv-name';
  const folderSel = document.createElement('select');
  folderSel.id = 'mv-folder';
  folderSel.className = 'st-select mv-folder';
  const folderLabel = node('label', 'sv-label', 'Folder');
  folderLabel.htmlFor = 'mv-folder';
  const nameField = node('div', 'mv-field');
  nameField.append(nameLabel, nameIn);
  const folderField = node('div', 'mv-field');
  folderField.append(folderLabel, folderSel);
  const fields = node('div', 'mv-fields');
  fields.append(nameField, folderField);

  const roadmap = node('fieldset', 'mv-roadmap');
  roadmap.append(node('legend', 'sv-label', 'Roadmaps'));
  const radios = ['append', 'fold'].map((value) => {
    const label = node('label', 'mv-radio');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'mv-phases';
    input.value = value;
    input.checked = value === st.phases;
    input.onchange = () => {
      if (input.checked) st.phases = value;
    };
    const text = node('span', 'mv-radio-text');
    label.append(input, text);
    roadmap.append(label);
    return text;
  });

  const warn = node('div', 'mv-warn');
  warn.setAttribute('role', 'alert');
  const err = node('div', 'sv-error');
  err.setAttribute('role', 'alert');
  const termNote = node('div', 'mv-note');
  const foot = node('div', 'sv-foot');
  const summaryLine = node('span', 'sv-foot-note');
  const cancel = node('button', 'home-btn', 'Cancel');
  cancel.type = 'button';
  const merge = node('button', 'home-btn primary', 'Merge verticals');
  merge.type = 'button';
  foot.append(summaryLine, cancel, merge);
  dlg.append(title, sub, pair, fields, roadmap, warn, termNote, err, foot);

  const inFlight = () =>
    [board(st.from), board(st.into)].flatMap((b) => (b.active ?? []).map((c) => ({ ...c, board: b.project.name })));

  function folderOptions() {
    const f = board(st.from).project;
    const i = board(st.into).project;
    // only inside the workspace (separate repos → the server rejects it), and the
    // workspace's own root is never a valid vertical root either
    const both = inWs(f.root_path) && inWs(i.root_path);
    const shared = both ? mvSharedParent(f.root_path, i.root_path) : null;
    const opts = [];
    if (shared && shared !== wsRoot) opts.push([shared, `Shared parent (${shown(shared)})`]);
    opts.push([f.root_path, `Keep ${f.name}’s`], [i.root_path, `Keep ${i.name}’s`]);
    return { opts, fallback: opts.length === 3 ? shared : i.root_path };
  }

  function render() {
    const f = board(st.from);
    const i = board(st.into);
    const opt = (b, other) =>
      Object.assign(document.createElement('option'), { value: b.project.id, textContent: b.project.name, disabled: b.project.id === other });
    fromSel.replaceChildren(...vs.map((b) => opt(b, st.into)));
    intoSel.replaceChildren(...vs.map((b) => opt(b, st.from)));
    fromSel.value = st.from;
    intoSel.value = st.into;
    if (!st.nameTouched) st.name = i.project.name;
    if (nameIn.value !== st.name) nameIn.value = st.name;

    const { opts, fallback } = folderOptions();
    if (!opts.some(([v]) => v === st.folder)) st.folder = fallback;
    folderSel.replaceChildren(...opts.map(([value, textContent]) => Object.assign(document.createElement('option'), { value, textContent })));
    folderSel.value = st.folder;

    const n = mvCount(f);
    fromRoot.textContent = shown(f.project.root_path);
    fromMeta.textContent = mvPlural(n, 'card');
    intoRoot.textContent = shown(st.folder);
    intoMeta.textContent = `${st.name.trim() || i.project.name} · ${mvPlural(n + mvCount(i), 'card')}`;

    radios[0].textContent = `Keep ${i.project.name}’s phases, append ${f.project.name}’s after them`;
    radios[1].textContent = `Keep ${i.project.name}’s phases, file ${f.project.name}’s cards under ${i.project.name}’s active phase`;

    const busy = inFlight();
    warn.classList.toggle('hidden', !busy.length);
    if (busy.length) {
      const list = node('ul', 'mv-warn-list');
      for (const c of busy) {
        const li = node('li', '');
        li.append(node('span', 'mv-warn-title', c.title), node('span', 'mv-warn-where', ` · ${c.board} · ${LANE_NAME(c.lane)}`));
        list.append(li);
      }
      warn.replaceChildren(
        node('div', 'mv-warn-head', `⚠ ${busy.length === 1 ? 'A card is' : `${busy.length} cards are`} in progress or in review`),
        list,
        node('div', 'mv-warn-hint', 'Merge it or send it back first.'),
      );
    } else warn.replaceChildren();
    termNote.textContent = `${f.project.name}’s terminal session will be closed.`;

    summaryLine.textContent = `moves ${mvPlural(n, 'card')} · stats and history kept`;
    err.replaceChildren();
    if (st.error) {
      err.append(node('div', '', st.error));
      if (st.errorCards.length) {
        const list = node('ul', 'mv-err-list');
        list.append(...st.errorCards.map((t) => node('li', '', t)));
        err.append(list);
      }
    }
    merge.textContent = st.merging ? 'Merging…' : 'Merge verticals';
    merge.disabled = st.merging || busy.length > 0;
    cancel.disabled = st.merging;
    for (const el of [fromSel, intoSel, nameIn, folderSel, ...roadmap.querySelectorAll('input')]) el.disabled = st.merging;
  }

  const clearError = () => {
    st.error = '';
    st.errorCards = [];
  };
  fromSel.onchange = () => {
    if (fromSel.value === st.into) st.into = st.from; // swap rather than allow from = into
    st.from = fromSel.value;
    clearError();
    render();
  };
  intoSel.onchange = () => {
    if (intoSel.value === st.from) st.from = st.into;
    st.into = intoSel.value;
    clearError();
    render();
  };
  nameIn.oninput = () => {
    st.name = nameIn.value;
    st.nameTouched = true;
    intoMeta.textContent = `${st.name.trim() || board(st.into).project.name} · ${mvPlural(mvCount(board(st.from)) + mvCount(board(st.into)), 'card')}`;
  };
  folderSel.onchange = () => {
    st.folder = folderSel.value;
    clearError();
    render();
  };

  // Live board traffic (a card leaving review, a vertical renamed/removed) → re-read, debounced.
  async function refresh() {
    const seq = ++st.seq;
    let next;
    try {
      next = await read();
    } catch {
      return; // keep the last good read
    }
    if (seq !== st.seq) return;
    const nv = verticalsOf(next);
    const ok = (id) => nv.some((b) => b.project.id === id);
    if (nv.length < 2 || !ok(st.from) || !ok(st.into)) {
      if (st.merging) return; // our own merge removed `from`; doMerge closes the dialog
      close();
      return svFlash('The workspace changed — reopen Merge to continue.');
    }
    vs = nv;
    render();
  }
  mergeDlg = {
    refresh: () => {
      clearTimeout(st.timer);
      st.timer = setTimeout(refresh, MV_REFRESH_MS);
    },
  };

  async function doMerge() {
    if (st.merging || merge.disabled) return;
    const f = board(st.from).project;
    const into = st.into;
    const body = { from: f.id, into, phases: st.phases, root: st.folder };
    const name = st.name.trim();
    if (name) body.name = name;
    st.merging = true;
    clearError();
    render();
    // project_removed(from) can reload the page before the response lands
    mergeRedirect = { from: f.id, into, flash: `Merged ${f.name} into ${name || board(into).project.name}` };
    let res, out;
    try {
      res = await fetch('/verticals/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      out = await res.json().catch(() => ({}));
    } catch {
      out = { error: 'Couldn’t reach the daemon — try again.' };
    }
    st.merging = false;
    if (res?.ok) {
      close();
      const done = `Merged ${f.name} into ${out.name ?? (name || board(into).project.name)}`;
      if (currentProject() === f.id || projectId === f.id) {
        svFlashAfterReload(done);
        return void (location.search = mvRedirectSearch(into));
      }
      svFlash(done);
      mergeRedirect = null;
      loadProjects();
      if (term.enabled) refreshTermTabs();
      if (activeView === 'dashboard') loadDashboard();
      else if (activeView === 'home') loadHome();
      return;
    }
    mergeRedirect = null;
    st.error = typeof out.error === 'string' && out.error ? out.error : `Couldn’t merge (HTTP ${res?.status}).`;
    const titles = new Map(vs.flatMap((b) => (b.active ?? []).map((c) => [c.id, c.title])));
    st.errorCards = (Array.isArray(out.cardIds) ? out.cardIds : []).map((id) => titles.get(id) ?? id);
    render();
    mergeDlg.refresh(); // the board may have changed under us
  }

  cancel.onclick = close;
  merge.onclick = doMerge;
  render();
  modal.mount();
  fromSel.focus();
}

// Where to land when the vertical we're viewing was merged away: the merged board, same view.
function mvRedirectSearch(into) {
  const view = activeView === 'dashboard' || URL_VIEWS.includes(activeView) ? `&view=${activeView}` : '';
  return `?project=${encodeURIComponent(into)}${view}`;
}

// "Merge…" button for a vertical's tile/row (Dashboard, Home); null when merging isn't possible.
function mergeButton(pid, name, verticalCount) {
  if (EMBED || verticalCount < 2) return null;
  const b = node('button', 'mv-open', 'Merge…');
  b.type = 'button';
  b.title = `Merge ${name} into another vertical`;
  b.setAttribute('aria-label', `Merge ${name} into another vertical`);
  b.onclick = (e) => {
    e.stopPropagation();
    openMergeDialog({ from: pid });
  };
  return b;
}

// ── visual planner: drafts list + plan graph canvas ─────────────────
// ?view=planner[&plan=<id>]. Drafts live on the WORKSPACE (a vertical resolves to
// it server-side); the canvas keeps its own socket on the workspace id because
// plan_draft broadcasts go to the workspace's subscribers only. Data → textContent.
const PL = { COL: 240, GAP: 20, X0: 20, PAD: 20, NODE_W: 200, NODE_H: 88, TOP: 52, STEP: 120 };
const PL_MAIN_COLOR = '#aab2c5';
const PL_VERT_COLORS = ['#61afef', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66', '#98c379', '#f0a0a7'];
const PL_PHASE_COLORS = ['#5dd3a8', '#61afef', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66', '#98c379'];
const PL_NONE_COLOR = '#8b93a7';
const PL_ZOOM_MIN = 0.25;
const PL_ZOOM_MAX = 2;
const SVG_NS = 'http://www.w3.org/2000/svg';
const plan = {
  project: null, // the project the list was loaded for
  workspace: null, // its workspace id (the socket's subscription)
  list: null, // PlanDraftSummary[]
  listFailed: false,
  openId: null,
  view: null, // GET /plan-drafts/:id payload for openId
  viewFailed: false,
  notice: '',
  lastCols: new Map(), // draftId → last valid layout.columns (shown while a cycle pauses steps)
  selected: null, // selected node id (the node editor reads this)
  flagged: null, // { ids: Set, kind: 'error' | 'warn', key } from a strip's "Show cards"
  colorBy: 'board',
  xf: { x: 12, y: 12, k: 1 },
  size: { W: 0, H: 0 },
  fitted: false,
  seq: 0,
  listSeq: 0,
  busy: false,
  autoFit: null, // the minK of the last fit, until the user pans/zooms (re-fit on resize)
  stripKey: '',
  skipSync: false, // the socket's first open right after openPlanner's own fetch
  stripError: '',
  ws: null,
  retry: 1000,
  retryTimer: null,
  listTimer: null,
  ed: null, // the card editor for `selected` (renderPlanEditor)
  listOpen: false, // the drafts list shown anyway while the editor is open
  selEdge: null, // { from, to }: the selected arrow
  link: null, // drag-to-connect in progress (startPlanLink)
  queue: Promise.resolve(), // PATCHes run one at a time, in order
  patching: 0, // PATCHes in flight
  deferVersion: 0, // highest plan_draft version heard while patching (checked once they land)
  boardPhases: new Map(), // board id → its existing phase titles (fetched on demand, per planner visit)
  lostSaves: new Map(), // `${draft}\0${node}\0${field}` → the value whose last save failed after its editor closed
  actionBusy: false, // Commit is flushing edits before its dialog opens
  liveStripKey: '', // Live's blocked strip, re-filled only when it changes
  failN: 0, // failed PATCHes so far (planDrain counts the ones that land while it waits)
  failLog: [], // { n, draft, what }: the recent failed PATCHes, newest last
  visit: 0, // bumped on closePlanner: work started in an earlier visit never opens a dialog
  modes: new Map(), // draftId → 'plan' | 'live' (mirrors localStorage)
  live: { draft: null, cards: new Map(), pending: new Set(), failed: new Set(), seq: 0 }, // Live mode's card cache
};

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, String(v));
  return el;
}

// [label, css modifier] from committed_version and version
function planStatus(d) {
  if (d.committed_version === null || d.committed_version === undefined) return ['Draft', 'draft'];
  return d.version === d.committed_version ? ['Committed', 'committed'] : ['Committed · edited', 'edited'];
}

function planChip(d, cls = 'pl-chip') {
  const [label, mod] = planStatus(d);
  return node('span', `${cls} ${mod}`, label);
}

async function openPlanner() {
  renderPlanner();
  const project = currentProject();
  if (!project) return; // the init message re-opens once the project is known
  plan.project = project;
  plan.boardPhases.clear();
  await resolvePlanWorkspace();
  if (activeView !== 'planner') return;
  await loadPlanList();
  if (activeView !== 'planner') return;
  if (!plan.ws && !plan.retryTimer) {
    plan.skipSync = !plan.listFailed; // the list was just fetched and the draft is fetched below
    planConnect();
  }
  const want = new URLSearchParams(location.search).get('plan');
  const id = want || plan.openId || plan.list?.[0]?.id || null;
  if (id) openPlan(id, id === plan.openId && !!plan.view);
  else renderPlanner();
}

// The workspace id for the socket. Only a real answer is kept; on failure it's
// retried on the next (re)connect.
async function resolvePlanWorkspace() {
  if (plan.workspace || !plan.project) return;
  try {
    const res = await fetch(`/workspace?project=${encodeURIComponent(plan.project)}`);
    if (res.ok) plan.workspace = (await res.json()).workspace.id;
  } catch {
    /* daemon hiccup — retried on the next (re)connect */
  }
}

function closePlanner() {
  plan.visit++; // a Commit still draining its saves must not open its dialog later
  plan.skipSync = false;
  clearTimeout(plan.retryTimer);
  clearTimeout(plan.listTimer);
  plan.retryTimer = null;
  plan.retry = 1000;
  const ws = plan.ws;
  plan.ws = null;
  ws?.close();
  plan.live.draft = null; // no card messages while away: re-read on the next visit
  const url = new URL(location.href);
  if (url.searchParams.get('view') === 'planner') url.searchParams.delete('view');
  url.searchParams.delete('plan');
  history.replaceState(null, '', url);
}

// Subscribed to every project (like the dashboard): a plan's cards live on the
// vertical boards too, and their card messages only go to each board's own channel.
async function planConnect() {
  await resolvePlanWorkspace();
  if (activeView !== 'planner' || plan.ws) return;
  const ws = new WebSocket(`ws://${location.host}/ws`);
  plan.ws = ws;
  ws.onopen = () => {
    plan.retry = 1000;
    if (plan.skipSync) return void (plan.skipSync = false); // openPlanner just fetched
    loadPlanList(); // re-connect: catch anything missed while disconnected
    if (plan.openId) openPlan(plan.openId, true);
    if (plan.view && planIsLive(plan.view)) loadLiveCards(true); // card moves missed while disconnected
  };
  ws.onmessage = (e) => onPlannerMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (plan.ws !== ws) return; // closed on purpose (left the view)
    plan.ws = null;
    plan.skipSync = false; // whatever opens next is a re-connect
    plan.retryTimer = setTimeout(() => {
      plan.retryTimer = null;
      if (activeView === 'planner') planConnect();
    }, plan.retry);
    plan.retry = Math.min(plan.retry * 2, 10000);
  };
}

function onPlannerMessage(msg) {
  if (msg.type === 'card' || msg.type === 'card_removed') return onLiveCard(msg);
  // this workspace's drafts only (unresolved workspace: take them all, as before)
  const ws = plan.workspace ?? plan.list?.[0]?.workspace_id;
  if (msg.workspace_id && ws && msg.workspace_id !== ws) return;
  if (msg.type === 'plan_draft') {
    schedulePlanList();
    if (msg.id !== plan.openId) return;
    // our own PATCH's echo can beat its response: hold versions heard mid-PATCH until it lands
    if (plan.patching) plan.deferVersion = Math.max(plan.deferVersion, msg.version);
    else if (!plan.view || msg.version > plan.view.draft.version) openPlan(msg.id, true);
  } else if (msg.type === 'plan_draft_removed') {
    if (plan.list) plan.list = plan.list.filter((d) => d.id !== msg.id);
    schedulePlanList();
    if (msg.id === plan.openId) {
      plan.openId = null;
      plan.view = null;
      plan.selected = null;
      plan.flagged = null;
      plan.notice = 'That plan was deleted.';
      setPlanUrl(null);
    }
    renderPlanner();
  }
}

function schedulePlanList() {
  clearTimeout(plan.listTimer);
  plan.listTimer = setTimeout(loadPlanList, 250);
}

async function loadPlanList() {
  if (!plan.project) return;
  const seq = ++plan.listSeq;
  let list = null;
  try {
    const res = await fetch(`/plan-drafts?workspace=${encodeURIComponent(plan.project)}`);
    if (res.ok) list = await res.json();
  } catch {
    /* handled below */
  }
  if (seq !== plan.listSeq) return; // a newer fetch owns the list
  if (list) plan.list = list;
  plan.listFailed = !list;
  if (activeView === 'planner') renderPlanner();
}

function setPlanUrl(id) {
  const url = new URL(location.href);
  url.searchParams.set('view', 'planner');
  if (id) url.searchParams.set('plan', id);
  else url.searchParams.delete('plan');
  history.replaceState(null, '', url);
}

// Open a draft (refresh=true: refetch the open one in place, keeping pan/zoom + selection).
async function openPlan(id, refresh = false) {
  if (!refresh || id !== plan.openId) {
    plan.selected = null;
    plan.selEdge = null;
    endPlanLink();
    plan.flagged = null;
    plan.fitted = false;
    plan.stripError = '';
    plan.live.draft = null; // Live re-reads every card on a fresh open
    if (plan.view?.draft.id !== id) plan.view = null;
  }
  plan.openId = id;
  plan.notice = '';
  plan.viewFailed = false;
  setPlanUrl(id);
  if (!refresh) renderPlanner();
  const seq = ++plan.seq;
  let view = null;
  let missing = false;
  try {
    const res = await fetch(`/plan-drafts/${encodeURIComponent(id)}`);
    if (res.status === 404) missing = true;
    else if (res.ok) view = await res.json();
  } catch {
    /* handled below */
  }
  if (seq !== plan.seq || plan.openId !== id) return; // superseded
  if (missing) {
    plan.openId = null;
    plan.view = null;
    plan.notice = 'That plan no longer exists.';
    setPlanUrl(null);
    return renderPlanner();
  }
  if (!view) {
    plan.viewFailed = !plan.view;
    return renderPlanner();
  }
  setPlanView(view);
}

function setPlanView(view) {
  if (view?.draft?.id !== plan.openId) return; // another draft was opened meanwhile
  const cur = plan.view;
  if (cur && cur.draft.id === view.draft.id && view.draft.version < cur.draft.version) return; // stale
  plan.view = view;
  const { draft } = view;
  if (view.layout) plan.lastCols.set(draft.id, view.layout.columns);
  const ids = new Set(draft.data.nodes.map((n) => n.id));
  if (plan.selected && !ids.has(plan.selected)) plan.selected = null;
  if (plan.flagged) plan.flagged = null; // issues are recomputed; old highlights may no longer apply
  // a lost save of a card that's gone can never be retried: drop it
  for (const k of plan.lostSaves.keys()) {
    const [d, nodeId] = k.split('\u0000');
    if (d === draft.id && !ids.has(nodeId)) plan.lostSaves.delete(k);
  }
  const row = plan.list?.find((d) => d.id === draft.id);
  if (row)
    Object.assign(row, {
      title: draft.title,
      version: draft.version,
      committed_version: draft.committed_version,
      node_count: draft.data.nodes.length,
      edge_count: draft.data.edges.length,
    });
  renderPlanner();
  if (planIsLive(view)) loadLiveCards(); // only cards not seen yet (a node committed since): no refetch loop
}

function renderPlanner() {
  renderPlanList();
  renderPlanMain();
}

function renderPlanList() {
  $('pl-new').classList.toggle('hidden', EMBED);
  const host = $('pl-list');
  if (!plan.list) {
    host.replaceChildren(node('div', 'pl-list-empty', plan.listFailed ? 'Couldn’t load plans.' : 'Loading plans…'));
    return;
  }
  if (!plan.list.length) {
    host.replaceChildren(node('div', 'pl-list-empty', 'No plans yet.'));
    return;
  }
  host.replaceChildren(
    ...plan.list.map((d) => {
      const b = node('button', 'pl-item');
      b.type = 'button';
      if (d.id === plan.openId) {
        b.classList.add('current');
        b.setAttribute('aria-current', 'true');
      }
      const meta = node('span', 'pl-item-meta');
      meta.append(node('span', 'pl-item-count', `${d.node_count} card${d.node_count === 1 ? '' : 's'}`), planChip(d));
      b.append(node('span', 'pl-item-title', d.title), meta);
      b.onclick = () => openPlan(d.id);
      return b;
    }),
  );
}

function renderPlanEmpty() {
  const host = $('pl-empty');
  const box = node('div', 'pl-empty-box');
  if (!plan.list && !plan.listFailed) box.append(node('div', 'pl-empty-sub', 'Loading plans…'));
  else if (plan.openId && plan.viewFailed) box.append(node('div', 'pl-empty-sub', 'Couldn’t load this plan.'));
  else if (plan.openId) box.append(node('div', 'pl-empty-sub', 'Loading plan…'));
  else if (plan.list && !plan.list.length) {
    if (plan.notice) box.append(node('div', 'pl-empty-sub', plan.notice));
    box.append(
      node('div', 'pl-empty-title', 'No plans yet'),
      node('div', 'pl-empty-sub', 'Sketch cards across boards, wire their dependencies, then commit the plan to the board.'),
    );
    if (!EMBED) {
      const b = node('button', 'pl-btn', '+ New plan');
      b.type = 'button';
      b.onclick = showNewPlanForm;
      box.append(b);
    }
  } else {
    if (plan.notice) box.append(node('div', 'pl-empty-sub', plan.notice));
    box.append(node('div', 'pl-empty-title', 'Select a plan'));
  }
  host.replaceChildren(box);
}

function renderPlanMain() {
  const v = plan.view;
  const open = !!v && v.draft.id === plan.openId;
  $('pl-open').classList.toggle('hidden', !open);
  $('pl-empty').classList.toggle('hidden', open);
  renderPlanEditor(); // before any fit: the panel takes its width from the canvas
  if (!open) return renderPlanEmpty();
  const { draft, validation } = v;
  const live = planIsLive(v);
  $('pl-title').textContent = draft.title;
  const run = live ? planRunMode(draft.id) : null;
  const [chipLabel, chipMod] = run ? [run === 'autopilot' ? 'Running · autopilot' : 'Running · queue only', 'committed'] : planStatus(draft);
  $('pl-chip').className = `pl-chip ${chipMod}`;
  $('pl-chip').textContent = chipLabel;
  renderPlanMode(v);
  renderPlanSaved();
  $('pl-add').classList.toggle('hidden', EMBED || live);
  $('pl-hint').classList.toggle('hidden', EMBED || live);
  document.querySelector('#planner-view .pl-colorby').classList.toggle('hidden', live);
  const n = validation.errors.length;
  $('pl-errcount').textContent = n && !live ? `Fix ${n} error${n === 1 ? '' : 's'} to commit` : '';
  $('pl-by-board').setAttribute('aria-pressed', String(plan.colorBy === 'board'));
  $('pl-by-phase').setAttribute('aria-pressed', String(plan.colorBy === 'phase'));
  const model = planModel(v);
  const prev = plan.size;
  renderPlanLegend(v, model);
  renderPlanGraph(v, model);
  renderPlanStrip(v, model);
  const grew = prev.W !== plan.size.W || prev.H !== plan.size.H;
  if (!plan.fitted && $('pl-canvas').clientWidth) {
    plan.fitted = true;
    planFit(0.6); // first look stays readable; the Fit button fits everything
  } else if (grew && plan.autoFit !== null) planFit(plan.autoFit); // still as fitted: keep it all in view
  else applyPlanXf();
}

// Board id → { name, color }: Main first, verticals in the boards array's order.
function planBoards(v) {
  const map = new Map();
  let i = 0;
  for (const b of v.boards) {
    const main = b.root === '';
    map.set(b.id, { name: main ? 'Main' : b.name, color: main ? PL_MAIN_COLOR : PL_VERT_COLORS[i++ % PL_VERT_COLORS.length] });
  }
  return map;
}

// Phase name → colour: a stable palette over the draft's phase names, sorted.
function planPhases(v) {
  const names = [...new Set(v.draft.data.nodes.map((n) => n.phase).filter(Boolean))].sort();
  return new Map(names.map((p, i) => [p, PL_PHASE_COLORS[i % PL_PHASE_COLORS.length]]));
}

function planModel(v) {
  const { nodes: all, edges } = v.draft.data;
  const nodes = all.filter((n, i) => all.findIndex((m) => m.id === n.id) === i); // first of any duplicate id
  const paused = !v.layout;
  const cols = v.layout?.columns ?? plan.lastCols.get(v.draft.id) ?? null;
  const byCol = [];
  for (const n of nodes) {
    const c = cols && Number.isInteger(cols[n.id]) ? cols[n.id] : 0;
    (byCol[c] ??= []).push(n);
  }
  const ncol = Math.max(1, byCol.length);
  const pos = new Map();
  const colX = (c) => PL.X0 + c * (PL.COL + PL.GAP);
  let maxN = 1;
  for (let c = 0; c < ncol; c++) {
    const list = (byCol[c] ??= []);
    maxN = Math.max(maxN, list.length);
    list.forEach((n, i) => pos.set(n.id, { x: colX(c) + PL.PAD, y: PL.TOP + i * PL.STEP }));
  }
  // A cycle's arrows, or a self-loop's: each issue's edge indexes in draft order.
  const issueEdges = (it) => {
    const ids = it.nodes ?? [];
    if (it.code === 'self_loop') return edges.flatMap((e, i) => (e.from === e.to && e.from === ids[0] ? [i] : []));
    if (it.code !== 'cycle') return [];
    const pairs = new Set(ids.map((id, i) => `${id}\u0000${ids[(i + 1) % ids.length]}`));
    return edges.flatMap((e, i) => (pairs.has(`${e.from}\u0000${e.to}`) ? [i] : []));
  };
  const loopIssues = v.validation.errors.filter((e) => e.code === 'cycle' || e.code === 'self_loop');
  const cycle = loopIssues.flatMap((e) => e.nodes ?? []);
  const cycleEdges = loopIssues.flatMap(issueEdges);
  const chain = v.layout?.longestChain ?? [];
  const chainPairs = new Set(chain.slice(1).map((id, i) => `${chain[i]}\u0000${id}`));
  const backward = edges.some((e) => e.from !== e.to && pos.has(e.from) && pos.has(e.to) && pos.get(e.to).x <= pos.get(e.from).x);
  const bandH = PL.TOP + maxN * PL.STEP - (PL.STEP - PL.NODE_H) + 24;
  return {
    nodes,
    edges,
    pos,
    byCol,
    colX,
    paused,
    stale: paused && !!cols, // showing the last valid layout
    cycle: new Set(cycle),
    cycleEdges: new Set(cycleEdges),
    newestEdge: (it) => edges[issueEdges(it).at(-1)] ?? null, // "Remove newest arrow" for a cycle / self-loop issue
    maxN,
    chain: chain.length >= 2 ? new Set(chain) : new Set(),
    chainLen: chain.length,
    chainPairs,
    bandH,
    W: colX(ncol),
    H: bandH + (backward ? 36 : 0),
  };
}

function planColor(v, n, boards, phases) {
  if (plan.colorBy === 'phase') return n.phase ? phases.get(n.phase) : PL_NONE_COLOR;
  return boards.get(n.board_id)?.color ?? PL_NONE_COLOR;
}

function legendItem(color, label) {
  const s = node('span', 'pl-lg');
  const dot = node('span', 'pl-dot');
  dot.style.background = color;
  s.append(dot, node('span', '', label));
  return s;
}

function renderPlanLegend(v, m) {
  if (planIsLive(v)) return $('pl-legend').replaceChildren(...planLiveLegend());
  const items = [];
  if (plan.colorBy === 'phase') {
    for (const [p, c] of planPhases(v)) items.push(legendItem(c, p));
    if (m.nodes.some((n) => !n.phase)) items.push(legendItem(PL_NONE_COLOR, 'No phase'));
  } else for (const b of planBoards(v).values()) items.push(legendItem(b.color, b.name));
  if (m.chain.size) {
    const s = node('span', 'pl-lg pl-lg-chain');
    s.append(node('span', 'pl-chain-swatch'), node('span', '', `Critical path · ${m.chainLen} steps`));
    items.push(s);
  }
  $('pl-legend').replaceChildren(...items);
}

// A polyline as a path with rounded corners (radius r, at most half of a segment).
function planRoundPath(pts, r) {
  const p = pts.filter((q, i) => i === 0 || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1]);
  let d = `M${p[0][0]} ${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [[ax, ay], [bx, by], [cx, cy]] = [p[i - 1], p[i], p[i + 1]];
    const l1 = Math.hypot(bx - ax, by - ay);
    const l2 = Math.hypot(cx - bx, cy - by);
    const k = Math.min(r, l1 / 2, l2 / 2);
    d += ` L${bx - ((bx - ax) * k) / l1} ${by - ((by - ay) * k) / l1} Q${bx} ${by} ${bx + ((cx - bx) * k) / l2} ${by + ((cy - by) * k) / l2}`;
  }
  return `${d} L${p[p.length - 1][0]} ${p[p.length - 1][1]}`;
}

// Cubic from the right edge of `a` to the left edge of `b`. An arrow that skips
// columns (`lane` set) runs through the gaps instead: down the corridor after `a`,
// along a row gap (no card sits there in any column), and into `b` from the
// corridor before it, so it never passes under a card. A self-loop rounds over
// the node's top-right corner; a backward arrow (cycle / stale layout) loops
// under the columns.
function planEdgePath(a, b, m, lane) {
  const x1 = a.x + PL.NODE_W;
  const y1 = a.y + PL.NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + PL.NODE_H / 2;
  if (a === b) {
    const tx = x1 - 30;
    return `M${x1} ${y1} C${x1 + 44} ${y1} ${tx} ${a.y - 44} ${tx} ${a.y}`;
  }
  if (x2 > x1 && lane !== undefined) {
    const half = (PL.COL + PL.GAP - PL.NODE_W) / 2; // the middle of the corridor between node columns
    return planRoundPath([[x1, y1], [x1 + half, y1], [x1 + half, lane], [x2 - half, lane], [x2 - half, y2], [x2, y2]], 14);
  }
  if (x2 > x1) {
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  }
  const by = m.H - 12;
  return `M${x1} ${y1} C${x1 + 36} ${y1} ${x1 + 36} ${by} ${x1 - 10} ${by} L${x2 - 10} ${by} C${x2 - 34} ${by} ${x2 - 34} ${y2} ${x2} ${y2}`;
}

function renderPlanGraph(v, m) {
  const live = planIsLive(v); // read-only: no arrow hits, no handles, nodes coloured by lane
  const world = $('pl-world');
  const canvas = $('pl-canvas');
  const refocus = document.activeElement?.closest?.('.pl-node')?.dataset.id;
  plan.size = { W: m.W, H: m.H };
  world.style.width = `${m.W}px`;
  world.style.height = `${m.H}px`;
  const paused = $('pl-paused');
  paused.classList.toggle('hidden', !m.paused);
  paused.textContent = m.stale ? 'Steps paused · showing the last valid layout' : 'Steps paused · fix the cycle to see steps';
  $('pl-canvas-empty').classList.toggle('hidden', m.nodes.length > 0);
  canvas.classList.toggle('paused', m.paused);

  const parts = [];
  // step bands (none in the single-column fallback or an empty draft: no steps to show)
  if (m.nodes.length && (!m.paused || m.stale)) {
    m.byCol.forEach((list, c) => {
      const band = node('div', 'pl-band');
      band.style.left = `${m.colX(c)}px`;
      band.style.width = `${PL.COL}px`;
      band.style.height = `${m.bandH}px`;
      const label = node('div', 'pl-band-label', `STEP ${c + 1}`);
      if (!m.paused) label.append(node('span', '', ` · ${list.length} card${list.length === 1 ? '' : 's'}`));
      band.append(label);
      parts.push(band);
    });
  }

  const svg = svgEl('svg', { width: m.W, height: m.H, viewBox: `0 0 ${m.W} ${m.H}`, class: 'pl-edges', 'aria-hidden': 'true' });
  const defs = svgEl('defs');
  for (const [id, fill, size] of [['pl-ah', m.paused ? '#3f4555' : '#5b6275', 8], ['pl-ahm', '#5dd3a8', 7], ['pl-ahr', '#e06c75', 7]]) {
    const mk = svgEl('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: size, markerHeight: size, orient: 'auto' });
    mk.append(svgEl('path', { d: 'M0 1L9 5L0 9z', fill }));
    defs.append(mk);
  }
  svg.append(defs);
  const plain = svgEl('g', { fill: 'none', stroke: m.paused ? '#3f4555' : '#5b6275', 'stroke-width': 1.5 });
  const halo = svgEl('g', { fill: 'none', 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-opacity': m.paused ? 0.2 : 0.22 });
  const hot = svgEl('g', { fill: 'none', 'stroke-width': 2.5 });
  const hits = svgEl('g', { fill: 'none' }); // wide invisible strokes: click an arrow to select it
  const colOf = (p) => Math.round((p.x - PL.X0 - PL.PAD) / (PL.COL + PL.GAP));
  const laneUse = new Map(); // row gap → arrows already in it (spread them apart)
  m.edges.forEach((e, i) => {
    const a = m.pos.get(e.from);
    const b = m.pos.get(e.to);
    if (!a || !b) return;
    let lane;
    if (colOf(b) - colOf(a) > 1) {
      // the row gap (below row 1..maxN, never above the first: step labels) nearest both ends
      const ya = a.y + PL.NODE_H / 2;
      const yb = b.y + PL.NODE_H / 2;
      let best = 1;
      const gapY = (r) => PL.TOP + r * PL.STEP - (PL.STEP - PL.NODE_H) / 2;
      for (let r = 2; r <= m.maxN; r++)
        if (Math.abs(gapY(r) - ya) + Math.abs(gapY(r) - yb) < Math.abs(gapY(best) - ya) + Math.abs(gapY(best) - yb)) best = r;
      const k = laneUse.get(best) ?? 0;
      laneUse.set(best, k + 1);
      lane = gapY(best) + [0, -6, 6][k % 3];
    }
    const d = planEdgePath(a, b, m, lane);
    const kind = m.cycleEdges.has(i) ? 'cycle' : m.chainPairs.has(`${e.from}\u0000${e.to}`) ? 'chain' : '';
    if (!EMBED && !live) hits.append(svgEl('path', { d, class: 'pl-edge-hit', 'data-i': i }));
    if (!kind) return plain.append(svgEl('path', { d, 'marker-end': 'url(#pl-ah)', class: 'pl-edge-vis', 'data-i': i }));
    const color = kind === 'cycle' ? '#e06c75' : '#5dd3a8';
    halo.append(svgEl('path', { d, stroke: color }));
    hot.append(svgEl('path', { d, stroke: color, 'marker-end': `url(#${kind === 'cycle' ? 'pl-ahr' : 'pl-ahm'})`, 'data-edge': `${e.from}>${e.to}`, class: 'pl-edge-vis', 'data-i': i }));
  });
  svg.append(plain, halo, hot, hits);
  parts.push(svg);

  const boards = planBoards(v);
  const phases = planPhases(v);
  for (const n of m.nodes) {
    const p = m.pos.get(n.id);
    const board = boards.get(n.board_id);
    const color = planColor(v, n, boards, phases);
    const inCycle = m.cycle.has(n.id);
    const b = node('button', 'pl-node');
    b.type = 'button';
    b.dataset.id = n.id;
    b.style.left = `${p.x}px`;
    b.style.top = `${p.y}px`;
    if (!live) {
      if (m.chain.has(n.id)) b.classList.add('chain');
      if (inCycle) b.classList.add('cycle');
      else if (m.cycle.size) b.classList.add('dim');
    }
    const boardName = board?.name ?? 'Unknown board';
    b.setAttribute(
      'aria-label',
      [n.title || 'Untitled', boardName, n.phase || 'no phase'].join(', ') + (inCycle ? ', part of a cycle' : ''),
    );
    const top = node('span', 'pl-node-top');
    const dot = node('span', 'pl-dot');
    dot.style.background = color;
    const bn = node('span', 'pl-node-board', boardName);
    if (plan.colorBy === 'board' && !live) bn.style.color = color; // Live: board names go neutral grey
    if (live) top.append(bn);
    else top.append(dot, bn);
    if (n.phase) {
      const ph = node('span', 'pl-node-phase', `· ${n.phase}`);
      if (plan.colorBy === 'phase' && !live) ph.style.color = color;
      top.append(ph);
    }
    const noSpec = !n.requirements?.trim() || !n.subtasks?.length;
    const crit = n.subtasks?.length ?? 0;
    const meta = inCycle
      ? node('span', 'pl-node-meta cycle', 'in cycle')
      : noSpec
        ? node('span', 'pl-node-meta warn', 'No spec yet')
        : node('span', 'pl-node-meta', `${crit} criteri${crit === 1 ? 'on' : 'a'}`);
    b.append(top, node('span', 'pl-node-title', n.title || 'Untitled'), meta);
    b.onclick = () => selectPlanNode(n.id);
    parts.push(b);
    if (live) applyLiveNode(b, n, v, boardName);
    else if (!EMBED) {
      // drag from here to another card to add an arrow (startPlanLink)
      const h = node('span', 'pl-handle');
      h.dataset.id = n.id;
      h.setAttribute('aria-hidden', 'true');
      h.style.left = `${p.x + PL.NODE_W - 8}px`;
      h.style.top = `${p.y + PL.NODE_H / 2 - 8}px`;
      parts.push(h);
    }
  }
  world.replaceChildren(...parts);
  updatePlanMarks();
  markPlanEdge();
  if (plan.link) drawPlanLink(); // a re-render mid-drag: put the dashed arrow back
  if (refocus) world.querySelector(`.pl-node[data-id="${CSS.escape(refocus)}"]`)?.focus({ preventScroll: true });
}

// Selection ring + "Show cards" highlight, without a re-render.
function updatePlanMarks() {
  for (const b of $('pl-world').querySelectorAll('.pl-node')) {
    const sel = b.dataset.id === plan.selected;
    b.classList.toggle('selected', sel);
    b.setAttribute('aria-pressed', String(sel));
    const f = plan.flagged?.ids.has(b.dataset.id);
    b.classList.toggle('flag-error', !!f && plan.flagged.kind === 'error');
    b.classList.toggle('flag-warn', !!f && plan.flagged.kind === 'warn');
  }
  for (const btn of $('pl-strip').querySelectorAll('.pl-show')) btn.setAttribute('aria-pressed', String(plan.flagged?.key === btn.dataset.key));
}

const PL_ICON = {
  error: ['M12 8v5', 'M12 16h.01'],
  warn: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z'],
};
function planIssueIcon(kind) {
  const svg = svgEl('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: kind === 'error' ? '#e06c75' : '#e5c07b', 'stroke-width': 2, 'stroke-linecap': 'round', class: 'pl-issue-icon', 'aria-hidden': 'true' });
  if (kind === 'error') svg.append(svgEl('circle', { cx: 12, cy: 12, r: 9 }));
  for (const d of PL_ICON[kind]) svg.append(svgEl('path', { d }));
  return svg;
}

// The strip's two containers are persistent (index.html) and only re-filled when
// the issues change, so a screen reader doesn't re-announce the alert on every render.
function renderPlanStrip(v, m) {
  renderLiveStrip(v);
  if (planIsLive(v)) {
    // Live: the validation issues give way to the blocked strip
    if (plan.stripKey !== 'live') {
      plan.stripKey = 'live';
      $('pl-errors').replaceChildren();
      $('pl-warns').replaceChildren();
    }
    return;
  }
  const titles = new Map(m.nodes.map((n) => [n.id, n.title || n.id]));
  const { errors, warnings } = v.validation;
  const loops = errors.filter((it) => it.code === 'cycle' || it.code === 'self_loop');
  const key = JSON.stringify([
    v.draft.id,
    errors,
    warnings,
    plan.stripError,
    loops.map((it) => [(it.nodes ?? []).map((id) => titles.get(id)), m.newestEdge(it)]),
  ]);
  const syncBusy = () => $('pl-strip').querySelectorAll('.pl-remove').forEach((b) => (b.disabled = plan.busy));
  if (key === plan.stripKey) return syncBusy();
  plan.stripKey = key;
  const issue = (it, kind, key) => {
    const row = node('div', `pl-issue ${kind}`);
    const text = node('span', 'pl-issue-text');
    if (it.code === 'cycle' && it.nodes?.length) {
      text.append(node('b', '', 'Cycle:'), ` ${[...it.nodes, it.nodes[0]].map((id) => titles.get(id) ?? id).join(' → ')}. Remove one arrow.`);
    } else if (it.code === 'self_loop' && it.nodes?.length) {
      text.append(node('b', '', 'Cycle:'), ` ${titles.get(it.nodes[0]) ?? it.nodes[0]} depends on itself. Remove the arrow.`);
    } else text.textContent = it.message;
    row.append(planIssueIcon(kind), text);
    if (it.nodes?.length) {
      const show = node('button', 'pl-show', 'Show cards');
      show.type = 'button';
      show.dataset.key = key;
      show.onclick = () => {
        plan.flagged = plan.flagged?.key === key ? null : { ids: new Set(it.nodes), kind, key };
        updatePlanMarks();
        if (plan.flagged) planReveal(it.nodes);
      };
      row.append(show);
    }
    const edge = m.newestEdge(it);
    if (edge && !EMBED) {
      const rm = node('button', 'pl-remove', 'Remove newest arrow');
      rm.type = 'button';
      rm.onclick = () => removePlanEdge(edge);
      row.append(rm);
    }
    return row;
  };
  const errs = errors.map((it, i) => issue(it, 'error', `e${i}`));
  if (plan.stripError) errs.push(node('div', 'pl-issue error pl-strip-err', plan.stripError));
  $('pl-errors').replaceChildren(...errs);
  $('pl-warns').replaceChildren(...warnings.map((it, i) => issue(it, 'warn', `w${i}`)));
  syncBusy();
  updatePlanMarks();
}

async function removePlanEdge(edge) {
  const v = plan.view;
  if (!v || plan.busy) return;
  plan.busy = true;
  plan.stripError = '';
  renderPlanStrip(v, planModel(v));
  let res;
  let out = {};
  plan.patching++;
  try {
    res = await fetch(`/plan-drafts/${encodeURIComponent(v.draft.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: v.draft.version, ops: [{ op: 'remove_edge', from: edge.from, to: edge.to }] }),
    });
    out = await res.json().catch(() => ({}));
  } catch {
    /* handled below */
  }
  plan.patching--;
  if (res?.ok) setPlanView(out);
  planPatchSettled();
  plan.busy = false;
  if (plan.openId !== v.draft.id) {
    // another draft was opened meanwhile: just re-enable its buttons
    if (plan.view?.draft.id === plan.openId) renderPlanStrip(plan.view, planModel(plan.view));
    return;
  }
  if (res?.ok) return renderPlanStrip(plan.view, planModel(plan.view));
  if (res?.status === 409) return openPlan(v.draft.id, true); // changed under us — show the latest
  plan.stripError = typeof out.error === 'string' && out.error ? `Couldn’t remove the arrow: ${out.error}` : 'Couldn’t reach the daemon — try again.';
  if (plan.view) renderPlanStrip(plan.view, planModel(plan.view));
}

// ── editing: every write is an ops batch on PATCH /plan-drafts/:id ──
// Batches run one at a time, in order; each response (the GET shape) re-renders
// in place. A plan_draft heard while one is in flight is held until it lands
// (it's usually our own echo) and refetched only if it's newer still.
function planPatch(draftId, ops) {
  const run = async () => {
    let res;
    let out = {};
    plan.patching++;
    renderPlanSaved();
    try {
      res = await fetch(`/plan-drafts/${encodeURIComponent(draftId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops }),
      });
      out = await res.json().catch(() => ({}));
    } catch {
      /* handled below */
    }
    plan.patching--;
    if (res?.ok) setPlanView(out);
    planPatchSettled();
    renderPlanSaved();
    if (res?.ok) return { ok: true };
    const error = typeof out.error === 'string' && out.error ? out.error : res ? `the daemon answered ${res.status}` : 'couldn’t reach the daemon';
    plan.failLog.push({ n: ++plan.failN, draft: draftId, what: planOpsLabel(ops) });
    if (plan.failLog.length > 50) plan.failLog.shift();
    return { ok: false, error };
  };
  const p = plan.queue.then(run);
  plan.queue = p.catch(() => {});
  return p;
}

// What a failed batch was trying to save, for "Not saved: …".
function planOpsLabel(ops) {
  const title = (id) => `“${planNodeById(id)?.title || 'Untitled'}”`;
  return [
    ...new Set(
      ops.map((o) => {
        if (o.op === 'update_node') return `${Object.keys(o.patch ?? {}).map((f) => PL_FIELD_NAME[f] ?? f).join(', ')} on ${title(o.id)}`;
        if (o.op === 'add_node') return 'a new card';
        if (o.op === 'remove_node') return `deleting ${title(o.id)}`;
        return o.op === 'add_edge' ? 'a new arrow' : 'removing an arrow';
      }),
    ),
  ].join('; ');
}

// This draft's lost saves: [{ key, node, field, value }].
function planLostSaves(draftId) {
  const out = [];
  for (const [key, value] of plan.lostSaves) {
    const [d, node, field] = key.split('\u0000');
    if (d === draftId) out.push({ key, node, field, value });
  }
  return out;
}

function planLostLabel(l) {
  return `${PL_FIELD_NAME[l.field] ?? l.field} on “${planNodeById(l.node)?.title || 'Untitled'}”`;
}

function planPatchSettled() {
  if (plan.patching) return;
  const dv = plan.deferVersion;
  plan.deferVersion = 0;
  if (dv && plan.openId && plan.view?.draft.id === plan.openId && dv > plan.view.draft.version) openPlan(plan.openId, true);
}

function planSaving() {
  const ed = plan.ed;
  return plan.patching > 0 || (!!ed && (Object.keys(ed.pending).length > 0 || [...ed.inflight.values()].some((c) => c > 0)));
}

function renderPlanSaved() {
  const saving = planSaving();
  const v = plan.view;
  if (v) {
    const lost = planLostSaves(v.draft.id).length > 0;
    const el = $('pl-saved');
    el.textContent = saving ? 'Saving…' : lost ? `Not saved · v${v.draft.version}` : `Saved · v${v.draft.version}`;
    el.classList.toggle('lost', !saving && lost);
    el.disabled = EMBED || saving || !lost; // "Not saved" opens retry / discard
    el.title = el.disabled ? '' : 'Retry or discard the edits that weren’t saved';
  }
  if (plan.ed) plan.ed.els.status.textContent = saving ? 'Saving…' : 'Changes save as you type';
  renderPlanActions();
}

function planNodeById(id) {
  return plan.view?.draft.data.nodes.find((n) => n.id === id) ?? null;
}

function selectPlanNode(id) {
  plan.selected = id;
  if (id && plan.selEdge) {
    plan.selEdge = null; // Delete / Backspace must not remove an arrow selected before this card
    markPlanEdge();
  }
  updatePlanMarks();
  renderPlanEditor();
  if (plan.view && planIsLive(plan.view)) syncPlanKanban(plan.view);
  if (!id) return;
  if (plan.autoFit !== null) planFit(plan.autoFit); // the panel took room from the canvas
  planReveal([id]);
}

// ── the card editor (side panel for the selected node) ──
// Built once per selected node; later renders only sync values into it, never
// over a field that has focus or unsaved/in-flight edits, so typing stays smooth.
function renderPlanEditor() {
  const v = plan.view;
  const n = !EMBED && v && v.draft.id === plan.openId && plan.selected && !planIsLive(v) ? planNodeById(plan.selected) : null;
  if (plan.ed && (plan.ed.id !== n?.id || plan.ed.draft !== v?.draft.id)) {
    const old = plan.ed;
    plan.ed = null;
    flushPlanEdits(old); // leaving a card saves what was typed into it
  }
  const open = !!n;
  if (!open) plan.listOpen = false;
  const host = $('pl-editor');
  host.classList.toggle('hidden', !open);
  $('pl-side').classList.toggle('hidden', open && !plan.listOpen);
  const show = $('pl-show-plans');
  show.classList.toggle('hidden', !open);
  show.setAttribute('aria-expanded', String(plan.listOpen));
  show.setAttribute('aria-label', plan.listOpen ? 'Hide plans' : 'Show plans');
  if (!open) return host.replaceChildren();
  if (!plan.ed) plan.ed = buildPlanEditor(n.id, v.draft.id);
  syncPlanEditor(plan.ed);
  renderPlanSaved();
}

const PL_X_ICON = ['M6 6l12 12', 'M18 6L6 18'];
function planXIcon(size) {
  const svg = svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'aria-hidden': 'true' });
  for (const d of PL_X_ICON) svg.append(svgEl('path', { d }));
  return svg;
}

function buildPlanEditor(id, draftId) {
  const ed = { id, draft: draftId, pending: {}, inflight: new Map(), saveSeq: 0, latest: {}, timer: null, errs: {}, els: { err: {} }, phaseOpen: false, phaseIdx: 0, phaseOpts: [], keys: {} };
  const { els } = ed;
  const errEl = (f) => {
    const e = node('div', 'pl-ed-err');
    e.setAttribute('role', 'alert');
    els.err[f] = e;
    return e;
  };
  const field = (label, forId, ...kids) => {
    const f = node('div', 'pl-ed-field');
    const l = node('label', 'pl-ed-label', label);
    l.htmlFor = forId;
    f.append(l, ...kids);
    return f;
  };
  const button = (cls, text, label) => {
    const b = node('button', cls, text);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    return b;
  };

  const head = node('div', 'pl-ed-head');
  els.kicker = node('span', 'pl-ed-kicker');
  const close = button('pl-ed-close', null, 'Close card editor');
  close.append(planXIcon(14));
  close.onclick = () => {
    selectPlanNode(null);
    $('pl-canvas').focus({ preventScroll: true });
  };
  head.append(els.kicker, close);

  els.title = node('input', 'pl-ed-input pl-ed-title');
  els.title.id = 'pl-ed-title';
  els.title.autocomplete = 'off';
  els.title.oninput = () => planEdit(ed, 'title', els.title.value);

  els.board = node('select', 'pl-ed-input pl-ed-select');
  els.board.id = 'pl-ed-board';
  els.board.onchange = () => {
    planEdit(ed, 'board_id', els.board.value, true);
    loadBoardPhases(els.board.value);
  };

  // phase: free text + suggestions (this plan's phases on that board, then the board's own)
  els.phase = node('input', 'pl-ed-input');
  els.phase.id = 'pl-ed-phase';
  els.phase.autocomplete = 'off';
  els.phase.placeholder = 'No phase';
  els.phase.setAttribute('role', 'combobox');
  els.phase.setAttribute('aria-autocomplete', 'list');
  els.phase.setAttribute('aria-controls', 'pl-ed-phase-list');
  els.phase.setAttribute('aria-expanded', 'false');
  els.phaseList = node('div', 'pl-ed-sugg hidden');
  els.phaseList.id = 'pl-ed-phase-list';
  els.phaseList.setAttribute('role', 'listbox');
  els.phaseList.setAttribute('aria-label', 'Phase suggestions');
  const openPhases = (on) => {
    ed.phaseOpen = on;
    ed.phaseIdx = 0;
    if (on) loadBoardPhases(els.board.value);
    renderPlanPhaseList(ed);
  };
  els.phase.onfocus = () => openPhases(true);
  els.phase.oninput = () => openPhases(true);
  els.phase.onblur = () => {
    openPhases(false);
    commitPlanPhase(ed, els.phase.value);
  };
  els.phase.onkeydown = (e) => {
    const opts = ed.phaseOpts;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!ed.phaseOpen) return openPhases(true);
      if (opts.length) ed.phaseIdx = (ed.phaseIdx + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length;
      renderPlanPhaseList(ed);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = ed.phaseOpen ? opts[ed.phaseIdx] : null;
      choosePlanPhase(ed, o ? o.name : els.phase.value);
    } else if (e.key === 'Escape' && ed.phaseOpen) {
      e.stopPropagation();
      openPhases(false);
    }
  };
  els.phaseList.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the input
  const combo = node('div', 'pl-ed-combo');
  combo.append(els.phase, els.phaseList);
  const grid = node('div', 'pl-ed-grid');
  grid.append(field('Board', 'pl-ed-board', els.board, errEl('board_id')), field('Phase', 'pl-ed-phase', combo, errEl('phase')));

  els.req = node('textarea', 'pl-ed-input pl-ed-req');
  els.req.id = 'pl-ed-req';
  els.req.oninput = () => planEdit(ed, 'requirements', els.req.value);

  // acceptance criteria
  const critBox = node('div', 'pl-ed-field');
  els.critLabel = node('span', 'pl-ed-label');
  els.critLabel.id = 'pl-ed-crit-label';
  els.crit = node('div', 'pl-ed-list');
  els.crit.setAttribute('role', 'group');
  els.crit.setAttribute('aria-labelledby', 'pl-ed-crit-label');
  const addCrit = button('pl-ed-add', '+ Add criterion');
  addCrit.onclick = () => {
    const row = planCritRow(ed, '');
    els.crit.append(row);
    row.querySelector('input').focus();
    planCritLabel(ed);
  };
  els.addCrit = addCrit;
  critBox.append(els.critLabel, els.crit, addCrit, errEl('subtasks'));

  // touches
  const touchBox = node('div', 'pl-ed-field');
  const touchLabel = node('span', 'pl-ed-label', 'Touches');
  touchLabel.id = 'pl-ed-touch-label';
  els.touches = node('div', 'pl-ed-chips');
  els.touches.setAttribute('role', 'group');
  els.touches.setAttribute('aria-labelledby', 'pl-ed-touch-label');
  touchBox.append(touchLabel, els.touches, errEl('touches'));

  // depends on / blocks
  els.deps = node('div', 'pl-ed-deps');
  const depBox = node('div', 'pl-ed-field');
  depBox.append(els.deps, errEl('deps'));

  const foot = node('div', 'pl-ed-foot');
  const del = button('pl-ed-delete', 'Delete card');
  del.onclick = () => confirmPlanDelete(ed);
  els.status = node('span', 'pl-ed-status');
  els.status.setAttribute('role', 'status');
  foot.append(del, els.status);

  $('pl-editor').replaceChildren(
    head,
    field('Title', 'pl-ed-title', els.title, errEl('title')),
    grid,
    field('Requirements', 'pl-ed-req', els.req, errEl('requirements')),
    critBox,
    touchBox,
    depBox,
    errEl('delete'),
    foot,
  );
  if (!planNodeById(id)?.board_id) return ed;
  loadBoardPhases(planNodeById(id).board_id);
  return ed;
}

function planEdit(ed, field, value, now = false) {
  ed.pending[field] = value;
  if (ed.errs[field]) {
    delete ed.errs[field];
    ed.els.err[field].textContent = '';
  }
  clearTimeout(ed.timer);
  ed.timer = null;
  if (now) flushPlanEdits(ed);
  else ed.timer = setTimeout(() => flushPlanEdits(ed), 500);
  renderPlanSaved();
}

// Everything typed since the last save, as ONE update_node op with only those fields.
async function flushPlanEdits(ed) {
  clearTimeout(ed.timer);
  ed.timer = null;
  const patch = ed.pending;
  const fields = Object.keys(patch);
  if (!fields.length) return;
  ed.pending = {};
  if (plan.view?.draft.id === ed.draft && !planNodeById(ed.id)) return renderPlanSaved(); // the card is gone
  const seq = ++ed.saveSeq;
  for (const f of fields) {
    ed.inflight.set(f, (ed.inflight.get(f) ?? 0) + 1);
    ed.latest[f] = seq;
  }
  const title = planNodeById(ed.id)?.title || 'Untitled';
  const r = await planPatch(ed.draft, [{ op: 'update_node', id: ed.id, patch }]);
  for (const f of fields) ed.inflight.set(f, ed.inflight.get(f) - 1);
  // only the latest save of a field decides its error / revert: an older failure
  // must not undo a newer value, and a newer success clears an older error
  const mine = fields.filter((f) => ed.latest[f] === seq);
  for (const f of mine) {
    const key = `${ed.draft}\u0000${ed.id}\u0000${f}`;
    if (r.ok) {
      delete ed.errs[f];
      plan.lostSaves.delete(key);
    } else ed.errs[f] = `Couldn’t save: ${r.error}`;
    if (!r.ok && plan.ed !== ed) plan.lostSaves.set(key, patch[f]);
  }
  if (plan.ed !== ed) {
    // the editor moved on: nothing shows the field error, so say it here
    if (!r.ok && mine.length) svFlash(`Couldn’t save ${mine.map((f) => PL_FIELD_NAME[f] ?? f).join(', ')} on “${title}”`);
    renderPlanSaved();
    return r;
  }
  // a failed field reverts to the saved value (unless it has been edited again since)
  syncPlanEditor(ed, r.ok ? [] : mine.filter((f) => !(f in ed.pending)));
  renderPlanSaved();
  return r;
}

const PL_FIELD_NAME = { title: 'title', board_id: 'board', phase: 'phase', requirements: 'requirements', subtasks: 'acceptance criteria', touches: 'touches' };

function syncPlanEditor(ed, force = []) {
  const v = plan.view;
  const n = planNodeById(ed.id);
  if (!v || !n || v.draft.id !== ed.draft) return;
  const { els } = ed;
  const active = document.activeElement;
  const busy = (f) => !force.includes(f) && (f in ed.pending || (ed.inflight.get(f) ?? 0) > 0);
  const hold = (f, el) => busy(f) || (!force.includes(f) && el.contains(active));
  const boards = planBoards(v);

  const b = boards.get(n.board_id);
  const bn = node('span', '', b?.name ?? 'Unknown board');
  bn.style.color = b?.color ?? PL_NONE_COLOR;
  const step = v.layout?.columns?.[n.id];
  els.kicker.replaceChildren('CARD · ', bn, ...(Number.isInteger(step) ? [` · STEP ${step + 1}`] : []));

  if (!hold('title', els.title) && els.title.value !== n.title) els.title.value = n.title;

  if (!hold('board_id', els.board)) {
    const known = v.boards.some((x) => x.id === n.board_id);
    const key = JSON.stringify([v.boards, known ? null : n.board_id]);
    if (ed.keys.board !== key) {
      ed.keys.board = key;
      const opts = v.boards.map((x) => {
        const o = node('option', '', x.root === '' ? `${boards.get(x.id)?.name ?? x.name} (workspace)` : `${x.name} · ${x.root}`);
        o.value = x.id;
        return o;
      });
      if (!known) {
        const o = node('option', '', 'Unknown board');
        o.value = n.board_id;
        opts.push(o);
      }
      els.board.replaceChildren(...opts);
    }
    els.board.value = n.board_id;
  }

  if (!hold('phase', els.phase) && els.phase.value !== (n.phase ?? '')) els.phase.value = n.phase ?? '';
  if (!hold('requirements', els.req) && els.req.value !== (n.requirements ?? '')) els.req.value = n.requirements ?? '';

  if (!hold('subtasks', els.crit)) {
    const cur = [...els.crit.querySelectorAll('input')].map((i) => i.value);
    const want = n.subtasks ?? [];
    if (JSON.stringify(cur) !== JSON.stringify(want)) els.crit.replaceChildren(...want.map((t) => planCritRow(ed, t)));
  }
  planCritLabel(ed);

  if (!hold('touches', els.touches) && JSON.stringify(ed.touchList) !== JSON.stringify(n.touches ?? [])) renderPlanTouches(ed, n.touches ?? []);

  renderPlanDeps(ed, v, n, boards);

  for (const [f, el] of Object.entries(els.err)) el.textContent = ed.errs[f] ?? '';
}

function planCritRow(ed, text) {
  const row = node('div', 'pl-ed-row');
  const input = node('input', 'pl-ed-row-input');
  input.value = text;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Acceptance criterion');
  input.oninput = () => {
    planEdit(ed, 'subtasks', planCritValues(ed));
    planCritLabel(ed);
  };
  input.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    ed.els.addCrit.click(); // Enter: on to a new criterion
  };
  const rm = node('button', 'pl-ed-x', '✕');
  rm.type = 'button';
  rm.setAttribute('aria-label', 'Remove criterion');
  rm.onclick = () => {
    row.remove();
    planEdit(ed, 'subtasks', planCritValues(ed), true);
    planCritLabel(ed);
    ed.els.addCrit.focus();
  };
  row.append(input, rm);
  return row;
}

function planCritValues(ed) {
  return [...ed.els.crit.querySelectorAll('input')].map((i) => i.value).filter((s) => s.trim());
}

function planCritLabel(ed) {
  ed.els.critLabel.textContent = `Acceptance criteria · ${planCritValues(ed).length}`;
}

function renderPlanTouches(ed, list) {
  ed.touchList = [...list];
  const set = (next) => {
    planEdit(ed, 'touches', next, true);
    renderPlanTouches(ed, next);
  };
  const chips = list.map((p, i) => {
    const c = node('span', 'pl-ed-chip pl-ed-path');
    c.append(node('span', 'pl-ed-chip-text', p));
    const rm = node('button', 'pl-ed-x', '✕');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remove path ${p}`);
    rm.onclick = () => {
      set(list.filter((_, j) => j !== i));
      ed.els.touches.querySelector('.pl-ed-add')?.focus();
    };
    c.append(rm);
    return c;
  });
  const add = node('button', 'pl-ed-add pl-ed-add-sm', '+ Path');
  add.type = 'button';
  add.onclick = () => {
    const input = node('input', 'pl-ed-input pl-ed-path-input');
    input.placeholder = 'path/or/glob';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'New path');
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const p = input.value.trim();
      if (save && p && !ed.touchList.includes(p)) set([...ed.touchList, p]);
      else renderPlanTouches(ed, ed.touchList);
      ed.els.touches.querySelector('.pl-ed-add')?.focus();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    };
    input.onblur = () => finish(true);
    add.replaceWith(input);
    input.focus();
  };
  ed.els.touches.replaceChildren(...chips, add);
}

function renderPlanDeps(ed, v, n, boards) {
  const { els } = ed;
  const nodes = v.draft.data.nodes;
  const edges = v.draft.data.edges;
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const on = edges.filter((e) => e.to === n.id && e.from !== n.id).map((e) => e.from);
  const blocks = edges.filter((e) => e.from === n.id && e.to !== n.id).map((e) => e.to);
  const offer = nodes.filter((x) => x.id !== n.id && !on.includes(x.id));
  const desc = (id) => {
    const x = byId.get(id);
    return [id, x?.title || 'Untitled', boards.get(x?.board_id)?.color ?? PL_NONE_COLOR];
  };
  const key = JSON.stringify([on.map(desc), blocks.map(desc), offer.map((x) => [x.id, x.title])]);
  if (ed.keys.deps === key) return;
  ed.keys.deps = key;
  const refocus = els.deps.contains(document.activeElement) && document.activeElement.id === 'pl-ed-adddep';
  const chip = ([, title, color], cls) => {
    const c = node('span', `pl-ed-chip ${cls}`);
    const dot = node('span', 'pl-dot');
    dot.style.background = color;
    c.append(dot, node('span', 'pl-ed-chip-text', title));
    return c;
  };
  const row = (label, ...kids) => {
    const r = node('div', 'pl-ed-deprow');
    r.append(node('span', 'pl-ed-deplabel', label), ...kids);
    return r;
  };
  const depErr = (r) => {
    ed.errs.deps = r.ok ? '' : `Couldn’t change dependencies: ${r.error}`;
    if (plan.ed === ed) els.err.deps.textContent = ed.errs.deps;
  };
  const onChips = on.map((id) => {
    const d = desc(id);
    const c = chip(d, 'dep');
    const rm = node('button', 'pl-ed-x', '✕');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remove dependency on ${d[1]}`);
    rm.onclick = async () => {
      $('pl-ed-adddep')?.focus();
      depErr(await planPatch(ed.draft, [{ op: 'remove_edge', from: id, to: n.id }]));
    };
    c.append(rm);
    return c;
  });
  // keyboard alternative to dragging an arrow
  const sel = node('select', 'pl-ed-input pl-ed-select pl-ed-adddep');
  sel.id = 'pl-ed-adddep';
  sel.setAttribute('aria-label', 'Add dependency');
  const first = node('option', '', 'Add dependency…');
  first.value = '';
  sel.append(
    first,
    ...offer.map((x) => {
      const o = node('option', '', x.title || 'Untitled');
      o.value = x.id;
      return o;
    }),
  );
  sel.disabled = !offer.length;
  sel.onchange = async () => {
    const from = sel.value;
    sel.value = '';
    if (from) depErr(await planPatch(ed.draft, [{ op: 'add_edge', from, to: n.id }]));
  };
  const blockChips = blocks.map((id) => chip(desc(id), 'blocks'));
  els.deps.replaceChildren(
    row('Depends on', ...onChips, sel),
    row('Blocks', ...(blockChips.length ? blockChips : [node('span', 'pl-ed-none', 'Nothing yet')])),
  );
  if (refocus) sel.focus();
}

// ── phase suggestions ──
async function loadBoardPhases(boardId) {
  if (!boardId || plan.boardPhases.has(boardId)) return;
  plan.boardPhases.set(boardId, []);
  let titles = null;
  try {
    const res = await fetch(`/phases?project=${encodeURIComponent(boardId)}`);
    if (res.ok) titles = (await res.json()).map((p) => p.title).filter((t) => typeof t === 'string' && t.trim());
  } catch {
    /* no board phases to suggest; retried next time */
  }
  if (titles) plan.boardPhases.set(boardId, titles);
  else plan.boardPhases.delete(boardId);
  if (plan.ed?.phaseOpen) renderPlanPhaseList(plan.ed);
}

function planPhaseOptions(ed) {
  const v = plan.view;
  if (!v) return [];
  const board = ed.els.board.value;
  const typed = ed.els.phase.value.trim();
  const q = typed.toLowerCase();
  const counts = new Map();
  for (const n of v.draft.data.nodes) {
    const p = n.board_id === board ? n.phase?.trim() : '';
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const opts = [...counts].map(([name, c]) => ({ name, sub: `${c} card${c === 1 ? '' : 's'} in this plan` }));
  for (const t of plan.boardPhases.get(board) ?? []) {
    const name = t.trim();
    if (!opts.some((o) => o.name === name)) opts.push({ name, sub: 'On the board' });
  }
  const shown = opts.filter((o) => !q || o.name.toLowerCase().includes(q));
  if (typed && !opts.some((o) => o.name === typed)) shown.push({ name: typed, isNew: true });
  return shown;
}

function renderPlanPhaseList(ed) {
  const { els } = ed;
  const opts = ed.phaseOpen ? planPhaseOptions(ed) : [];
  ed.phaseOpts = opts;
  if (ed.phaseIdx >= opts.length) ed.phaseIdx = 0;
  const open = opts.length > 0;
  els.phaseList.classList.toggle('hidden', !open);
  els.phase.setAttribute('aria-expanded', String(open));
  if (open) els.phase.setAttribute('aria-activedescendant', `pl-ed-ph-${ed.phaseIdx}`);
  else els.phase.removeAttribute('aria-activedescendant');
  els.phaseList.replaceChildren(
    ...opts.map((o, i) => {
      const el = node('div', `pl-ed-opt${o.isNew ? ' new' : ''}`);
      el.id = `pl-ed-ph-${i}`;
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', String(i === ed.phaseIdx));
      if (o.isNew) el.textContent = `+ New phase “${o.name}”`;
      else el.append(node('span', 'pl-ed-opt-name', o.name), node('span', 'pl-ed-opt-sub', o.sub));
      el.onclick = () => choosePlanPhase(ed, o.name);
      return el;
    }),
  );
}

function choosePlanPhase(ed, name) {
  ed.els.phase.value = name.trim();
  ed.phaseOpen = false;
  renderPlanPhaseList(ed);
  commitPlanPhase(ed, name);
}

// The phase saves when picked (or on Enter / leaving the field), not per keystroke:
// a half-typed name would otherwise land in the plan as a phase of its own.
function commitPlanPhase(ed, value) {
  const t = value.trim();
  const saved = 'phase' in ed.pending ? ed.pending.phase : planNodeById(ed.id)?.phase;
  if (t !== (saved ?? '')) planEdit(ed, 'phase', t || null, true);
}

// ── delete a card ──
function confirmPlanDelete(ed) {
  const n = planNodeById(ed.id);
  if (!n || svModal) return;
  const { dlg, close, mount } = openModal({ labelledBy: 'pl-del-title', describedBy: 'pl-del-sub', busy: () => false, fallbackFocus: () => $('pl-canvas') });
  const title = node('h2', 'sv-title', `Delete “${n.title || 'Untitled'}”?`);
  title.id = 'pl-del-title';
  const k = plan.view.draft.data.edges.filter((e) => e.from === n.id || e.to === n.id).length;
  const sub = node('p', 'sv-sub', k ? `It leaves this plan with its ${k} arrow${k === 1 ? '' : 's'}.` : 'It leaves this plan.');
  sub.id = 'pl-del-sub';
  const foot = node('div', 'sv-foot');
  const cancel = node('button', 'home-btn', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = close;
  const del = node('button', 'home-btn pl-danger', 'Delete card');
  del.type = 'button';
  del.onclick = () => {
    close();
    deletePlanNode(ed);
  };
  foot.append(node('span', 'sv-foot-note'), cancel, del);
  dlg.append(title, sub, foot);
  mount();
  cancel.focus();
}

async function deletePlanNode(ed) {
  clearTimeout(ed.timer);
  ed.timer = null;
  ed.pending = {};
  const r = await planPatch(ed.draft, [{ op: 'remove_node', id: ed.id }]);
  if (r.ok) return $('pl-canvas').focus({ preventScroll: true });
  ed.errs.delete = `Couldn’t delete: ${r.error}`;
  if (plan.ed === ed) syncPlanEditor(ed);
}

// ── add a card ──
async function addPlanCard() {
  const v = plan.view;
  if (EMBED || !v || v.draft.id !== plan.openId || planIsLive(v)) return; // Live is read-only
  // never reuse a removed node's id: its `committed` entry would map the new node onto the old card
  const ids = new Set([...v.draft.data.nodes.map((n) => n.id), ...Object.keys(v.draft.data.committed ?? {})]);
  let id;
  do id = Math.random().toString(36).slice(2, 8);
  while (!id || ids.has(id));
  const board = planNodeById(plan.selected)?.board_id ?? v.boards.find((b) => b.root === '')?.id ?? v.draft.workspace_id;
  plan.stripError = '';
  const r = await planPatch(v.draft.id, [{ op: 'add_node', node: { id, title: 'New card', board_id: board } }]);
  if (plan.openId !== v.draft.id) return;
  if (!r.ok) {
    plan.stripError = `Couldn’t add a card: ${r.error}`;
    if (plan.view) renderPlanStrip(plan.view, planModel(plan.view));
    return;
  }
  if (!planNodeById(id)) return;
  selectPlanNode(id);
  const t = $('pl-ed-title');
  t?.focus();
  t?.select();
}

// ── arrows: select / delete, drag to connect ──
async function planEdgeOp(op, from, to) {
  const v = plan.view;
  if (EMBED || !v) return;
  plan.stripError = '';
  const r = await planPatch(v.draft.id, [{ op, from, to }]);
  if (r.ok || plan.openId !== v.draft.id || !plan.view) return;
  plan.stripError = `Couldn’t ${op === 'add_edge' ? 'add' : 'remove'} the arrow: ${r.error}`;
  renderPlanStrip(plan.view, planModel(plan.view));
}

function removeSelectedEdge() {
  const e = plan.selEdge;
  if (!e) return;
  plan.selEdge = null;
  markPlanEdge();
  planEdgeOp('remove_edge', e.from, e.to);
}

// The selected arrow: highlighted, with a ✕ at its midpoint.
function markPlanEdge() {
  const world = $('pl-world');
  world.querySelector('.pl-edge-x')?.remove();
  for (const p of world.querySelectorAll('.pl-edge-vis.sel')) p.classList.remove('sel');
  const s = plan.selEdge;
  if (!s || !plan.view) return;
  const i = plan.view.draft.data.edges.findIndex((e) => e.from === s.from && e.to === s.to);
  const path = i < 0 ? null : world.querySelector(`.pl-edge-vis[data-i="${i}"]`);
  if (!path) return void (plan.selEdge = null);
  path.classList.add('sel');
  const pt = path.getPointAtLength(path.getTotalLength() / 2);
  const title = (id) => planNodeById(id)?.title || 'Untitled';
  const x = node('button', 'pl-edge-x');
  x.type = 'button';
  x.setAttribute('aria-label', `Remove arrow: ${title(s.from)} → ${title(s.to)}`);
  x.append(planXIcon(12));
  x.style.left = `${pt.x - 12}px`;
  x.style.top = `${pt.y - 12}px`;
  x.onclick = removeSelectedEdge;
  world.append(x);
}

function planWorldPoint(e) {
  const r = $('pl-canvas').getBoundingClientRect();
  const { x, y, k } = plan.xf;
  return { x: (e.clientX - r.left - x) / k, y: (e.clientY - r.top - y) / k };
}

function startPlanLink(from, e) {
  e.preventDefault();
  const canvas = $('pl-canvas');
  canvas.setPointerCapture(e.pointerId);
  canvas.focus({ preventScroll: true });
  canvas.classList.add('linking');
  const svg = svgEl('svg', { class: 'pl-link', width: 1, height: 1, 'aria-hidden': 'true' });
  svg.append(svgEl('path', { class: 'pl-link-line' }));
  const tip = node('div', 'pl-link-tip hidden');
  tip.setAttribute('role', 'tooltip');
  plan.link = { from, pointer: e.pointerId, at: planWorldPoint(e), target: null, svg, dot: node('span', 'pl-link-dot'), tip };
  drawPlanLink();
}

function movePlanLink(e) {
  const l = plan.link;
  l.at = planWorldPoint(e);
  const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('#pl-world .pl-node, #pl-world .pl-handle');
  const id = hit?.dataset.id ?? null;
  const edges = plan.view?.draft.data.edges ?? [];
  // no self arrows and no duplicates: those cards are never offered as a drop target
  l.target = id && id !== l.from && !edges.some((x) => x.from === l.from && x.to === id) ? id : null;
  drawPlanLink();
}

function drawPlanLink() {
  const l = plan.link;
  const world = $('pl-world');
  const at = (id) => world.querySelector(`.pl-node[data-id="${CSS.escape(id)}"]`);
  const src = at(l.from);
  if (!src) return endPlanLink();
  if (!l.svg.isConnected) world.append(l.svg, l.dot, l.tip);
  const tgt = l.target ? at(l.target) : null;
  if (!tgt) l.target = null;
  for (const b of world.querySelectorAll('.pl-node.drop')) if (b !== tgt) b.classList.remove('drop');
  tgt?.classList.add('drop');
  const sx = src.offsetLeft + PL.NODE_W;
  const sy = src.offsetTop + PL.NODE_H / 2;
  const ex = tgt ? tgt.offsetLeft : l.at.x;
  const ey = tgt ? tgt.offsetTop + PL.NODE_H / 2 : l.at.y;
  const dx = ex >= sx ? Math.max(40, (ex - sx) / 2) : 40; // leftward: a short hook, not a loop
  l.svg.firstChild.setAttribute('d', `M${sx} ${sy} C${sx + dx} ${sy} ${ex - dx} ${ey} ${ex} ${ey}`);
  l.dot.style.left = `${sx - 8}px`;
  l.dot.style.top = `${sy - 8}px`;
  l.tip.classList.toggle('hidden', !tgt);
  if (!tgt) return;
  const title = (id) => planNodeById(id)?.title || 'Untitled';
  l.tip.replaceChildren(node('span', 'pl-link-tip-k', 'DROP TO ADD ARROW'), node('span', '', `${title(l.target)} will depend on ${title(l.from)}`));
  l.tip.style.left = `${tgt.offsetLeft + 14}px`;
  const above = tgt.offsetTop - l.tip.offsetHeight - 8;
  l.tip.style.top = `${above >= 0 ? above : tgt.offsetTop + PL.NODE_H + 8}px`;
}

function dropPlanLink() {
  const { from, target } = plan.link;
  endPlanLink();
  if (target) planEdgeOp('add_edge', from, target);
}

function endPlanLink() {
  const l = plan.link;
  if (!l) return;
  plan.link = null;
  l.svg.remove();
  l.dot.remove();
  l.tip.remove();
  const canvas = $('pl-canvas');
  canvas.classList.remove('linking');
  if (canvas.hasPointerCapture(l.pointer)) canvas.releasePointerCapture(l.pointer);
  for (const b of $('pl-world').querySelectorAll('.pl-node.drop')) b.classList.remove('drop');
}

// ── commit / run ──
// Commit is live while the draft is dirty (or never committed) and has no errors;
// Run only once the committed plan has no edits since.
function renderPlanActions() {
  const v = plan.view;
  if (!v || v.draft.id !== plan.openId) return;
  const errs = v.validation.errors.length;
  const saving = planSaving();
  const busy = plan.actionBusy; // Commit is draining the saves
  const live = planIsLive(v);
  const commit = $('pl-commit');
  commit.classList.toggle('hidden', live);
  commit.textContent = busy ? 'Saving…' : `Commit v${v.draft.version}`;
  commit.disabled = EMBED || busy || errs > 0 || !(v.dirty || saving);
  commit.title = busy ? '' : errs ? `Fix ${errs} error${errs === 1 ? '' : 's'} to commit` : commit.disabled ? 'No edits since the last commit' : '';
  commit.setAttribute('aria-busy', String(busy));
  const run = $('pl-run');
  run.classList.toggle('hidden', live);
  run.disabled = EMBED || busy || v.draft.committed_version === null || v.dirty || saving;
  run.title = busy ? '' : run.disabled ? 'Commit your edits to run' : '';
}

const PL_DRAIN_MS = 15000;

// Flush the editor's pending autosave and wait for every PATCH to land, so what
// Commit sees includes the last keystrokes. Fails (with a message) when any save
// of this draft failed while it waited, a save of it is still recorded as lost,
// or the saves don't land within PL_DRAIN_MS.
async function planDrain(draftId) {
  const from = plan.failN;
  let stop = false;
  const work = (async () => {
    const flushed = plan.ed ? flushPlanEdits(plan.ed) : null;
    for (let q; q !== plan.queue; ) {
      q = plan.queue;
      await q;
    }
    await flushed;
    while (plan.patching && !stop) await new Promise((res) => setTimeout(res, 50));
    return true;
  })();
  let timer;
  const done = await Promise.race([work, new Promise((res) => (timer = setTimeout(() => res(false), PL_DRAIN_MS)))]);
  clearTimeout(timer);
  stop = true;
  if (!done) return { ok: false, message: 'Saving is taking too long — check the daemon, then commit again' };
  const what = [
    ...new Set([
      ...plan.failLog.filter((f) => f.n > from && f.draft === draftId).map((f) => f.what),
      ...planLostSaves(draftId).map(planLostLabel),
    ]),
  ];
  return what.length ? { ok: false, message: `Not saved: ${what.join('; ')} — fix it, then commit` } : { ok: true };
}

const plBold = (s) => node('b', '', s);
const plDim = (s) => node('span', 'pl-dlg-dim', s);
const plCount = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PL_DIFF_FIELD = { title: 'title', requirements: 'requirements', subtasks: 'acceptance criteria', tag: 'tag', phase: 'phase', depends_on: 'depends on', board: 'board' };
const PL_LANE = { backlog: 'Backlog', queued: 'Queued', in_progress: 'In progress', in_review: 'In review', done: 'Done' };

async function plJson(url, opts) {
  let res;
  let out = {};
  try {
    res = await fetch(url, opts);
    out = await res.json().catch(() => ({}));
  } catch {
    /* handled by the caller */
  }
  const error = !res ? 'couldn’t reach the daemon' : typeof out.error === 'string' && out.error ? out.error : `the daemon answered ${res.status}`;
  return { res, out, ok: !!res?.ok, error };
}

function plDlgButton(cls, text) {
  const b = node('button', cls, text);
  b.type = 'button';
  return b;
}

async function openCommitModal() {
  const v0 = plan.view;
  if (EMBED || !v0 || v0.draft.id !== plan.openId || svModal || plan.actionBusy) return;
  const id = v0.draft.id;
  const visit = plan.visit;
  plan.actionBusy = true;
  renderPlanActions();
  let saved;
  try {
    saved = await planDrain(id);
  } finally {
    plan.actionBusy = false;
    renderPlanActions();
  }
  const v = plan.view;
  // only while the planner is still open on this draft (not after leaving and coming back)
  if (svModal || plan.visit !== visit || activeView !== 'planner' || plan.openId !== id || v?.draft.id !== id) return;
  if (!saved.ok) return svFlash(saved.message);
  renderPlanActions();
  if ($('pl-commit').disabled) return; // the flushed edits left errors (or nothing to commit)

  const st = { diff: null, error: '', note: '', keepNote: false, loading: true, busy: false, seq: 0, closed: false };
  const { dlg, close, mount } = openModal({
    labelledBy: 'pl-cm-title',
    describedBy: 'pl-cm-sub',
    busy: () => st.busy,
    onClose: () => {
      st.closed = true;
      st.seq++;
    },
    fallbackFocus: () => $('pl-commit'),
  });
  dlg.classList.add('pl-dlg', 'pl-cm');
  const head = node('div', 'pl-dlg-head');
  const title = node('h2', 'pl-dlg-title', `Commit ${v.draft.title}`);
  title.id = 'pl-cm-title';
  const sub = node('p', 'pl-dlg-sub', 'Writes the plan onto its boards in one step. Nothing is queued until you Run.');
  sub.id = 'pl-cm-sub';
  head.append(title, sub);
  const note = node('div', 'pl-dlg-note');
  note.setAttribute('role', 'status');
  const chips = node('div', 'pl-cm-chips');
  const body = node('div', 'pl-cm-body');
  const err = node('div', 'pl-dlg-err');
  err.setAttribute('role', 'alert');
  const foot = node('div', 'pl-dlg-foot');
  const ver = node('span', 'pl-cm-ver');
  const btns = node('div', 'pl-dlg-btns');
  const cancel = plDlgButton('pl-dlg-btn', 'Cancel');
  cancel.onclick = () => !st.busy && close();
  const go = plDlgButton('pl-dlg-btn primary', 'Commit');
  btns.append(cancel, go);
  foot.append(ver, btns);
  dlg.append(head, note, chips, body, err, foot);

  const render = () => {
    const d = st.diff;
    note.textContent = st.note;
    err.textContent = st.error;
    const cv = plan.view?.draft.id === id ? plan.view.draft.committed_version : v.draft.committed_version;
    go.textContent = st.busy ? 'Committing…' : d ? `Commit v${d.version}` : 'Commit';
    go.disabled = st.busy || st.loading || !d || d.errors.length > 0;
    cancel.disabled = st.busy;
    ver.textContent = d ? `${cv === null || cv === undefined ? 'first commit' : `v${cv} → v${d.version}`} · all or nothing` : '';
    if (st.loading) {
      chips.replaceChildren();
      return body.replaceChildren(node('div', 'pl-dlg-empty', 'Working out what changes…'));
    }
    if (!d) return void (chips.replaceChildren(), body.replaceChildren());
    const sum = (k) => d.boards.reduce((a, b) => a + b[k].length, 0);
    const chip = (n, text, cls) => (n ? [node('span', `pl-cm-chip ${cls}`, text)] : []);
    const np = sum('phases');
    const nc = sum('create');
    chips.replaceChildren(
      ...chip(np, `+${np} phase${np === 1 ? '' : 's'}`, 'add'),
      ...chip(nc, `+${nc} card${nc === 1 ? '' : 's'}`, 'add'),
      ...chip(sum('update'), `~${sum('update')} updated`, 'edit'),
      ...chip(sum('delete'), `−${sum('delete')} deleted`, 'del'),
      ...chip(sum('kept'), `${sum('kept')} kept`, 'kept'),
      ...chip(sum('locked'), `${sum('locked')} locked`, 'lock'),
    );
    const parts = [];
    if (d.errors.length) {
      const box = node('div', 'pl-cm-errors');
      box.append(node('b', '', `Fix ${plCount(d.errors.length, 'error')} to commit`), ...d.errors.map((e) => node('div', '', e.message)));
      parts.push(box);
    }
    const boards = planBoards(plan.view?.draft.id === id ? plan.view : v);
    const roots = new Map((plan.view?.draft.id === id ? plan.view : v).boards.map((b) => [b.id, b.root]));
    for (const b of d.boards) {
      const info = boards.get(b.board_id);
      const sec = node('section', 'pl-cm-board');
      const bh = node('div', 'pl-cm-bhead');
      const dot = node('span', 'pl-dot');
      dot.style.background = info?.color ?? PL_NONE_COLOR;
      const root = roots.get(b.board_id);
      bh.append(dot, node('span', 'pl-cm-bname', info?.name ?? 'Unknown board'), node('span', 'pl-cm-bfolder', root === '' ? 'workspace' : root ?? ''));
      sec.append(bh);
      const row = (kind, label, ...content) => {
        const r = node('div', 'pl-cm-row');
        const t = node('span', 'pl-cm-text');
        t.append(...content);
        r.append(node('span', `pl-cm-k ${kind}`, label), t);
        sec.append(r);
      };
      const existing = st.phases?.get(b.board_id);
      let prev = existing?.length ? existing[existing.length - 1] : null;
      for (const p of b.phases) {
        row('add', '+ phase', 'New phase ', plBold(p.name), ...(prev ? [' ', plDim(`after ${prev}`)] : existing ? [' ', plDim('first on this board')] : []));
        prev = p.name;
      }
      if (b.create.length) row('add', `+ ${b.create.length}`, b.create.map((c) => c.title || 'Untitled').join(' · '));
      for (const u of b.update) row('edit', '~ edit', plBold(u.title || 'Untitled'), ' ', plDim(Object.keys(u.changes).map((f) => PL_DIFF_FIELD[f] ?? f).join(', ')));
      for (const x of b.delete) {
        const lane = st.lanes?.get(x.card_id);
        row('del', '− delete', plBold(x.title || 'Untitled'), ' ', plDim(lane ? `was in ${PL_LANE[lane] ?? lane}, removed from the plan` : 'removed from the plan'));
      }
      for (const x of b.kept) {
        const why = x.reason === 'blocked' ? 'is blocked' : x.lane === 'in_progress' ? 'is in progress' : 'has started';
        row('kept', 'kept', plBold(x.title || 'Untitled'), ' ', plDim(`${why}, so it stays on the board (no longer in this plan)`));
      }
      for (const x of b.locked) {
        const why = x.reason === 'blocked' ? 'is blocked' : 'has started';
        row('lock', 'locked', plBold(x.title || 'Untitled'), ' ', plDim(`${why}, so your edits aren’t applied`));
      }
      parts.push(sec);
    }
    if (!d.boards.length && !d.errors.length) parts.push(node('div', 'pl-dlg-empty', 'Nothing changes on the boards.'));
    body.replaceChildren(...parts);
  };

  const load = async () => {
    const seq = ++st.seq;
    st.loading = true;
    st.error = '';
    render();
    const r = await plJson(`/plan-drafts/${encodeURIComponent(id)}/diff`);
    let phases = null;
    let lanes = null;
    if (r.ok) {
      // the explanatory text: which phase a new one follows, and where a deleted card was
      const withPhases = r.out.boards.filter((b) => b.phases.length).map((b) => b.board_id);
      const dels = r.out.boards.flatMap((b) => b.delete.map((x) => x.card_id));
      const [ph, ln] = await Promise.all([
        Promise.all(withPhases.map((b) => plJson(`/phases?project=${encodeURIComponent(b)}`))),
        plFetchCards(dels),
      ]);
      phases = new Map();
      withPhases.forEach((b, i) => {
        if (ph[i].ok && Array.isArray(ph[i].out)) phases.set(b, [...ph[i].out].sort((x, y) => x.position - y.position).map((p) => p.title));
      });
      lanes = new Map();
      dels.forEach((c, i) => ln[i].ok && lanes.set(c, ln[i].out.lane));
    }
    if (seq !== st.seq || st.closed) return;
    st.loading = false;
    st.diff = r.ok ? r.out : null;
    // "The plan changed" belongs to the load it triggered; the next good load clears it
    if (r.ok && !st.keepNote) st.note = '';
    if (r.ok) st.keepNote = false;
    st.phases = phases;
    st.lanes = lanes;
    if (!r.ok) st.error = `Couldn’t load the changes: ${r.error}`;
    render();
  };

  go.onclick = async () => {
    const d = st.diff;
    if (!d || st.busy || st.loading) return; // double-submit guard
    st.busy = true;
    st.error = '';
    render();
    const r = await plJson(`/plan-drafts/${encodeURIComponent(id)}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: d.version }),
    });
    st.busy = false;
    if (st.closed) return;
    if (r.res?.status === 409) {
      // stale (the plan changed while this was open) or new errors: show the latest
      st.note = 'The plan changed — review again';
      st.keepNote = true;
      if (plan.openId === id) openPlan(id, true);
      return load();
    }
    if (!r.ok) {
      st.error = `Couldn’t commit: ${r.error}`;
      return render();
    }
    close();
    svFlash(`Committed v${r.out.draft.draft.version}`);
    if (plan.openId === id) setPlanView(r.out.draft); // the draft stays open: only its commit mark moved
    schedulePlanList();
  };

  mount();
  cancel.focus();
  load();
}

async function openRunModal() {
  const v = plan.view;
  if (EMBED || !v || v.draft.id !== plan.openId || svModal || plan.actionBusy || $('pl-run').disabled) return;
  const id = v.draft.id;
  const st = { mode: 'queue', loading: true, busy: false, error: '', closed: false, cards: null, sessions: new Map() };
  const { dlg, close, mount } = openModal({
    labelledBy: 'pl-run-title',
    describedBy: 'pl-run-sub',
    busy: () => st.busy,
    onClose: () => (st.closed = true),
    fallbackFocus: () => $('pl-run'),
  });
  dlg.classList.add('pl-dlg', 'pl-rn');
  const boards = planBoards(v);
  const verts = new Set(v.boards.filter((b) => b.root !== '').map((b) => b.id));
  const head = node('div', 'pl-dlg-head');
  const title = node('h2', 'pl-dlg-title', `Run ${v.draft.title}`);
  title.id = 'pl-run-title';
  const sub = node('p', 'pl-dlg-sub', 'How should agents take over?');
  sub.id = 'pl-run-sub';
  head.append(title, sub);

  const fs = node('fieldset', 'pl-rn-modes');
  fs.append(node('legend', 'pl-sr', 'Take-over mode'));
  const option = (mode, label) => {
    const l = node('label', 'pl-rn-opt');
    const r = node('input');
    r.type = 'radio';
    r.name = 'pl-run-mode';
    r.value = mode;
    r.checked = st.mode === mode;
    r.onchange = () => {
      st.mode = mode;
      render();
    };
    const text = node('span', 'pl-rn-opt-text');
    text.append(node('span', 'pl-rn-opt-title', label));
    l.append(r, text);
    fs.append(l);
    return { l, r, text, titleEl: text.firstChild };
  };
  const q = option('queue', 'Queue the cards');
  const qDesc = node('span', 'pl-rn-opt-desc');
  q.text.append(qDesc);
  const a = option('autopilot', 'Queue + autopilot');
  const aDesc = node('span', 'pl-rn-opt-desc', 'Idle sessions are prompted to work their next card automatically. Autopilot pauses while 5-hour usage is above 80%.');
  const aSess = node('span', 'pl-rn-sessions');
  const aMain = node('span', 'pl-rn-main');
  a.text.append(aDesc, aSess, aMain);

  const spec = node('div', 'pl-rn-spec hidden');
  const err = node('div', 'pl-dlg-err');
  err.setAttribute('role', 'alert');
  const foot = node('div', 'pl-dlg-foot');
  const started = node('span', 'pl-rn-started');
  const btns = node('div', 'pl-dlg-btns');
  const cancel = plDlgButton('pl-dlg-btn', 'Cancel');
  cancel.onclick = () => !st.busy && close();
  const go = plDlgButton('pl-dlg-btn primary', 'Queue');
  btns.append(cancel, go);
  foot.append(started, btns);
  dlg.append(head, fs, spec, err, foot);

  const render = () => {
    const cards = st.cards ?? [];
    const queue = cards.filter((c) => c.lane === 'backlog' && c.spec);
    const need = cards.filter((c) => c.lane === 'backlog' && !c.spec);
    const begun = cards.filter((c) => c.lane !== 'backlog' && c.lane !== 'queued' && c.lane !== 'done');
    const n = queue.length;
    // nothing new to queue, but vertical boards already have queued cards: Run just turns autopilot on
    const apOnly = st.mode === 'autopilot' && n === 0 && cards.some((c) => c.lane === 'queued' && verts.has(c.board));
    qDesc.textContent = st.loading
      ? 'Counting cards…'
      : `${plCount(n, 'card')} move${n === 1 ? 's' : ''} to Queued. Each vertical picks them up when you prompt its session in the terminal tab.`;
    // autopilot: the plan's vertical boards (never Main: it's the human's session)
    const onBoards = [...new Set(cards.map((c) => c.board))].filter((b) => verts.has(b)).sort(
      (x, y) => v.boards.findIndex((b) => b.id === x) - v.boards.findIndex((b) => b.id === y),
    );
    a.titleEl.textContent = onBoards.length ? `Queue + autopilot on ${onBoards.map((b) => boards.get(b)?.name ?? 'Unknown board').join(', ')}` : 'Queue + autopilot';
    a.r.disabled = !st.loading && !onBoards.length;
    if (a.r.disabled && st.mode === 'autopilot') {
      st.mode = 'queue';
      q.r.checked = true;
    }
    aDesc.textContent = !st.loading && !onBoards.length
      ? 'No vertical board in this plan: autopilot only drives vertical sessions.'
      : 'Idle sessions are prompted to work their next card automatically. Autopilot pauses while 5-hour usage is above 80%.';
    aSess.replaceChildren(
      ...onBoards.map((b) => {
        const s = node('span', 'pl-rn-sess');
        const dot = node('span', 'pl-dot');
        dot.style.background = boards.get(b)?.color ?? PL_NONE_COLOR;
        const state = st.sessions.get(b) ?? 'offline';
        s.append(dot, `${boards.get(b)?.name ?? 'Unknown board'} · ${state === 'needs_you' ? 'needs you' : state}`);
        return s;
      }),
    );
    const hasMain = cards.some((c) => !verts.has(c.board));
    aMain.textContent = hasMain ? 'Main’s cards are queued for you. Autopilot never drives the main session.' : '';
    for (const o of [q, a]) o.l.classList.toggle('on', o.r.checked);

    spec.classList.toggle('hidden', !need.length);
    spec.replaceChildren(
      node('span', 'pl-rn-spec-head', `${plCount(need.length, 'card')} need${need.length === 1 ? 's' : ''} a spec and won’t be queued`),
      ...need.map((c) => {
        const r = node('div', 'pl-rn-spec-row');
        const dot = node('span', 'pl-dot');
        dot.style.background = boards.get(c.board)?.color ?? PL_NONE_COLOR;
        const t = node('span', 'pl-rn-spec-title', c.title || 'Untitled');
        t.append(' ', node('span', 'pl-rn-spec-board', boards.get(c.board)?.name ?? 'Unknown board'));
        const add = plDlgButton('pl-rn-addspec', 'Add spec');
        add.setAttribute('aria-label', `Add spec: ${c.title || 'Untitled'}`);
        add.onclick = () => {
          if (st.busy) return;
          close();
          if (plan.openId !== id || !planNodeById(c.node)) return;
          selectPlanNode(c.node);
          $('pl-ed-req')?.focus();
        };
        r.append(dot, t, add);
        return r;
      }),
    );
    const names = begun.map((c) => c.title || 'Untitled');
    started.textContent = !names.length
      ? ''
      : names.length <= 2
        ? `${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} already started · left as is`
        : `${names.length} cards have already started · left as is`;
    err.textContent = st.error;
    go.textContent = st.busy ? (apOnly ? 'Turning on…' : 'Queueing…') : st.loading ? 'Queue' : apOnly ? 'Turn on autopilot' : `Queue ${plCount(n, 'card')}`;
    go.disabled = st.busy || st.loading || (n === 0 && !apOnly);
    cancel.disabled = st.busy;
  };

  go.onclick = async () => {
    if (st.busy || st.loading || go.disabled) return; // double-submit guard
    st.busy = true;
    st.error = '';
    render();
    const mode = st.mode;
    const r = await plJson(`/plan-drafts/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    st.busy = false;
    if (st.closed) return;
    if (!r.ok) {
      st.error = `Couldn’t run the plan: ${r.error}`;
      return render();
    }
    close();
    const out = r.out;
    const name = (b) => boards.get(b)?.name ?? 'Unknown board';
    const parts = out.queued.length || mode !== 'autopilot' ? [`Queued ${plCount(out.queued.length, 'card')}`] : [];
    if (out.skipped.length) parts.push(`${out.skipped.length} need${out.skipped.length === 1 ? 's' : ''} a spec`);
    if (mode === 'autopilot') {
      if (out.autopilot.enabled.length) parts.push(`autopilot on ${out.autopilot.enabled.map((x) => name(x.board_id)).join(', ')}`);
      const idle = out.autopilot.not_enabled.filter((x) => x.reason !== 'main_session');
      if (idle.length) parts.push(`not on ${idle.map((x) => name(x.board_id)).join(', ')} (nothing queued)`);
      if (out.autopilot.not_enabled.some((x) => x.reason === 'main_session')) parts.push('Main’s cards are queued for you');
    }
    svFlash(parts.join(' · ') || 'Nothing to queue');
    plStore(`pl.run.${id}`, mode); // the Live header's "Running · …"
    setPlanMode(id, 'live'); // a plan that just ran opens on its live progress
    if (plan.openId === id) $('pl-mode-live').focus(); // Run itself is hidden in Live
  };

  mount();
  q.r.focus();
  render();

  // the plan's mapped cards as they are now, and each board's session
  const mapped = Object.entries(v.draft.data.committed ?? {});
  const [tasks, sum] = await Promise.all([
    plFetchCards(mapped.map(([, cardId]) => cardId)),
    plJson(`/workspace/summary?project=${encodeURIComponent(v.draft.workspace_id)}`),
  ]);
  if (st.closed) return;
  st.cards = mapped.flatMap(([nodeId], i) => {
    const t = tasks[i];
    if (!t.ok) return []; // deleted elsewhere
    const c = t.out;
    return [{ node: nodeId, id: c.id, title: c.title, board: c.project_id, lane: c.lane, spec: !!c.requirements?.trim() && (c.subtasks?.length ?? 0) > 0 }];
  });
  if (sum.ok) for (const b of sum.out.boards ?? []) st.sessions.set(b.project.id, b.session?.state ?? 'offline');
  if (tasks.some((t) => !t.ok && t.res?.status !== 400)) st.error = 'Couldn’t read every card — the count may be off.';
  st.loading = false;
  render();
}

// GET /task/:id for many cards, at most `limit` at a time (Run modal, Commit's
// deleted-card lanes, Live mode). Results come back in the ids' order.
async function plFetchCards(ids, limit = 6) {
  const out = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      out[i] = await plJson(`/task/${encodeURIComponent(ids[i])}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, worker));
  return out;
}

function plStore(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: kept for this page only */
  }
}

function plLoad(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ── "Not saved": retry or discard the edits whose save was lost ──
function openLostSavesModal() {
  const v = plan.view;
  if (EMBED || !v || v.draft.id !== plan.openId || svModal) return;
  const id = v.draft.id;
  if (!planLostSaves(id).length) return renderPlanSaved();
  const st = { busy: false, error: '', closed: false };
  const { dlg, close, mount } = openModal({
    labelledBy: 'pl-lost-title',
    describedBy: 'pl-lost-sub',
    busy: () => st.busy,
    onClose: () => (st.closed = true),
    fallbackFocus: () => $('pl-saved'),
  });
  dlg.classList.add('pl-dlg', 'pl-lost');
  const head = node('div', 'pl-dlg-head');
  const title = node('h2', 'pl-dlg-title', 'Edits not saved');
  title.id = 'pl-lost-title';
  const sub = node('p', 'pl-dlg-sub', 'These edits didn’t reach the daemon. Retry them, or discard them and keep what’s saved.');
  sub.id = 'pl-lost-sub';
  head.append(title, sub);
  const list = node('ul', 'pl-lost-list');
  const err = node('div', 'pl-dlg-err');
  err.setAttribute('role', 'alert');
  const foot = node('div', 'pl-dlg-foot');
  const btns = node('div', 'pl-dlg-btns');
  const discard = plDlgButton('pl-dlg-btn', 'Discard');
  const retry = plDlgButton('pl-dlg-btn primary', 'Retry');
  btns.append(discard, retry);
  foot.append(node('span'), btns);
  dlg.append(head, list, err, foot);
  const render = () => {
    list.replaceChildren(...planLostSaves(id).map((l) => node('li', '', planLostLabel(l))));
    err.textContent = st.error;
    retry.textContent = st.busy ? 'Retrying…' : 'Retry';
    retry.disabled = discard.disabled = st.busy;
  };
  discard.onclick = () => {
    if (st.busy) return;
    for (const l of planLostSaves(id)) plan.lostSaves.delete(l.key);
    close();
    renderPlanSaved();
    svFlash('Discarded the unsaved edits');
  };
  retry.onclick = async () => {
    if (st.busy) return;
    const lost = planLostSaves(id).filter((l) => plan.view?.draft.id !== id || planNodeById(l.node));
    const byNode = new Map();
    for (const l of lost) (byNode.get(l.node) ?? byNode.set(l.node, {}).get(l.node))[l.field] = l.value;
    st.busy = true;
    st.error = '';
    render();
    const r = byNode.size ? await planPatch(id, [...byNode].map(([nid, patch]) => ({ op: 'update_node', id: nid, patch }))) : { ok: true };
    st.busy = false;
    // a newer value saved meanwhile (or the card was deleted) already dropped its entry: leave those alone
    if (r.ok) for (const l of lost) if (plan.lostSaves.get(l.key) === l.value) plan.lostSaves.delete(l.key);
    renderPlanSaved();
    if (st.closed) return;
    if (r.ok) {
      close();
      return svFlash('Saved');
    }
    st.error = `Still couldn’t save: ${r.error}`;
    render();
  };
  mount();
  retry.focus();
  render();
}

// ── Live mode: a committed plan's cards, coloured by their lane as they move ──
const PL_FLAG = 'M5 3v18h2v-7h10l-2-4 2-4H7V3z';

function planFlagIcon(size, fill) {
  const svg = svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24', fill, 'aria-hidden': 'true', class: 'pl-flag' });
  svg.append(svgEl('path', { d: PL_FLAG }));
  return svg;
}

// Per draft, in localStorage: 'plan' (default) or 'live'.
function planModeOf(id) {
  if (!plan.modes.has(id)) plan.modes.set(id, plLoad(`pl.mode.${id}`) === 'live' ? 'live' : 'plan');
  return plan.modes.get(id);
}

function planIsLive(v) {
  const cv = v?.draft.committed_version;
  return !!v && cv !== null && cv !== undefined && planModeOf(v.draft.id) === 'live';
}

function setPlanMode(id, mode) {
  plan.modes.set(id, mode);
  plStore(`pl.mode.${id}`, mode);
  const v = plan.view;
  if (!v || v.draft.id !== id || id !== plan.openId) return;
  if (mode === 'live') {
    plan.selEdge = null; // read-only: nothing to delete
    plan.flagged = null;
    endPlanLink();
  }
  renderPlanMain();
  if (planIsLive(v)) loadLiveCards(true); // fresh lanes each time Live is switched on
}

// The "Running · …" chip: the last Run's mode for this draft, if this browser saw it.
function planRunMode(id) {
  const m = plLoad(`pl.run.${id}`);
  return m === 'queue' || m === 'autopilot' ? m : null;
}

// The card ids the draft's nodes map to (a removed node's old mapping isn't shown).
function planLiveIds(v) {
  const c = v.draft.data.committed ?? {};
  return [...new Set(v.draft.data.nodes.map((n) => c[n.id]).filter(Boolean))];
}

// Fetch the mapped cards: all of them (force: entering Live, a re-connect), else
// only ids not read yet. Card messages keep them current after that.
async function loadLiveCards(force = false) {
  const v = plan.view;
  if (!planIsLive(v) || v.draft.id !== plan.openId) return;
  const L = plan.live;
  if (L.draft !== v.draft.id) {
    L.draft = v.draft.id;
    L.cards = new Map();
    L.pending = new Set();
    L.failed = new Set();
    L.seq++;
  }
  const seq = L.seq;
  const want = planLiveIds(v).filter((id) => !L.pending.has(id) && (force || !L.cards.has(id)));
  if (!want.length) return;
  for (const id of want) L.pending.add(id);
  const got = await plFetchCards(want);
  if (seq !== L.seq) return; // the cache was reset (another draft, or the planner closed)
  want.forEach((id, i) => {
    L.pending.delete(id);
    const r = got[i];
    if (r.ok) {
      L.failed.delete(id);
      planLiveSet(id, r.out, false);
    } else if (r.res?.status === 400 || r.res?.status === 404) {
      L.failed.delete(id);
      L.cards.set(id, null); // deleted on its board
    } else L.failed.add(id);
  });
  renderPlanLive();
}

// Keep a card's live state (from GET /task/:id, or a card message's toCard shape).
// An older read landing after a newer message is ignored.
function planLiveSet(id, c, fromMessage) {
  const L = plan.live;
  const prev = L.cards.get(id);
  if (prev && (c.updated_at ?? 0) < prev.updated_at) return false;
  const blocked = fromMessage ? !!c.blocked : !!c.blocked_at;
  L.cards.set(id, {
    id,
    lane: c.lane,
    title: c.title,
    board: c.project_id ?? prev?.board ?? null,
    updated_at: c.updated_at ?? 0,
    blocked,
    reason: c.blocked_reason ?? '',
    since: blocked ? (c.blocked_at ?? (prev?.blocked ? prev.since : null) ?? Date.now()) : null,
  });
  return true;
}

// card / card_removed from any board (the planner socket hears every project)
function onLiveCard(msg) {
  const v = plan.view;
  const L = plan.live;
  if (!v || L.draft !== v.draft.id || !planIsLive(v)) return;
  const id = msg.type === 'card' ? msg.card?.id : msg.card_id;
  if (!id || !planLiveIds(v).includes(id)) return;
  if (msg.type === 'card_removed') L.cards.set(id, null);
  else if (!planLiveSet(id, { ...msg.card, project_id: msg.project_id }, true)) return;
  L.failed.delete(id);
  renderPlanLive();
}

// { kind: 'none' | 'loading' | 'failed' | 'removed' | <lane>, card?, cardId? } for a node
function planLiveOf(v, n) {
  const cardId = v.draft.data.committed?.[n.id];
  if (!cardId) return { kind: 'none' };
  const L = plan.live;
  if (L.draft !== v.draft.id || !L.cards.has(cardId)) return { kind: L.failed.has(cardId) ? 'failed' : 'loading', cardId };
  const card = L.cards.get(cardId);
  return card ? { kind: card.lane, card, cardId } : { kind: 'removed', cardId };
}

function planBlockedFor(since) {
  if (!since) return '';
  const m = Math.floor((Date.now() - since) / 60000);
  return m < 1 ? ' · JUST NOW' : m < 60 ? ` · ${m} MIN` : ` · ${Math.floor(m / 60)} H`;
}

// Lane class, meta line, pulse ring, Blocked pill + tooltip: all inside the node
// button, so a card message updates it in place.
function applyLiveNode(b, n, v, boardName) {
  const s = planLiveOf(v, n);
  const c = s.card;
  for (const k of [...b.classList]) if (k.startsWith('live-')) b.classList.remove(k);
  b.classList.add('live', `live-${s.kind.replace('_', '-')}`);
  b.classList.toggle('blocked', !!c?.blocked);
  const label =
    s.kind === 'none' ? 'not committed'
    : s.kind === 'removed' ? 'removed from board'
    : s.kind === 'loading' ? 'Loading…'
    : s.kind === 'failed' ? 'Couldn’t load the card'
    : s.kind === 'done' ? '✓ Done'
    : `${PL_LANE[s.kind] ?? s.kind}${c.blocked ? ' · needs you' : ''}`;
  const meta = b.querySelector('.pl-node-meta');
  meta.className = 'pl-node-meta pl-live-meta';
  meta.textContent = label;
  b.querySelector('.pl-pulse')?.remove();
  b.querySelector('.pl-live-pill')?.remove();
  b.querySelector('.pl-live-tip')?.remove();
  if (s.kind === 'in_progress') {
    const ring = node('span', 'pl-pulse');
    ring.setAttribute('aria-hidden', 'true');
    b.prepend(ring);
  }
  b.removeAttribute('aria-describedby');
  if (c?.blocked) {
    const pill = node('span', 'pl-live-pill');
    pill.setAttribute('aria-hidden', 'true');
    pill.append(planFlagIcon(11, '#0b0d12'), 'Blocked');
    const tip = node('span', 'pl-live-tip');
    tip.id = `pl-tip-${encodeURIComponent(n.id)}`;
    tip.setAttribute('role', 'tooltip');
    if (parseFloat(b.style.top) < PL.TOP + PL.STEP) tip.classList.add('below'); // no room above the first row
    tip.append(node('span', 'pl-live-tip-k', `BLOCKED${planBlockedFor(c.since)} · ${boardName}`), node('span', 'pl-live-tip-text', c.reason || 'No reason given'));
    b.append(pill, tip);
    b.setAttribute('aria-describedby', tip.id);
  }
  b.setAttribute('aria-label', [n.title || 'Untitled', boardName, n.phase || 'no phase', label].join(', ') + (c?.blocked ? ', blocked' : ''));
}

function planLiveCounts(v) {
  const L = plan.live;
  const k = { total: 0, done: 0, building: 0, blocked: 0 };
  if (L.draft !== v.draft.id) return k;
  for (const id of planLiveIds(v)) {
    const c = L.cards.get(id);
    if (!c) continue; // not read yet, or removed from its board
    k.total++;
    if (c.lane === 'done') k.done++;
    if (c.lane === 'in_progress' || c.lane === 'in_review') k.building++;
    if (c.blocked) k.blocked++;
  }
  return k;
}

// Header: the Plan | Live toggle (committed drafts), and Live's progress + Open in Kanban.
function renderPlanMode(v) {
  const cv = v.draft.committed_version;
  const live = planIsLive(v);
  $('pl-mode').classList.toggle('hidden', cv === null || cv === undefined);
  $('pl-mode-plan').setAttribute('aria-pressed', String(!live));
  $('pl-mode-live').setAttribute('aria-pressed', String(live));
  $('pl-live-sum').classList.toggle('hidden', !live);
  $('pl-live-bar').classList.toggle('hidden', !live);
  $('pl-open-kanban').classList.toggle('hidden', !live || EMBED);
  $('pl-saved').classList.toggle('hidden', live);
  $('pl-open').classList.toggle('live', live);
  if (!live) return;
  const k = planLiveCounts(v);
  const b = (t, cls = '') => node('b', cls, t);
  $('pl-live-sum').replaceChildren(b(`${k.done}/${k.total}`), ' done · ', b(k.building), ' building · ', b(k.blocked, k.blocked ? 'hot' : ''), ' blocked');
  const [done, busy] = $('pl-live-bar').children;
  done.style.width = `${k.total ? (100 * k.done) / k.total : 0}%`;
  busy.style.width = `${k.total ? (100 * k.building) / k.total : 0}%`;
  syncPlanKanban(v);
}

function syncPlanKanban(v) {
  const n = plan.selected ? planNodeById(plan.selected) : null;
  const card = n ? planLiveOf(v, n).card : null;
  const btn = $('pl-open-kanban');
  btn.disabled = !card;
  btn.title = card ? '' : n ? 'This card isn’t on a board' : 'Select a card to open it in Kanban';
}

function openPlanCardInKanban() {
  const v = plan.view;
  const n = plan.selected ? planNodeById(plan.selected) : null;
  const card = v && n ? planLiveOf(v, n).card : null;
  if (!card) return;
  if (card.board === projectId) {
    setView('kanban');
    openCardModal(card.id);
  } else location.search = `?project=${encodeURIComponent(card.board)}&card=${encodeURIComponent(card.id)}&view=kanban`;
}

function planLiveLegend() {
  const lane = (cls, label) => {
    const s = node('span', 'pl-lg');
    s.append(node('span', `pl-lane-sw ${cls}`), node('span', '', label));
    return s;
  };
  const done = node('span', 'pl-lg pl-lg-done');
  done.append(node('span', 'pl-lg-check', '✓'), node('span', '', 'Done'));
  const blocked = node('span', 'pl-lg pl-lg-blocked');
  blocked.append(planFlagIcon(12, '#e06c75'), node('span', '', 'Blocked'));
  return [lane('backlog', 'Backlog'), lane('queued', 'Queued'), lane('in-progress', 'In progress'), lane('in-review', 'In review'), done, blocked];
}

// "N blocked · Answer in <board> terminal", one row per board with blocked cards.
function renderLiveStrip(v) {
  const host = $('pl-live-strip');
  if (!planIsLive(v)) {
    plan.liveStripKey = '';
    return host.replaceChildren();
  }
  const L = plan.live;
  const byBoard = new Map();
  if (L.draft === v.draft.id)
    for (const id of planLiveIds(v)) {
      const c = L.cards.get(id);
      if (!c?.blocked) continue;
      if (!byBoard.has(c.board)) byBoard.set(c.board, []);
      byBoard.get(c.board).push(c.title || 'Untitled');
    }
  const order = (b) => {
    const i = v.boards.findIndex((x) => x.id === b);
    return i < 0 ? Infinity : i;
  };
  const rows = [...byBoard].sort((a, b) => order(a[0]) - order(b[0]));
  const canOpen = !EMBED && term.enabled;
  const key = JSON.stringify([v.draft.id, rows, canOpen]);
  if (key === plan.liveStripKey) return;
  plan.liveStripKey = key;
  const boards = planBoards(v);
  host.replaceChildren(
    ...rows.map(([board, titles]) => {
      const name = boards.get(board)?.name ?? 'Unknown board';
      const row = node('div', 'pl-issue pl-blocked');
      const text = node('span', 'pl-issue-text');
      text.append(node('b', '', `${titles.length} blocked`), ` · ${titles.join(', ')} · ${name} is waiting on your answer`);
      row.append(planFlagIcon(16, '#e06c75'), text);
      if (canOpen) {
        const go = node('button', 'pl-answer', `Answer in ${name} terminal`);
        go.type = 'button';
        go.onclick = () => openBoardTerminal(board, plan.workspace ?? v.draft.workspace_id);
        row.append(go);
      } else row.append(node('span', 'pl-answer-note', `Answer in ${name} terminal`));
      return row;
    }),
  );
}

// A card message: re-style the nodes in place and refresh the header + strip.
function renderPlanLive() {
  const v = plan.view;
  if (!planIsLive(v) || v.draft.id !== plan.openId || activeView !== 'planner') return;
  const boards = planBoards(v);
  for (const b of $('pl-world').querySelectorAll('.pl-node')) {
    const n = planNodeById(b.dataset.id);
    if (n) applyLiveNode(b, n, v, boards.get(n.board_id)?.name ?? 'Unknown board');
  }
  renderPlanMode(v);
  renderLiveStrip(v);
}

// ── pan / zoom ──
function applyPlanXf() {
  const { x, y, k } = plan.xf;
  $('pl-world').style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  $('pl-zoom-pct').textContent = `${Math.round(k * 100)}%`;
}

function planZoomAt(factor, cx, cy) {
  plan.autoFit = null;
  const { x, y, k } = plan.xf;
  const nk = Math.min(PL_ZOOM_MAX, Math.max(PL_ZOOM_MIN, k * factor));
  plan.xf = { k: nk, x: cx - ((cx - x) * nk) / k, y: cy - ((cy - y) * nk) / k };
  applyPlanXf();
}

function planZoomCenter(factor) {
  const c = $('pl-canvas');
  planZoomAt(factor, c.clientWidth / 2, c.clientHeight / 2);
}

function planFit(minK = PL_ZOOM_MIN) {
  const c = $('pl-canvas');
  const { W, H } = plan.size;
  if (!c.clientWidth || !W) return;
  const k = Math.min(1, Math.max(minK, Math.min((c.clientWidth - 24) / W, (c.clientHeight - 24) / H)));
  plan.xf = { k, x: Math.max(12, (c.clientWidth - W * k) / 2), y: 12 };
  plan.autoFit = minK; // re-fit when the canvas or the graph resizes, until the user pans/zooms
  applyPlanXf();
}

// Pan so the given nodes are in view (when they aren't already).
function planReveal(ids) {
  const c = $('pl-canvas');
  const pts = ids.map((id) => $('pl-world').querySelector(`.pl-node[data-id="${CSS.escape(id)}"]`)).filter(Boolean);
  if (!pts.length) return;
  const { x, y, k } = plan.xf;
  const xs = pts.flatMap((b) => [b.offsetLeft, b.offsetLeft + PL.NODE_W]);
  const ys = pts.flatMap((b) => [b.offsetTop, b.offsetTop + PL.NODE_H]);
  const [l, r, t, bm] = [Math.min(...xs) * k + x, Math.max(...xs) * k + x, Math.min(...ys) * k + y, Math.max(...ys) * k + y];
  if (l >= 0 && t >= 0 && r <= c.clientWidth && bm <= c.clientHeight) return;
  plan.autoFit = null;
  plan.xf = { k, x: x + c.clientWidth / 2 - (l + r) / 2, y: y + c.clientHeight / 2 - (t + bm) / 2 };
  applyPlanXf();
}

{
  const canvas = $('pl-canvas');
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!plan.view) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      planZoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (plan.link) endPlanLink(); // a press while a link is still armed: its release was never seen
    const handle = !EMBED && e.target.closest('.pl-handle');
    if (handle) return startPlanLink(handle.dataset.id, e);
    if (e.target.closest('.pl-node, .pl-edge-hit, .pl-edge-x')) return;
    if (plan.selEdge) {
      plan.selEdge = null;
      markPlanEdge();
    }
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: plan.xf.x, y: plan.xf.y };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('panning');
    canvas.focus({ preventScroll: true });
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    plan.autoFit = null;
    plan.xf = { ...plan.xf, x: drag.x + e.clientX - drag.sx, y: drag.y + e.clientY - drag.sy };
    applyPlanXf();
  });
  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    drag = null;
    canvas.classList.remove('panning');
  };
  canvas.addEventListener('pointerup', end);
  // a lost capture (or the window losing focus) never sees the release: end the drag here,
  // so neither a pan nor an armed link outlives the gesture
  canvas.addEventListener('lostpointercapture', (e) => {
    end(e);
    if (plan.link && e.pointerId === plan.link.pointer) endPlanLink();
  });
  window.addEventListener('blur', () => {
    end();
    endPlanLink();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (plan.link && e.pointerId === plan.link.pointer) movePlanLink(e);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (plan.link && e.pointerId === plan.link.pointer) dropPlanLink();
  });
  canvas.addEventListener('pointercancel', (e) => {
    if (plan.link && e.pointerId === plan.link.pointer) endPlanLink();
  });
  canvas.addEventListener('click', (e) => {
    const hit = e.target.closest('.pl-edge-hit');
    if (!hit || !plan.view) return;
    const edge = plan.view.draft.data.edges[Number(hit.dataset.i)];
    if (!edge) return;
    plan.selEdge = { from: edge.from, to: edge.to };
    markPlanEdge();
    canvas.focus({ preventScroll: true }); // Delete / Backspace now removes it
  });
  canvas.addEventListener('dblclick', (e) => {
    if (EMBED || !plan.view || e.target.closest('.pl-node, .pl-handle, .pl-edge-hit, .pl-edge-x')) return;
    addPlanCard();
  });
  // the validation strip growing (a cycle appears) shrinks the canvas: re-fit if still fitted
  new ResizeObserver(() => {
    if (plan.autoFit !== null && plan.view && activeView === 'planner') planFit(plan.autoFit);
  }).observe(canvas);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') planZoomCenter(1.2);
    else if (e.key === '-' || e.key === '_') planZoomCenter(1 / 1.2);
    else if (e.key === '0') planZoomCenter(1 / plan.xf.k); // back to 100%
    else return;
    e.preventDefault();
  });
  $('pl-zoom-in').onclick = () => planZoomCenter(1.2);
  $('pl-zoom-out').onclick = () => planZoomCenter(1 / 1.2);
  $('pl-fit').onclick = () => planFit();
  $('pl-by-board').onclick = () => {
    plan.colorBy = 'board';
    renderPlanMain();
  };
  $('pl-by-phase').onclick = () => {
    plan.colorBy = 'phase';
    renderPlanMain();
  };
  document.addEventListener('keydown', (e) => {
    if (activeView !== 'planner' || svModal) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable], .xterm')) return; // typing, or the terminal
    if ((e.key === 'Delete' || e.key === 'Backspace') && plan.selEdge && !EMBED) {
      e.preventDefault();
      return removeSelectedEdge();
    }
    if (e.key !== 'Escape') return;
    if (plan.link) return endPlanLink();
    if (plan.selEdge) {
      plan.selEdge = null;
      return markPlanEdge();
    }
    if (!plan.selected && !plan.flagged) return;
    plan.flagged = null;
    selectPlanNode(null);
  });
  $('pl-add').onclick = () => addPlanCard();
  $('pl-saved').onclick = () => openLostSavesModal();
  $('pl-mode-plan').onclick = () => plan.view && setPlanMode(plan.view.draft.id, 'plan');
  $('pl-mode-live').onclick = () => plan.view && setPlanMode(plan.view.draft.id, 'live');
  $('pl-open-kanban').onclick = () => openPlanCardInKanban();
  $('pl-commit').onclick = () => openCommitModal();
  $('pl-run').onclick = () => openRunModal();
  // a field that was held while focused catches up once focus leaves it (bound once: #pl-editor persists)
  $('pl-editor').addEventListener('focusout', () => {
    const ed = plan.ed;
    setTimeout(() => {
      if (ed && plan.ed === ed) syncPlanEditor(ed);
    });
  });
  $('pl-show-plans').onclick = () => {
    plan.listOpen = !plan.listOpen;
    renderPlanEditor();
  };

  // "+ New plan": an inline title input at the top of the list
  const form = $('pl-new-form');
  const input = $('pl-new-title');
  const hideForm = () => {
    form.classList.add('hidden');
    $('pl-new-err').textContent = '';
  };
  $('pl-new').onclick = showNewPlanForm;
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    hideForm();
    $('pl-new').focus();
  });
  input.addEventListener('blur', () => {
    if (!input.value.trim() && !form.dataset.busy) hideForm();
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title || form.dataset.busy || !plan.project) return;
    form.dataset.busy = '1';
    input.disabled = true;
    $('pl-new-err').textContent = '';
    let res;
    let out = {};
    try {
      res = await fetch('/plan-drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: plan.project, title }),
      });
      out = await res.json().catch(() => ({}));
    } catch {
      /* handled below */
    }
    delete form.dataset.busy;
    input.disabled = false;
    if (!res?.ok) {
      $('pl-new-err').textContent = typeof out.error === 'string' && out.error ? out.error : 'Couldn’t reach the daemon — try again.';
      return input.focus();
    }
    input.value = '';
    hideForm();
    const { data, ...summary } = out;
    if (plan.list && !plan.list.some((d) => d.id === out.id))
      plan.list.unshift({ ...summary, node_count: data?.nodes?.length ?? 0, edge_count: data?.edges?.length ?? 0 });
    openPlan(out.id);
  };
}

function showNewPlanForm() {
  if (EMBED) return;
  $('pl-new-form').classList.remove('hidden');
  $('pl-new-title').focus();
}

// Show the landing view at once — no Kanban flash while the first board data and
// attention fetch are in flight. 'smart' and ?view=dashboard still wait for data;
// scm needs the project id before it can load.
const EARLY_VIEW = URL_VIEW === 'dashboard' ? null : URL_VIEWS.includes(URL_VIEW) ? URL_VIEW : SETTINGS.defaultView === 'home' ? 'home' : null;
if (EARLY_VIEW && EARLY_VIEW !== 'scm') setView(EARLY_VIEW);

svFlashPending();
connect();
teamCacheLoad = loadTeamCache();
teamCacheLoad.then(() => {
  if (activeView === 'dashboard') renderDashboard();
});
if (!EMBED) initTerminal(); // an OBS scene gets no terminal (and no pty sockets)
