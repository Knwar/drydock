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
const homeView = document.getElementById('home-view');
const attentionView = document.getElementById('attention-view');
const scmView = document.getElementById('scm-view');
const phasesView = document.getElementById('phases-view');
const statsView = document.getElementById('stats-view');
const dashboardView = document.getElementById('dashboard-view');
let activeView = 'kanban'; // 'home' | 'attention' | 'kanban' | 'scm' | 'phases' | 'stats' | 'dashboard'

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
  attentionView.classList.toggle('hidden', name !== 'attention');
  boardEl.classList.toggle('hidden', name !== 'kanban');
  scmView.classList.toggle('hidden', name !== 'scm');
  phasesView.classList.toggle('hidden', name !== 'phases');
  statsView.classList.toggle('hidden', name !== 'stats');
  dashboardView.classList.toggle('hidden', name !== 'dashboard');
  homeView.classList.toggle('hidden', name !== 'home');
  if (name === 'scm') refreshFiles();
  if (name === 'phases') renderPhaseDetail();
  if (name === 'attention') renderAttention();
  if (name === 'stats') loadStats();
  if (name === 'dashboard') openDashboard();
  else if (!(name === 'home' && prev === 'home')) closeDashboard(); // also drops Home's all-projects socket on leave
  if (name === 'home' && prev !== 'home') openHome();
}

railAttention.onclick = () => setView('attention');
railKanban.onclick = () => setView('kanban');
railScm.onclick = () => setView('scm');
railPhases.onclick = () => setView('phases');
railStats.onclick = () => setView('stats');
railDashboard.onclick = () => setView('dashboard');
railHome.onclick = () => setView('home');

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
const URL_VIEWS = ['home', 'attention', 'kanban', 'scm', 'phases', 'stats'];
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
