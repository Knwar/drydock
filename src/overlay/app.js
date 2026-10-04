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
  // the counts are this board's: on a workspace's Home (which covers every board) they say so
  const mainOnly = activeView === 'home' && home.data?.verticals?.length > 0 && hctx.workspaceId === projectId;
  statsEl.innerHTML =
    (mainOnly ? '<span class="stats-scope">Main board</span> · ' : '') +
    `<span class="n">${done}</span> done · <span class="n">${flight}</span> in flight` +
    ` · reviews <span class="pass">${reviews.pass}✓</span>/<span class="fail">${reviews.fail}✗</span>`;
  // the full line as its tooltip (it truncates in a narrow header)
  statsEl.title = statsEl.textContent + (mainOnly ? ' (Main board only: Home covers every board in the workspace)' : '');
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
let boardInits = 0; // board socket init messages so far: the first is the page's connect, later ones reconnects
function applyEvent(msg) {
  if (msg.type === 'init') {
    boardInits++;
    cards.clear();
    for (const card of msg.board) cards.set(card.id, card);
    phases = msg.phases ?? [];
    setProject(msg.project);
    projectId = msg.project?.id ?? null;
    loadBoardSettings();
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
    setInitialView();
    openCardFromUrl();
    if (activeView === 'planner' && !plan.project) openPlanner(); // ?view=planner opened before the project was known
    if (activeView === 'metrics' && !mx.project) openMetrics(); // ?view=metrics opened before the project was known
    if (activeView === 'governance' && !gov.project) openGovernance(); // ?view=governance opened before the project was known
    highlightCardsFromUrl();
  } else if (msg.type === 'phases') {
    phases = msg.phases;
    renderBoard(); // active phase may have changed → board scope shifts
    renderPhaseList();
  } else if (msg.type === 'card') {
    cards.set(msg.card.id, msg.card);
    scheduleReloadSoon();
    renderBoard();
    renderPhaseList();
    if (activeView === 'scm') refreshFiles();
    else refreshScmBadge();
    if (msg.card.id === openCardId) refreshCardModal();
  } else if (msg.type === 'card_removed') {
    cards.delete(msg.card_id);
    scheduleReloadSoon();
    renderBoard();
    renderPhaseList();
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
    }
    if (['tool', 'build_start', 'build_end', 'check'].includes(ev.type)) pulse(ev.task_id);
  } else if (msg.type === 'status') {
    setStatus(msg.status);
  } else if (msg.type === 'usage') {
    renderUsage(msg.usage);
  } else if (msg.type === 'verticals') {
    onVerticals(msg);
  } else if (msg.type === 'governance') {
    gvOnMessage();
  } else if (msg.type === 'settings' && msg.project_id === projectId) {
    boardSettings = msg.settings;
    renderBoard();
    if (!$('settings-modal').classList.contains('hidden')) renderBoardSettings();
  }
  if (activeView === 'home') onHomeMessage(msg);
  if (mergeDlg && MV_REFRESH_ON.includes(msg.type)) mergeDlg.refresh();
}

// ── subscription usage bars (fed by the statusline script) ─────────
// Below 500px the pill collapses to its ✳ (coloured by the hotter window): a tap / Enter opens the
// full bars under the header, a tap elsewhere / Esc closes them; the tooltip carries the numbers.
const cuEl = document.getElementById('claude-usage');
const cuCompact = matchMedia('(max-width: 499px)');
let cuLabel = 'Usage limits'; // the compact button's name: "Usage limits: 5h 38%, week 64%"
function cuSetOpen(open) {
  cuEl.classList.toggle('open', open);
  if (cuCompact.matches) cuEl.setAttribute('aria-expanded', String(open));
}
function cuSync() {
  const on = cuCompact.matches;
  if (on) {
    cuEl.tabIndex = 0;
    cuEl.setAttribute('role', 'button');
    cuEl.setAttribute('aria-expanded', String(cuEl.classList.contains('open')));
    cuEl.setAttribute('aria-label', cuLabel);
  } else {
    cuEl.removeAttribute('tabindex');
    cuEl.removeAttribute('role');
    cuEl.removeAttribute('aria-label');
    cuEl.removeAttribute('aria-expanded');
    cuEl.classList.remove('open');
  }
}
cuCompact.addEventListener('change', cuSync);
cuSync();
cuEl.addEventListener('click', () => cuCompact.matches && cuSetOpen(!cuEl.classList.contains('open')));
cuEl.addEventListener('keydown', (e) => {
  if (!cuCompact.matches) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    cuSetOpen(!cuEl.classList.contains('open'));
  } else if (e.key === 'Escape' && cuEl.classList.contains('open')) {
    e.preventDefault();
    cuSetOpen(false);
  }
});
document.addEventListener('click', (e) => {
  if (cuEl.classList.contains('open') && !cuEl.contains(e.target)) cuSetOpen(false);
});
let lastUsage = null;
function renderUsage(usage) {
  lastUsage = usage ?? null;
  if (activeView === 'home') renderHomeHead();
  const windows = [
    ['usage-5h', usage?.five_hour],
    ['usage-wk', usage?.seven_day],
  ];
  const pcts = windows.map(([, w]) => w?.used_percentage).filter((x) => typeof x === 'number');
  const hot = pcts.length ? Math.max(...pcts) : null;
  cuEl.classList.toggle('cu-hot', hot !== null && hot >= 85);
  cuEl.classList.toggle('cu-warn', hot !== null && hot >= 60 && hot < 85);
  const pctText = (w) => (typeof w?.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : '—');
  cuEl.title = `Claude subscription usage limits · 5h ${pctText(usage?.five_hour)} · week ${pctText(usage?.seven_day)}`;
  cuLabel = `Usage limits: 5h ${pctText(usage?.five_hour)}, week ${pctText(usage?.seven_day)}`;
  cuSync();
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
      // WIP counts the whole lane (every phase), like the dashboard tile
      const wip = wipOf(lane, [...cards.values()].filter((c) => c.lane === lane).length, kanbanSettings());
      if (wip) {
        const countEl = laneEl.querySelector('.lane-count');
        countEl.textContent = `${wip.n} / ${wip.limit}`;
        countEl.classList.toggle('wip-over', wip.over);
        countEl.title = wip.over ? `Over the WIP limit: ${wip.n} cards, limit ${wip.limit}` : `WIP limit ${wip.limit}`;
      }
      applyLaneState(laneEl, lane);
      laneEl.querySelector('.lane-head').addEventListener('click', () => toggleLane(lane, laneEl));
      const cardsEl = document.createElement('div');
      cardsEl.className = 'cards';
      cardsEl.append(...inLane.map(cardEl));
      const hiddenNote = laneHiddenNote(lane);
      if (hiddenNote) cardsEl.append(hiddenNote);
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

// The board shows the active phase (plus every done card) — but only once phases exist. Flat /
// legacy projects (no phases) keep showing every card.
// kanbanShowAll: the user asked to see the cards outside the active phase too (the lanes' "Show" note).
let kanbanShowAll = false;
const inActiveScope = (c, apid) => c.phase_id === apid || c.lane === 'done' || kanbanHighlight.has(c.id);
function visibleCards() {
  const apid = activePhaseId();
  const all = [...cards.values()];
  // done cards (every phase's history) and cards highlighted from Metrics' "Open all" stay visible whatever their phase
  return phases.length && apid && !kanbanShowAll ? all.filter((c) => inActiveScope(c, apid)) : all;
}
// A lane's cards outside the active phase (hidden unless kanbanShowAll), and the toggle naming them:
// "2 cards in planned phases hidden · Show" / "2 cards outside the active phase shown · Hide".
function laneHiddenNote(lane) {
  const apid = activePhaseId();
  if (!phases.length || !apid) return null;
  const out = [...cards.values()].filter((c) => c.lane === lane && !inActiveScope(c, apid));
  if (!out.length) return null;
  const planned = out.every((c) => phases.find((p) => p.id === c.phase_id)?.status === 'planned');
  const where = planned ? `in planned ${out.length === 1 ? 'phase' : 'phases'}` : 'outside the active phase';
  const b = node('button', 'lane-hidden');
  b.type = 'button';
  b.setAttribute('aria-pressed', String(kanbanShowAll));
  if (kanbanShowAll) b.append(node('span', '', `${mxPlural(out.length, 'card')} ${where} shown · `), node('span', 'lane-hidden-act', 'Hide'));
  else b.append(node('span', '', `${mxPlural(out.length, 'card')} ${where} hidden · `), node('span', 'lane-hidden-act', 'Show'));
  b.onclick = (e) => {
    e.stopPropagation();
    kanbanShowAll = !kanbanShowAll;
    renderBoard();
    boardEl.querySelector(`.lane[data-lane="${lane}"] .lane-hidden`)?.focus();
  };
  return b;
}

// ── lane health: age in lane, stuck flags, WIP limits ───────────────
// Per-board config lives server-side (GET/PUT /project/:id/settings); the
// Kanban uses the current board's, each dashboard tile its own board's.
const DEFAULT_BOARD_SETTINGS = {
  stuck_hours: { queued: 72, in_progress: 24, in_review: 24 },
  wip: { in_progress: null, in_review: null },
};
const AGE_LANES = { queued: 'Queued', in_progress: 'In progress', in_review: 'In review' };
let boardSettings = null; // the current board's settings, once loaded
const kanbanSettings = () => boardSettings ?? DEFAULT_BOARD_SETTINGS;

async function loadBoardSettings() {
  if (!projectId) return;
  try {
    const res = await fetch(`/project/${encodeURIComponent(projectId)}/settings`);
    if (!res.ok) return;
    boardSettings = await res.json();
  } catch {
    return; // daemon hiccup — defaults until the next load
  }
  renderBoard();
}

/** Compact age: "4m", "3h", "2d". */
function fmtAge(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** Long age for tooltips: "2d 4h", "5h 12m", "40m" (zero parts dropped). */
function fmtAgeLong(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  const parts = d ? [d && `${d}d`, h && `${h}h`] : h ? [`${h}h`, mm && `${mm}m`] : [`${mm}m`];
  return parts.filter(Boolean).join(' ');
}

/** Age-in-lane badge for an in-flight card, or null for other lanes. Painted by paintAge. */
function ageBadge(lane, since, settings) {
  if (!(lane in AGE_LANES) || !since) return null;
  const el = document.createElement('span');
  el.className = 'age';
  el.dataset.lane = lane;
  el.dataset.since = since;
  el.dataset.limitH = settings.stuck_hours[lane];
  paintAge(el);
  return el;
}

function paintAge(el) {
  const age = Date.now() - Number(el.dataset.since);
  const limit = Number(el.dataset.limitH) * 3600000;
  const stuck = age > limit;
  const lane = AGE_LANES[el.dataset.lane];
  el.classList.toggle('stuck', stuck);
  el.textContent = stuck ? `stuck ${fmtAge(age)}` : fmtAge(age);
  el.title = stuck
    ? `${lane} for ${fmtAgeLong(age)}, over the ${fmtAgeLong(limit)} limit`
    : `${lane} for ${fmtAgeLong(age)} (stuck after ${fmtAgeLong(limit)})`;
}

// Ages tick once a minute in place — no refetch, no re-render.
let ageTicks = 0;
tick.add(() => {
  if (++ageTicks % 60 === 0) for (const el of document.querySelectorAll('.age[data-since]')) paintAge(el);
});

/** { n, limit, over } for a lane with a WIP limit set, else null. */
function wipOf(lane, n, settings) {
  const limit = settings.wip?.[lane];
  return limit ? { n, limit, over: n > limit } : null;
}

// ── activity rail: view switcher (Kanban / Git / Phases / …) ─
const railKanban = document.getElementById('rail-kanban');
const railScm = document.getElementById('rail-scm');
const railPhases = document.getElementById('rail-phases');
const railMetrics = document.getElementById('rail-metrics');
const railHome = document.getElementById('rail-home');
const railPlanner = document.getElementById('rail-planner');
const railGovernance = document.getElementById('rail-governance');
const governanceView = document.getElementById('governance-view');
const plannerView = document.getElementById('planner-view');
const homeView = document.getElementById('home-view');
const scmView = document.getElementById('scm-view');
const phasesView = document.getElementById('phases-view');
const metricsView = document.getElementById('metrics-view');
const dashboardView = document.getElementById('dashboard-view');
let activeView = 'kanban'; // 'home' | 'kanban' | 'scm' | 'phases' | 'metrics' | 'dashboard' | 'planner' | 'governance'

// Non-kanban views take over the whole board area (full-screen).
function setView(name) {
  const prev = activeView;
  activeView = name;
  if (prev !== name) {
    mx.drill?.close(); // a drill-down belongs to the view that opened it
    if (prev === 'dashboard' || prev === 'home') {
      fbClearUrl(prev); // before the next view reads the URL
      fbCancelMeta(prev === 'dashboard' ? dctx : hctx); // an in-flight filtered load never lands on a closed view
    }
  }
  railKanban.classList.toggle('active', name === 'kanban');
  railScm.classList.toggle('active', name === 'scm');
  railPhases.classList.toggle('active', name === 'phases');
  railMetrics.classList.toggle('active', name === 'metrics');
  railHome.classList.toggle('active', name === 'home');
  railPlanner.classList.toggle('active', name === 'planner');
  railGovernance.classList.toggle('active', name === 'governance');
  boardEl.classList.toggle('hidden', name !== 'kanban');
  scmView.classList.toggle('hidden', name !== 'scm');
  phasesView.classList.toggle('hidden', name !== 'phases');
  metricsView.classList.toggle('hidden', name !== 'metrics');
  dashboardView.classList.toggle('hidden', name !== 'dashboard');
  homeView.classList.toggle('hidden', name !== 'home');
  plannerView.classList.toggle('hidden', name !== 'planner');
  governanceView.classList.toggle('hidden', name !== 'governance');
  renderStats(); // the header names its scope on a workspace's Home
  if (name !== 'governance' && prev === 'governance') closeGovernance(); // drops ?tab before Metrics reads it
  if (name === 'scm') refreshFiles();
  if (name === 'phases') {
    loadSchedule(); // fresh pills on every open
    renderPhaseDetail();
  }
  if (name === 'metrics' && prev !== 'metrics') openMetrics();
  else if (name !== 'metrics' && prev === 'metrics') closeMetrics();
  if (name !== 'kanban' && kanbanHighlight.size) clearKanbanHighlight();
  if (name === 'dashboard') openDashboard();
  else if (!(name === 'home' && prev === 'home')) closeDashboard(); // also drops Home's all-projects socket on leave
  if (name === 'home' && prev !== 'home') openHome();
  if (name === 'planner' && prev !== 'planner') openPlanner();
  else if (name !== 'planner' && prev === 'planner') closePlanner();
  if (name === 'governance' && prev !== 'governance') openGovernance();
}

railKanban.onclick = () => setView('kanban');
railScm.onclick = () => setView('scm');
railPhases.onclick = () => setView('phases');
railMetrics.onclick = () => setView('metrics');
railHome.onclick = () => setView('home');
railPlanner.onclick = () => setView('planner');
railGovernance.onclick = () => setView('governance');

// ── token / duration formatters (card modal) ────────────────────────
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n | 0));
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Shared filters: Metrics, the dashboard and Home ─────────────────
// One scope / phase / tag / agent / range / tz filter, URL-backed. A view owns a
// ctx { f, meta, customOpen, window, rangeDefault, lockScope?, open? }: f holds the
// values, meta the boards, phases and cards — the options, plus (dashboard / Home:
// fbLoadCards, filtered server-side) the cards their drill-downs list. filterBar draws
// the full bar (Metrics); filterChip the compact "Filters · …" chip + Clear that expands to it.
const FB_KEYS = ['scope', 'phase', 'tag', 'agent', 'workType', 'range', 'from', 'to', 'tz'];
const FB_FIELDS = ['scope', 'phase', 'tag', 'agent', 'workType', 'range', 'tz'];
// Card work types (task.work_type; null = unclassified), in display order. The filter's
// workType also takes 'none' (unclassified cards only).
const WORK_TYPES = [['feature', 'Feature'], ['defect', 'Defect'], ['debt', 'Debt'], ['risk', 'Risk']];
const WORK_TYPE_LABEL = Object.fromEntries(WORK_TYPES);
const FB_WORK_TYPES = [['', 'Any'], ...WORK_TYPES, ['none', 'Unclassified']];
const fbWorkTypeLabel = (v) => FB_WORK_TYPES.find(([id]) => id === v)?.[1] ?? v;

function fbReadUrl(q, rangeDefault) {
  const range = q.get('range') || rangeDefault;
  const tz = q.get('tz') || MX_LOCAL_TZ;
  return {
    scope: q.get('scope') || null,
    phase: q.get('phase') || '',
    tag: q.get('tag') || '',
    agent: q.get('agent') || '',
    workType: FB_WORK_TYPES.some(([id]) => id && id === q.get('workType')) ? q.get('workType') : '',
    range: range === 'custom' || MX_RANGES.some(([id]) => id === range) ? range : rangeDefault,
    from: q.get('from') || '',
    to: q.get('to') || '',
    tz: mxValidTz(tz) ? tz : MX_LOCAL_TZ,
  };
}
const fbDefaults = (ctx) => ({
  scope: ctx.lockScope ?? ctx.meta?.workspaceId ?? null,
  phase: '',
  tag: '',
  agent: '',
  workType: '',
  range: ctx.rangeDefault,
  from: '',
  to: '',
  tz: MX_LOCAL_TZ,
});
// Non-default values into url (defaults are left out; from / to only with a custom range).
function fbWriteParams(url, f, defaults, keys = FB_KEYS) {
  for (const k of keys) url.searchParams.delete(k);
  for (const k of keys) {
    if (k === 'from' || k === 'to') {
      if (f.range === 'custom' && f[k]) url.searchParams.set(k, f[k]);
    } else if (f[k] && f[k] !== defaults[k]) url.searchParams.set(k, f[k]);
  }
}
// The dashboard's / Home's filters into the URL (view=<view> so a reload comes back to them)…
function fbSyncUrl(view, ctx) {
  const url = new URL(location.href);
  url.searchParams.set('view', view);
  fbWriteParams(url, ctx.f, fbDefaults(ctx));
  history.replaceState(null, '', url);
}
// …and out of it when the view is left.
function fbClearUrl(view) {
  const url = new URL(location.href);
  if (url.searchParams.get('view') === view) url.searchParams.delete('view');
  for (const k of FB_KEYS) url.searchParams.delete(k);
  history.replaceState(null, '', url);
}

// The filters' boards (workspace first, then its verticals) with their labels and colours.
const fbBoards = (raw) =>
  raw.map((b, i) => ({
    id: b.id,
    name: b.name,
    label: i === 0 && raw.length > 1 ? 'Main' : b.name,
    color: i === 0 ? PL_MAIN_COLOR : PL_VERT_COLORS[(i - 1) % PL_VERT_COLORS.length],
  }));
// Boards (workspace + verticals), their phases and cards (+ committed plans, for Metrics' Forecast).
async function fbLoadMeta(project, { plans: withPlans = false } = {}) {
  const ws = await mxGet(`/workspace?project=${encodeURIComponent(project)}`);
  const main = ws.workspace;
  const boards = fbBoards([main, ...ws.verticals]);
  // per board: its phases and cards, at most MX_META_CONCURRENCY requests in flight
  const jobs = boards.flatMap((b) => [
    () => mxGet(`/phases?project=${encodeURIComponent(b.id)}`).catch(() => []),
    () => mxGet(`/board?project=${encodeURIComponent(b.id)}`).catch(() => []),
  ]);
  const plansReq = withPlans ? mxGet(`/plan-drafts?workspace=${encodeURIComponent(main.id)}`).catch(() => []) : Promise.resolve([]);
  const results = await mxPool(jobs, MX_META_CONCURRENCY);
  const plans = (await plansReq).filter((d) => d.committed_version !== null).map((d) => ({ id: d.id, title: d.title }));
  const per = boards.map((b, i) => ({ b, phaseList: results[2 * i], cardList: results[2 * i + 1] }));
  const meta = { workspaceId: main.id, boards, boardById: new Map(boards.map((b) => [b.id, b])), phases: new Map(), cards: new Map(), tags: [], agents: [], plans };
  const tags = new Set();
  const agents = new Set(teamByName.keys());
  for (const { b, phaseList, cardList } of per) {
    meta.phases.set(b.id, phaseList);
    for (const c of cardList) {
      meta.cards.set(c.id, { ...c, board: b.id });
      if (c.tag) tags.add(c.tag);
      if (c.agent) agents.add(c.agent);
    }
  }
  meta.tags = [...tags].sort();
  meta.agents = [...agents].sort((a, b) => a.localeCompare(b));
  return meta;
}
// The dashboard's / Home's filters as query params for /workspace/summary, /home and
// /workspace/cards. The scope is left out when it's the view's default (the workspace, or a
// vertical Home's own board: the server's defaults); the range as epoch ms (to inclusive).
// relative: the range as chosen ("range=2w", a custom range's days) — the key a view compares
// its data against, so it doesn't go stale when the day rolls over and "2w" resolves anew.
// withRange false: the range left out (Home's live reads: see hctx.widgetRange).
function fbParams(ctx, relative = false, withRange = true) {
  const f = ctx.f;
  const workspaceId = ctx.workspaceId ?? ctx.meta?.workspaceId;
  const q = new URLSearchParams();
  if (f.scope && f.scope !== workspaceId && f.scope !== ctx.lockScope) q.set('scope', f.scope);
  for (const k of ['phase', 'tag', 'agent', 'workType']) if (f[k]) q.set(k, f[k]);
  if (!withRange) return q.toString();
  if (f.range !== 'all' && relative) {
    q.set('range', f.range);
    if (f.range === 'custom') for (const k of ['from', 'to']) if (f[k]) q.set(k, f[k]);
  } else if (f.range !== 'all') {
    const w = fbWindowMs(f);
    if (Number.isFinite(w.from)) q.set('from', String(w.from));
    if (Number.isFinite(w.to)) q.set('to', String(w.to - 1));
  }
  return q.toString();
}
// A widget's filters (ctx.filters) without the date range: the live reads (/home,
// /workspace/summary) on Home show the present, whatever window the history widgets cover.
function fbNoRange(params) {
  const q = new URLSearchParams(params);
  for (const k of ['range', 'from', 'to']) q.delete(k);
  return q.toString();
}
// The card filters in params (phase / tag / agent / workType) as a predicate over /workspace/cards'
// cards, matching as the server's cardWhere does (the scope and the range are the reader's).
function fbCardFilter(params) {
  const q = new URLSearchParams(params);
  const [phase, tag, agent, wt] = ['phase', 'tag', 'agent', 'workType'].map((k) => q.get(k));
  return (c) => (!phase || c.phase_id === phase) && (!tag || c.tag === tag) && (!agent || c.agent === agent) && (!wt || (wt === 'none' ? c.work_type == null : c.work_type === wt));
}
// One read for the filter options and the matching cards (GET /workspace/cards): a meta
// like fbLoadMeta's, its cards already filtered (key: the filters they match, see fbParams).
// Home's: the scope-only read its widgets share (dwCardsRead: one per refresh cycle), filtered here.
async function fbLoadCards(project, ctx) {
  const key = fbParams(ctx, true, !ctx.widgetRange);
  const params = fbParams(ctx, false, !ctx.widgetRange);
  let r;
  if (ctx === hctx && typeof dwCardsRead === 'function') {
    const all = await dwCardsRead(project, new URLSearchParams(params).get('scope'));
    r = { ...all, cards: all.cards.filter(fbCardFilter(params)) };
  } else r = await mxGet(`/workspace/cards?project=${encodeURIComponent(project)}${params ? `&${params}` : ''}`);
  const boards = fbBoards(r.boards);
  const phases = new Map(boards.map((b) => [b.id, []]));
  for (const p of r.phases) phases.get(p.board)?.push(p);
  const agents = new Set([...teamByName.keys(), ...r.agents]);
  return {
    workspaceId: r.workspace_id,
    boards,
    boardById: new Map(boards.map((b) => [b.id, b])),
    phases,
    cards: new Map(r.cards.map((c) => [c.id, c])),
    tags: r.tags,
    agents: [...agents].sort((a, b) => a.localeCompare(b)),
    key,
  };
}
// (Re)load a dashboard / Home ctx's meta; onReady runs once it lands. One load at a time: a
// request while one is in flight queues a single follow-up (the latest wins), and a load
// superseded by fbCancelMeta (the view closed) never applies. Resolves once the queue drains.
function fbReloadMeta(ctx, project, onReady) {
  ctx.metaDirty = false;
  if (ctx.metaLoading) {
    ctx.metaAgain = { project, onReady };
    return ctx.metaReady;
  }
  ctx.metaLoading = true;
  const seq = ++ctx.metaSeq;
  const settle = () => {
    ctx.metaLoading = false;
    const again = ctx.metaAgain;
    ctx.metaAgain = null;
    return again && seq === ctx.metaSeq ? fbReloadMeta(ctx, again.project, again.onReady) : ctx.meta;
  };
  ctx.metaReady = fbLoadCards(project, ctx).then(
    (meta) => {
      if (seq !== ctx.metaSeq) return ctx.meta; // cancelled: a newer load owns the queue
      ctx.meta = meta;
      if (ctx.f.scope && !meta.boardById.has(ctx.f.scope)) ctx.f.scope = null;
      ctx.filtersStale = true; // new options / labels: the next render may redraw the filters
      const next = settle(); // a queued reload supersedes this one: skip the render
      if (next === ctx.meta && !ctx.metaLoading) onReady();
      return next;
    },
    () => {
      if (seq !== ctx.metaSeq) return ctx.meta;
      ctx.metaDirty = true;
      return settle();
    },
  );
  return ctx.metaReady;
}
// Drop in-flight loads (the view closed): their results never apply.
function fbCancelMeta(ctx) {
  ctx.metaSeq++;
  ctx.metaLoading = false;
  ctx.metaAgain = null;
}

function fbPhaseById(meta, id) {
  for (const [board, list] of meta?.phases ?? []) {
    const p = list.find((x) => x.id === id);
    if (p) return { ...p, board };
  }
  return null;
}
// Boards the scope covers: the workspace (or no scope) → every board; a vertical → itself.
function fbScopeBoards(ctx) {
  const m = ctx.meta;
  if (!m) return [];
  return !ctx.f.scope || ctx.f.scope === m.workspaceId ? m.boards : m.boards.filter((b) => b.id === ctx.f.scope);
}
// Card-level filters: the counts are the filtered ones (no WIP limits).
const fbCardFiltered = (ctx) => !!(ctx.f.phase || ctx.f.tag || ctx.f.agent || ctx.f.workType || ctx.f.range !== 'all');
// The date window as epoch ms (local days; from inclusive, to exclusive).
function fbWindowMs(f) {
  const w = mxWindow(f);
  const at = (day) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  return { from: w.from ? at(w.from) : -Infinity, to: w.to ? at(mxAddDays(w.to, 1)) : Infinity };
}
// The meta's cards (already filtered by the server) that pass pred.
const fbCards = (ctx, pred) => [...(ctx.meta?.cards.values() ?? [])].filter(pred);

function fbWindowLabel(ctx) {
  const f = ctx.f;
  const today = mxDayKey(Date.now(), f.tz);
  const w = mxWindow(f);
  const from = w.from ?? (ctx.window ? mxDayKey(ctx.window.from, f.tz) : null);
  const to = w.to ?? (ctx.window ? mxDayKey(ctx.window.to, f.tz) : today);
  return from ? fbDays(from, to) : 'all time';
}
// Two local days (YYYY-MM-DD) as the delta chips write a range (dashboard.js' dwDays): "Sep 7 – Oct 3",
// "Sep 7 – 21" within a month, "Sep 7" for one day.
function fbDays(from, to) {
  const md = (day) => `${MX_MONTHS[mxUtc(day).getUTCMonth()]} ${mxUtc(day).getUTCDate()}`;
  if (from === to) return md(from);
  return from.slice(0, 7) === to.slice(0, 7) ? `${md(from)} – ${mxUtc(to).getUTCDate()}` : `${md(from)} – ${md(to)}`;
}
// phaseId: the phase to name when the filters have none (a drill-down of one phase's cards).
function fbScopeLabel(ctx, phaseId = null) {
  const m = ctx.meta;
  const f = ctx.f;
  const scope = !m || !f.scope || f.scope === m.workspaceId ? (m && m.boards.length > 1 ? 'all boards' : (m?.boards[0]?.name ?? '')) : m.boardById.get(f.scope)?.label;
  const ph = f.phase || phaseId;
  const phase = ph ? (fbPhaseById(m, ph)?.title ?? 'one phase') : 'all phases';
  return [scope, phase, f.tag && `tag ${f.tag}`, f.agent && f.agent, f.workType && fbWorkTypeLabel(f.workType)].filter(Boolean).join(' · ');
}
// The active (non-default) filters, as the chip names them: "web · Checkout · ui".
function fbActiveLabels(ctx, fields) {
  const m = ctx.meta;
  const f = ctx.f;
  const out = [];
  if (fields.includes('scope') && f.scope && f.scope !== fbDefaults(ctx).scope) out.push(m?.boardById.get(f.scope)?.label ?? '…');
  if (f.phase) out.push(m ? (fbPhaseById(m, f.phase)?.title ?? 'one phase') : '…');
  if (f.tag) out.push(f.tag);
  if (f.agent) out.push(f.agent);
  if (f.workType) out.push(fbWorkTypeLabel(f.workType));
  if (fields.includes('range') && f.range !== ctx.rangeDefault) out.push(fbRangeLabel(ctx));
  return out;
}
// The date range in words: "last 4 weeks", "all time", "Sep 7 – Oct 3".
function fbRangeLabel(ctx) {
  const r = ctx.f.range;
  if (r === 'custom') return fbWindowLabel(ctx);
  const weeks = MX_RANGES.find(([id]) => id === r)?.[2];
  return weeks ? `last ${mxPlural(weeks, 'week')}` : 'all time';
}

// The full bar. opts: fields (which controls), onChange(patch), rangeId (the range button's id, if any).
// Redraw host keeping keyboard focus on the same control (data-fb key), else on fallback.
function fbKeepFocus(host, fallback, draw) {
  const a = document.activeElement;
  const key = a && host.contains(a) ? a.dataset.fb : null;
  draw();
  if (key) (host.querySelector(`[data-fb="${key}"]`) ?? host.querySelector(`[data-fb="${fallback}"]`))?.focus();
}
const fbKey = (el, key) => {
  (el.matches('select, button, input') ? el : el.querySelector('select')).dataset.fb = key;
  return el;
};
function filterBar(host, ctx, opts) {
  fbKeepFocus(host, 'range-custom', () => drawFilterBar(host, ctx, opts));
}
function drawFilterBar(host, ctx, opts) {
  const { fields, onChange, rangeId } = opts;
  const m = ctx.meta;
  const f = ctx.f;
  const has = (k) => fields.includes(k);
  const items = [];
  if (m) {
    if (has('scope')) {
      // the API expands a workspace id to every board, so "all boards" or one vertical
      const scopes = m.boards.length > 1 ? [[m.workspaceId, `${m.boards[0].name} · all boards`], ...m.boards.slice(1).map((b) => [b.id, b.label])] : [[m.workspaceId, m.boards[0].name]];
      items.push(
        fbKey(
          mxSelect('Scope', f.scope ?? m.workspaceId, scopes, (v) => {
            const boards = v === m.workspaceId ? m.boards : m.boards.filter((b) => b.id === v);
            const keep = f.phase && boards.some((b) => (m.phases.get(b.id) ?? []).some((p) => p.id === f.phase));
            onChange({ scope: v, phase: keep ? f.phase : '' });
          }),
          'scope',
        ),
      );
    }
    const boards = fbScopeBoards(ctx);
    const phaseOpts = boards.flatMap((b) => (m.phases.get(b.id) ?? []).map((p) => [p.id, boards.length > 1 ? `${b.label} · ${p.title}` : p.title]));
    if (has('phase')) items.push(fbKey(mxSelect('Phase', f.phase, [['', 'All phases'], ...phaseOpts], (v) => onChange({ phase: v })), 'phase'));
    if (has('tag')) items.push(fbKey(mxSelect('Tag', f.tag, [['', 'Any'], ...m.tags.map((t) => [t, t])], (v) => onChange({ tag: v })), 'tag'));
    if (has('agent')) items.push(fbKey(mxSelect('Agent', f.agent, [['', 'Anyone'], ...m.agents.map((a) => [a, a])], (v) => onChange({ agent: v })), 'agent'));
    if (has('workType')) items.push(fbKey(mxSelect('Type', f.workType, FB_WORK_TYPES, (v) => onChange({ workType: v })), 'workType'));
  } else items.push(node('span', 'mx-dim', 'Loading boards…'));
  items.push(node('div', 'mx-grow'));

  if (has('range')) {
    const ranges = node('div', 'mx-seg');
    ranges.setAttribute('role', 'group');
    ranges.setAttribute('aria-label', 'Date range');
    for (const [id, text] of MX_RANGES) {
      const b = fbKey(node('button', 'mx-seg-btn', text), `range-${id}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(f.range === id));
      b.onclick = () => {
        ctx.customOpen = false;
        onChange({ range: id, from: '', to: '' });
      };
      ranges.append(b);
    }
    items.push(ranges);

    const rangeBtn = fbKey(node('button', 'mx-chip mono', fbWindowLabel(ctx)), 'range-custom');
    if (rangeId) rangeBtn.id = rangeId;
    rangeBtn.type = 'button';
    rangeBtn.title = 'Custom range';
    rangeBtn.setAttribute('aria-pressed', String(f.range === 'custom'));
    rangeBtn.setAttribute('aria-expanded', String(ctx.customOpen));
    rangeBtn.onclick = () => {
      ctx.customOpen = !ctx.customOpen;
      filterBar(host, ctx, opts);
    };
    const rangeWrap = node('div', 'mx-range');
    rangeWrap.append(rangeBtn);
    if (ctx.customOpen) {
      const pop = node('div', 'mx-pop');
      const today = mxDayKey(Date.now(), f.tz);
      const w = mxWindow(f);
      const input = (label, value) => {
        const l = node('label', 'mx-pop-field');
        l.append(node('span', '', label));
        const i = node('input');
        i.type = 'date';
        i.value = value;
        i.max = today;
        l.append(i);
        return [l, i];
      };
      const fromDefault = w.from ?? (ctx.window ? mxDayKey(ctx.window.from, f.tz) : mxAddDays(today, -27));
      const [fl, fi] = input('From', f.range === 'custom' ? f.from : fromDefault);
      const [tl, ti] = input('To', f.range === 'custom' ? f.to || today : today);
      fbKey(fi, 'from');
      fbKey(ti, 'to');
      const apply = fbKey(node('button', 'mx-btn primary', 'Apply'), 'apply');
      apply.type = 'button';
      const err = node('span', 'mx-pop-err');
      apply.onclick = () => {
        if (!fi.value) return (err.textContent = 'Pick a start date');
        if (ti.value && ti.value < fi.value) return (err.textContent = 'From must be on or before To');
        ctx.customOpen = false;
        onChange({ range: 'custom', from: fi.value, to: ti.value === today ? '' : ti.value });
      };
      pop.append(fl, tl, apply, err);
      rangeWrap.append(pop);
    }
    items.push(rangeWrap);
  }

  if (has('tz')) {
    const tzSel = fbKey(mxSelect('', f.tz, mxTzOptions(), (v) => onChange({ tz: v })), 'tz');
    tzSel.classList.add('mx-tz');
    tzSel.querySelector('select').setAttribute('aria-label', 'Time zone');
    tzSel.firstChild.remove();
    items.push(tzSel);
  }
  host.replaceChildren(...items);
}

// The compact form: a "Filters" chip naming the range and counting the active filters (+ Clear);
// clicking it expands the bar.
// opts.barId: the bar's id (the chip's aria-controls). Keyboard focus survives the redraw
// (Clear, once gone, hands it to the chip).
function filterChip(host, ctx, opts) {
  fbKeepFocus(host, 'chip', () => drawFilterChip(host, ctx, opts));
  ctx.filtersStale = false;
  fbChipHost = { host, ctx, opts }; // the chip Esc collapses
}
// Esc closes the expanded bar (its custom-range popover first), unless a dialog has it; while the
// dashboard is being edited, only from inside the bar (the editor's Esc is its own).
let fbChipHost = null;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || !fbChipHost) return;
  const { host, ctx, opts } = fbChipHost;
  if (!ctx.open || !host.isConnected || host.closest('.hidden') || anyDialogOpen()) return;
  const inside = host.contains(document.activeElement);
  if (document.body.classList.contains('de-editing') && !inside) return;
  e.preventDefault();
  const pop = ctx.customOpen;
  if (pop) ctx.customOpen = false;
  else ctx.open = false;
  filterChip(host, ctx, opts);
  if (inside) host.querySelector(`[data-fb="${pop ? 'range-custom' : 'chip'}"]`)?.focus();
});
// A redraw that's not the user's doing (fresh options / labels after a load): never while they're
// in the bar (an open select, a half-typed custom range) — it waits for the next chance instead.
function filterChipSoft(host, ctx, opts) {
  const bar = host.querySelector('.fb-bar');
  const busy = ctx.customOpen || (bar && (bar.contains(document.activeElement) || !bar.querySelector(':scope > .mx-dim')));
  if (busy) ctx.filtersStale = true;
  else filterChip(host, ctx, opts);
}
function drawFilterChip(host, ctx, opts) {
  const active = fbActiveLabels(ctx, opts.fields);
  // collapsed, the chip still names the range, then counts the other filters (named in its tooltip):
  // "last 4 weeks · 2 filters"
  const range = opts.fields.includes('range') ? fbRangeLabel(ctx) : null;
  const filters = fbActiveLabels(ctx, opts.fields.filter((k) => k !== 'range'));
  const summary = [range, filters.length && mxPlural(filters.length, 'filter')].filter(Boolean).join(' · ');
  const chip = fbKey(node('button', `fb-chip${active.length ? ' on' : ''}`), 'chip');
  chip.type = 'button';
  chip.setAttribute('aria-expanded', String(!!ctx.open));
  if (opts.barId) chip.setAttribute('aria-controls', opts.barId);
  if (filters.length) chip.title = [range, ...filters].filter(Boolean).join(' · ');
  chip.append(node('span', 'fb-chip-k', 'Filters'));
  if (summary) chip.append(node('span', 'fb-chip-v', summary));
  const caret = node('span', 'fb-caret', ctx.open ? '▴' : '▾');
  caret.setAttribute('aria-hidden', 'true');
  chip.append(caret);
  chip.onclick = () => {
    ctx.open = !ctx.open;
    ctx.customOpen = false;
    filterChip(host, ctx, opts);
  };
  const row = node('div', 'fb-row');
  row.append(chip);
  if (active.length) {
    const clear = fbKey(node('button', 'fb-clear', 'Clear'), 'clear');
    clear.type = 'button';
    clear.setAttribute('aria-label', 'Clear filters');
    clear.onclick = () => {
      ctx.customOpen = false;
      opts.onChange(fbDefaults(ctx));
    };
    row.append(clear);
  }
  const parts = [row];
  if (ctx.open) {
    const bar = node('div', 'mx-filters fb-bar');
    if (opts.barId) bar.id = opts.barId;
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Filters');
    filterBar(bar, ctx, opts);
    // a redraw deferred while the user was in the bar runs once focus leaves it
    bar.addEventListener('focusout', (e) => {
      if (bar.contains(e.relatedTarget)) return;
      setTimeout(() => {
        if (ctx.filtersStale && host.contains(bar) && !bar.contains(document.activeElement)) filterChipSoft(host, ctx, opts);
      });
    });
    parts.push(bar);
  }
  host.replaceChildren(...parts);
}
// Any non-default filter (the chip would name it).
const fbAnyActive = (ctx, fields) => fbActiveLabels(ctx, fields).length > 0;

// A drill-down of cards (dashboard / Home counts): title, board, lane, agent; Open / Open all in Kanban.
// phase: the drill's own phase (a phase's cards), named in the subtitle when the filters have none.
// source: what "Open all" says the highlight came from ("Home · Now building"; Home's default: Home).
// order: a label ("Largest first") for the cards' own order, offered as the first (default) sort.
function fbDrillCards(ctx, host, { kicker, title, cards, range, phase = null, source, order = null }) {
  const now = Date.now();
  const rows = cards.map((c, i) => {
    const since = c.lane_since ?? c.updated_at ?? now;
    const done = c.lane === 'done';
    return {
      i,
      id: c.id,
      title: c.title,
      board: c.board,
      agent: c.agent ?? null,
      when: done ? `done ${mxWeekdayDay(mxDayKey(since, MX_LOCAL_TZ))}` : `${LANE_LABELS[c.lane] ?? c.lane}${c.blocked ? ' · blocked' : ''}`,
      at: since,
      value: done ? since : now - since,
      valueText: done ? mxShortDay(mxDayKey(since, MX_LOCAL_TZ)) : mxWait(now - since),
    };
  });
  const allDone = rows.length > 0 && cards.every((c) => c.lane === 'done');
  mxOpenDrill({
    ctx,
    host,
    kicker,
    title,
    sub: [range, fbScopeLabel(ctx, phase)].filter(Boolean).join(' · '),
    source: source ?? (ctx === hctx ? 'Home' : undefined),
    stat: allDone ? '' : 'time in lane',
    rows,
    sorts: [
      ...(order ? [['order', order, (a, b) => a.i - b.i]] : []),
      ...(allDone
        ? [['value', 'Most recently done', (a, b) => b.value - a.value], ['board', 'Board', (a, b) => mxByBoard(a, b, ctx.meta)]]
        : [['value', 'Longest in lane', (a, b) => b.value - a.value], ['board', 'Board', (a, b) => mxByBoard(a, b, ctx.meta)]]),
    ],
  });
}

// ── Metrics: tabs over /metrics/* (hand-drawn SVG, no chart library) ─
// A tab registers { id, label, endpoints, render }: the shared loader fetches
// its endpoints (with the URL-backed filters) behind a sequence guard and calls
// render(host) on every settle, so tiles fill in as responses land. Shared
// helpers: formatters (mxSpan, mxWait, mxMoney, day keys in the chosen tz),
// SVG axes (mxNiceTicks, mxGrid), tiles (mxTile) and the drill-down panel.
const MX_LANES = [
  // bottom → top of the cumulative-flow stack
  { lane: 'done', name: 'Done', fill: '#2e5c50' },
  { lane: 'in_review', name: 'In review', fill: 'url(#mx-hatch-review)', swatch: '#e5c07b' },
  { lane: 'in_progress', name: 'In progress', fill: '#5dd3a8' },
  { lane: 'queued', name: 'Queued', fill: '#61afef' },
  { lane: 'backlog', name: 'Backlog', fill: '#5b6275' },
];
const MX_RANGES = [
  ['2w', '2w', 2],
  ['4w', '4w', 4],
  ['8w', '8w', 8],
  ['all', 'All', null],
];
const MX_DEFAULT_RANGE = '8w';
const MX_LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MX_URL_KEYS = ['tab', 'scope', 'phase', 'tag', 'agent', 'workType', 'range', 'from', 'to', 'tz', 'target'];
const MX_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MX_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MX_COST_LIMIT = 100;
const MX_META_CONCURRENCY = 6;

const mx = {
  project: null, // the board the view was opened from
  f: null, // filters (from the URL)
  meta: null, // { workspaceId, boards, boardById, phases: Map board → phases, cards: Map id → card, tags, agents, plans }
  metaSeq: 0,
  metaReady: null,
  seq: 0, // bumped per load: a response from an older load never renders
  res: {}, // endpoint → { state: 'loading' | 'ok' | 'error' | 'none', data, error }
  window: null, // the resolved { from, to } (epoch ms) once flow has answered
  drill: null, // the open drill-down panel's { close }
  notes: null, // the open cost-notes popover's { close }
  customOpen: false,
  rangeDefault: MX_DEFAULT_RANGE, // the shared filter bar's default range
  loadedAt: null,
  ui: { measure: 'cycle', waitBy: 'board' }, // in-tab toggles (Flow: cycle / lead; Quality: wait by board / phase)
};

// ---------- formatting ----------
const mxFmts = new Map();
function mxDayKey(ts, tz) {
  let f = mxFmts.get(tz);
  if (!f) mxFmts.set(tz, (f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })));
  return f.format(ts); // YYYY-MM-DD
}
const mxUtc = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const mxAddDays = (day, n) => new Date(mxUtc(day).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const mxShortDay = (day) => `${mxUtc(day).getUTCDate()} ${MX_MONTHS[mxUtc(day).getUTCMonth()]}`; // 3 Aug
const mxLongDay = (day) => `${MX_WEEKDAYS[mxUtc(day).getUTCDay()]} ${mxShortDay(day)}`; // Sat 3 Oct
const mxWeekdayDay = (day) => `${MX_WEEKDAYS[mxUtc(day).getUTCDay()]} ${mxUtc(day).getUTCDate()}`; // Tue 15

// Cycle / lead times: 47m, 5.2h, 14h, 1.6d.
function mxSpan(ms) {
  if (ms === null || ms === undefined) return '—';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(0, Math.round(ms / 60_000))}m`;
  if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)}h`;
  const d = h / 24;
  return `${d < 10 ? d.toFixed(1).replace(/\.0$/, '') : Math.round(d)}d`;
}
// Waits: 47m, 9h 20m, 2d 3h.
function mxWait(ms) {
  if (ms === null || ms === undefined) return '—';
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}
function mxMoney(usd) {
  if (usd === null || usd === undefined) return '—';
  if (usd > 0 && usd < 10) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}
const mxPlural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const mxNum = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// ---------- URL-backed filters ----------
function mxReadUrl() {
  const q = new URLSearchParams(location.search);
  return {
    tab: MX_TABS.some((t) => t.id === q.get('tab')) ? q.get('tab') : 'overview',
    ...fbReadUrl(q, MX_DEFAULT_RANGE),
    target: q.get('target') || '', // the Forecast tab's target: phase:<id>, plan:<id> or all ('' = the focus phase)
  };
}
function mxValidTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
// Non-default filters into the URL (defaults are left out); view=metrics replaces ?view=stats.
function mxWriteUrl() {
  const url = new URL(location.href);
  url.searchParams.set('view', 'metrics');
  fbWriteParams(url, mx.f, { ...fbDefaults(mx), tab: 'overview', target: '' }, MX_URL_KEYS);
  history.replaceState(null, '', url);
}
function mxSetFilter(patch) {
  mx.f = { ...mx.f, ...patch };
  mxWriteUrl();
  mxRenderFilters();
  mxLoad();
}

// The date window as local days in tz (from null = all history; to null = now). A rolling range is
// exactly 7×N days ending today (today included); the server's previous period (metrics.previousPeriod:
// whole local days before `from`) is then the 7×N days before it. Weekly charts mark the cut ISO weeks partial.
function mxWindow(f) {
  const today = mxDayKey(Date.now(), f.tz);
  if (f.range === 'custom') return { from: f.from || null, to: f.to || null };
  const weeks = MX_RANGES.find(([id]) => id === f.range)?.[2] ?? null;
  if (weeks === null) return { from: null, to: null };
  return { from: mxAddDays(today, 1 - 7 * weeks), to: null };
}
const mxWindowLabel = () => fbWindowLabel(mx);

// ---------- tab registry ----------
const MX_TABS = [
  { id: 'overview', label: 'Overview', endpoints: ['flow', 'quality', 'wait', 'cost', 'forecast', 'usageBurn'], render: mxRenderOverview },
  { id: 'flow', label: 'Flow', endpoints: ['flow', 'burn', 'burnForecast'], render: mxRenderFlow },
  // flow: the by-agent drill-down lists an agent's done cards from its points
  { id: 'quality', label: 'Quality & waiting', endpoints: ['quality', 'wait', 'flow'], render: mxRenderQuality },
  // forecastAll (the whole-workspace fallback) is fetched only when forecastTarget lacks history: see mxLoad
  { id: 'forecast', label: 'Forecast', endpoints: ['forecastTarget'], render: mxRenderForecast },
];
const mxTab = () => MX_TABS.find((t) => t.id === mx.f.tab) ?? MX_TABS[0];

// The phase a forecast / budget / usage-burn talks about: the phase filter, else the scope board's active phase.
function mxFocusPhase() {
  const m = mx.meta;
  if (!m) return null;
  if (mx.f.phase) return mxPhaseById(mx.f.phase);
  const p = (m.phases.get(mx.f.scope) ?? []).find((x) => x.status === 'active');
  return p ? { ...p, board: mx.f.scope } : null;
}
const mxPhaseById = (id) => fbPhaseById(mx.meta, id);
// The Forecast tab's target: the URL's, when it still exists in the scope, else the focus phase, else the whole scope.
function mxForecastTarget() {
  const t = mx.f.target;
  const m = mx.meta;
  if (t.startsWith('phase:')) {
    const p = mxPhaseById(t.slice(6));
    if (p && mxScopeBoards().some((b) => b.id === p.board)) return { kind: 'phase', id: p.id, key: t, phase: p };
  } else if (t.startsWith('plan:') && m && mx.f.scope === m.workspaceId) {
    const plan = m.plans.find((x) => x.id === t.slice(5));
    if (plan) return { kind: 'plan', id: plan.id, key: t, plan };
  } else if (t === 'all') return { kind: 'all', key: 'all' };
  const p = mxFocusPhase();
  return p ? { kind: 'phase', id: p.id, key: `phase:${p.id}`, phase: p } : { kind: 'all', key: 'all' };
}
const mxScopeBoards = () => fbScopeBoards(mx);

// Query string per endpoint. `from` may be a local day or epoch ms (the All range, once flow resolved it).
const MX_ENDPOINTS = {
  flow: (f, w) => ['/metrics/flow', { phase: f.phase, tag: f.tag, agent: f.agent, workType: f.workType, from: w.from, to: w.to }],
  quality: (f, w) => ['/metrics/quality', { phase: f.phase, tag: f.tag, agent: f.agent, workType: f.workType, from: w.from, to: w.to }],
  wait: (f, w) => ['/metrics/wait', { phase: f.phase, workType: f.workType, from: w.from, to: w.to }],
  cost: (f, w) => ['/metrics/cost', { phase: f.phase, tag: f.tag, agent: f.agent, workType: f.workType, from: w.from, to: w.to, limit: MX_COST_LIMIT }],
  forecast: (f) => {
    const p = mxFocusPhase();
    return p ? ['/metrics/forecast', { phase: p.id, tag: f.tag, workType: f.workType }] : null;
  },
  usageBurn: () => ['/metrics/usage-burn', { phase: mxFocusPhase()?.id }],
  burn: (f) => {
    const p = mxFocusPhase();
    return p ? ['/metrics/burn', { phase: p.id, workType: f.workType }] : null;
  },
  // the burn-up's cone: the whole phase, like /metrics/burn (which takes no tag / agent; a work type, yes)
  burnForecast: (f) => {
    const p = mxFocusPhase();
    return p ? ['/metrics/forecast', { phase: p.id, workType: f.workType }] : null;
  },
  // the Forecast tab: its target (a plan is workspace-wide, so it is asked of the workspace)
  forecastTarget: (f) => {
    const t = mxForecastTarget();
    if (t.kind === 'phase') return ['/metrics/forecast', { phase: t.id, tag: f.tag, workType: f.workType }];
    if (t.kind === 'plan') return ['/metrics/forecast', { plan: t.id, tag: f.tag, workType: f.workType, project: mx.meta.workspaceId }];
    return ['/metrics/forecast', { tag: f.tag, workType: f.workType }];
  },
  // the fallback when one board lacks history: the whole workspace (more boards, more history)
  forecastAll: (f) => (mx.meta && f.scope !== mx.meta.workspaceId ? ['/metrics/forecast', { tag: f.tag, workType: f.workType, project: mx.meta.workspaceId }] : null),
};
function mxUrl([path, params]) {
  const q = new URLSearchParams({ project: mx.f.scope, tz: mx.f.tz });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  return `${path}?${q}`;
}
async function mxGet(url) {
  const res = await fetch(url);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

// ---------- open / close / load ----------
async function openMetrics() {
  const project = currentProject();
  if (!project) return mxRenderShell(); // the init message will call back
  mx.project = project;
  mx.f = mxReadUrl();
  mxRenderShell();
  mxLoadMeta();
  mxLoad();
}
function closeMetrics() {
  mx.seq++; // drop anything in flight
  mx.metaSeq++;
  mx.drill?.close();
  mx.notes?.close(false);
  const url = new URL(location.href);
  if (url.searchParams.get('view') === 'metrics' || url.searchParams.get('view') === 'stats') url.searchParams.delete('view');
  for (const k of MX_URL_KEYS) url.searchParams.delete(k);
  history.replaceState(null, '', url);
}

// Boards (workspace + verticals), their phases and cards: the filter options, and card → board / agent for drill-downs.
function mxLoadMeta() {
  const seq = ++mx.metaSeq;
  mx.metaReady = fbLoadMeta(mx.project, { plans: true }).then(
    (meta) => {
      if (seq !== mx.metaSeq) return meta;
      mx.meta = meta;
      if (!mx.f.scope || !meta.boardById.has(mx.f.scope)) mx.f.scope = meta.workspaceId;
      mxWriteUrl();
      mxRenderFilters();
      return meta;
    },
    (err) => {
      if (seq === mx.metaSeq) mxRenderShell(err.message);
      throw err;
    },
  );
  mx.metaReady.catch(() => {}); // mxLoad reports it; never an unhandled rejection
}
// Run async jobs with at most `limit` in flight; results in the jobs' order.
async function mxPool(jobs, limit) {
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

async function mxLoad() {
  const tab = mxTab();
  const seq = ++mx.seq;
  mx.notes?.close(false); // its notes belong to the previous filters
  mx.res = Object.fromEntries(tab.endpoints.map((k) => [k, { state: 'loading' }]));
  mx.window = null;
  mxRenderBody();
  if (!tab.endpoints.length) return;
  try {
    await mx.metaReady;
  } catch (err) {
    if (seq !== mx.seq) return;
    for (const k of tab.endpoints) mx.res[k] = { state: 'error', error: err.message };
    return mxRenderBody();
  }
  if (seq !== mx.seq) return;
  const f = mx.f;
  const win = mxWindow(f);
  const fetchOne = async (key, w) => {
    const spec = MX_ENDPOINTS[key](f, w);
    if (!spec) {
      mx.res[key] = { state: 'none' };
      return;
    }
    try {
      const data = await mxGet(mxUrl(spec));
      if (seq !== mx.seq) return;
      mx.res[key] = { state: 'ok', data };
      if (key === 'flow') mx.window = { from: data.range.from, to: data.range.to };
    } catch (err) {
      if (seq !== mx.seq) return;
      mx.res[key] = { state: 'error', error: err.message };
    }
    mx.loadedAt = Date.now();
    mxRenderBody();
    mxRenderHead();
  };
  let rest = tab.endpoints;
  let w = win;
  // All history: flow picks the start (the scope's first card); the rest get it as an explicit `from`
  if (win.from === null && tab.endpoints.includes('flow')) {
    await fetchOne('flow', win);
    if (seq !== mx.seq) return;
    rest = rest.filter((k) => k !== 'flow');
    if (mx.window) w = { from: Math.floor(mx.window.from), to: win.to }; // epoch ms (the API reads digits only)
    const rangeBtn = $('mx-range-btn');
    if (rangeBtn) rangeBtn.textContent = mxWindowLabel(); // the resolved dates
  }
  await Promise.all(rest.map((k) => fetchOne(k, w)));
  // Forecast tab: not enough history for the target → ask the whole workspace (the fallback offer)
  const target = mx.res.forecastTarget;
  if (seq === mx.seq && tab.id === 'forecast' && target?.state === 'ok' && target.data.status !== 'ok' && MX_ENDPOINTS.forecastAll(f)) {
    mx.res.forecastAll = { state: 'loading' };
    mxRenderBody();
    await fetchOne('forecastAll', w);
  }
}

// ---------- shell: title + tabs + filters + body ----------
function mxRenderShell(error) {
  const head = node('div', 'mx-head');
  head.id = 'mx-head';
  const filters = node('div', 'mx-filters');
  filters.id = 'mx-filters';
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filters');
  const body = node('div', 'mx-body');
  body.id = 'mx-body';
  const wrap = node('div', 'mx-wrap');
  wrap.append(head, filters, body);
  metricsView.replaceChildren(wrap);
  if (error) body.append(node('div', 'mx-state mx-error', `Couldn't load the boards: ${error}`));
  else if (!mx.f) body.append(node('div', 'mx-state', 'Loading…'));
  if (mx.f) {
    mxRenderHead();
    mxRenderFilters();
    if (!error) mxRenderBody();
  }
}

function mxRenderHead() {
  const head = $('mx-head');
  if (!head || !mx.f) return;
  const tabs = node('nav', 'mx-tabs');
  tabs.setAttribute('aria-label', 'Metrics sections');
  for (const t of MX_TABS) {
    const b = node('button', 'mx-tab', t.label);
    b.type = 'button';
    if (t.id === mx.f.tab) b.setAttribute('aria-current', 'page');
    b.onclick = () => t.id !== mx.f.tab && mxSetFilter({ tab: t.id });
    tabs.append(b);
  }
  const flow = mx.res.flow?.state === 'ok' ? mx.res.flow.data : null;
  const status = node('span', 'mx-status');
  if (flow) {
    const at = new Date(mx.loadedAt ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    status.textContent = `As of ${at} · ${mxPlural(flow.cards, 'card')} · ${mxPlural(flow.partial, 'partial history', 'partial histories')}`;
  }
  const report = node('a', 'mx-tab', 'Weekly report');
  report.href = `/report.html?${new URLSearchParams({ project: mx.f.scope ?? mx.project, tz: mx.f.tz })}`;
  report.target = '_blank';
  report.rel = 'noopener';
  report.style.cssText = 'display:inline-flex;align-items:center;text-decoration:none';
  head.replaceChildren(node('h1', 'mx-title', 'Metrics'), tabs, node('div', 'mx-grow'), status, report);
}

function mxSelect(label, value, options, onChange) {
  const wrap = node('label', 'mx-field');
  wrap.append(node('span', '', label));
  const sel = node('select', 'mx-select');
  for (const [v, text] of options) {
    const o = node('option', '', text);
    o.value = v;
    sel.append(o);
  }
  if (!options.some(([v]) => v === value)) {
    const o = node('option', '', value); // a URL value the lists don't know (still filtered on)
    o.value = value;
    sel.append(o);
  }
  sel.value = value;
  sel.onchange = () => onChange(sel.value);
  wrap.append(sel);
  return wrap;
}

let mxTzList = null; // built once: ~400 zones
function mxTzOptions() {
  if (!mxTzList) {
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [MX_LOCAL_TZ];
    mxTzList = [...new Set([MX_LOCAL_TZ, 'UTC', ...zones])].map((z) => [z, z]);
  }
  return mxTzList;
}

function mxRenderFilters() {
  const host = $('mx-filters');
  if (!host || !mx.f) return;
  filterBar(host, mx, { fields: FB_FIELDS, onChange: mxSetFilter, rangeId: 'mx-range-btn' });
}

function mxRenderBody() {
  const host = $('mx-body');
  if (!host || !mx.f) return;
  const tab = mxTab();
  if (!tab.render) {
    const ph = node('div', 'mx-state mx-soon');
    ph.append(node('b', '', tab.label), node('span', '', 'Coming next: this tab is being built.'));
    return host.replaceChildren(ph);
  }
  tab.render(host);
}

let mxResizeTimer = null;
window.addEventListener('resize', () => {
  if (activeView !== 'metrics') return;
  clearTimeout(mxResizeTimer);
  mxResizeTimer = setTimeout(mxRenderBody, 150);
});

// ---------- shared: tiles, states, axes ----------
// A tile for one endpoint: loading / error (with retry) / the built content.
function mxTile(key, cls, kicker, build) {
  const el = node('div', `mx-tile ${cls ?? ''}`);
  el.append(node('span', 'mx-kicker', kicker));
  const r = mx.res[key] ?? { state: 'loading' };
  if (r.state === 'loading') {
    el.classList.add('mx-loading');
    el.append(node('span', 'mx-skel mx-skel-big'), node('span', 'mx-skel'));
  } else if (r.state === 'error') {
    el.classList.add('mx-tile-error');
    el.append(node('span', 'mx-err-title', 'Couldn’t load'), node('span', 'mx-err-msg', r.error));
    const retry = node('button', 'mx-link', 'Retry');
    retry.type = 'button';
    retry.onclick = mxLoad;
    el.append(retry);
  } else build(el, r.data);
  return el;
}
// A big number; a button (drill-down) only when a card list backs it.
function mxBig(text, onClick, label, size = '') {
  if (!onClick) return node('span', `mx-big ${size}`, text);
  const b = node('button', `mx-big mx-drillable ${size}`, text);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.onclick = onClick;
  return b;
}
function mxChartState(key, empty) {
  const r = mx.res[key] ?? { state: 'loading' };
  if (r.state === 'loading') return node('div', 'mx-chart-state mx-loading', 'Loading…');
  if (r.state === 'error') {
    const el = node('div', 'mx-chart-state mx-error');
    el.append(node('span', '', `Couldn’t load: ${r.error}`));
    const retry = node('button', 'mx-link', 'Retry');
    retry.type = 'button';
    retry.onclick = mxLoad;
    el.append(retry);
    return el;
  }
  return empty ? node('div', 'mx-chart-state', empty) : null;
}
// ~4 round-numbered (integer) intervals from 0 covering max.
function mxNiceTicks(max, count = 4) {
  const raw = Math.max(1, max) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw));
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return ticks;
}
// Horizontal grid lines + y labels (HTML spans over the SVG, as in the artboard).
function mxGrid(svg, box, ticks, y, labelWidth) {
  svg.append(svgEl('path', { d: ticks.map((v) => `M${box.L},${y(v).toFixed(1)} H${box.R}`).join(' '), stroke: 'rgba(255,255,255,0.06)', 'stroke-width': 1, fill: 'none' }));
  return ticks.map((v) => {
    const l = node('span', 'mx-axis-y', v);
    l.style.top = `${(y(v) - 8).toFixed(1)}px`;
    l.style.width = `${labelWidth}px`;
    return l;
  });
}
function mxHatch(id, bg, stripe) {
  const p = svgEl('pattern', { id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  p.append(svgEl('rect', { width: 6, height: 6, fill: bg }), svgEl('rect', { width: 2, height: 6, fill: stripe }));
  return p;
}

// Weekly buckets with partial flags (a week the window cuts), from flow.
function mxWeeks(flow) {
  const tz = mx.f.tz;
  const first = mxDayKey(flow.range.from, tz);
  const last = mxDayKey(flow.range.to, tz);
  return flow.throughput.weekly.map((w) => ({ ...w, end: mxAddDays(w.start, 6), partial: w.start < first || mxAddDays(w.start, 6) > last }));
}
// The average of the last (up to) 4 complete weeks, and those weeks.
function mxAvgWeeks(weeks) {
  const full = weeks.filter((w) => !w.partial).slice(-4);
  return { weeks: full, avg: full.length ? full.reduce((s, w) => s + w.count, 0) / full.length : null };
}
const mxPointsIn = (flow, fromDay, toDay) =>
  flow.points.filter((p) => {
    const d = mxDayKey(p.doneAt, mx.f.tz);
    return d >= fromDay && d <= toDay;
  });

// ---------- Overview ----------
function mxRenderOverview(host) {
  const tiles = node('div', 'mx-tiles');
  tiles.append(mxWaitTile(), mxThroughputTile(), mxCycleTile(), mxQualityTile(), mxForecastTile(), mxCostTile());
  const charts = node('div', 'mx-charts');
  const cfd = node('section', 'mx-panel mx-cfd');
  cfd.setAttribute('aria-label', 'Cumulative flow');
  const tp = node('section', 'mx-panel mx-tp');
  tp.setAttribute('aria-label', 'Throughput per week');
  charts.append(cfd, tp);
  host.replaceChildren(tiles, charts);
  mxRenderCfd(cfd);
  mxRenderThroughput(tp);
}

function mxWaitTile() {
  return mxTile('wait', 'mx-hero', 'WAITING ON YOU', (el, w) => {
    const now = w.waiting;
    const line = node('span', 'mx-row');
    line.append(
      mxBig(String(now.count), now.count ? () => mxDrillWaiting(w) : null, `List the ${mxPlural(now.count, 'wait')} open now`, 'mx-big-xl'),
      node('span', 'mx-hero-sub', now.count ? `now · longest ${mxWait(now.longestMs)}` : 'now'),
    );
    el.append(line);
    const first = [...now.needsYou.map((n) => ({ ...n, kind: 'needs' })), ...now.blockers.map((b) => ({ ...b, kind: 'blocker' }))].sort((a, b) => b.waitingMs - a.waitingMs)[0];
    const board = (id) => mx.meta?.boardById.get(id)?.label ?? 'a board';
    el.append(
      node(
        'span',
        'mx-sub',
        !first
          ? 'Nothing is waiting on you'
          : first.kind === 'needs'
            ? `${board(first.project_id)} is waiting on you${first.reason ? `: ${first.reason}` : ''}`
            : `“${first.title}” is blocked${first.reason ? `: ${first.reason}` : ''}`,
      ),
    );
    const total = w.needsYou.totalMs + w.blocked.totalMs;
    const waits = w.needsYou.count + w.blocked.count;
    const d = w.needsYou.duration;
    const foot = node('span', 'mx-foot mono');
    foot.append(node('b', '', mxWait(total)), ` this period · ${mxPlural(waits, 'wait')}`);
    if (d.count) foot.append(` · p50 ${mxWait(d.p50)} · p85 ${mxWait(d.p85)}`);
    el.append(foot);
  });
}

function mxThroughputTile() {
  return mxTile('flow', '', 'THROUGHPUT', (el, flow) => {
    const weeks = mxWeeks(flow);
    const { weeks: full, avg } = mxAvgWeeks(weeks);
    const line = node('span', 'mx-row');
    if (avg === null) {
      line.append(mxBig(String(flow.throughput.total), flow.throughput.total ? () => mxDrillDone(flow.points, 'THROUGHPUT · THIS PERIOD', mxWindowLabel()) : null, 'List the cards done this period'), node('span', 'mx-unit', 'done'));
      el.append(line, node('span', 'mx-sub', 'no complete week yet'));
      return;
    }
    const pts = mxPointsIn(flow, full[0].start, full[full.length - 1].end);
    line.append(
      mxBig(mxNum(avg), pts.length ? () => mxDrillDone(pts, `THROUGHPUT · LAST ${mxPlural(full.length, 'WEEK')}`, `${mxShortDay(full[0].start)} – ${mxShortDay(full[full.length - 1].end)}`) : null, `List the ${pts.length} cards done in the last ${mxPlural(full.length, 'week')}`),
      node('span', 'mx-unit', '/ week'),
    );
    el.append(line, node('span', 'mx-sub', `last ${mxPlural(full.length, 'complete week')}`));
    const series = weeks.filter((w) => !w.partial).slice(-8).map((w) => w.count);
    if (series.length >= 2) el.append(mxSparkline(series));
  });
}
function mxSparkline(values) {
  const W = 150;
  const H = 34;
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const x = (i) => 6 + (i * (W - 12)) / (values.length - 1);
  const y = (v) => H - 4 - ((v - min) * (H - 10)) / Math.max(1, max - min);
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', class: 'mx-spark' });
  svg.append(
    svgEl('polyline', { points: values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '), fill: 'none', stroke: '#5dd3a8', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    svgEl('circle', { cx: x(values.length - 1).toFixed(1), cy: y(values[values.length - 1]).toFixed(1), r: 3.5, fill: '#5dd3a8', stroke: '#141925', 'stroke-width': 2 }),
  );
  return svg;
}

function mxCycleTile() {
  return mxTile('flow', '', 'CYCLE TIME', (el, flow) => {
    const c = flow.cycleTime;
    const line = node('span', 'mx-row');
    line.append(mxBig(mxSpan(c.p50), c.count ? () => mxDrillDone(flow.points, 'CYCLE TIME · THIS PERIOD', mxWindowLabel()) : null, `List the ${mxPlural(c.count, 'card')} behind the cycle time`), node('span', 'mx-unit', 'p50'));
    el.append(line);
    const sub = node('span', 'mx-sub');
    if (c.count) sub.append('p85 ', node('b', '', mxSpan(c.p85)), ` · p95 ${mxSpan(c.p95)}`);
    else sub.textContent = 'no cards done this period';
    el.append(sub, node('span', 'mx-foot', `queued → done · ${mxPlural(c.count, 'card')}`));
  });
}

function mxQualityTile() {
  return mxTile('quality', '', 'FIRST-PASS REVIEW', (el, q) => {
    const t = q.totals;
    if (!t.reviewed) {
      el.append(mxBig('—'), node('span', 'mx-sub', 'no reviews this period'));
      if (t.unreviewedDone) el.append(node('span', 'mx-foot', `${mxPlural(t.unreviewedDone, 'card')} done unreviewed`));
      return;
    }
    const passed = Math.round(t.firstPassRate * t.reviewed);
    el.append(
      mxBig(`${Math.round(t.firstPassRate * 100)}%`),
      node('span', 'mx-sub', `${passed} of ${t.reviewed} reviewed`),
      node('span', 'mx-foot', `${t.avgRounds.toFixed(2)} rounds avg · ${t.capped} capped`),
    );
  });
}

function mxForecastTile() {
  const p = mxFocusPhase();
  const kicker = p ? `${p.title.toUpperCase()} DONE BY` : 'PHASE DONE BY';
  return mxTile('forecast', '', kicker, (el, fc) => {
    if (mx.res.forecast.state === 'none' || !fc) {
      el.append(mxBig('—'), node('span', 'mx-sub', 'no active phase'), node('span', 'mx-foot', 'pick a phase to forecast it'));
      return;
    }
    if (fc.status !== 'ok') {
      el.append(
        node('span', 'mx-big mx-big-sm', 'Not enough history'),
        node('span', 'mx-sub', `${mxPlural(fc.have.done, 'card')} done over ${mxPlural(fc.have.days, 'day')}`),
        node('span', 'mx-foot', `needs ${fc.need.done} done over ${fc.need.days} days · ${fc.remaining} left`),
      );
      return;
    }
    if (fc.remaining === 0) {
      el.append(mxBig('Done', null, '', 'mx-big-md'), node('span', 'mx-sub', 'no cards left'));
      return;
    }
    el.append(
      mxBig(mxLongDay(fc.p85.date), null, '', 'mx-big-md'),
      node('span', 'mx-sub', '85% confidence'),
      node('span', 'mx-foot', `50%: ${mxLongDay(fc.p50.date)} · ${fc.remaining} left`),
    );
  });
}

function mxCostTile() {
  const p = mxFocusPhase();
  // the period cost follows the Phase filter; the budget line below is the focus phase's (named there)
  const phaseFilter = mx.f.phase ? mxPhaseById(mx.f.phase) : null;
  return mxTile('cost', '', phaseFilter ? `COST · ${phaseFilter.title.toUpperCase()}` : 'COST · all phases', (el, c) => {
    const line = node('span', 'mx-row');
    line.append(
      mxBig(mxMoney(c.totals.cost), c.byCard.length ? () => mxDrillCost(c) : null, `List the ${mxPlural(c.cardCount, 'card')} with cost this period`),
      node('span', 'mx-unit', 'this period'),
    );
    el.append(line);
    const budget = p ? c.budgets.find((b) => b.phase_id === p.id) : null;
    if (budget && budget.budget !== null) {
      const pct = budget.budget > 0 ? budget.actual / budget.budget : 1;
      el.append(node('span', 'mx-sub', `${p.title}: ${mxMoney(budget.actual)} of ${mxMoney(budget.budget)} budget`));
      const bar = node('span', 'mx-bar');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', `${Math.round(pct * 100)}% of budget used`);
      const fill = node('span', `mx-bar-fill${budget.overBudget ? ' over' : budget.projectedOverBudget ? ' warn' : ''}`);
      fill.style.width = `${Math.min(100, pct * 100)}%`;
      bar.append(fill);
      el.append(bar);
    } else el.append(node('span', 'mx-sub', p ? `no budget set for ${p.title}` : `${mxPlural(c.totals.runs, 'run')} · ${mxPlural(c.totals.cards, 'card')}`));
    const burn = mx.res.usageBurn?.state === 'ok' ? mx.res.usageBurn.data : null;
    const msg = burn?.status === 'ok' ? mxBurnMessage(burn) : null;
    if (msg) {
      const warn = node('span', `mx-warn${msg.warn ? '' : ' calm'}`);
      warn.append(mxWarnIcon(), node('span', '', msg.text));
      el.append(warn);
    }
    const notes = mxCostNotes();
    if (notes.length) {
      const link = node('button', 'mx-notes-link', `ⓘ ${mxPlural(notes.length, 'note')}`);
      link.id = 'mx-notes-btn';
      link.type = 'button';
      link.setAttribute('aria-haspopup', 'dialog');
      link.setAttribute('aria-expanded', String(!!mx.notes));
      link.onclick = () => (mx.notes ? mx.notes.close() : mxOpenNotes());
      el.append(link);
    }
  });
}
// The usage-burn line for the tile, short as in the artboard ("Weekly limit Thu 1 Oct, before the 85% date"):
// a limit hit before the phase forecast first, then any hit / reached limit, else the first message as is.
// The full messages are in the cost tile's notes popover.
function mxBurnMessage(burn) {
  const reports = [burn.limits.seven_day, burn.limits.five_hour].filter(Boolean);
  const r =
    reports.find((x) => x.vsForecast === 'before_p50' || x.vsForecast === 'before_p85') ??
    reports.find((x) => x.state === 'reached' || x.state === 'at_risk' || x.state === 'projected') ??
    null;
  if (!r) return burn.messages[0] ? { text: burn.messages[0], warn: false } : null;
  const name = `${r.label[0].toUpperCase()}${r.label.slice(1)} limit`;
  if (r.state === 'reached') return { text: `${name} reached (${r.usedPct}%)`, warn: true };
  if (r.state === 'at_risk') return { text: `${name} being reached now`, warn: true };
  const day = mxLongDay(mxDayKey(r.hitsAt, mx.f.tz));
  const time = r.window === 'five_hour' ? `, ${new Date(r.hitsAt).toLocaleTimeString('en-GB', { timeZone: mx.f.tz, hour: '2-digit', minute: '2-digit' })}` : '';
  const vs = { before_p50: ', before the 50% date', before_p85: ', before the 85% date', after_p85: ', after the 85% date' }[r.vsForecast] ?? '';
  return { text: `${name} ${day}${time}${vs}`, warn: true };
}
function mxWarnIcon() {
  const svg = svgEl('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'aria-hidden': 'true' });
  for (const d of ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z']) svg.append(svgEl('path', { d }));
  return svg;
}
// The cost tile's notes: the API's caveats in plain language (unknown ones as sent), then the usage-limit messages.
function mxCostNotes() {
  const c = mx.res.cost?.state === 'ok' ? mx.res.cost.data : null;
  const burn = mx.res.usageBurn?.state === 'ok' ? mx.res.usageBurn.data : null;
  const notes = [];
  if (c) {
    const since = c.tokenBasisChangedAt === null ? null : mxShortDay(mxDayKey(c.tokenBasisChangedAt, mx.f.tz));
    if (c.prices.placeholder) notes.push({ group: 'Cost', text: 'Prices are placeholders: set your rates in Settings → Prices', prices: true });
    for (const raw of c.caveats) {
      let text = raw;
      if (raw.startsWith('output tokens come from transcripts')) text = 'Output tokens are undercounted, so costs read low';
      else if (raw.startsWith('estimated cost (')) text = since ? `Costs before ${since} are estimates` : 'These costs are estimates (no run has a token breakdown yet)';
      else if (raw.startsWith('totals.tokens and estimated.tokens include')) text = since ? `Token totals before ${since} are roughly double-counted` : 'Token totals are roughly double-counted';
      notes.push({ group: 'Cost', text, raw });
    }
  }
  if (burn?.status === 'ok') for (const m of burn.messages) notes.push({ group: 'Usage limits', text: m });
  return notes;
}

// The notes popover: mounted on the view (tiles re-render under it), Esc / outside click closes, focus returns.
function mxOpenNotes() {
  mx.notes?.close();
  const btn = $('mx-notes-btn');
  if (!btn) return;
  const pop = node('div', 'mx-notes');
  pop.id = 'mx-notes';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Cost notes');
  let group = null;
  let ul = null;
  for (const n of mxCostNotes()) {
    if (n.group !== group) {
      group = n.group;
      ul = node('ul');
      pop.append(node('span', 'mx-notes-h', group), ul);
    }
    const li = node('li', '', n.text);
    if (n.raw && n.raw !== n.text) li.title = n.raw;
    if (n.prices) {
      // "Settings → Prices" opens that Settings tab
      const go = node('button', 'mx-link mx-inline', 'Settings → Prices');
      go.type = 'button';
      go.onclick = () => {
        api.close(false);
        openSettings('prices');
      };
      li.replaceChildren('Prices are placeholders: set your rates in ', go);
    }
    ul.append(li);
  }
  const close = node('button', 'mx-link', 'Close');
  close.type = 'button';
  pop.append(close);
  const r = btn.getBoundingClientRect();
  const host = metricsView.getBoundingClientRect();
  pop.style.top = `${r.bottom - host.top + 6}px`;
  pop.style.right = `${Math.max(8, host.right - r.right)}px`;
  metricsView.append(pop);
  btn.setAttribute('aria-expanded', 'true');
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    api.close();
  };
  const onDown = (e) => {
    if (!pop.contains(e.target) && e.target.id !== 'mx-notes-btn') api.close(false);
  };
  const api = {
    close(refocus = true) {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      pop.remove();
      if (mx.notes === api) mx.notes = null;
      const b = $('mx-notes-btn'); // the tile may have re-rendered: the current button
      b?.setAttribute('aria-expanded', 'false');
      if (refocus) b?.focus();
    },
  };
  close.onclick = () => api.close();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  mx.notes = api;
  close.focus();
}

// ---------- cumulative flow ----------
function mxRenderCfd(host) {
  const head = node('div', 'mx-panel-head');
  head.append(node('h2', '', 'Cumulative flow'), node('span', 'mx-panel-sub', 'cards per lane, end of each day'), node('div', 'mx-grow'));
  const legend = node('div', 'mx-legend');
  for (const l of [...MX_LANES].reverse()) {
    const s = node('span', 'mx-lg');
    const sw = node('span', `mx-sw${l.lane === 'in_review' ? ' hatch' : ''}`);
    if (l.lane !== 'in_review') sw.style.background = l.fill;
    s.append(sw, l.name);
    legend.append(s);
  }
  head.append(legend);
  host.append(head);
  const r = mx.res.flow;
  const flow = r?.state === 'ok' ? r.data : null;
  const state = mxChartState('flow', flow && !flow.cfd.some((d) => MX_LANES.some((l) => d[l.lane])) ? 'No cards on the board in this period' : null);
  if (state) return host.append(state);

  const days = flow.cfd;
  const W = Math.max(420, host.clientWidth - 32);
  const H = 360;
  const box = { L: 44, R: W - 110, T: 24, B: H - 38 };
  const stacks = days.map((d) => {
    let acc = 0;
    return MX_LANES.map((l) => (acc += d[l.lane]));
  });
  const max = Math.max(1, ...stacks.map((s) => s[s.length - 1]));
  const ticks = mxNiceTicks(max);
  const yMax = ticks[ticks.length - 1];
  const n = days.length;
  const x = (i) => (n === 1 ? box.L + (i ? box.R - box.L : 0) : box.L + (i * (box.R - box.L)) / (n - 1));
  const y = (v) => box.B - (v * (box.B - box.T)) / yMax;
  const xs = n === 1 ? [0, 1] : days.map((_, i) => i); // one day: a flat band across
  const at = (i) => (n === 1 ? 0 : i);

  const wrap = node('div', 'mx-chart');
  wrap.style.width = `${W}px`;
  wrap.style.height = `${H}px`;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const last = days[n - 1];
  svg.setAttribute(
    'aria-label',
    `Cumulative flow, ${mxShortDay(days[0].date)} to ${mxShortDay(last.date)}. At the end: ${MX_LANES.map((l) => `${l.name} ${last[l.lane]}`).join(', ')}.`,
  );
  const defs = svgEl('defs');
  defs.append(mxHatch('mx-hatch-review', '#e5c07b', '#b89659'));
  svg.append(defs);
  const labels = mxGrid(svg, box, ticks, y, 36);
  MX_LANES.forEach((l, li) => {
    const top = xs.map((i) => `${x(i).toFixed(1)},${y(stacks[at(i)][li]).toFixed(1)}`);
    const bot = xs.map((i) => `${x(i).toFixed(1)},${y(li ? stacks[at(i)][li - 1] : 0).toFixed(1)}`).reverse();
    const path = svgEl('path', { d: `M${top.concat(bot).join(' L')} Z`, fill: l.fill, stroke: '#0f1219', 'stroke-width': 2, 'stroke-linejoin': 'round' });
    path.dataset.lane = l.lane;
    svg.append(path);
  });
  // x labels: Mondays (every k-th when there are many), else the first day
  const mondays = days.map((d, i) => [d.date, i]).filter(([d]) => mxUtc(d).getUTCDay() === 1);
  const xl = mondays.length ? mondays : [[days[0].date, 0]];
  const step = Math.max(1, Math.ceil(xl.length / Math.max(2, Math.floor((box.R - box.L) / 80))));
  for (const [d, i] of xl.filter((_, k) => k % step === 0)) {
    const s = node('span', 'mx-axis-x', mxShortDay(d));
    s.style.left = `${(x(i) - 30).toFixed(1)}px`;
    s.style.top = `${box.B + 10}px`;
    labels.push(s);
  }
  // band labels at the right edge, pushed apart so they never overlap
  const end = stacks[n - 1];
  const want = MX_LANES.map((l, li) => ({ l, y: y(((li ? end[li - 1] : 0) + end[li]) / 2) - 8 })).reverse(); // top band first
  let prev = -Infinity;
  for (const w of want) {
    w.y = Math.max(w.y, prev + 16);
    prev = w.y;
  }
  const over = prev - (box.B - 8);
  for (const w of want) {
    if (over > 0) w.y -= over;
    const s = node('span', 'mx-band-label', `${w.l.name} ${last[w.l.lane]}`);
    s.style.left = `${box.R + 10}px`;
    s.style.top = `${w.y.toFixed(1)}px`;
    labels.push(s);
  }
  // hover: nearest day → a rule + a tooltip with every lane
  const rule = svgEl('path', { d: '', stroke: '#e8eaf0', 'stroke-width': 1, fill: 'none', 'pointer-events': 'none' });
  const hit = svgEl('rect', { x: box.L, y: box.T, width: box.R - box.L, height: box.B - box.T, fill: 'transparent' });
  svg.append(rule, hit);
  const tip = node('div', 'mx-tip hidden');
  tip.setAttribute('role', 'tooltip');
  const show = (i) => {
    const hx = x(i);
    rule.setAttribute('d', `M${hx.toFixed(1)},${box.T} V${box.B}`);
    const d = days[i];
    tip.replaceChildren(node('span', 'mx-tip-h', mxLongDay(d.date)));
    for (const l of [...MX_LANES].reverse()) {
      const row = node('span', 'mx-tip-row');
      const sw = node('span', `mx-sw sm${l.lane === 'in_review' ? ' hatch' : ''}`);
      if (l.lane !== 'in_review') sw.style.background = l.fill;
      row.append(sw, node('span', 'mx-grow', l.name), node('b', '', d[l.lane]));
      tip.append(row);
    }
    tip.classList.remove('hidden');
    tip.style.left = `${(hx + 12 + 184 > box.R ? hx - 196 : hx + 12).toFixed(1)}px`;
    tip.style.top = `${box.T + 30}px`;
  };
  hit.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) * W) / rect.width;
    show(n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((px - box.L) / (box.R - box.L)) * (n - 1)))));
  });
  hit.addEventListener('mouseleave', () => {
    rule.setAttribute('d', '');
    tip.classList.add('hidden');
  });
  wrap.append(svg, ...labels, tip);
  host.append(wrap);
}

// ---------- weekly throughput ----------
function mxRenderThroughput(host) {
  const head = node('div', 'mx-panel-head');
  head.append(node('h2', '', 'Throughput'), node('span', 'mx-panel-sub', 'cards done per week'));
  host.append(head);
  const r = mx.res.flow;
  const flow = r?.state === 'ok' ? r.data : null;
  const state = mxChartState('flow', flow && !flow.throughput.total ? 'No cards done in this period' : null);
  if (state) return host.append(state);

  const weeks = mxWeeks(flow);
  const { avg, weeks: full } = mxAvgWeeks(weeks);
  const W = Math.max(300, host.clientWidth - 32);
  const H = 360;
  const box = { L: 34, R: W - 8, T: 24, B: H - 38 };
  const max = Math.max(1, ...weeks.map((w) => w.count), avg ?? 0);
  const ticks = mxNiceTicks(max);
  const yMax = ticks[ticks.length - 1];
  const y = (v) => box.B - (v * (box.B - box.T)) / yMax;
  const slot = (box.R - box.L) / weeks.length;
  const pad = Math.min(8, slot * 0.15);
  const bw = Math.max(2, slot - 2 * pad);

  const wrap = node('div', 'mx-chart');
  wrap.style.width = `${W}px`;
  wrap.style.height = `${H}px`;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
  svg.setAttribute(
    'aria-label',
    `Throughput per week: ${weeks.map((w) => `${w.count}${w.partial ? ' (partial week)' : ''}`).join(', ')}.${avg !== null ? ` Average ${mxNum(avg)} over the last ${mxPlural(full.length, 'complete week')}.` : ''}`,
  );
  const defs = svgEl('defs');
  defs.append(mxHatch('mx-hatch-tp', 'rgba(93,211,168,0.16)', 'rgba(93,211,168,0.55)'));
  svg.append(defs);
  const labels = mxGrid(svg, box, ticks, y, 26);
  const tip = node('div', 'mx-tip mx-tip-sm hidden');
  tip.setAttribute('role', 'tooltip');
  const peak = weeks.reduce((best, w, i) => (!w.partial && w.count > (best === null ? -1 : weeks[best].count) ? i : best), null);
  const labelEvery = Math.max(1, Math.ceil(weeks.length / Math.max(2, Math.floor((box.R - box.L) / 44))));
  weeks.forEach((w, i) => {
    const x0 = box.L + i * slot + pad;
    const yt = y(w.count);
    const rr = Math.min(4, bw / 2, box.B - yt);
    const d =
      w.count > 0
        ? `M${x0.toFixed(1)},${box.B} V${(yt + rr).toFixed(1)} Q${x0.toFixed(1)},${yt.toFixed(1)} ${(x0 + rr).toFixed(1)},${yt.toFixed(1)} H${(x0 + bw - rr).toFixed(1)} Q${(x0 + bw).toFixed(1)},${yt.toFixed(1)} ${(x0 + bw).toFixed(1)},${(yt + rr).toFixed(1)} V${box.B} Z`
        : `M${x0.toFixed(1)},${box.B - 1} H${(x0 + bw).toFixed(1)}`;
    const bar = svgEl('path', w.partial ? { d, fill: 'url(#mx-hatch-tp)', stroke: '#5dd3a8', 'stroke-width': 1.5 } : { d, fill: w.count ? '#5dd3a8' : 'none', stroke: w.count ? 'none' : 'rgba(255,255,255,0.2)' });
    bar.classList.add('mx-bar-rect');
    bar.dataset.week = w.start;
    const range = `${mxShortDay(w.start)} – ${mxShortDay(w.end)}`;
    const text = `Week of ${mxShortDay(w.start)}: ${w.count} done${w.partial ? ' so far (partial week)' : ''}`;
    const pts = w.count ? mxPointsIn(flow, w.start, w.end) : [];
    // the whole slot is the hit area, so short bars are easy to click
    const hitArea = svgEl('rect', { x: (box.L + i * slot).toFixed(1), y: box.T, width: slot.toFixed(1), height: box.B - box.T, fill: 'transparent', class: 'mx-bar-hit' });
    hitArea.dataset.week = w.start;
    const on = () => {
      bar.classList.add('hover');
      tip.textContent = pts.length ? `${text} · click to list` : text;
      tip.classList.remove('hidden');
      tip.style.left = `${Math.min(W - 190, Math.max(0, x0 + bw / 2 - 90)).toFixed(1)}px`;
      tip.style.top = `${Math.max(0, yt - 52).toFixed(1)}px`;
    };
    const off = () => {
      bar.classList.remove('hover');
      tip.classList.add('hidden');
    };
    hitArea.addEventListener('mouseenter', on);
    hitArea.addEventListener('mouseleave', off);
    hitArea.addEventListener('focus', on);
    hitArea.addEventListener('blur', off);
    if (pts.length) {
      hitArea.setAttribute('tabindex', '0');
      hitArea.setAttribute('role', 'button');
      hitArea.setAttribute('aria-label', `${text}. List the cards.`);
      const open = () => mxDrillDone(pts, `THROUGHPUT · WEEK OF ${mxShortDay(w.start).toUpperCase()}`, range);
      hitArea.addEventListener('click', open);
      hitArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
      hitArea.style.cursor = 'pointer';
    }
    svg.append(bar);
    svg.append(hitArea);
    if (i % labelEvery === 0) {
      const s = node('span', 'mx-axis-x mx-axis-x-sm', `${mxUtc(w.start).getUTCDate()}/${mxUtc(w.start).getUTCMonth() + 1}`);
      s.style.left = `${(box.L + i * slot + slot / 2 - 24).toFixed(1)}px`;
      s.style.top = `${box.B + 10}px`;
      labels.push(s);
    }
    const value = w.partial ? (w === weeks[weeks.length - 1] ? `${w.count} so far` : null) : i === peak ? String(w.count) : null;
    if (value) {
      const s = node('span', `mx-bar-label${w.partial ? ' dim' : ''}`, value);
      s.style.left = `${(x0 + bw / 2 - 30).toFixed(1)}px`;
      s.style.top = `${(yt - 20).toFixed(1)}px`;
      labels.push(s);
    }
  });
  if (avg !== null) {
    svg.append(svgEl('path', { d: `M${box.L},${y(avg).toFixed(1)} H${box.R}`, stroke: '#e8eaf0', 'stroke-width': 1, 'stroke-dasharray': '4 4', fill: 'none', 'pointer-events': 'none', class: 'mx-avg' }));
    const s = node('span', 'mx-avg-label', `avg ${mxNum(avg)} (${full.length}w)`);
    s.style.left = `${box.L + 6}px`;
    s.style.top = `${(y(avg) - 20).toFixed(1)}px`;
    labels.push(s);
  }
  wrap.append(svg, ...labels, tip);
  host.append(wrap);
}

// ---------- shared: board marks, toggles ----------
const MX_SHAPES = ['square', 'circle', 'triangle', 'diamond'];
function mxShapeD(shape, cx, cy) {
  const f = (n) => n.toFixed(1);
  if (shape === 'square') return `M${f(cx - 4.5)},${f(cy - 4.5)} h9 v9 h-9 Z`;
  if (shape === 'circle') return `M${f(cx - 5)},${f(cy)} a5,5 0 1,0 10,0 a5,5 0 1,0 -10,0 Z`;
  if (shape === 'triangle') return `M${f(cx)},${f(cy - 5.5)} L${f(cx + 5.5)},${f(cy + 4.5)} L${f(cx - 5.5)},${f(cy + 4.5)} Z`;
  return `M${f(cx)},${f(cy - 6)} L${f(cx + 6)},${f(cy)} L${f(cx)},${f(cy + 6)} L${f(cx - 6)},${f(cy)} Z`;
}
// A board's mark: its colour, and a shape by board order (Main square, then circle, triangle, diamond…).
function mxBoardMark(id) {
  const m = mx.meta;
  const i = m ? m.boards.findIndex((b) => b.id === id) : -1;
  return {
    color: i >= 0 ? m.boards[i].color : PL_NONE_COLOR,
    shape: MX_SHAPES[Math.max(0, i) % MX_SHAPES.length],
    label: i >= 0 ? m.boards[i].label : 'unknown board',
  };
}
function mxShapeIcon(mark) {
  const svg = svgEl('svg', { width: 10, height: 10, viewBox: '-6 -6 12 12', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: mxShapeD(mark.shape, 0, 0), fill: mark.color }));
  return svg;
}
// A small segmented toggle (Cycle / Lead, By board / By phase).
function mxToggle(label, options, value, onChange) {
  const g = node('div', 'mx-seg mx-seg-sm');
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', label);
  for (const [id, text] of options) {
    const b = node('button', 'mx-seg-btn', text);
    b.type = 'button';
    b.dataset.value = id;
    b.setAttribute('aria-pressed', String(id === value));
    b.onclick = () => id !== value && onChange(id);
    g.append(b);
  }
  return g;
}
function mxPanel(cls, label) {
  const el = node('section', `mx-panel ${cls}`);
  el.setAttribute('aria-label', label);
  return el;
}
function mxInfoIcon() {
  const svg = svgEl('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: 12, cy: 12, r: 9 }), svgEl('path', { d: 'M12 11v6' }), svgEl('path', { d: 'M12 7.5h.01' }));
  return svg;
}
// Labels at the chart's right edge (or anywhere in a column), pushed apart so they never overlap.
function mxSpread(items, gap, maxY) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  let prev = -Infinity;
  for (const it of sorted) {
    it.y = Math.max(it.y, prev + gap);
    prev = it.y;
  }
  const over = prev - maxY;
  if (over > 0) for (const it of sorted) it.y -= over;
  return items;
}
// Show a tooltip beside (x, y) inside a W-wide chart.
function mxPlaceTip(tip, x, y, W, width) {
  tip.classList.remove('hidden');
  tip.style.left = `${(x + 14 + width > W ? x - 14 - width : x + 14).toFixed(1)}px`;
  tip.style.top = `${Math.max(0, y - 30).toFixed(1)}px`;
}

// ---------- Flow ----------
function mxRenderFlow(host) {
  const row = node('div', 'mx-charts');
  const sc = mxPanel('mx-scatter', mx.ui.measure === 'lead' ? 'Lead time per card' : 'Cycle time per card');
  const bu = mxPanel('mx-burn', 'Phase burn-up');
  row.append(sc, bu);
  host.replaceChildren(row);
  mxRenderScatter(sc);
  mxRenderBurn(bu);
}

// Log-axis ticks, in hours.
const MX_LOG_TICKS = [
  [1 / 60, '1m'],
  [2 / 60, '2m'],
  [1 / 12, '5m'],
  [0.25, '15m'],
  [0.5, '30m'],
  [1, '1h'],
  [2, '2h'],
  [4, '4h'],
  [12, '12h'],
  [24, '1d'],
  [72, '3d'],
  [168, '1w'],
  [336, '2w'],
  [672, '4w'],
  [1344, '8w'],
];

function mxRenderScatter(host) {
  const measure = mx.ui.measure;
  const lead = measure === 'lead';
  const head = node('div', 'mx-panel-head');
  head.append(
    node('h2', '', lead ? 'Lead time per card' : 'Cycle time per card'),
    node('span', 'mx-panel-sub', `${lead ? 'created → done' : 'queued → done'} · log scale`),
    node('div', 'mx-grow'),
    mxToggle('Measure', [['cycle', 'Cycle'], ['lead', 'Lead']], measure, (v) => {
      mx.ui.measure = v;
      mxRenderBody();
    }),
  );
  host.append(head);
  const r = mx.res.flow;
  const flow = r?.state === 'ok' ? r.data : null;
  const state = mxChartState('flow', flow && !flow.points.length ? 'No cards done in this period' : null);
  if (state) return host.append(state);

  const pts = flow.points;
  const ms = (p) => (lead ? p.leadTimeMs : p.cycleTimeMs);
  const pc = lead ? flow.leadTime : flow.cycleTime;
  const kicker = lead ? 'LEAD TIME' : 'CYCLE TIME';
  // legend: every board in scope, and the card count (a drill-down to them all)
  const legend = node('div', 'mx-legend');
  for (const b of mxScopeBoards()) {
    const s = node('span', 'mx-lg');
    s.append(mxShapeIcon(mxBoardMark(b.id)), b.label);
    legend.append(s);
  }
  legend.append(node('div', 'mx-grow'));
  const all = node('button', 'mx-link mx-count', `${mxPlural(pts.length, 'card')} · ${mxWindowLabel()}`);
  all.type = 'button';
  all.setAttribute('aria-label', `List the ${mxPlural(pts.length, 'card')} done this period`);
  all.onclick = () => mxDrillDone(pts, `${kicker} · THIS PERIOD`, mxWindowLabel(), measure);
  legend.append(all);
  host.append(legend);

  const W = Math.max(420, host.clientWidth - 32);
  const H = 460;
  const box = { L: 48, R: W - 84, T: 12, B: H - 40 };
  const tz = mx.f.tz;
  // x: one column per local day of the window; y: hours on a log scale (≥ 1 minute)
  const first = mxDayKey(flow.range.from, tz);
  const last = mxDayKey(flow.range.to, tz);
  const dayIdx = (day) => Math.round((mxUtc(day) - mxUtc(first)) / 86_400_000);
  const nDays = dayIdx(last) + 1;
  const dayW = (box.R - box.L) / nDays;
  const xDay = (i) => box.L + (i + 0.5) * dayW;
  const hrs = (v) => Math.max(1 / 60, v / 3_600_000);
  const vals = pts.map((p) => hrs(ms(p)));
  const pcts = [pc.p50, pc.p85, pc.p95].filter((v) => v !== null).map(hrs);
  const lo = Math.log(Math.min(...vals, ...pcts) / 1.5);
  const hi = Math.log(Math.max(...vals, ...pcts) * 1.5);
  const y = (h) => box.B - ((Math.log(h) - lo) * (box.B - box.T)) / Math.max(1e-9, hi - lo);
  let ticks = MX_LOG_TICKS.filter(([h]) => Math.log(h) >= lo && Math.log(h) <= hi);
  while (ticks.length > 6) ticks = ticks.filter((_, i) => i % 2 === 0);
  // a narrow range (every card about the same time): two ticks from the data range itself
  if (ticks.length < 2) ticks = [0.25, 0.75].map((k) => Math.exp(lo + k * (hi - lo))).map((h) => [h, mxSpan(h * 3_600_000)]);

  const wrap = node('div', 'mx-chart');
  wrap.style.width = `${W}px`;
  wrap.style.height = `${H}px`;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
  svg.setAttribute(
    'aria-label',
    `Scatter of ${measure} time per card by done date, ${mxPlural(pts.length, 'card')}. Median ${mxSpan(pc.p50)}, 85th percentile ${mxSpan(pc.p85)}, 95th percentile ${mxSpan(pc.p95)}.`,
  );
  const labels = [];
  svg.append(svgEl('path', { d: ticks.map(([h]) => `M${box.L},${y(h).toFixed(1)} H${box.R}`).join(' '), stroke: 'rgba(255,255,255,0.06)', 'stroke-width': 1, fill: 'none' }));
  for (const [h, text] of ticks) {
    const l = node('span', 'mx-axis-y', text);
    l.style.top = `${(y(h) - 8).toFixed(1)}px`;
    l.style.width = '40px';
    labels.push(l);
  }
  // percentile lines (the API's), labelled at the right edge
  const lines = [
    ['50', pc.p50, '#e8eaf0', '#e8eaf0'],
    ['85', pc.p85, '#e5c07b', '#e5c07b'],
    ['95', pc.p95, '#e06c75', '#f0a0a7'],
  ].filter(([, v]) => v !== null);
  const pctLabels = lines.map(([p, v, , text]) => ({ p, v, text, y: y(hrs(v)) - 9 }));
  for (const [p, v, stroke] of [...lines].reverse()) {
    const line = svgEl('path', { d: `M${box.L},${y(hrs(v)).toFixed(1)} H${box.R}`, stroke, 'stroke-width': 1.5, 'stroke-dasharray': '5 4', fill: 'none', class: 'mx-pct' });
    line.dataset.p = p;
    svg.append(line);
  }
  for (const l of mxSpread(pctLabels, 16, box.B - 8)) {
    const s = node('span', 'mx-pct-label', `p${l.p} ${mxSpan(l.v)}`);
    s.dataset.p = l.p;
    s.style.color = l.text;
    s.style.left = `${box.R + 6}px`;
    s.style.top = `${l.y.toFixed(1)}px`;
    labels.push(s);
  }
  // x labels: Mondays (every k-th when there are many), else the first day
  const days = Array.from({ length: nDays }, (_, i) => mxAddDays(first, i));
  const mondays = days.map((d, i) => [d, i]).filter(([d]) => mxUtc(d).getUTCDay() === 1);
  const xl = mondays.length ? mondays : [[first, 0]];
  const step = Math.max(1, Math.ceil(xl.length / Math.max(2, Math.floor((box.R - box.L) / 80))));
  for (const [d, i] of xl.filter((_, k) => k % step === 0)) {
    const s = node('span', 'mx-axis-x', mxShortDay(d));
    s.style.left = `${(xDay(i) - 30).toFixed(1)}px`;
    s.style.top = `${box.B + 12}px`;
    labels.push(s);
  }
  // points: same-day cards side by side within their day column
  const byDay = new Map();
  for (const p of pts) {
    const d = mxDayKey(p.doneAt, tz);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(p);
  }
  const ring = svgEl('circle', { cx: -20, cy: -20, r: 9, fill: 'none', stroke: '#e8eaf0', 'stroke-width': 2, 'pointer-events': 'none', visibility: 'hidden' });
  const tip = node('div', 'mx-tip mx-tip-card hidden');
  tip.setAttribute('role', 'tooltip');
  for (const [d, list] of byDay) {
    const spread = Math.min(8, (dayW * 0.7) / Math.max(1, list.length));
    list.forEach((p, k) => {
      const cx = xDay(dayIdx(d)) + (k - (list.length - 1) / 2) * spread;
      const cy = y(hrs(ms(p)));
      const board = mxBoardOf(p.id);
      const mark = mxBoardMark(board);
      const el = svgEl('path', { d: mxShapeD(mark.shape, cx, cy), fill: mark.color, stroke: '#0f1219', 'stroke-width': 1.5, class: 'mx-pt' });
      el.dataset.id = p.id;
      el.dataset.board = board ?? '';
      el.dataset.shape = mark.shape;
      el.style.cursor = 'pointer';
      el.addEventListener('mouseenter', () => {
        ring.setAttribute('cx', cx.toFixed(1));
        ring.setAttribute('cy', cy.toFixed(1));
        ring.setAttribute('visibility', 'visible');
        const rounds = mx.meta?.cards.get(p.id)?.rounds;
        tip.replaceChildren(
          node('span', 'mx-tip-h', p.title),
          node('span', 'mx-tip-row', `${mark.label} · ${mxAgentOf(p.id) ?? 'unassigned'} · done ${mxLongDay(d)}`),
          node('span', 'mx-tip-row mx-tip-hi', `cycle ${mxSpan(p.cycleTimeMs)} · lead ${mxSpan(p.leadTimeMs)}${rounds ? ` · ${mxPlural(rounds, 'review round')}` : ''}`),
        );
        mxPlaceTip(tip, cx, cy, box.R, 240);
      });
      el.addEventListener('mouseleave', () => {
        ring.setAttribute('visibility', 'hidden');
        tip.classList.add('hidden');
      });
      el.addEventListener('click', () => mxDrillDone(list, `${kicker} · ${mxLongDay(d).toUpperCase()}`, mxLongDay(d), measure));
      svg.append(el);
    });
  }
  svg.append(ring);
  wrap.append(svg, ...labels, tip);
  host.append(wrap);
}

// Burn-up of the focus phase: stepped scope, done area, and the 50–85% forecast cone.
function mxRenderBurn(host) {
  const p = mxFocusPhase();
  const head = node('div', 'mx-panel-head');
  head.append(node('h2', '', p ? `Burn-up · ${p.title}` : 'Burn-up'));
  host.append(head);
  if (p && (mx.f.tag || mx.f.agent)) {
    const note = node('p', 'mx-note mx-filter-note');
    note.append(mxInfoIcon(), node('span', '', "Burn-up covers the whole phase; Tag and Agent filters don't apply."));
    host.append(note);
  }
  const r = mx.res.burn ?? { state: 'loading' };
  if (r.state === 'none') return host.append(node('div', 'mx-chart-state', 'No active phase: pick a phase to see its burn-up'));
  const burn = r.state === 'ok' ? r.data : null;
  const state = mxChartState('burn', burn && !burn.scope ? 'No cards in this phase yet' : null);
  if (state) return host.append(state);

  const fr = mx.res.burnForecast;
  const fcData = fr?.state === 'ok' ? fr.data : null;
  const active = burn.phase.status !== 'done';
  const fc = active && fcData?.status === 'ok' && fcData.remaining > 0 ? fcData : null;
  const legend = node('div', 'mx-legend');
  const lg = (sw, text) => {
    const s = node('span', 'mx-lg');
    s.append(sw, text);
    return s;
  };
  legend.append(lg(node('span', 'mx-sw-line'), 'Scope'), lg(node('span', 'mx-sw mx-sw-done'), 'Done'));
  if (fc) legend.append(lg(node('span', 'mx-sw mx-sw-cone'), 'Forecast 50–85%'));
  else if (active && fcData && fcData.status !== 'ok') legend.append(node('span', 'mx-dim mx-sm', 'no forecast yet: not enough history'));
  host.append(legend);

  const s = burn.series;
  const start = s[0].date;
  const idx = (day) => Math.round((mxUtc(day) - mxUtc(start)) / 86_400_000);
  const lastIdx = s.length - 1;
  const n = Math.max(lastIdx, fc ? idx(fc.p85.date) + 1 : 0) + 1; // room past the 85% date
  const W = Math.max(320, host.clientWidth - 32);
  const H = 420;
  const box = { L: 36, R: W - 20, T: 24, B: H - 40 };
  const x = (i) => box.L + (i * (box.R - box.L)) / Math.max(1, n - 1);
  const ticks = mxNiceTicks(Math.max(...s.map((d) => d.scope)));
  const yMax = ticks[ticks.length - 1];
  const y = (v) => box.B - (v * (box.B - box.T)) / yMax;
  const f = (v) => v.toFixed(1);

  const wrap = node('div', 'mx-chart');
  wrap.style.width = `${W}px`;
  wrap.style.height = `${H}px`;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
  svg.setAttribute(
    'aria-label',
    `Burn-up for ${burn.phase.title} from ${mxShortDay(start)}. Scope ${mxPlural(burn.scope, 'card')}; ${burn.done} done.${fc ? ` Forecast: all done by ${mxLongDay(fc.p50.date)} at 50% and ${mxLongDay(fc.p85.date)} at 85%.` : ''}`,
  );
  const labels = mxGrid(svg, box, ticks, y, 28);
  const today = s[lastIdx];
  if (fc) {
    const cone = svgEl('path', {
      d: `M${f(x(lastIdx))},${f(y(today.done))} L${f(x(idx(fc.p50.date)))},${f(y(burn.scope))} L${f(x(idx(fc.p85.date)))},${f(y(burn.scope))} Z`,
      fill: 'rgba(93,211,168,0.18)',
      class: 'mx-cone',
    });
    svg.append(cone);
  }
  const doneLine = s.map((d, i) => `${f(x(i))},${f(y(d.done))}`);
  svg.append(
    svgEl('path', { d: `M${doneLine.join(' L')} L${f(x(lastIdx))},${box.B} L${f(x(0))},${box.B} Z`, fill: '#2e5c50', class: 'mx-done-area' }),
    svgEl('path', { d: `M${doneLine.join(' L')}`, fill: 'none', stroke: '#5dd3a8', 'stroke-width': 2, 'stroke-linejoin': 'round' }),
  );
  if (fc)
    for (const [pt, dash] of [
      [fc.p50, '4 4'],
      [fc.p85, '2 4'],
    ])
      svg.append(svgEl('path', { d: `M${f(x(lastIdx))},${f(y(today.done))} L${f(x(idx(pt.date)))},${f(y(burn.scope))}`, fill: 'none', stroke: '#5dd3a8', 'stroke-width': 1.5, 'stroke-dasharray': dash }));
  let scopeD = `M${f(x(0))},${f(y(s[0].scope))}`;
  for (let i = 1; i <= lastIdx; i++) scopeD += ` H${f(x(i))} V${f(y(s[i].scope))}`;
  scopeD += ` H${f(x(n - 1))}`;
  svg.append(svgEl('path', { d: scopeD, fill: 'none', stroke: '#e8eaf0', 'stroke-width': 2, 'stroke-linejoin': 'round', class: 'mx-scope' }));
  if (active) {
    svg.append(svgEl('path', { d: `M${f(x(lastIdx))},${box.T} V${box.B}`, stroke: '#aab2c5', 'stroke-width': 1, fill: 'none' }));
    const t = node('span', 'mx-axis-x mx-axis-note', 'today');
    t.style.left = `${f(x(lastIdx) - 30)}px`;
    t.style.top = `${box.T - 22}px`;
    labels.push(t);
  }
  if (fc) {
    const my = y(burn.scope);
    for (const [pt, pct, fill, dy] of [
      [fc.p50, '50%', '#5dd3a8', 12],
      [fc.p85, '85%', '#0f1219', -44],
    ]) {
      const mxX = x(idx(pt.date));
      const c = svgEl('circle', { cx: f(mxX), cy: f(my), r: 5, fill, stroke: fill === '#0f1219' ? '#5dd3a8' : '#0f1219', 'stroke-width': 2, class: 'mx-marker' });
      c.dataset.p = pct.slice(0, 2);
      c.dataset.date = pt.date;
      svg.append(c);
      const l = node('span', 'mx-marker-label');
      l.dataset.p = pct.slice(0, 2);
      l.append(node('span', '', pct), node('span', '', mxLongDay(pt.date)));
      l.style.left = `${f(Math.min(W - 92, mxX - 45))}px`;
      l.style.top = `${f(Math.max(0, my + dy))}px`;
      labels.push(l);
    }
  }
  // labels just left of today: the scope above its line, the done count inside the done area
  const sl = node('span', 'mx-burn-label', `scope ${today.scope}`);
  sl.style.left = `${f(Math.max(box.L, x(lastIdx) - 78))}px`;
  sl.style.top = `${f(Math.max(0, y(today.scope) - 20))}px`;
  const dl = node('span', 'mx-burn-label done', `${today.done} done`);
  dl.style.left = `${f(Math.max(box.L, x(lastIdx) - 78))}px`;
  dl.style.top = `${f(Math.min(box.B - 20, y(today.done) + 26))}px`;
  labels.push(sl, dl);
  // x labels: Mondays across the phase + forecast days, else the first day
  const days = Array.from({ length: n }, (_, i) => mxAddDays(start, i));
  const mondays = days.map((d, i) => [d, i]).filter(([d]) => mxUtc(d).getUTCDay() === 1);
  const xl = mondays.length ? mondays : [[start, 0]];
  const step = Math.max(1, Math.ceil(xl.length / Math.max(2, Math.floor((box.R - box.L) / 70))));
  for (const [d, i] of xl.filter((_, k) => k % step === 0)) {
    const l = node('span', 'mx-axis-x', mxShortDay(d));
    l.style.left = `${f(x(i) - 30)}px`;
    l.style.top = `${box.B + 12}px`;
    labels.push(l);
  }
  wrap.append(svg, ...labels);
  host.append(wrap);
  const a = burn.approximated;
  const note = node('p', 'mx-note');
  note.append(
    mxInfoIcon(),
    node(
      'span',
      '',
      `Scope is today's cards in the phase.${a ? ` ${mxPlural(a, 'card')} joined the phase after it was created, so ${a === 1 ? 'its join date is' : 'their join dates are'} estimated.` : ''} Cards moved out of the phase don't show.`,
    ),
  );
  host.append(note);
}

// ---------- Quality & waiting ----------
function mxRenderQuality(host) {
  const row = node('div', 'mx-charts');
  const left = node('div', 'mx-col mx-col-l');
  const right = node('div', 'mx-col mx-col-r');
  const weekly = mxPanel('mx-qweeks', 'Review quality by week');
  const agents = mxPanel('mx-agents', 'Review quality by agent');
  const now = mxPanel('mx-waiting', 'Waiting on you now');
  const time = mxPanel('mx-waittime', 'Time waiting on you');
  left.append(weekly, agents);
  right.append(now, time);
  row.append(left, right);
  host.replaceChildren(row);
  mxRenderQualityWeeks(weekly);
  mxRenderAgents(agents);
  mxRenderWaitingNow(now);
  mxRenderWaitTime(time);
}

function mxRenderQualityWeeks(host) {
  const head = node('div', 'mx-panel-head');
  head.append(node('h2', '', 'Review quality by week'), node('span', 'mx-panel-sub', 'by week of each card’s final review'));
  host.append(head);
  const r = mx.res.quality;
  const q = r?.state === 'ok' ? r.data : null;
  const state = mxChartState('quality', q && !q.totals.reviewed ? 'No reviews in this period' : null);
  if (state) return host.append(state);
  const t = q.totals;
  const weeks = q.weekly;
  const W = Math.max(240, host.clientWidth - 32 - 136);
  const box = { L: 42, R: W - 8 };
  const slot = (box.R - box.L) / weeks.length;
  const x = (i) => box.L + slot * (i + 0.5);
  const fp = weeks.map((w) => (w.firstPassRate === null ? null : w.firstPassRate * 100));
  const ar = weeks.map((w) => w.avgRounds);
  const fpLo = fp.some((v) => v !== null && v < 50) ? 0 : 50;
  const arHi = Math.max(2, Math.ceil(Math.max(...ar.filter((v) => v !== null))));
  const passed = Math.round(t.firstPassRate * t.reviewed);
  host.append(
    mxQualityRow('fp', 'FIRST-PASS', `${Math.round(t.firstPassRate * 100)}%`, `${passed} of ${t.reviewed} reviewed`, {
      values: fp,
      ticks: [fpLo, (fpLo + 100) / 2, 100],
      fmt: (v) => `${Math.round(v)}%`,
      color: '#5dd3a8',
      tipText: (w, v) => `Week of ${mxShortDay(w.start)}: ${Math.round(v)}% first-pass · ${w.reviewed} reviewed`,
    }),
    mxQualityRow('ar', 'AVG ROUNDS', t.avgRounds.toFixed(2), t.capped ? `${t.capped} hit the 2-round cap` : 'none hit the 2-round cap', {
      values: ar,
      ticks: [1, (1 + arHi) / 2, arHi],
      fmt: (v) => v.toFixed(1),
      color: '#aab2c5',
      tipText: (w, v) => `Week of ${mxShortDay(w.start)}: ${v.toFixed(2)} rounds avg · ${w.reviewed} reviewed`,
    }),
  );
  function mxQualityRow(key, kicker, big, sub, o) {
    const row = node('div', 'mx-qrow');
    const stat = node('div', 'mx-qstat');
    stat.append(node('span', 'mx-kicker', kicker), node('span', 'mx-big', big), node('span', 'mx-sub', sub));
    const H = 110;
    const T = 10;
    const B = H - 10;
    const lo = o.ticks[0];
    const hi = o.ticks[o.ticks.length - 1];
    const y = (v) => B - ((v - lo) * (B - T)) / (hi - lo);
    const wrap = node('div', 'mx-chart');
    wrap.style.width = `${W}px`;
    wrap.style.height = `${H}px`;
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', class: `mx-qline-${key}` });
    const shown = weeks.map((w, i) => [w, o.values[i]]).filter(([, v]) => v !== null);
    svg.setAttribute('aria-label', `${kicker.toLowerCase()} by week: ${shown.map(([w, v]) => `week of ${mxShortDay(w.start)} ${o.fmt(v)}`).join(', ')}.`);
    svg.append(svgEl('path', { d: o.ticks.map((v) => `M${box.L},${y(v).toFixed(1)} H${box.R}`).join(' '), stroke: 'rgba(255,255,255,0.06)', fill: 'none' }));
    const labels = o.ticks.map((v) => {
      const l = node('span', 'mx-axis-y', o.fmt(v));
      l.style.top = `${(y(v) - 8).toFixed(1)}px`;
      l.style.width = '34px';
      return l;
    });
    // the line breaks over weeks without reviews
    let d = '';
    let pen = false;
    o.values.forEach((v, i) => {
      if (v === null) return void (pen = false);
      d += `${pen ? ' L' : ' M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    svg.append(svgEl('path', { d: d.trim(), stroke: o.color, 'stroke-width': 2, fill: 'none', 'stroke-linejoin': 'round', class: 'mx-line' }));
    const tip = node('div', 'mx-tip mx-tip-sm hidden');
    tip.setAttribute('role', 'tooltip');
    o.values.forEach((v, i) => {
      if (v === null) return;
      const dot = svgEl('circle', { cx: x(i).toFixed(1), cy: y(v).toFixed(1), r: 4, fill: o.color, stroke: '#0f1219', 'stroke-width': 2, class: 'mx-dotpt' });
      dot.dataset.week = weeks[i].start;
      dot.dataset.value = String(v);
      const hit = svgEl('rect', { x: (x(i) - slot / 2).toFixed(1), y: 0, width: slot.toFixed(1), height: H, fill: 'transparent' });
      hit.addEventListener('mouseenter', () => {
        tip.textContent = o.tipText(weeks[i], v);
        tip.classList.remove('hidden');
        tip.style.left = `${Math.min(W - 190, Math.max(0, x(i) - 90)).toFixed(1)}px`;
        tip.style.top = `${Math.max(0, y(v) - 60).toFixed(1)}px`;
      });
      hit.addEventListener('mouseleave', () => tip.classList.add('hidden'));
      svg.append(dot, hit);
    });
    const lastI = o.values.findLastIndex((v) => v !== null);
    if (lastI >= 0) {
      const l = node('span', 'mx-bar-label', o.fmt(o.values[lastI]));
      l.style.left = `${(x(lastI) - 30).toFixed(1)}px`;
      l.style.top = `${Math.max(0, y(o.values[lastI]) - 24).toFixed(1)}px`;
      labels.push(l);
    }
    wrap.append(svg, ...labels, tip);
    row.append(stat, wrap);
    return row;
  }
  // week labels under both charts
  const axis = node('div', 'mx-qaxis');
  axis.style.width = `${W}px`;
  const every = Math.max(1, Math.ceil(48 / slot));
  weeks.forEach((w, i) => {
    if (i % every) return;
    const l = node('span', 'mx-axis-x mx-axis-x-sm', `${mxUtc(w.start).getUTCDate()}/${mxUtc(w.start).getUTCMonth() + 1}`);
    l.style.left = `${(x(i) - 24).toFixed(1)}px`;
    axis.append(l);
  });
  host.append(axis);
}

function mxRenderAgents(host) {
  host.append(node('h2', 'mx-h2', 'By agent'));
  const r = mx.res.quality;
  const q = r?.state === 'ok' ? r.data : null;
  const state = mxChartState('quality', q && !q.byAgent.length ? 'No reviewed or finished cards in this period' : null);
  if (state) return host.append(state);
  const flow = mx.res.flow?.state === 'ok' ? mx.res.flow.data : null;
  const table = node('table', 'mx-table');
  const thead = node('thead');
  const hr = node('tr');
  for (const [text, cls] of [
    ['Agent', 'l'],
    ['Reviewed'],
    ['Done'],
    ['First-pass', 'fp'],
    ['Avg rounds'],
    ['Capped'],
    ['Rework'],
  ]) {
    const th = node('th', cls ?? '', text);
    th.scope = 'col';
    hr.append(th);
  }
  thead.append(hr);
  const tbody = node('tbody');
  const rows = [...q.byAgent].sort((a, b) => b.reviewed - a.reviewed || b.done - a.done || (a.agent ?? '~').localeCompare(b.agent ?? '~'));
  for (const a of rows) {
    const tr = node('tr');
    tr.dataset.agent = a.agent ?? '';
    const th = node('th', 'l');
    th.scope = 'row';
    const name = a.agent ?? 'unassigned';
    const who = node('span', 'mx-who');
    who.append(avatarEl(teamByName.get(a.agent) ?? { name, color: a.agent ? accentFor(a.agent) : PL_NONE_COLOR }, 28), node('span', '', name));
    // drill-down: the agent's done cards this period (flow's points)
    const pts = flow ? flow.points.filter((p) => mxAgentOf(p.id) === a.agent) : [];
    if (pts.length) {
      const b = node('button', 'mx-who-btn');
      b.type = 'button';
      b.setAttribute('aria-label', `List ${name}'s ${mxPlural(pts.length, 'card')} done this period`);
      b.append(who);
      b.onclick = () => mxDrillDone(pts, `BY AGENT · ${name.toUpperCase()}`, mxWindowLabel());
      th.append(b);
    } else th.append(who);
    const fp = node('td', 'fp');
    if (a.firstPassRate === null) fp.textContent = '—';
    else {
      const cell = node('span', 'mx-fp');
      const bar = node('span', 'mx-bar');
      const fill = node('span', 'mx-bar-fill');
      fill.style.width = `${Math.round(a.firstPassRate * 100)}%`;
      bar.append(fill);
      cell.append(bar, node('span', 'mono', `${Math.round(a.firstPassRate * 100)}%`));
      fp.append(cell);
    }
    const capped = node('td', `mono${a.capped ? ' warn' : ' dim'}`, a.capped);
    tr.append(
      th,
      node('td', 'mono', a.reviewed),
      node('td', 'mono', a.done),
      fp,
      node('td', 'mono', a.avgRounds === null ? '—' : a.avgRounds.toFixed(2)),
      capped,
      node('td', 'mono', a.rework),
    );
    tbody.append(tr);
  }
  table.append(thead, tbody);
  host.append(table);
  const t = q.totals;
  host.append(
    node(
      'p',
      'mx-foot',
      `Per agent = the member the card was assigned to. ${mxPlural(t.unreviewedDone, 'card')} reached done without a review; ${t.notYetReviewed} ${t.notYetReviewed === 1 ? 'isn’t' : 'aren’t'} reviewed yet.`,
    ),
  );
}

function mxRenderWaitingNow(host) {
  const r = mx.res.wait;
  const w = r?.state === 'ok' ? r.data : null;
  const head = node('div', 'mx-panel-head');
  head.append(node('h2', '', 'Waiting on you now'));
  if (w) {
    head.append(node('span', 'mx-badge', w.waiting.count), node('div', 'mx-grow'));
    if (w.waiting.count) head.append(node('span', 'mx-panel-sub', `longest ${mxWait(w.waiting.longestMs)}`));
  }
  host.append(head);
  const state = mxChartState('wait', w && !w.waiting.count ? 'Nothing is waiting on you' : null);
  if (state) return host.append(state);
  const m = mx.meta;
  const canOpen = !EMBED && term.enabled;
  const items = [
    ...w.waiting.needsYou.map((n) => ({ kind: 'needs', board: n.project_id, card: n.task_id ? (m?.cards.get(n.task_id)?.title ?? null) : null, text: n.reason || 'A session is waiting on you', ms: n.waitingMs })),
    ...w.waiting.blockers.map((b) => ({ kind: 'blocked', board: b.project_id, card: b.title, text: b.reason || 'Blocked', ms: b.waitingMs })),
  ].sort((a, b) => b.ms - a.ms);
  const list = node('ul', 'mx-wait-list');
  for (const it of items) {
    const li = node('li', `mx-wait-item ${it.kind}`);
    const age = node('span', 'mx-wait-age');
    const ageCls = it.kind === 'blocked' ? 'rose' : it.ms >= 30 * 60_000 ? 'amber' : '';
    age.append(node('b', ageCls, mxWait(it.ms)), node('span', it.kind === 'blocked' ? 'rose' : 'amber', it.kind === 'blocked' ? 'blocked' : 'needs you'));
    const main = node('span', 'mx-wait-main');
    const meta = node('span', 'mx-drill-meta');
    const b = m?.boardById.get(it.board);
    const dot = node('span', 'mx-dot');
    dot.style.background = b?.color ?? PL_NONE_COLOR;
    meta.append(dot, [b?.label ?? 'unknown board', it.card].filter(Boolean).join(' · '));
    main.append(meta, node('span', 'mx-wait-text', it.text));
    li.append(age, main);
    if (canOpen) {
      const go = node('button', 'mx-answer', 'Answer');
      go.type = 'button';
      go.setAttribute('aria-label', `Answer in ${b?.label ?? 'the board'}'s terminal`);
      go.onclick = () => openBoardTerminal(it.board, m?.workspaceId);
      li.append(go);
    } else li.append(node('span', 'mx-answer-note', `Answer in ${b?.label ?? 'the board'}'s terminal`));
    list.append(li);
  }
  host.append(list);
}

function mxRenderWaitTime(host) {
  const head = node('div', 'mx-panel-head');
  head.append(
    node('h2', '', 'Time waiting on you'),
    node('div', 'mx-grow'),
    mxToggle('Group by', [['board', 'By board'], ['phase', 'By phase']], mx.ui.waitBy, (v) => {
      mx.ui.waitBy = v;
      mxRenderBody();
    }),
  );
  host.append(head);
  const r = mx.res.wait;
  const w = r?.state === 'ok' ? r.data : null;
  const state = mxChartState('wait');
  if (state) return host.append(state);
  const sums = node('div', 'mx-wait-sums');
  const sum = (cls, title, total, sub) => {
    const el = node('div', `mx-wait-sum ${cls}`);
    const k = node('span', 'mx-kicker');
    k.append(node('span', `mx-sw ${cls === 'needs' ? 'mx-sw-needs' : 'hatch-rose'}`), title);
    el.append(k, node('span', 'mx-big mx-big-md', mxWait(total)), node('span', 'mx-sub mono', sub));
    return el;
  };
  const d = w.needsYou.duration;
  const res = w.blocked.resolution;
  sums.append(
    sum('needs', 'NEEDS YOU', w.needsYou.totalMs, `${mxPlural(w.needsYou.count, 'wait')}${d.count ? ` · p50 ${mxWait(d.p50)} · p85 ${mxWait(d.p85)}` : ''}`),
    sum('blocked', 'BLOCKED', w.blocked.totalMs, `${mxPlural(w.blocked.count, 'blocker')}${res.count ? ` · resolved p50 ${mxWait(res.p50)} · p85 ${mxWait(res.p85)}` : ''}`),
  );
  host.append(sums);
  const byBoard = mx.ui.waitBy === 'board';
  const m = mx.meta;
  const rows = (byBoard ? w.byBoard : w.byPhase)
    .map((x) => {
      const board = byBoard ? x.project_id : x.phase_id === null ? null : (mxPhaseById(x.phase_id)?.board ?? null);
      const b = board ? m?.boardById.get(board) : null;
      const name = byBoard ? (b?.label ?? x.name ?? 'unknown board') : x.phase_id === null ? 'No phase' : `${m && m.boards.length > 1 && b ? `${b.label} · ` : ''}${x.title ?? 'unknown phase'}`;
      return { name, color: b?.color ?? PL_NONE_COLOR, n: x.needsYou.totalMs, b: x.blocked.totalMs };
    })
    .filter((x) => x.n + x.b > 0)
    .sort((a, b) => b.n + b.b - (a.n + a.b));
  if (!rows.length) return host.append(node('div', 'mx-chart-state', 'No waiting in this period'));
  const max = Math.max(...rows.map((x) => x.n + x.b));
  const h = (ms) => (ms / 3_600_000).toFixed(1);
  const bars = node('div', 'mx-wait-bars');
  bars.setAttribute('role', 'img');
  bars.setAttribute('aria-label', `Hours waiting ${byBoard ? 'by board' : 'by phase'}: ${rows.map((x) => `${x.name} ${h(x.n + x.b)} (${h(x.n)} needs you, ${h(x.b)} blocked)`).join('; ')}.`);
  for (const x of rows) {
    const row = node('div', 'mx-wait-row');
    const name = node('span', 'mx-wait-name');
    const dot = node('span', 'mx-dot');
    dot.style.background = x.color;
    name.append(dot, node('span', '', x.name));
    name.title = x.name;
    const bar = node('span', 'mx-wait-bar');
    const nb = node('span', 'needs');
    nb.style.width = `${((x.n / max) * 100).toFixed(1)}%`;
    const bb = node('span', 'blocked');
    bb.style.width = `${((x.b / max) * 100).toFixed(1)}%`;
    bar.append(nb, bb);
    bar.title = `needs you ${mxWait(x.n)} · blocked ${mxWait(x.b)}`;
    const val = node('span', 'mx-wait-val');
    val.append(node('b', '', `${h(x.n + x.b)}h`), ` · ${h(x.n)} + ${h(x.b)}`);
    row.append(name, bar, val);
    bars.append(row);
  }
  host.append(bars);
}

// ---------- Forecast ----------
function mxForecastTargetName(t) {
  const m = mx.meta;
  if (t.kind === 'phase') return t.phase.title;
  if (t.kind === 'plan') return t.plan.title;
  if (!m || mx.f.scope === m.workspaceId) return m && m.boards.length > 1 ? `the whole ${m.boards[0].name} workspace` : (m?.boards[0]?.name ?? 'the board');
  return m.boardById.get(mx.f.scope)?.label ?? 'the board';
}

function mxRenderForecast(host) {
  const panel = mxPanel('mx-fc', 'Forecast');
  host.replaceChildren(panel);
  const m = mx.meta;
  const t = mxForecastTarget();
  const head = node('div', 'mx-panel-head');
  head.append(node('h2', '', 'When will it be done?'));
  if (m) {
    const boards = mxScopeBoards();
    const opts = boards.flatMap((b) => (m.phases.get(b.id) ?? []).map((p) => [`phase:${p.id}`, `Phase · ${boards.length > 1 ? `${b.label} · ` : ''}${p.title}`]));
    if (mx.f.scope === m.workspaceId) opts.push(...m.plans.map((p) => [`plan:${p.id}`, `Plan · ${p.title}`]));
    opts.push(['all', mx.f.scope === m.workspaceId ? (m.boards.length > 1 ? 'Whole workspace' : 'Whole board') : `Whole board · ${m.boardById.get(mx.f.scope)?.label ?? ''}`]);
    const sel = mxSelect('Forecast', t.key, opts, (v) => mxSetFilter({ target: v }));
    sel.classList.add('mx-fc-target');
    head.append(sel);
  }
  head.append(node('div', 'mx-grow'));
  const r = mx.res.forecastTarget;
  const fc = r?.state === 'ok' ? r.data : null;
  if (fc?.status === 'ok') head.append(node('span', 'mx-panel-sub', `${fc.runs.toLocaleString('en-US')} runs · seed ${fc.seed}`));
  panel.append(head);
  const state = mxChartState('forecastTarget');
  if (state) return panel.append(state);
  const name = mxForecastTargetName(t);
  if (fc.status !== 'ok') return mxForecastEmpty(panel, fc, t, name);
  if (fc.remaining === 0) return panel.append(node('div', 'mx-chart-state', `Nothing left to forecast: no open cards in ${name}.`));

  const inDays = (d) => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`);
  const tiles = node('div', 'mx-fc-tiles');
  const tile = (cls, kicker, big, sub) => {
    const el = node('div', `mx-fc-tile ${cls}`);
    el.append(node('span', 'mx-kicker', kicker), node('span', 'mx-fc-big', big), node('span', 'mx-fc-sub', sub));
    return el;
  };
  // "of N in <phase>": the phase's cards as the board lists them (tag-filtered like the forecast)
  let of = '';
  if (t.kind === 'phase' && m) {
    const total = [...m.cards.values()].filter((c) => c.phase_id === t.id && (!mx.f.tag || c.tag === mx.f.tag) && (!mx.f.workType || (c.work_type ?? 'none') === mx.f.workType)).length;
    of = total >= fc.remaining ? `of ${total} in ${name}` : `in ${name}`;
  } else of = t.kind === 'plan' ? `in plan ${name}` : `not done in ${name}`;
  tiles.append(
    tile('p50', '50% LIKELY BY', mxLongDay(fc.p50.date), inDays(fc.p50.days)),
    tile('p85 plan', '85% LIKELY BY', mxLongDay(fc.p85.date), `${inDays(fc.p85.days)} · the date to plan on`),
    tile('p95', '95% LIKELY BY', mxLongDay(fc.p95.date), inDays(fc.p95.days)),
    tile('left', 'REMAINING', mxPlural(fc.remaining, 'card'), of),
    tile('basis', 'BASED ON', mxPlural(fc.samples.days, 'day'), `${mxPlural(fc.samples.done, 'card')} done in that time`),
  );
  panel.append(tiles);

  const today = mxAddDays(fc.p50.date, -fc.p50.days);
  const hh = node('div', 'mx-panel-head');
  hh.append(node('h3', '', `Finish day across ${fc.runs.toLocaleString('en-US')} runs`), node('span', 'mx-panel-sub', `days from today (${mxLongDay(today)})`));
  panel.append(hh);
  const histHost = node('div');
  panel.append(histHost);
  mxRenderHistogram(histHost, fc, today, panel.clientWidth - 40);
  panel.append(
    node(
      'p',
      'mx-note mx-how',
      `We replay your last ${mxPlural(fc.samples.days, 'day')} of daily throughput ${fc.runs.toLocaleString('en-US')} times, drawing a random past day at a time, until the ${mxPlural(fc.remaining, 'remaining card')} ${fc.remaining === 1 ? 'is' : 'are'} done. No estimates needed. More history or steadier throughput narrows the spread.`,
    ),
  );
}

const MX_HIST_MAX_BARS = 90;
function mxRenderHistogram(host, fc, today, width) {
  const W = Math.max(480, width);
  const counts = new Map(fc.histogram.map((b) => [b.days, b.count]));
  const minD = fc.histogram[0].days;
  const maxD = fc.histogram[fc.histogram.length - 1].days;
  const lastD = Math.min(maxD, minD + MX_HIST_MAX_BARS - 1); // a long tail is lumped into the last bar ("N+")
  const bins = [];
  for (let d = minD; d <= lastD; d++) bins.push({ d, count: counts.get(d) ?? 0, tail: false });
  if (maxD > lastD) {
    const last = bins[bins.length - 1];
    last.tail = true;
    last.count = fc.histogram.filter((b) => b.days >= lastD).reduce((s, b) => s + b.count, 0);
  }
  const L = 56;
  const R = W - 8;
  const bw = (R - L) / bins.length;
  // markers at the right edge of the 50 / 85 / 95% day's bar; labels that would collide go on a row below
  let prevX = -Infinity;
  let row = 0;
  const marks = [
    ['50', fc.p50, '#e8eaf0', '5 4', 1.5],
    ['85', fc.p85, '#5dd3a8', null, 2],
    ['95', fc.p95, '#aab2c5', '2 4', 1.5],
  ].map(([p, pt, color, dash, sw]) => {
    const x = L + (Math.min(pt.days, lastD) - minD + 1) * bw;
    row = x - prevX < 150 ? row + 1 : 0;
    prevX = x;
    return { p, pt, color, dash, sw, x, row };
  });
  const T = 30 + Math.max(...marks.map((mk) => mk.row)) * 20;
  const H = 330 + T;
  const box = { L, R, T, B: H - 42 };
  const ticks = mxNiceTicks(Math.max(...bins.map((b) => b.count)));
  const yMax = ticks[ticks.length - 1];
  const y = (v) => box.B - (v * (box.B - box.T)) / yMax;
  const pad = Math.min(10, bw * 0.15);
  const f = (v) => v.toFixed(1);
  const wrap = node('div', 'mx-chart');
  wrap.style.width = `${W}px`;
  wrap.style.height = `${H}px`;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
  svg.setAttribute('aria-label', `Histogram of simulated finish days. 50% by day ${fc.p50.days}, 85% by day ${fc.p85.days}, 95% by day ${fc.p95.days}.`);
  const labels = mxGrid(svg, box, ticks, y, 44);
  labels.forEach((l, i) => (l.textContent = ticks[i].toLocaleString('en-US')));
  const tip = node('div', 'mx-tip hidden');
  tip.setAttribute('role', 'tooltip');
  const outline = svgEl('path', { d: '', fill: 'none', stroke: '#e8eaf0', 'stroke-width': 2, 'pointer-events': 'none' });
  const barD = (i, v) => {
    const x0 = box.L + i * bw + pad;
    const w = bw - 2 * pad;
    const yt = y(v);
    const rr = Math.min(4, w / 2, box.B - yt);
    return v > 0
      ? `M${f(x0)},${box.B} V${f(yt + rr)} Q${f(x0)},${f(yt)} ${f(x0 + rr)},${f(yt)} H${f(x0 + w - rr)} Q${f(x0 + w)},${f(yt)} ${f(x0 + w)},${f(yt + rr)} V${box.B} Z`
      : '';
  };
  let cum = fc.histogram.filter((b) => b.days < minD).reduce((s, b) => s + b.count, 0);
  const every = Math.max(1, Math.ceil(88 / bw));
  bins.forEach((b, i) => {
    cum += b.count;
    const d = barD(i, b.count);
    if (d) {
      const bar = svgEl('path', { d, fill: b.d <= fc.p85.days ? '#5dd3a8' : 'rgba(93,211,168,0.38)', class: 'mx-hist-bar' });
      bar.dataset.days = String(b.d);
      bar.dataset.count = String(b.count);
      svg.append(bar);
    }
    const date = mxAddDays(today, b.d);
    const doneBy = Math.round((cum / fc.runs) * 100);
    const hit = svgEl('rect', { x: f(box.L + i * bw), y: box.T, width: f(bw), height: box.B - box.T, fill: 'transparent', class: 'mx-hist-hit' });
    hit.dataset.days = String(b.d);
    hit.addEventListener('mouseenter', () => {
      outline.setAttribute('d', d);
      tip.replaceChildren(
        node('span', 'mx-tip-h', `Day ${b.d}${b.tail ? '+' : ''} · ${mxLongDay(date)}`),
        node('span', 'mx-tip-row', `${b.count.toLocaleString('en-US')} ${b.count === 1 ? 'run' : 'runs'} finished ${b.tail ? 'then or later' : 'that day'}`),
        node('span', 'mx-tip-row mx-tip-hi', `${doneBy}% of runs done by then`),
      );
      mxPlaceTip(tip, box.L + (i + 0.5) * bw, 140, W, 230);
    });
    hit.addEventListener('mouseleave', () => {
      outline.setAttribute('d', '');
      tip.classList.add('hidden');
    });
    svg.append(hit);
    if (i % every === 0) {
      const l = node('span', 'mx-axis-x mx-axis-x-lg', `${b.d}${b.tail ? '+' : ''}d · ${mxWeekdayDay(date)}`);
      l.style.left = `${f(box.L + (i + 0.5) * bw - 40)}px`;
      l.style.top = `${box.B + 12}px`;
      labels.push(l);
    }
  });
  svg.append(outline);
  for (const mk of marks) {
    const line = svgEl('path', { d: `M${f(mk.x)},${f(mk.row * 20 + 22)} V${box.B}`, stroke: mk.color, 'stroke-width': mk.sw, fill: 'none', class: 'mx-hist-mark' });
    if (mk.dash) line.setAttribute('stroke-dasharray', mk.dash);
    line.dataset.p = mk.p;
    svg.append(line);
    const l = node('span', 'mx-hist-label', `${mk.p}% · ${mxLongDay(mk.pt.date)}`);
    l.dataset.p = mk.p;
    l.style.color = mk.color;
    l.style.left = `${f(Math.min(W - 150, Math.max(0, mk.x - 60)))}px`;
    l.style.top = `${mk.row * 20}px`;
    labels.push(l);
  }
  wrap.append(svg, ...labels, tip);
  host.append(wrap);
}

// Not enough history: what's missing, and the whole workspace as a fallback when it has enough.
function mxForecastEmpty(panel, fc, t, name) {
  const m = mx.meta;
  const box = node('div', 'mx-fc-empty');
  const scopeLabel = m && mx.f.scope !== m.workspaceId ? ` (${m.boardById.get(mx.f.scope)?.label ?? ''})` : '';
  const what = t.kind === 'phase' ? `PHASE · ${name}` : t.kind === 'plan' ? `PLAN · ${name}` : m && mx.f.scope === m.workspaceId && m.boards.length > 1 ? 'WHOLE WORKSPACE' : 'WHOLE BOARD';
  box.append(node('span', 'mx-kicker', `FORECAST · ${what.toUpperCase()}${scopeLabel}`));
  box.append(
    node('h2', '', 'Not enough history yet'),
    node(
      'p',
      'mx-fc-empty-lead',
      `A forecast needs at least ${mxPlural(fc.need.days, 'day')} of work and ${mxPlural(fc.need.done, 'done card')} ${m && mx.f.scope !== m.workspaceId ? 'on this board' : 'in this workspace'}${mx.f.tag ? ` tagged ${mx.f.tag}` : ''}. It appears on its own once there's enough.`,
    ),
  );
  const bars = node('div', 'mx-fc-need');
  for (const [label, have, need] of [
    ['DAYS OF HISTORY', fc.have.days, fc.need.days],
    ['DONE CARDS', fc.have.done, fc.need.done],
  ]) {
    const el = node('div', 'mx-fc-need-item');
    const top = node('span', 'mx-fc-need-top');
    top.append(node('span', '', label), node('b', '', `${have} / ${need}`));
    const bar = node('span', 'mx-bar mx-bar-lg');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${have} of ${need} ${label.toLowerCase()}`);
    const fill = node('span', 'mx-bar-fill blue');
    fill.style.width = `${Math.min(100, (have / need) * 100)}%`;
    bar.append(fill);
    el.append(top, bar);
    bars.append(el);
  }
  box.append(bars);
  const all = mx.res.forecastAll;
  if (m && mx.f.scope !== m.workspaceId && all) {
    if (all.state === 'loading') box.append(node('p', 'mx-note', 'Checking the whole workspace…'));
    else if (all.state === 'ok' && all.data.status === 'ok') {
      box.append(node('p', 'mx-note', `Meanwhile, the whole ${m.boards[0].name} workspace has enough history: its forecast uses every board's throughput.`));
      const go = node('button', 'mx-btn primary', 'Forecast the whole workspace');
      go.type = 'button';
      go.onclick = () => mxSetFilter({ scope: m.workspaceId, target: 'all' });
      const actions = node('div', 'mx-fc-actions');
      actions.append(go);
      box.append(actions);
    } else if (all.state === 'ok') box.append(node('p', 'mx-note', `The whole ${m.boards[0].name} workspace doesn't have enough history yet either.`));
  }
  panel.append(box);
}

// ---------- drill-down side panel ----------
const mxBoardOf = (id, fallback) => mx.meta?.cards.get(id)?.board ?? fallback ?? null;
const mxAgentOf = (id) => mx.meta?.cards.get(id)?.agent ?? null;
const mxScopeLabel = () => fbScopeLabel(mx);

// measure: which time the rows show and sort by (the Flow tab's Cycle / Lead toggle)
function mxDrillDone(points, kicker, range, measure = 'cycle') {
  const ms = (p) => (measure === 'lead' ? p.leadTimeMs : p.cycleTimeMs);
  const rows = points.map((p) => ({
    id: p.id,
    title: p.title,
    board: mxBoardOf(p.id),
    agent: mxAgentOf(p.id),
    when: `done ${mxWeekdayDay(mxDayKey(p.doneAt, mx.f.tz))}`,
    at: p.doneAt,
    value: ms(p),
    valueText: mxSpan(ms(p)),
  }));
  const cyc = [...points.map(ms)].sort((a, b) => a - b);
  mxOpenDrill({
    kicker,
    title: `${mxPlural(rows.length, 'card')} done`,
    sub: `${range} · ${mxScopeLabel()}`,
    stat: cyc.length ? `median ${measure} ${mxSpan(cyc[Math.ceil(cyc.length / 2) - 1])}` : '',
    rows,
    sorts: [
      ['value', `Longest ${measure} time`, (a, b) => b.value - a.value],
      ['at', 'Done date', (a, b) => b.at - a.at],
      ['board', 'Board', mxByBoard],
    ],
  });
}
function mxDrillCost(c) {
  const flow = mx.res.flow?.state === 'ok' ? mx.res.flow.data : null;
  const doneAt = new Map((flow?.points ?? []).map((p) => [p.id, p.doneAt]));
  const rows = c.byCard.map((x) => ({
    id: x.deleted ? null : x.id,
    title: x.title ?? '(deleted card)',
    board: x.project_id,
    agent: mxAgentOf(x.id),
    when: doneAt.has(x.id) ? `done ${mxWeekdayDay(mxDayKey(doneAt.get(x.id), mx.f.tz))}` : x.deleted ? 'deleted' : (LANE_LABELS[x.lane] ?? x.lane ?? ''),
    at: doneAt.get(x.id) ?? 0,
    value: x.cost,
    valueText: `${mxMoney(x.cost)}${x.estimated ? '*' : ''}`,
  }));
  mxOpenDrill({
    kicker: 'COST · THIS PERIOD',
    title: `${mxMoney(c.totals.cost)} over ${mxPlural(c.cardCount, 'card')}`,
    sub: `${mxWindowLabel()} · ${mxScopeLabel()}`,
    stat: rows.some((r) => r.valueText.endsWith('*')) ? '* includes estimated runs' : '',
    rows,
    total: c.cardCount,
    sorts: [
      ['value', 'Highest cost', (a, b) => b.value - a.value],
      ['board', 'Board', mxByBoard],
    ],
  });
}
function mxDrillWaiting(w) {
  const rows = [
    ...w.waiting.needsYou.map((n) => ({
      id: n.task_id && mx.meta?.cards.has(n.task_id) ? n.task_id : null,
      title: n.task_id && mx.meta?.cards.get(n.task_id) ? mx.meta.cards.get(n.task_id).title : n.reason || 'Session waiting on you',
      board: n.project_id,
      agent: n.agent_id,
      when: n.reason ? `needs you: ${n.reason}` : 'needs you',
      at: n.since,
      value: n.waitingMs,
      valueText: mxWait(n.waitingMs),
    })),
    ...w.waiting.blockers.map((b) => ({
      id: b.task_id,
      title: b.title,
      board: b.project_id,
      agent: mxAgentOf(b.task_id),
      when: b.reason ? `blocked: ${b.reason}` : 'blocked',
      at: b.since,
      value: b.waitingMs,
      valueText: mxWait(b.waitingMs),
    })),
  ];
  mxOpenDrill({
    kicker: 'WAITING ON YOU · NOW',
    title: `${mxPlural(rows.length, 'wait')} open`,
    sub: mxScopeLabel(),
    stat: `longest ${mxWait(w.waiting.longestMs)}`,
    rows,
    sorts: [
      ['value', 'Longest waiting', (a, b) => b.value - a.value],
      ['board', 'Board', mxByBoard],
    ],
  });
}
function mxByBoard(a, b, meta = mx.meta) {
  const la = meta?.boardById.get(a.board)?.label ?? '';
  const lb = meta?.boardById.get(b.board)?.label ?? '';
  return la.localeCompare(lb) || b.value - a.value;
}

// Open one card: the card modal on this board, else that board's Kanban with the card open.
function mxOpenCard(id, board) {
  mx.drill?.close();
  if (board === projectId && cards.has(id)) {
    setView('kanban');
    openCardModal(id);
  } else location.search = `?project=${encodeURIComponent(board)}&card=${encodeURIComponent(id)}&view=kanban`;
}
// Open a board's Kanban with these cards highlighted. source: the banner's "from <source>" (default Metrics).
function mxOpenAll(ids, board, source = 'Metrics') {
  mx.drill?.close();
  if (board === projectId) {
    setView('kanban');
    setKanbanHighlight(ids, source);
  } else location.search = `?project=${encodeURIComponent(board)}&cards=${encodeURIComponent(ids.join(','))}&view=kanban${source === 'Metrics' ? '' : `&hlfrom=${encodeURIComponent(source)}`}`;
}

// ctx: whose meta names the boards (Metrics' mx, the dashboard's, Home's); host: the view it covers.
// source: where "Open all" says the highlight came from (default Metrics).
function mxOpenDrill({ kicker, title, sub, stat, rows, sorts, total, unit = 'card', ctx = mx, host = metricsView, source }) {
  mx.drill?.close();
  const opener = document.activeElement;
  const backdrop = node('div', 'mx-drill-backdrop');
  const panel = node('aside', 'mx-drill');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'mx-drill-title');
  const head = node('div', 'mx-drill-head');
  const titles = node('div', 'mx-drill-titles');
  const h = node('h2', '', title);
  h.id = 'mx-drill-title';
  titles.append(node('span', 'mx-kicker', kicker), h, node('span', 'mx-drill-sub', sub));
  const close = node('button', 'mx-drill-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  head.append(titles, close);

  const tools = node('div', 'mx-drill-tools');
  let sortId = sorts[0][0];
  const sortSel = mxSelect('Sort', sortId, sorts.map(([id, label]) => [id, label]), (v) => {
    sortId = v;
    renderList();
  });
  tools.append(sortSel, node('div', 'mx-grow'), node('span', 'mx-drill-stat', stat ?? ''));

  const list = node('ul', 'mx-drill-list');
  const renderList = () => {
    const cmp = sorts.find(([id]) => id === sortId)[2];
    list.replaceChildren(
      ...[...rows].sort(cmp).map((r) => {
        const li = node('li', 'mx-drill-row');
        const main = node('span', 'mx-drill-main');
        const b = ctx.meta?.boardById.get(r.board);
        const meta = node('span', 'mx-drill-meta');
        const dot = node('span', 'mx-dot');
        dot.style.background = b?.color ?? PL_NONE_COLOR;
        meta.append(dot, [b?.label ?? 'unknown board', r.agent ?? 'unassigned', r.when].filter(Boolean).join(' · '));
        main.append(node('span', 'mx-drill-title', r.title), meta);
        li.append(main, node('span', 'mx-drill-value', r.valueText));
        if (r.id && r.board) {
          const open = node('button', 'mx-btn', 'Open');
          open.type = 'button';
          open.setAttribute('aria-label', `Open ${r.title} in Kanban`);
          open.onclick = () => mxOpenCard(r.id, r.board);
          li.append(open);
        } else li.append(node('span', 'mx-btn-spacer'));
        return li;
      }),
    );
  };
  renderList();

  const foot = node('div', 'mx-drill-foot');
  const openable = rows.filter((r) => r.id && r.board);
  foot.append(node('span', 'mx-drill-count', total && total > rows.length ? `showing ${rows.length} of ${total}` : mxPlural(rows.length, unit)), node('div', 'mx-grow'));
  const byBoard = new Map();
  for (const r of openable) {
    if (!byBoard.has(r.board)) byBoard.set(r.board, []);
    byBoard.get(r.board).push(r.id);
  }
  const groups = [...byBoard].sort((a, b) => b[1].length - a[1].length);
  if (groups.length === 1) {
    const [board, ids] = groups[0];
    const all = node('button', 'mx-btn primary', `Open all ${ids.length} in Kanban`);
    all.type = 'button';
    all.onclick = () => mxOpenAll(ids, board, source);
    foot.append(all);
  } else if (groups.length > 1) {
    // Kanban shows one board at a time: one button per board
    const wrap = node('div', 'mx-drill-alls');
    for (const [board, ids] of groups) {
      const label = ctx.meta?.boardById.get(board)?.label ?? 'board';
      const all = node('button', 'mx-btn', `Open ${ids.length} in ${label}`);
      all.type = 'button';
      all.onclick = () => mxOpenAll(ids, board, source);
      wrap.append(all);
    }
    foot.append(wrap);
  }

  panel.append(head, tools, list, foot);
  backdrop.append(panel);
  let closed = false;
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      api.close();
    }
  };
  const api = {
    close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      if (mx.drill === api) mx.drill = null;
      if (opener && opener.isConnected && opener !== document.body) opener.focus();
    },
  };
  close.onclick = api.close;
  backdrop.onmousedown = (e) => {
    if (e.target === backdrop) api.close();
  };
  document.addEventListener('keydown', onKey, true);
  host.append(backdrop);
  mx.drill = api; // the one open drill-down, whichever view opened it
  close.focus();
}

// ── Kanban highlight: Metrics' "Open all N in Kanban" ────────────────
const kanbanHighlight = new Set();
let kanbanHighlightChip = null; // "N highlighted · Clear", while the highlight is on
let kanbanHighlightSource = 'Metrics'; // where the highlight came from, as the banner names it
// sourceLabel: the view or widget that asked ("N cards highlighted from <label>"); default Metrics.
function setKanbanHighlight(ids, sourceLabel = 'Metrics') {
  kanbanHighlightSource = sourceLabel || 'Metrics';
  kanbanHighlight.clear();
  for (const id of ids) if (cards.has(id)) kanbanHighlight.add(id);
  renderBoard();
  renderHighlightChip();
  boardEl.querySelector('.card.mx-hl')?.scrollIntoView({ block: 'nearest' });
}
function clearKanbanHighlight() {
  kanbanHighlight.clear();
  renderBoard();
  renderHighlightChip();
}
function renderHighlightChip() {
  kanbanHighlightChip?.remove();
  kanbanHighlightChip = null;
  if (!kanbanHighlight.size) return;
  const chip = node('div', 'mx-hl-chip');
  chip.setAttribute('role', 'status');
  const clear = node('button', '', 'Clear highlight');
  clear.type = 'button';
  clear.onclick = clearKanbanHighlight;
  chip.append(node('span', '', `${mxPlural(kanbanHighlight.size, 'card')} highlighted from ${kanbanHighlightSource}`), clear);
  document.body.append(chip);
  kanbanHighlightChip = chip;
}
// Is any dialog open (card modal, settings, a vertical dialog, the drill-down…)? Esc belongs to it then.
const anyDialogOpen = () =>
  !!openCardId || svModal || !$('settings-modal').classList.contains('hidden') || !!document.querySelector('[aria-modal="true"]');
// One-shot ?cards=<id,id,…> (from another board's Metrics drill-down), once the board init has arrived.
// ?hlfrom=<label>: the banner's source ("from <label>", at most 80 characters); default Metrics. An
// older link's ?from=<label> is read only beside ?cards (elsewhere `from` is the custom range's start).
const HL_FROM_MAX = 80;
function highlightCardsFromUrl() {
  const url = new URL(location.href);
  const raw = url.searchParams.get('cards');
  if (raw === null) return;
  const legacy = !url.searchParams.has('hlfrom');
  const from = (legacy ? url.searchParams.get('from') : url.searchParams.get('hlfrom')) ?? '';
  url.searchParams.delete('cards');
  url.searchParams.delete('hlfrom');
  if (legacy) url.searchParams.delete('from');
  history.replaceState(null, '', url);
  setKanbanHighlight(raw.split(',').filter(Boolean), from.slice(0, HL_FROM_MAX) || 'Metrics');
}
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && activeView === 'kanban' && kanbanHighlight.size && !anyDialogOpen()) clearKanbanHighlight();
  },
  true,
);

// ── initial view: ?view= wins, else the user's Settings choice (once) ──
let initialViewSet = false;

async function setInitialView() {
  if (initialViewSet) return;
  // ?view=dashboard waits on the workspace probe (it wins if the dashboard opens)
  if (URL_VIEW === 'dashboard') await dashProbe;
  if (initialViewSet) return;
  initialViewSet = true;
  if (URL_VIEW && URL_VIEW !== 'dashboard' && URL_VIEWS.includes(URL_VIEW)) return setView(URL_VIEW);
  if (SETTINGS.defaultView === 'home') setView('home');
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
      const sched = pdSchedFor(p.id);
      if (sched) btn.querySelector('.pl-prog').before(schedPill(sched));
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
  if (activeView === 'phases' && pdSched.phases !== phases) loadSchedule(); // a new roadmap (init/phases broadcast) or the view opened
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
  // a re-render (any card event) keeps what's being typed into the budget field
  const typing = document.activeElement?.id === 'pd-budget' && document.activeElement.dataset.phase === p.id ? document.activeElement.value : null;
  const typingTarget = document.activeElement?.id === 'pd-target' && document.activeElement.dataset.phase === p.id ? document.activeElement.value : null;
  detail.innerHTML = `<div class="pd-detail"><div class="pd-detail-head"><span class="pd-detail-title">${esc(p.title)}</span><span class="pd-badge ${esc(p.status)}">${esc(p.status)}</span></div>${p.goal ? `<div class="pd-detail-goal">${esc(p.goal)}</div>` : ''}<h4>Cards ${done}/${pc.length}</h4><ul class="pd-cards">${rows}</ul></div>`;
  const fields = node('div', 'pd-fields');
  fields.append(phaseBudgetField(p, typing), phaseTargetField(p, typingTarget));
  detail.querySelector('.pd-detail h4').before(fields);
}

// Phase detail: "Budget ($)" (empty = no budget), saved via PUT /phase/:id/budget on change; errors inline.
const PD_BUDGET_MAX = 1e9; // the server's MAX_PHASE_BUDGET_USD
let pdBudgetMsg = null; // { phase, text, error }: the last save's result, kept across re-renders
function phaseBudgetField(p, typing) {
  const field = node('div', 'pd-budget');
  const label = node('label', 'pd-budget-label', 'Budget ($)');
  label.htmlFor = 'pd-budget';
  const input = node('input', 'st-num pd-budget-input');
  input.id = 'pd-budget';
  input.dataset.phase = p.id;
  input.type = 'number';
  input.min = '0';
  input.step = 'any';
  input.placeholder = 'no budget';
  input.value = typing ?? (p.budget_usd ?? '');
  const mine = pdBudgetMsg?.phase === p.id ? pdBudgetMsg : null;
  const msg = node('span', `pd-budget-msg${mine?.error ? ' error' : ''}`, mine?.text ?? 'empty = no budget');
  msg.setAttribute('role', 'status');
  if (mine?.error) input.classList.add('bad');
  const fail = (text) => {
    pdBudgetMsg = { phase: p.id, text, error: true };
    input.classList.add('bad');
    msg.className = 'pd-budget-msg error';
    msg.textContent = text;
  };
  input.onchange = async () => {
    if (input.validity.badInput) return fail('Enter an amount in dollars, or leave it empty for no budget');
    const v = input.value.trim() === '' ? null : Number(input.value);
    if (v !== null && (!Number.isFinite(v) || v < 0)) return fail('The budget can’t be negative');
    if (v !== null && v > PD_BUDGET_MAX) return fail(`The budget can be at most $${PD_BUDGET_MAX.toLocaleString('en-US')}`);
    try {
      const res = await fetch(`/phase/${encodeURIComponent(p.id)}/budget`, { method: 'PUT', body: JSON.stringify({ budget_usd: v }) });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      const local = phases.find((x) => x.id === p.id);
      if (local) local.budget_usd = body.budget_usd; // the phases broadcast follows
      pdBudgetMsg = { phase: p.id, text: v === null ? 'Budget cleared' : 'Saved', error: false };
      renderPhaseDetail();
    } catch (err) {
      fail(err.message);
    }
  };
  field.append(label, input, msg);
  if (typing !== null)
    queueMicrotask(() => {
      input.focus();
    });
  return field;
}

// ── Phases: target dates, schedule status (GET /metrics/schedule) and milestones ──
// The schedule reloads while the Phases view is visible: when it opens, when the roadmap array is replaced
// (init / phases broadcast — milestone and target writes send one; pdSched.phases is the array it was loaded
// for), and 2s after the last card event (a move changes the remaining counts).
let pdSched = { phases: null, project: null, byPhase: new Map(), milestones: [], allPhases: [] };
let pdSchedSeq = 0;
async function loadSchedule() {
  pdSched.phases = phases;
  const project = projectId;
  if (!project) return;
  const seq = ++pdSchedSeq;
  try {
    const res = await fetch(`/metrics/schedule?project=${encodeURIComponent(project)}&tz=${encodeURIComponent(MX_LOCAL_TZ)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (seq !== pdSchedSeq || project !== projectId) return; // a newer load (or another board) won
    pdSched = { phases: pdSched.phases, project, byPhase: new Map(body.phases.map((x) => [x.id, x])), milestones: body.milestones, allPhases: body.phases };
  } catch {
    if (seq !== pdSchedSeq) return;
    pdSched = { phases: pdSched.phases, project, byPhase: new Map(), milestones: [], allPhases: [] };
  }
  renderPhaseList();
  renderMilestones();
}
let pdSchedTimer = null;
function scheduleReloadSoon() {
  if (activeView !== 'phases') return;
  clearTimeout(pdSchedTimer);
  pdSchedTimer = setTimeout(() => activeView === 'phases' && loadSchedule(), 2000);
}
const pdSchedFor = (phaseId) => (pdSched.project === projectId ? pdSched.byPhase.get(phaseId) : null);

// "Tue 6 Oct" for a YYYY-MM-DD day (a calendar day: no time zone shift)
const PD_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PD_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pdDay = (d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return `${PD_DOW[t.getUTCDay()]} ${t.getUTCDate()} ${PD_MON[t.getUTCMonth()]}`;
};
const SCHED_LABEL = { on_track: 'on track', at_risk: 'at risk', late: 'late', unknown: 'unknown', complete: 'complete', done: 'done' };

/** Tooltip: "85% by Tue 6 Oct · target Mon 5 Oct", else what's known. */
function schedTip(x) {
  const parts = [];
  if (x.status === 'done') parts.push('phase done');
  else if (x.status === 'complete' || x.status === 'unknown') parts.push(x.reason);
  else if (!x.p85) parts.push(`${x.remaining} card${x.remaining === 1 ? '' : 's'} left`);
  if (x.p85) parts.push(`85% by ${pdDay(x.p85)}`);
  if (x.target_date) parts.push(`target ${pdDay(x.target_date)}`);
  if (x.history === 'workspace') parts.push('workspace history');
  return parts.join(' · ');
}

function schedPill(x) {
  const pill = node('span', `pl-sched ${x.status}`, SCHED_LABEL[x.status] ?? x.status);
  pill.title = schedTip(x);
  return pill;
}

// Phase detail: "Target date" (empty = none), saved via PUT /phase/:id/target on change; errors inline.
let pdTargetMsg = null; // { phase, text, error }
function phaseTargetField(p, typing) {
  const field = node('div', 'pd-budget pd-target');
  const label = node('label', 'pd-budget-label', 'Target date');
  label.htmlFor = 'pd-target';
  const input = node('input', 'st-num pd-target-input');
  input.id = 'pd-target';
  input.dataset.phase = p.id;
  input.type = 'date';
  input.value = typing ?? (p.target_date ?? '');
  const sched = pdSchedFor(p.id);
  const mine = pdTargetMsg?.phase === p.id ? pdTargetMsg : null;
  const msg = node('span', `pd-budget-msg${mine?.error ? ' error' : ''}`, mine?.text ?? (sched ? schedTip(sched) : 'empty = no target'));
  msg.setAttribute('role', 'status');
  if (sched && !mine) field.append(schedPill(sched));
  if (mine?.error) input.classList.add('bad');
  input.onchange = async () => {
    const v = input.value === '' ? null : input.value;
    if (input.validity.badInput) {
      pdTargetMsg = { phase: p.id, text: 'Enter a full date, or clear it for no target', error: true };
      return renderPhaseDetail();
    }
    try {
      const res = await fetch(`/phase/${encodeURIComponent(p.id)}/target`, { method: 'PUT', body: JSON.stringify({ target_date: v }) });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      const local = phases.find((x) => x.id === p.id);
      if (local) local.target_date = body.target_date; // the phases broadcast follows (and reloads the schedule)
      pdTargetMsg = { phase: p.id, text: v === null ? 'Target cleared' : 'Saved', error: false };
    } catch (err) {
      pdTargetMsg = { phase: p.id, text: err.message, error: true };
    }
    renderPhaseDetail();
  };
  field.prepend(label, input);
  field.append(msg);
  if (typing !== null) queueMicrotask(() => input.focus());
  return field;
}

// Sidebar: the board's milestones (incl. its workspace's / verticals'), add / edit / delete.
let msEditing = null; // milestone id being edited
let msDraft = { title: '', date: '', phase_id: '' }; // the add form, kept across re-renders
let msError = '';

function msPhaseSelect(value) {
  const sel = node('select', 'st-select ms-phase');
  sel.setAttribute('aria-label', 'Phase');
  sel.append(new Option('no phase', ''));
  for (const ph of pdSched.allPhases ?? []) sel.append(new Option(ph.title, ph.id));
  sel.value = value ?? '';
  return sel;
}

async function msWrite(method, path, body) {
  try {
    const res = await fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const out = await res.json().catch(() => null);
    if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
    msError = '';
    return true;
  } catch (err) {
    msError = err.message;
    renderMilestones();
    return false;
  }
}

function renderMilestones() {
  let host = document.getElementById('pd-milestones');
  if (!host) {
    host = node('div', 'ms');
    host.id = 'pd-milestones';
    document.getElementById('phase-list').after(host);
  }
  const head = node('div', 'ms-head');
  head.append(node('span', 'panel-heading', 'Milestones'), node('span', 'panel-sub', pdSched.milestones.length ? String(pdSched.milestones.length) : ''));
  const list = node('div', 'ms-list');
  const phaseTitle = (id) => (pdSched.allPhases ?? []).find((x) => x.id === id)?.title;
  if (!pdSched.milestones.length) list.append(node('div', 'ms-empty', 'No milestones yet.'));
  for (const m of pdSched.milestones) {
    const row = node('div', 'ms-row');
    row.dataset.id = m.id;
    if (msEditing === m.id) {
      const title = node('input', 'st-num ms-title');
      title.value = m.title;
      title.setAttribute('aria-label', 'Title');
      const date = node('input', 'st-num ms-date');
      date.type = 'date';
      date.value = m.date;
      date.setAttribute('aria-label', 'Date');
      const phase = msPhaseSelect(m.phase_id);
      const save = node('button', 'ms-btn primary', 'Save');
      save.onclick = async () => {
        const done = await msWrite('PATCH', `/milestones/${encodeURIComponent(m.id)}`, {
          title: title.value,
          date: date.value,
          phase_id: phase.value || null,
        });
        if (done) {
          msEditing = null;
          loadSchedule();
        }
      };
      const cancel = node('button', 'ms-btn', 'Cancel');
      cancel.onclick = () => {
        msEditing = null;
        msError = '';
        renderMilestones();
      };
      row.classList.add('editing');
      row.append(title, date, phase, save, cancel);
    } else {
      const text = node('div', 'ms-main');
      const when = node('span', 'ms-when', pdDay(m.date));
      when.title = m.date;
      text.append(when, node('span', 'ms-name', m.title));
      const ph = m.phase_id ? phaseTitle(m.phase_id) : null;
      if (ph) text.append(node('span', 'ms-ph', ph));
      const edit = node('button', 'ms-icon', '✎');
      edit.title = 'Edit milestone';
      edit.setAttribute('aria-label', `Edit ${m.title}`);
      edit.onclick = () => {
        msEditing = m.id;
        msError = '';
        renderMilestones();
      };
      const del = node('button', 'ms-icon del', '✕');
      del.title = 'Delete milestone';
      del.setAttribute('aria-label', `Delete ${m.title}`);
      del.onclick = async () => {
        if (await msWrite('DELETE', `/milestones/${encodeURIComponent(m.id)}`)) loadSchedule();
      };
      row.append(text, edit, del);
    }
    list.append(row);
  }
  // add form
  const add = node('div', 'ms-add');
  const title = node('input', 'st-num ms-title');
  title.placeholder = 'Milestone';
  title.setAttribute('aria-label', 'New milestone title');
  title.value = msDraft.title;
  title.oninput = () => (msDraft.title = title.value);
  const date = node('input', 'st-num ms-date');
  date.type = 'date';
  date.setAttribute('aria-label', 'New milestone date');
  date.value = msDraft.date;
  date.oninput = () => (msDraft.date = date.value);
  const phase = msPhaseSelect(msDraft.phase_id);
  phase.onchange = () => (msDraft.phase_id = phase.value);
  const btn = node('button', 'ms-btn primary', 'Add');
  btn.onclick = async () => {
    const body = { project_id: projectId, title: msDraft.title, date: msDraft.date };
    if (msDraft.phase_id) body.phase_id = msDraft.phase_id;
    if (await msWrite('POST', '/milestones', body)) {
      msDraft = { title: '', date: '', phase_id: '' };
      loadSchedule();
    }
  };
  add.append(title, date, phase, btn);
  const err = node('div', 'ms-error', msError);
  err.setAttribute('role', 'alert');
  const focused = document.activeElement && host.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
  host.replaceChildren(head, list, add, err);
  if (focused) host.querySelector(`[aria-label="${CSS.escape(focused)}"]`)?.focus();
}

function cardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = card.id;
  if (card.tag) el.dataset.tag = card.tag;
  if (card.blocked) el.classList.add('blocked');
  if (kanbanHighlight.has(card.id)) el.classList.add('mx-hl');
  const meta = [
    card.blocked && `<span class="blocked-pill" title="${esc(card.blocked_reason ?? '')}">✋ blocked</span>`,
    card.tag && `<span class="tag" title="${esc(team(card.tag).name)}">${esc(team(card.tag).name)}</span>`,
    Object.hasOwn(WORK_TYPE_LABEL, card.work_type ?? '') && `<span class="wt wt-${card.work_type}">${WORK_TYPE_LABEL[card.work_type]}</span>`,
    card.agent && `<span class="agent" title="${esc(card.agent)}">${esc(card.agent)}</span>`,
    card.skill && `<span class="skill" title="${esc(card.skill)}">✦ ${esc(card.skill)}</span>`,
    card.rounds > 0 && `<span class="rounds${card.rounds >= 2 ? ' cap' : ''}">R${card.rounds}</span>`,
    card.subs && `<span class="subs">${card.subs.done}/${card.subs.total}</span>`,
  ].filter(Boolean).join('');
  const bar = card.subs
    ? `<div class="bar"><div class="bar-fill" style="width:${(100 * card.subs.done) / card.subs.total}%"></div></div>`
    : '';
  el.innerHTML = `<div class="title">${esc(card.title)}</div><div class="meta">${meta}</div>${bar}`;
  const age = ageBadge(card.lane, card.lane_since, kanbanSettings());
  if (age) el.querySelector('.meta').append(age);
  if (!el.querySelector('.meta').childElementCount) el.querySelector('.meta').remove();
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
let cardWtError = null; // { id, msg }: the last failed work-type change, shown inline until the next try
const cardWtPending = new Map(); // card id → the work type a PATCH in flight is saving ('' = unclassified)

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

let cardModalOpener = null; // the element that had focus when the modal opened: focus goes back to it
async function openCardModal(cardId) {
  const modal = document.getElementById('card-modal');
  if (modal.classList.contains('hidden')) {
    const a = document.activeElement;
    cardModalOpener = a && a !== document.body && !modal.contains(a) ? a : null;
  }
  openCardId = cardId;
  cardWtError = null;
  modal.classList.remove('hidden');
  document.getElementById('card-close').focus({ preventScroll: true });
  await refreshCardModal();
}

function closeCardModal() {
  openCardId = null;
  const modal = document.getElementById('card-modal');
  const wasOpen = !modal.classList.contains('hidden');
  modal.classList.add('hidden');
  const opener = cardModalOpener;
  cardModalOpener = null;
  if (wasOpen && opener?.isConnected && (!document.activeElement || document.activeElement === document.body || modal.contains(document.activeElement))) opener.focus({ preventScroll: true });
}
// Esc closes the card modal, unless a dialog opened over it (settings, a vertical dialog, a drill…) owns Esc.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openCardId || e.defaultPrevented) return;
  if (svModal || !$('settings-modal').classList.contains('hidden') || document.querySelector('[aria-modal="true"]')) return;
  e.preventDefault();
  closeCardModal();
});

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
    { workType: task.work_type ?? '' },
    { estimate: task.estimate_hours ?? null },
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
  const metaEl = document.getElementById('card-meta');
  const wtFocused = document.activeElement?.closest?.('.cm-wt-sel') && metaEl.contains(document.activeElement);
  // a live update while the estimate is being typed keeps the draft and the caret
  const estInput = metaEl.querySelector('.cm-est-in');
  const estDraft = estInput && document.activeElement === estInput ? estInput.value : null;
  // removing the focused input blurs it, and Chrome then fires `change`: that must not save the draft
  if (estDraft !== null) estInput.onchange = estInput.onblur = null;
  metaEl.replaceChildren(
    ...meta.map((m) => {
      if (typeof m === 'string') return node('span', '', m);
      if ('workType' in m) return cardWorkTypeEl(task.id, m.workType);
      if ('estimate' in m) return cardEstimateEl(task.id, m.estimate);
      const member = teamByName.get(m.agent);
      if (!member) return node('span', '', `● ${m.agent}`);
      const chip = node('span', 'cm-agent');
      chip.append(avatarEl(member, 14), node('span', '', m.agent));
      return chip;
    }),
  );
  if (wtFocused) metaEl.querySelector('.cm-wt select')?.focus(); // a live update mid-choice keeps focus
  if (estDraft !== null) {
    const el = metaEl.querySelector('.cm-est-in');
    if (el) {
      el.value = estDraft;
      el.focus();
    }
  }
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

// The meta line's work type: a select ("Unclassified" + the 4 types) that PATCHes the card;
// a failure shows inline next to it (the live card update re-renders on success). The PATCH in
// flight lives in cardWtPending, so a select redrawn meanwhile shows its value, disabled, and
// the outcome lands on whichever select is on screen for the card when it completes.
const cardWtCurrent = (id) => (openCardId === id ? document.querySelector('#card-meta .cm-wt-sel')?.closest('.cm-wt-wrap') ?? null : null);
function cardWtPaint(wrap, value, pending, error) {
  const field = wrap.querySelector('.cm-wt');
  const sel = wrap.querySelector('select');
  if (value) field.dataset.wt = value;
  else delete field.dataset.wt;
  sel.value = value;
  sel.disabled = pending;
  wrap.querySelector('.cm-wt-err').textContent = error;
}
async function cardWtSave(id, prev, next) {
  if (cardWtPending.has(id)) return; // one PATCH at a time per card
  cardWtPending.set(id, next);
  cardWtError = null;
  const now = cardWtCurrent(id);
  if (now) cardWtPaint(now, next, true, '');
  let msg = null;
  try {
    const res = await fetch(`/task/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ work_type: next || null }),
    });
    if (!res.ok) msg = (await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`;
  } catch {
    msg = 'Daemon unreachable';
  }
  cardWtPending.delete(id);
  if (msg) cardWtError = { id, msg: `Couldn't change type: ${msg}` };
  const wrap = cardWtCurrent(id); // the select on screen now (a live update may have redrawn it)
  if (!wrap) return;
  // failure: back to what the card still has; success: the saved value (the live update follows)
  cardWtPaint(wrap, msg ? prev : next, false, msg ? cardWtError.msg : '');
  if (msg) wrap.querySelector('select').focus();
}
function cardWorkTypeEl(id, value) {
  const wrap = node('span', 'cm-wt-wrap');
  const field = node('label', 'cm-wt');
  field.append(node('span', 'cm-wt-k', 'Type'));
  const sel = node('select', 'cm-wt-sel');
  for (const [v, text] of [['', 'Unclassified'], ...WORK_TYPES]) {
    const o = node('option', '', text);
    o.value = v;
    sel.append(o);
  }
  sel.setAttribute('aria-label', 'Work type');
  sel.onchange = () => cardWtSave(id, value, sel.value);
  field.append(sel);
  const err = node('span', 'cm-wt-err');
  err.setAttribute('role', 'alert');
  wrap.append(field, err);
  const pending = cardWtPending.has(id);
  cardWtPaint(wrap, pending ? cardWtPending.get(id) : value, pending, cardWtError?.id === id ? cardWtError.msg : '');
  return wrap;
}

// The meta line's "Est. human hours": a number input (empty = no estimate) that PATCHes
// estimate_hours on Enter or on change (blur); a bad value or a failed save shows inline next to
// it. `state.saved` is the last value sent, so Enter, change and blur save once. Unparseable text
// (validity.badInput, e.g. "1e": the input then reads "") is an error, never a clear.
async function cardEstimateSave(id, input, err, state) {
  if (input.validity.badInput) {
    err.textContent = 'Enter hours > 0 and ≤ 1000, or leave it empty';
    return;
  }
  const raw = input.value.trim();
  const next = raw === '' ? null : Number(raw);
  if (next !== null && !(Number.isFinite(next) && next > 0 && next <= 1000)) {
    err.textContent = 'Enter hours > 0 and ≤ 1000, or leave it empty';
    return;
  }
  if (next === state.saved) {
    err.textContent = '';
    return;
  }
  const prev = state.saved;
  state.saved = next;
  input.disabled = true;
  let msg = null;
  try {
    const res = await fetch(`/task/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estimate_hours: next }),
    });
    if (!res.ok) msg = (await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`;
  } catch {
    msg = 'Daemon unreachable';
  }
  input.disabled = false;
  if (msg) state.saved = prev;
  err.textContent = msg ? `Couldn't save the estimate: ${msg}` : '';
  if (msg) input.focus();
}
function cardEstimateEl(id, value) {
  const wrap = node('span', 'cm-est-wrap');
  const field = node('label', 'cm-est');
  field.append(node('span', 'cm-est-k', 'Est. human hours'));
  const input = node('input', 'cm-est-in');
  Object.assign(input, { type: 'number', min: '0', max: '1000', step: 'any', placeholder: '—', value: value ?? '' });
  input.setAttribute('aria-label', 'Estimated human hours');
  const err = node('span', 'cm-est-err');
  err.setAttribute('role', 'alert');
  const state = { saved: value };
  input.onchange = () => cardEstimateSave(id, input, err, state);
  input.onblur = () => cardEstimateSave(id, input, err, state); // a draft kept across a re-render fires no change
  input.onkeydown = (e) => {
    if (e.key === 'Enter') cardEstimateSave(id, input, err, state); // also a draft kept across a re-render (no change event)
  };
  field.append(input);
  wrap.append(field, err);
  return wrap;
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
    const { files } = await (await gitApi(`/git/status?project=${projectId}&quiet=1`)).json();
    railScm.dataset.count = files.length ? String(files.length) : '';
  } catch {
    railScm.dataset.count = ''; // not a git repo / daemon hiccup
  }
}

async function refreshFiles() {
  const { branch, base, files, remote } = await (await gitApi(`/git/status?project=${projectId}`)).json();
  const vs = base && base !== 'HEAD' ? ` vs ${base}` : '';
  $('scm-branch').textContent = `${files.length} change${files.length === 1 ? '' : 's'} · ${branch}${vs}`;
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
  else $('git-diff').innerHTML = `<div class="dl meta"><span class="ln"></span><span class="ln"></span><span class="dt">${vs ? `no changes${esc(vs)}` : 'working tree clean'}</span></div>`;
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

// ── out-of-date daemon banner ──
// /config carries the fingerprint of the daemon code it started with, /version the
// one on disk now; they differ once the daemon's code changed under it. Checked on
// load and every few minutes; dismissed for the rest of the browser session.
const VERSION_DISMISS_KEY = 'kankan.versionBannerDismissed';
const VERSION_CHECK_MS = 3 * 60_000;
async function checkDaemonVersion() {
  const banner = $('version-banner');
  $('version-banner-close').onclick = () => {
    sessionStorage.setItem(VERSION_DISMISS_KEY, '1');
    banner.classList.add('hidden');
  };
  const check = async () => {
    if (sessionStorage.getItem(VERSION_DISMISS_KEY)) return;
    try {
      const cfg = await (await fetch('/config')).json();
      // no version field at all: the daemon predates this check, so it is older than this page
      if (!('version' in cfg)) return banner.classList.remove('hidden');
      if (!cfg.version) return; // not on this machine (loopback only)
      const res = await fetch('/version');
      if (!res.ok) return;
      const disk = await res.json();
      banner.classList.toggle('hidden', disk.fingerprint === cfg.version.fingerprint); // sha is informational only
    } catch {
      /* daemon unreachable: the offline badge covers it */
    }
  };
  await check();
  setInterval(check, VERSION_CHECK_MS);
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
  // never changed → Home; the retired Attention / Smart choices land on Kanban
  defaultView: ({ smart: 'kanban', attention: 'kanban' })[localStorage.getItem('settings.defaultView')] || localStorage.getItem('settings.defaultView') || 'home',
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
  if (tab === 'board') renderBoardSettings();
  if (tab === 'prices') loadPrices();
}

// Prices tab: the global price table (GET / PUT /settings/prices), USD per million tokens.
const PRICE_TYPES = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cache_read', 'Cache read'],
  ['cache_creation', 'Cache write'],
];
const PRICE_MAX = 10_000;
const PRICE_MAX_MODELS = 200; // the server's limits (core/cost.ts)
const PRICE_MAX_ID = 200;
let pricesSeq = 0;
async function loadPrices() {
  const host = $('prices-editor');
  const seq = ++pricesSeq;
  host.replaceChildren(node('div', 'st-rowsub', 'Loading…'));
  try {
    const res = await fetch('/settings/prices');
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    if (seq === pricesSeq) renderPrices(body);
  } catch (err) {
    if (seq !== pricesSeq) return;
    const retry = node('button', 'st-ghost', 'Retry');
    retry.onclick = loadPrices;
    host.replaceChildren(node('div', 'pr-error', `Couldn't load the prices: ${err.message}`), retry);
  }
}
function renderPrices(table, saved = false) {
  const host = $('prices-editor');
  const num = (v) => {
    const i = node('input', 'st-num pr-num');
    i.type = 'number';
    i.min = '0';
    i.max = String(PRICE_MAX);
    i.step = 'any';
    i.value = v ?? '';
    return i;
  };
  const rows = []; // { id: input | null (the default row), rates: { type → input }, el }
  const list = node('div', 'pr-table');
  const head = node('div', 'pr-row pr-head');
  head.append(node('span', 'pr-model', 'Model'), ...PRICE_TYPES.map(([, label]) => node('span', 'pr-cell', label)), node('span', 'pr-del'));
  list.append(head);
  const addRow = (id, rates) => {
    const el = node('div', 'pr-row');
    let idInput = null;
    if (id === null) el.append(node('span', 'pr-model pr-default', 'Default (any other model)'));
    else {
      idInput = node('input', 'pr-id');
      idInput.value = id;
      idInput.placeholder = 'model id or prefix';
      idInput.setAttribute('aria-label', 'Model id');
      el.append(idInput);
    }
    const inputs = {};
    for (const [type, label] of PRICE_TYPES) {
      const i = num(rates?.[type]);
      i.setAttribute('aria-label', `${id === null ? 'Default' : id || 'New model'} ${label} (USD per million tokens)`);
      inputs[type] = i;
      el.append(i);
    }
    const row = { id: idInput, rates: inputs, el };
    if (id === null) el.append(node('span', 'pr-del'));
    else {
      const del = node('button', 'pr-del pr-del-btn', '✕');
      del.title = 'Remove model';
      del.setAttribute('aria-label', `Remove ${id || 'this model'}`);
      del.onclick = () => {
        rows.splice(rows.indexOf(row), 1);
        el.remove();
      };
      el.append(del);
    }
    rows.push(row);
    list.append(el);
    return row;
  };
  for (const [id, rates] of Object.entries(table.models)) addRow(id, rates);
  const def = addRow(null, table.default);
  list.append(def.el); // the default row stays last
  const status = node('div', 'pr-status');
  if (table.placeholder) {
    status.append(node('span', 'pr-badge', 'placeholder'), node('span', '', 'These are placeholder rates, not real prices. Set your rates and save.'));
  } else if (saved) status.append(node('span', 'pr-badge ok', 'saved'), node('span', '', 'Prices saved.'));
  else if (table.updated_at) status.append(node('span', '', `Last saved ${new Date(table.updated_at).toLocaleString()}`));
  const err = node('div', 'pr-error');
  err.setAttribute('role', 'alert');
  const add = node('button', 'st-ghost', 'Add model');
  add.onclick = () => {
    const r = addRow('', null);
    list.append(def.el);
    r.id.focus();
  };
  const save = node('button', 'st-primary', 'Save prices');
  save.onclick = async () => {
    err.textContent = '';
    for (const i of list.querySelectorAll('input')) i.classList.remove('bad');
    const problems = [];
    const bad = (input, msg) => {
      input.classList.add('bad');
      problems.push(msg);
    };
    const models = {};
    const seen = new Set();
    let dflt = null;
    for (const r of rows) {
      const rates = {};
      const name = r.id ? r.id.value.trim() : 'Default';
      if (r.id) {
        if (!name) bad(r.id, 'Every model needs an id');
        else if (name.length > PRICE_MAX_ID) bad(r.id, `Model ids can be at most ${PRICE_MAX_ID} characters`);
        else if (seen.has(name.toLowerCase())) bad(r.id, `${name} is listed twice`);
        seen.add(name.toLowerCase());
      }
      for (const [type, label] of PRICE_TYPES) {
        const i = r.rates[type];
        const v = i.value.trim() === '' || i.validity.badInput ? NaN : Number(i.value);
        if (!Number.isFinite(v) || v < 0 || v > PRICE_MAX) bad(i, `${name || 'A model'}: ${label} must be a number from 0 to ${PRICE_MAX.toLocaleString('en-US')}`);
        rates[type] = v;
      }
      if (r.id) models[name] = rates;
      else dflt = rates;
    }
    if (rows.length - 1 > PRICE_MAX_MODELS) problems.push(`At most ${PRICE_MAX_MODELS} models (remove ${rows.length - 1 - PRICE_MAX_MODELS})`);
    if (problems.length) {
      err.textContent = problems[0] + (problems.length > 1 ? ` (and ${problems.length - 1} more)` : '');
      return;
    }
    save.disabled = true;
    try {
      const res = await fetch('/settings/prices', { method: 'PUT', body: JSON.stringify({ models, default: dflt }) });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      renderPrices(body, true);
      if (activeView === 'metrics') mxLoad(); // costs + notes follow the new rates
    } catch (e) {
      err.textContent = e.message;
      save.disabled = false;
    }
  };
  const actions = node('div', 'pr-actions');
  actions.append(add, node('div', 'mx-grow'), save);
  host.replaceChildren(status, list, err, actions);
}

// Board tab: this board's stuck thresholds (hours) + WIP limits, saved server-side on change.
function renderBoardSettings() {
  const host = $('board-settings');
  if (!projectId) return void host.replaceChildren(node('div', 'st-rowsub', 'Open a board first.'));
  const s = kanbanSettings();
  const row = (title, sub, value, placeholder, save) => {
    const r = node('div', 'st-list-row');
    const text = node('div', 'st-rowtext');
    text.append(node('div', 'st-rowtitle', title), node('div', 'st-rowsub', sub));
    const input = node('input', 'st-num');
    input.type = 'number';
    input.min = '1';
    input.value = value ?? '';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', title);
    input.onchange = () => save(input);
    r.append(text, input);
    return r;
  };
  const put = async (patch, input) => {
    input.classList.remove('bad');
    try {
      const res = await fetch(`/project/${encodeURIComponent(projectId)}/settings`, { method: 'PUT', body: JSON.stringify(patch) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      boardSettings = await res.json();
      renderBoard();
    } catch (err) {
      input.classList.add('bad');
      input.title = err.message;
    }
  };
  const rows = [];
  for (const [lane, label] of Object.entries(AGE_LANES)) {
    rows.push(
      row(`${label} stuck after`, 'Hours a card can sit in this lane before it is flagged stuck', s.stuck_hours[lane], 'hours', (input) => {
        const v = Number(input.value);
        put({ stuck_hours: { [lane]: v } }, input);
      }),
    );
  }
  for (const lane of ['in_progress', 'in_review']) {
    rows.push(
      row(`${AGE_LANES[lane]} WIP limit`, 'Warn when the lane holds more cards than this (empty = no limit)', s.wip[lane], 'none', (input) => {
        put({ wip: { [lane]: input.value === '' ? null : Number(input.value) } }, input);
      }),
    );
  }
  host.replaceChildren(...rows);
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

function openSettings(tab) {
  $('settings-modal').classList.remove('hidden');
  showSettingsTab(tab);
  renderGeneral();
}
$('settings-btn').onclick = () => openSettings('general');
$('settings-close').onclick = () => $('settings-modal').classList.add('hidden');
$('settings-modal').onclick = (e) => { if (e.target === $('settings-modal')) $('settings-modal').classList.add('hidden'); };
for (const b of document.querySelectorAll('.st-tab')) b.onclick = () => showSettingsTab(b.dataset.tab);
$('team-add-toggle').onclick = () => $('team-form').classList.toggle('hidden');
$('team-cancel').onclick = () => $('team-form').classList.add('hidden');
$('team-add-btn').onclick = addTeamMember;

// ── workspace dashboard: one live tile per board (Main + verticals) ───
// Only an OBS scene's URL opens it now: ?project=<id>&view=dashboard&embed=1. Home is the
// landing page, so ?view=dashboard without embed opens Home.
// Every user-controlled string goes in via textContent (node() below) — never innerHTML.
const EMBED = new URLSearchParams(location.search).get('embed') === '1';
const URL_VIEW_RAW = new URLSearchParams(location.search).get('view');
// ?view=stats: the old Stats view's links; ?view=dashboard (not embedded): the old Dashboard's links
const URL_VIEW = URL_VIEW_RAW === 'stats' ? 'metrics' : URL_VIEW_RAW === 'dashboard' && !EMBED ? 'home' : URL_VIEW_RAW;
const URL_VIEWS = ['home', 'kanban', 'scm', 'phases', 'metrics', 'planner', 'governance'];
const dash = { checked: false, workspace: null, summary: null, summaryKey: '', loadSeq: 0, failed: false, fetchRetry: 1000, ids: new Set(), ws: null, retry: 1000, retryTimer: null, refetchTimer: null, refetchFirst: null, skipOpenFetch: false, nudged: new Map() };
const DASH_LANES = [['backlog', 'backlog'], ['queued', 'queued'], ['in_progress', 'in prog'], ['in_review', 'review'], ['done', 'done']];
const DASH_STATE = { working: 'working', idle: 'idle', needs_you: '⚠ needs you', offline: 'offline' };
const DASH_MAX_CARDS = 5;
// the dashboard's filters (shared filter bar): the range counts done cards only
const dctx = { f: fbReadUrl(new URLSearchParams(), 'all'), meta: null, metaSeq: 0, metaDirty: true, metaReady: null, customOpen: false, window: null, open: false, rangeDefault: 'all', workspaceId: null };
const DASH_FILTER_FIELDS = ['scope', 'phase', 'tag', 'agent', 'workType', 'range'];
const DASH_NUDGE_PULSE_MS = 2400;

if (EMBED) document.body.classList.add('embed');
// Resolves once initDashboard's /workspace probe has settled; setInitialView
// waits on it before applying the default view when ?view=dashboard is set.
let dashProbeDone;
const dashProbe = new Promise((r) => (dashProbeDone = r));

function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

// Once per page: is the current project part of a workspace? Honors ?view=dashboard&embed=1.
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
  if (view) dctx.workspaceId = dash.workspace = view.workspace.id;
  if (URL_VIEW === 'dashboard' && inWorkspace && !initialViewSet) {
    initialViewSet = true; // the URL wins over the default-view setting
    setView('dashboard');
  }
  dashProbeDone();
}

// The summary under the dashboard's filters (the server filters the counts, in-flight cards,
// phase bars and Needs you); key: the filters it was read with.
async function loadDashboard() {
  const project = dash.workspace ?? currentProject();
  if (!project) return;
  const seq = ++dash.loadSeq;
  const key = fbParams(dctx, true);
  const params = fbParams(dctx);
  try {
    const res = await fetch(`/workspace/summary?project=${encodeURIComponent(project)}${params ? `&${params}` : ''}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const summary = await res.json();
    if (seq !== dash.loadSeq) return; // a newer load (other filters) owns the view
    dash.summary = summary;
    dash.summaryKey = key;
  } catch {
    if (seq !== dash.loadSeq) return;
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
  dctx.workspaceId = dash.workspace = dash.summary.workspace.id;
  dash.ids = new Set(dash.summary.boards.map((b) => b.project.id));
  dctx.metaDirty = true;
  if (activeView === 'dashboard') {
    renderDashboard();
    // once per open (the filter options), and on every refetch while filtered (fresh options + drill lists)
    if (dctx.needMeta || fbCardFiltered(dctx) || (dashActive() && !dctx.meta)) {
      dctx.needMeta = false;
      dashReloadMeta();
    }
  }
}

// Embed (OBS) has no chip: its filters come from the URL only, and without any the cards aren't needed.
const dashActive = () => fbAnyActive(dctx, DASH_FILTER_FIELDS);
function dashReloadMeta() {
  return fbReloadMeta(dctx, dash.workspace ?? currentProject(), () => activeView === 'dashboard' && renderDashboard());
}
// Fresh meta for a drill-down (the counts may have moved, or the filters changed, since it loaded).
async function dashMeta() {
  if (!dctx.meta || dctx.metaDirty || dctx.meta.key !== fbParams(dctx, true)) await dashReloadMeta();
  return dctx.meta;
}
function dashSetFilter(patch) {
  dctx.f = { ...dctx.f, ...patch, tz: MX_LOCAL_TZ };
  fbSyncUrl('dashboard', dctx);
  renderDashboard(); // "Loading…" until the summary for these filters lands
  renderDashFilters(true);
  loadDashboard();
}
// The summary on screen was read with other filters (one for these is on its way).
const dashLoading = () => dash.summaryKey !== fbParams(dctx, true);
// Boards the filters leave on the dashboard (scope; a phase → its board): the server's call.
const dashShown = () => dash.summary.boards.filter((b) => b.shown !== false);
// force: open / a filter change. Otherwise (a refetch or load landed) only when stale, and
// never while the user is in the bar.
function renderDashFilters(force) {
  const host = $('dashboard-body').querySelector('.dash-filters');
  if (!host || EMBED) return;
  const opts = { fields: DASH_FILTER_FIELDS, onChange: dashSetFilter, barId: 'dash-fb-bar' };
  if (force) filterChip(host, dctx, opts);
  else if (dctx.filtersStale) filterChipSoft(host, dctx, opts);
}
const dashRangeLabel = () => (dctx.f.range === 'all' ? '' : `done ${dctx.f.range === 'custom' ? fbWindowLabel(dctx) : `in ${dctx.f.range}`}`);
// The tiny done-lane label: "done 2w", "done Aug 3–Sep 26" (fbWindowLabel's dates, the spaces dropped).
const dashDoneLabel = () => `done ${dctx.f.range === 'custom' ? fbWindowLabel(dctx).replace(' – ', '–') : dctx.f.range}`;
async function dashDrillLane(b, lane, isMain) {
  const meta = await dashMeta();
  if (!meta || activeView !== 'dashboard') return;
  const name = isMain ? 'Main' : b.project.name;
  const list = fbCards(dctx, (c) => c.board === b.project.id && c.lane === lane);
  fbDrillCards(dctx, dashboardView, {
    kicker: `${name} · ${LANE_LABELS[lane]}`.toUpperCase(),
    title: lane === 'done' ? `${mxPlural(list.length, 'card')} done` : `${mxPlural(list.length, 'card')} in ${LANE_LABELS[lane]}`,
    cards: list,
    range: lane === 'done' ? dashRangeLabel() : '',
  });
}
// The "Needs you" list under the filters: sessions are board-level (the shown boards; no card
// to tag, assign or type, so a tag / agent / type filter hides them); attention items are cards (the server
// filters them).
function dashNeedsYou() {
  const f = dctx.f;
  const waiting = dashShown().filter((b) => b.session?.state === 'needs_you' && !f.tag && !f.agent && !f.workType);
  return { waiting, items: dash.summary.attention ?? [] };
}
async function dashDrillNeedsYou() {
  await dashMeta();
  if (activeView !== 'dashboard') return;
  const { waiting, items } = dashNeedsYou();
  const now = Date.now();
  const rows = [
    ...waiting.map((b) => ({
      id: null,
      title: `${dashBoardName(b.project.id, b.project.name)} is waiting for you`,
      board: b.project.id,
      agent: null,
      when: b.session.main?.detail ? `needs you: ${b.session.main.detail}` : 'needs you',
      value: now - (b.session.main?.at ?? now),
      valueText: b.session.main?.at ? mxWait(now - b.session.main.at) : '',
    })),
    ...items.map((i) => {
      const c = dctx.meta?.cards.get(i.card_id);
      return {
        id: i.card_id,
        title: i.title,
        board: i.project_id,
        agent: i.agent ?? null,
        when: [c ? LANE_LABELS[c.lane] : null, i.reason].filter(Boolean).join(' · '),
        value: now - i.since,
        valueText: mxWait(now - i.since),
      };
    }),
  ];
  mxOpenDrill({
    ctx: dctx,
    host: dashboardView,
    unit: waiting.length ? 'item' : 'card', // a waiting session isn't a card
    kicker: 'NEEDS YOU · NOW',
    title: `${mxPlural(rows.length, 'item')} need${rows.length === 1 ? 's' : ''} you`,
    sub: fbScopeLabel(dctx),
    stat: 'waiting',
    rows,
    sorts: [
      ['value', 'Longest waiting', (a, b) => b.value - a.value],
      ['board', 'Board', (a, b) => mxByBoard(a, b, dctx.meta)],
    ],
  });
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
  } else if (msg.type === 'settings') {
    const b = dash.summary?.boards.find((x) => x.project.id === pid);
    if (!b) return;
    b.settings = msg.settings; // this board's tile only
    replaceDashTile(b);
  } else if (['card', 'card_removed', 'phases', 'verticals', 'event'].includes(msg.type)) {
    scheduleDashboardRefetch();
  }
}

function replaceDashTile(b) {
  const old = $('dashboard-body').querySelector(`.dash-tile[data-id="${CSS.escape(b.project.id)}"]`);
  if (old) old.replaceWith(dashTile(b, dash.summary.boards.indexOf(b) === 0));
}

function openDashboard() {
  dctx.f = { ...fbReadUrl(new URLSearchParams(location.search), 'all'), tz: MX_LOCAL_TZ };
  dctx.customOpen = false;
  dctx.open = false; // the chip starts collapsed
  dctx.needMeta = !EMBED || dashActive(); // loaded once the summary lands (loadDashboard)
  loadTeamCache(); // fresh names / avatars for the tiles' agent chips
  renderDashboard(); // last good summary, or the loading state
  renderDashFilters(true);
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
  const boards = dashShown();
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
  if (dashLoading()) grid.append(node('div', 'dt-empty', 'Loading the filtered boards…'));
  else {
    const shown = dashShown();
    grid.append(...shown.map((b) => dashTile(b, b === dash.summary.boards[0])));
    if (!shown.length) grid.append(node('div', 'dt-empty', 'No boards match the filters.'));
  }
  const layout = node('div', 'dash-layout');
  layout.append(grid, node('aside', 'dash-attn'));
  // the head row (name + filters) is built once and kept: a refetch never touches the filter controls
  let top = host.querySelector(':scope > .dash-top');
  const old = host.querySelector(':scope > .dash-layout');
  if (top && old) old.replaceWith(layout);
  else {
    top = node('div', 'dash-top');
    top.append(node('div', 'dash-head'), node('div', 'dash-filters fb-host'));
    host.replaceChildren(top, layout);
    dctx.filtersStale = true;
  }
  renderDashHead();
  renderDashFilters(false);
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
  if (dashLoading()) {
    const head = node('div', 'da-head');
    head.append(node('span', 'da-title', 'Needs you'));
    return panel.replaceChildren(head, node('div', 'da-empty', 'Loading…'));
  }
  const { waiting, items } = dashNeedsYou();
  const total = waiting.length + items.length;

  const head = node('div', 'da-head');
  head.append(node('span', 'da-title', 'Needs you'));
  if (total) {
    const count = node(clickable ? 'button' : 'span', `da-count${waiting.length || items.some((i) => i.severity === 'blocker') ? ' hot' : ''}`, total);
    if (clickable) {
      count.type = 'button';
      count.title = 'List them';
      count.setAttribute('aria-label', `${total} need you: list them`);
      count.onclick = dashDrillNeedsYou;
    }
    head.append(count);
  }
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

  if (!total) list.append(node('div', 'da-empty', fbCardFiltered(dctx) || dctx.f.scope ? 'Nothing matching needs you.' : 'Nothing needs you.'));
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

  // lane counts (the server's, under the filters; filtered: no WIP limits); each opens its cards
  const filtered = fbCardFiltered(dctx);
  const counts = b.lanes ?? {};
  const lanes = node('div', 'dt-lanes');
  for (const [lane, label] of DASH_LANES) {
    const l = node(EMBED ? 'div' : 'button', 'dt-lane');
    l.dataset.lane = lane;
    const n = counts ? (counts[lane] ?? 0) : null;
    const wip = filtered || n === null ? null : wipOf(lane, n, b.settings ?? DEFAULT_BOARD_SETTINGS);
    const ranged = lane === 'done' && dctx.f.range !== 'all';
    l.append(node('span', 'dt-lane-n', n === null ? '…' : wip ? `${n}/${wip.limit}` : n), node('span', `dt-lane-l${ranged ? ' ranged' : ''}`, ranged ? dashDoneLabel() : label));
    if (!EMBED) {
      l.type = 'button';
      l.title = ranged ? `Done ${fbWindowLabel(dctx)}: list them` : `List the ${LANE_LABELS[lane]} cards`;
      l.onclick = (e) => {
        e.stopPropagation(); // the tile itself opens the board
        dashDrillLane(b, lane, isMain);
      };
    }
    if (wip?.over) {
      l.classList.add('wip-over');
      l.title = `Over the WIP limit: ${n} cards, limit ${wip.limit}`;
    }
    lanes.append(l);
  }
  tile.append(lanes);

  // phase: the filter's (when it's this board's), else the active one (the server's, under the filters)
  const phase = b.phase;
  if (phase) {
    const ph = node('div', 'dt-phase');
    const row = node('div', 'dt-phase-row');
    row.append(node('span', 'dt-phase-title', phase.title), node('span', 'dt-phase-n', `${phase.done}/${phase.total}`));
    const bar = node('div', 'dt-bar');
    const fill = node('span', 'dt-bar-fill');
    fill.style.width = `${phase.total ? Math.round((100 * phase.done) / phase.total) : 0}%`;
    bar.append(fill);
    ph.append(row, bar);
    tile.append(ph);
  }

  // active cards (the server's, under the filters)
  const list = node('div', 'dt-cards');
  const active = b.active ?? [];
  if (!active.length) list.append(node('div', 'dt-empty', 'nothing in flight'));
  for (const c of active.slice(0, DASH_MAX_CARDS)) {
    const row = node('div', `dt-card${c.blocked ? ' blocked' : ''}`);
    row.dataset.lane = c.lane;
    row.append(node('span', 'dt-card-mark'), node('span', 'dt-card-title', c.title));
    const age = ageBadge(c.lane, c.lane_since, b.settings ?? DEFAULT_BOARD_SETTINGS);
    if (age) row.append(age);
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
const home = { data: null, key: '', loadSeq: 0, failed: false, sessions: new Map(), project: null };
// status is applied in place (applyHomeStatus), never refetched; init = board socket (re)connected (the
// page's first init doesn't refetch when Home's open already read /home: see onHomeMessage)
const HOME_REFETCH = ['init', 'card', 'card_removed', 'phases', 'event', 'verticals', 'autopilot'];
// Home's filters (shared filter bar). lockScope: Home on a vertical covers that board only.
// widgetRange: the date range reaches the widgets only (ctx.filters: agent history, KPIs);
// /home and the card meta are read without it, so live state (now building, up next, agents,
// lane counts) never narrows by it.
const HOME_DEFAULT_RANGE = '4w';
const hctx = { f: fbReadUrl(new URLSearchParams(), HOME_DEFAULT_RANGE), meta: null, metaSeq: 0, metaDirty: true, metaReady: null, customOpen: false, window: null, open: false, rangeDefault: HOME_DEFAULT_RANGE, widgetRange: true, lockScope: null, workspaceId: null };
const homeFields = () => (hctx.meta && hctx.meta.boards.length > 1 && !hctx.lockScope ? ['scope', 'phase', 'tag', 'agent', 'workType', 'range'] : ['phase', 'tag', 'agent', 'workType', 'range']);
const homeScoped = () => !!hctx.f.scope && hctx.f.scope !== fbDefaults(hctx).scope;
const homeFiltered = () => !!(hctx.f.phase || hctx.f.tag || hctx.f.agent || hctx.f.workType || homeScoped());

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

// Home's range survives leaving Home (this tab's session storage, per project); a range in the URL wins.
const homeRangeKey = () => `kankan.home.range.${currentProject()}`;
function homeSaveRange() {
  if (EMBED) return;
  const { range, from, to } = hctx.f;
  try {
    if (range === HOME_DEFAULT_RANGE) sessionStorage.removeItem(homeRangeKey());
    else sessionStorage.setItem(homeRangeKey(), JSON.stringify({ range, from, to }));
  } catch {
    /* storage unavailable: the range just doesn't persist */
  }
}
function homeStoredRange() {
  if (EMBED) return null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(homeRangeKey()) ?? 'null');
    if (!saved || typeof saved.range !== 'string') return null;
    const { range, from, to } = fbReadUrl(new URLSearchParams({ range: saved.range, from: saved.from ?? '', to: saved.to ?? '' }), HOME_DEFAULT_RANGE);
    return range === HOME_DEFAULT_RANGE || (range === 'custom' && !from) ? null : { range, from, to };
  } catch {
    return null;
  }
}

function openHome() {
  const q = new URLSearchParams(location.search);
  hctx.f = { ...fbReadUrl(q, HOME_DEFAULT_RANGE), tz: MX_LOCAL_TZ };
  const stored = q.has('range') ? null : homeStoredRange();
  if (stored) Object.assign(hctx.f, stored);
  else if (q.has('range')) homeSaveRange(); // the URL's range is the one to come back to
  if (hctx.lockScope) hctx.f.scope = hctx.lockScope;
  if (stored) fbSyncUrl('home', hctx); // the restored range in the URL, as if just picked
  hctx.customOpen = false;
  hctx.open = false; // the chip starts collapsed
  hctx.needMeta = !EMBED || homeFiltered(); // loaded once /home lands (loadHome)
  if (homeFiltered()) loadTeamCache(); // a filtered /home carries only the matching agents, not the roster
  renderHome(); // last good data, or the loading state
  renderHomeFilters(true);
  if (typeof dwOpen === 'function') dwOpen(); // dashboard.js may load after an early setView('home')
  loadHome();
}

function homeReloadMeta() {
  const project = currentProject();
  if (!project) return Promise.resolve(null);
  return fbReloadMeta(hctx, project, () => {
    hctx.lockScope = project !== hctx.meta.workspaceId ? project : null;
    if (hctx.lockScope) hctx.f.scope = hctx.lockScope;
    if (activeView !== 'home') return;
    renderHome();
    if (typeof dwRetitle === 'function') dwRetitle(); // widgets' override chips name phases / boards now
    if (typeof dwRepaint === 'function') dwRepaint(['now-building']); // its phase chips read the meta
  });
}
async function homeMeta() {
  if (!hctx.meta || hctx.metaDirty || hctx.meta.key !== fbParams(hctx, true, false)) await homeReloadMeta();
  return hctx.meta;
}
function homeSetFilter(patch) {
  const liveKey = fbParams(hctx, true, false);
  hctx.f = { ...hctx.f, ...patch, tz: MX_LOCAL_TZ };
  if (hctx.lockScope) hctx.f.scope = hctx.lockScope;
  fbSyncUrl('home', hctx);
  homeSaveRange();
  // only the range changed: /home (live state) stands, so no refetch and no "Loading…";
  // just the widgets reading the range (agent history, KPIs) reload
  if (home.data && home.key === liveKey && fbParams(hctx, true, false) === liveKey && typeof dwRangeRefresh === 'function') {
    renderHomeFilters(true);
    return dwRangeRefresh();
  }
  renderHome(); // "Loading…" until /home for these filters lands
  renderHomeFilters(true);
  loadHome();
}
// force: open / a filter change. Otherwise (a refetch or load landed) only when stale, and
// never while the user is in the bar.
function renderHomeFilters(force) {
  const host = $('home-filters');
  if (!host || EMBED) return;
  // fields read live: a deferred redraw (focus left the bar) after the meta landed shows Scope too
  const opts = { get fields() { return homeFields(); }, onChange: homeSetFilter, barId: 'home-fb-bar' };
  if (force) filterChip(host, hctx, opts);
  else if (hctx.filtersStale) filterChipSoft(host, hctx, opts);
}
// Now building: /home's, read under the filters (the server applies them).
const homeNowItems = () => home.data.now_building;
// title: the calling widget's (ctx.title): "Open all" names it ("Home · Verticals")
const homeDrillSource = (title) => (title ? `Home · ${title}` : 'Home');
async function homeDrillLane(project, lane, title) {
  await homeMeta();
  if (activeView !== 'home') return;
  const list = fbCards(hctx, (c) => c.board === project.id && c.lane === lane);
  fbDrillCards(hctx, homeView, {
    kicker: `${homeBoardName(project)} · ${LANE_LABELS[lane]}`.toUpperCase(),
    title: lane === 'done' ? `${mxPlural(list.length, 'card')} done` : `${mxPlural(list.length, 'card')} in ${LANE_LABELS[lane]}`,
    cards: list,
    source: homeDrillSource(title), // its one caller: the Verticals widget's lane counts
  });
}
async function homeDrillNow(title) {
  await homeMeta();
  if (activeView !== 'home' || !home.data) return;
  const items = homeNowItems();
  const list = items.map((it) => ({ ...(hctx.meta?.cards.get(it.id) ?? {}), id: it.id, title: it.title, board: it.board.id, lane: it.lane, agent: it.agent, lane_since: it.since, blocked: it.blocked }));
  fbDrillCards(hctx, homeView, { kicker: 'NOW BUILDING', title: `${mxPlural(list.length, 'card')} in flight`, cards: list, source: homeDrillSource(title) });
}

// /home under Home's filters, without the range (live state); key: the filters it was read with.
async function loadHome() {
  const project = currentProject();
  if (!project) return;
  home.project = project; // the board this load reads (the first init skips its refetch, see onHomeMessage)
  const seq = ++home.loadSeq;
  const key = fbParams(hctx, true, false);
  const params = fbParams(hctx, false, false);
  let data;
  try {
    const res = await fetch(`/home?project=${encodeURIComponent(project)}${params ? `&${params}` : ''}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    if (seq !== home.loadSeq) return; // a newer load (other filters) owns the view
    home.sessions = new Map(data.verticals.map((v) => [v.project.id, v.session]));
    if (!data.verticals.length) {
      // standalone: /home carries no session → read it for the Send box's state
      const s = await fetch(`/session?project=${encodeURIComponent(data.project.id)}`);
      if (s.ok) home.sessions.set(data.project.id, await s.json());
    }
  } catch {
    if (seq !== home.loadSeq) return;
    home.failed = true;
    if (activeView !== 'home') return;
    renderHome();
    if (typeof dwRefresh === 'function') dwRefresh(null, new Error('Couldn’t load Home'));
    clearTimeout(dash.refetchTimer);
    dash.refetchTimer = setTimeout(loadHome, dash.fetchRetry);
    dash.fetchRetry = Math.min(dash.fetchRetry * 2, 10000);
    return;
  }
  if (seq !== home.loadSeq) return; // (the standalone session read above can outlast a newer load)
  home.failed = false;
  dash.fetchRetry = 1000;
  home.data = data;
  home.key = key;
  hctx.workspaceId = data.workspace?.workspace.id ?? data.project.id;
  renderStats();
  if (!key) setTeamCache(data.agents); // unfiltered /home carries the roster: keeps chips fresh after outside edits
  if (activeView !== 'home') return;
  hctx.metaDirty = true; // the cards may have moved: reload now while filtered (fresh options + drill lists)
  renderHome();
  if (typeof dwRefresh === 'function') dwRefresh(data); // the dashboard's widgets reload with this /home
  // after dwRefresh: the meta's /workspace/cards read lands in this refresh cycle, shared with the widgets
  if (hctx.needMeta || homeFiltered()) {
    hctx.needMeta = false;
    homeReloadMeta();
  }
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
  if (msg.type === 'init' && home.key) loadTeamCache(); // (re)connected while filtered: the roster isn't on /home
  // The page's first init brings only the board's cards / phases: when Home's open already read /home for
  // this board, repaint what reads them (the header's phase line, Now building's phase chips), no second
  // read. A reconnect refetches (anything missed while disconnected), as does an init Home still waits on.
  if (msg.type === 'init' && boardInits === 1 && home.project === currentProject() && !home.failed) {
    renderHome();
    if (typeof dwRepaint === 'function') dwRepaint(['now-building']);
  } else if (HOME_REFETCH.includes(msg.type)) scheduleDashboardRefetch();
  if (typeof dwOnMessage === 'function') dwOnMessage(msg); // widgets' onStatus; layout → refetch it
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
    renderHomeSplit();
    return;
  }
  renderHomeHead();
  renderHomeFilters(false);
  renderHomeSplit(); // the panels below the header are the dashboard's (#dash-root, dashboard.js)
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

// Type `text` into a board's Claude session (POST /pty/send: token-gated, idle
// sessions only). Used by Home's Send to agent and the planner's Run dialog.
async function ptySend(project, text) {
  try {
    const post = () => fetch(`/pty/send?${ptyQuery(project)}`, { method: 'POST', body: JSON.stringify({ text }) });
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
    if (r.status === 403) return { ok: false, message: 'Couldn’t reach the terminal — reload the page' };
    if (r.ok && out.sent) return { ok: true, message: 'Sent' };
    return { ok: false, message: out.error || `error ${r.status}` };
  } catch {
    return { ok: false, message: 'Could not reach the daemon' };
  }
}

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
    b.onclick = () => {
      selectPlanNode(n.id);
      if (!live) return; // Plan mode: the side editor opens
      const s = planLiveOf(v, n); // Live is read-only: open the board card's details in place
      if (s.cardId && s.kind !== 'removed') openCardModal(s.cardId);
    };
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
  const { errors } = v.validation;
  // shared files: the per-path groups stand in for the per-pair warnings (an older daemon has no groups)
  const groups = v.validation.groups;
  const warnings = groups ? [...groups, ...v.validation.warnings.filter((w) => w.code !== 'shared_file')] : v.validation.warnings;
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
      for (const p of b.phases) {
        const where = p.after ? `after ${p.after}` : 'first on this board';
        row('add', '+ phase', 'New phase ', plBold(p.name), ' ', plDim(b.activate === p.name ? `${where}, becomes active` : where));
      }
      if (b.activate && !b.phases.some((p) => p.name === b.activate)) row('edit', '~ phase', 'Phase ', plBold(b.activate), ' ', plDim('becomes active'));
      if (b.create.length) row('add', `+ ${b.create.length}`, b.create.map((c) => c.title || 'Untitled').join(' · '));
      // cards going into a phase that isn't the board's active one stay off its Kanban until that phase starts
      const later = new Map();
      if (b.active) {
        for (const c of b.create) if (c.phase && c.phase !== b.active) later.set(c.phase, (later.get(c.phase) ?? 0) + 1);
        for (const u of b.update) {
          const to = u.changes.phase?.to;
          if (to && to !== b.active) later.set(to, (later.get(to) ?? 0) + 1);
        }
      }
      for (const [ph, n] of later) row('wait', 'waits', n === 1 ? 'This card goes into ' : 'These cards go into ', plBold(ph), ', which starts after ', plBold(b.active), ' is finished');
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
    let lanes = null;
    if (r.ok) {
      // the explanatory text: where a deleted card was
      const dels = r.out.boards.flatMap((b) => b.delete.map((x) => x.card_id));
      const ln = await plFetchCards(dels);
      lanes = new Map();
      dels.forEach((c, i) => ln[i].ok && lanes.set(c, ln[i].out.lane));
    }
    if (seq !== st.seq || st.closed) return;
    st.loading = false;
    st.diff = r.ok ? r.out : null;
    // "The plan changed" belongs to the load it triggered; the next good load clears it
    if (r.ok && !st.keepNote) st.note = '';
    if (r.ok) st.keepNote = false;
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
  const st = {
    mode: 'queue',
    loading: true,
    busy: false,
    error: '',
    closed: false,
    cards: null,
    sessions: new Map(),
    phases: new Map(), // board → { active: phase id | null, byId: Map(id → { title, status }) }
    sending: false,
    sent: null,
    done: null, // after a Run that left Main's cards waiting: { head, summary, mode } (the dialog stays open for Send)
  };
  const { dlg, close, mount } = openModal({
    labelledBy: 'pl-run-title',
    describedBy: 'pl-run-sub',
    busy: () => st.busy,
    onClose: () => {
      st.closed = true;
      if (st.done) setTimeout(() => finish(st.done.summary, st.done.mode)); // after close() restores focus
    },
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
  a.text.append(aDesc, aSess);

  // Main (the workspace board, or a standalone project) is never driven by autopilot
  const mainId = v.draft.workspace_id;
  const mainBox = node('div', 'pl-rn-mainbox hidden');
  const mainMsg = node('span', 'pl-rn-mainmsg', 'Nothing starts automatically for Main: its session has to pick these up.');
  const mainRow = node('div', 'pl-rn-mainrow');
  const send = plDlgButton('pl-dlg-btn', 'Send to Main session');
  const sendNote = node('span', 'pl-rn-sendnote');
  sendNote.id = 'pl-rn-sendnote';
  send.setAttribute('aria-describedby', sendNote.id);
  mainRow.append(send, sendNote);
  mainBox.append(mainMsg, mainRow);

  const later = node('div', 'pl-rn-later hidden');
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
  dlg.append(head, fs, mainBox, later, spec, err, foot);

  const name = (b) => boards.get(b)?.name ?? 'Unknown board';
  // queued (or about to be) cards whose phase hasn't started: the board's Kanban and next card skip them
  const laterLines = (work) => {
    const groups = new Map();
    for (const c of work) {
      const ph = st.phases.get(c.board);
      const p = ph?.byId.get(c.phase);
      if (!ph?.active || !p || p.status !== 'planned') continue;
      const key = `${c.board}\u0000${c.phase}`;
      groups.set(key, { board: c.board, title: p.title, n: (groups.get(key)?.n ?? 0) + 1 });
    }
    const many = new Set(work.map((c) => c.board)).size > 1;
    return [...groups.values()].map(
      (g) => `${plCount(g.n, 'card')} ${g.n === 1 ? 'is' : 'are'} in ${g.title}${many ? ` on ${name(g.board)}` : ''}, which hasn’t started: ${g.n === 1 ? 'it won’t' : 'they won’t'} be picked up until it’s the active phase`,
    );
  };

  // why Send is unavailable, or null when Main's session can take the message now
  const sendBlocked = () => {
    if (!term.enabled || !term.token) return 'The terminal is off';
    const state = st.sessions.get(mainId) ?? 'offline';
    if (state === 'idle') return null;
    if (state === 'working') return 'Main’s session is busy';
    if (state === 'needs_you') return 'Main’s session is waiting for a decision';
    return 'No Main session is running';
  };

  // the flash, the Live mode switch and focus: once the dialog is gone
  const finish = (summary, mode) => {
    svFlash(summary);
    plStore(`pl.run.${id}`, mode); // the Live header's "Running · …"
    setPlanMode(id, 'live'); // a plan that just ran opens on its live progress
    if (plan.openId === id) $('pl-mode-live').focus(); // Run itself is hidden in Live
  };

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
    for (const o of [q, a]) o.l.classList.toggle('on', o.r.checked);
    // the work this Run hands over: cards already queued, plus the spec'd backlog it queues
    const work = cards.filter((c) => c.lane === 'queued' || (c.lane === 'backlog' && c.spec));
    // Main's cards wait for its session; Send only once they're all queued
    const onMain = work.some((c) => !verts.has(c.board));
    const unqueued = work.some((c) => !verts.has(c.board) && c.lane === 'backlog');
    mainBox.classList.toggle('hidden', !onMain);
    const blocked = unqueued ? 'Queue the cards first' : sendBlocked();
    send.textContent = st.sending ? 'Sending…' : 'Send to Main session';
    send.disabled = st.busy || st.sending || !!blocked || st.sent?.ok === true;
    sendNote.textContent = st.sent ? st.sent.message : blocked ?? 'Types “Work the queued cards on the board.” into Main’s terminal';
    sendNote.className = `pl-rn-sendnote${st.sent ? (st.sent.ok ? ' ok' : ' err') : blocked ? ' warn' : ''}`;
    const lines = laterLines(work);
    later.classList.toggle('hidden', !lines.length);
    later.replaceChildren(...lines.map((l) => node('div', 'pl-rn-later-line', l)));

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
    if (st.done) {
      // ran: the result, plus Send for Main's waiting cards
      sub.textContent = st.done.head; // the phase lines stay in their own box below
      for (const el of [fs, spec, cancel]) el.classList.add('hidden');
      started.textContent = '';
      go.textContent = 'Done';
      go.disabled = false;
    }
  };

  send.onclick = async () => {
    if (st.sending || send.disabled) return;
    st.sending = true;
    st.sent = null;
    render();
    const sent = await ptySend(mainId, 'Work the queued cards on the board.');
    st.sending = false;
    if (st.closed) return;
    st.sent = sent;
    render();
  };

  go.onclick = async () => {
    if (st.done) return close(); // onClose finishes (flash + Live)
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
    const out = r.out;
    const parts = out.queued.length || mode !== 'autopilot' ? [`Queued ${plCount(out.queued.length, 'card')}`] : [];
    if (out.skipped.length) parts.push(`${out.skipped.length} need${out.skipped.length === 1 ? 's' : ''} a spec`);
    // who picks the queued work up: Main's session, autopilot, or each vertical when prompted
    const boardOf = new Map((st.cards ?? []).map((c) => [c.id, c.board]));
    const waiting = new Set([...out.queued, ...(st.cards ?? []).filter((c) => c.lane === 'queued').map((c) => c.id)]);
    const waitingOn = [...new Set([...waiting].map((c) => boardOf.get(c)).filter(Boolean))];
    const vertsWaiting = waitingOn.filter((b) => verts.has(b)).sort(
      (x, y) => v.boards.findIndex((b) => b.id === x) - v.boards.findIndex((b) => b.id === y),
    );
    if (mode === 'autopilot') {
      if (out.autopilot.enabled.length) parts.push(`autopilot on ${out.autopilot.enabled.map((x) => name(x.board_id)).join(', ')}`);
      const idle = out.autopilot.not_enabled.filter((x) => x.reason !== 'main_session');
      if (idle.length) parts.push(`not on ${idle.map((x) => name(x.board_id)).join(', ')} (nothing queued)`);
    } else if (vertsWaiting.length) {
      parts.push(`prompt ${vertsWaiting.map(name).join(', ')} to pick ${vertsWaiting.length === 1 ? 'its' : 'their'} cards up`);
    }
    const mainWaits = waitingOn.some((b) => !verts.has(b));
    if (mainWaits) parts.push('Main’s cards wait for the Main session');
    const queued = new Set(out.queued);
    for (const c of st.cards ?? []) if (queued.has(c.id)) c.lane = 'queued';
    const head = parts.join(' · ') || 'Nothing to queue';
    const summary = [head, ...laterLines((st.cards ?? []).filter((c) => waiting.has(c.id)))].join(' · ');
    if (!mainWaits) {
      close();
      return finish(summary, mode);
    }
    // Main's cards are queued now: stay open so its session can be prompted
    st.done = { head, summary, mode };
    render();
    (send.disabled ? go : send).focus();
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
    return [{ node: nodeId, id: c.id, title: c.title, board: c.project_id, phase: c.phase_id, lane: c.lane, spec: !!c.requirements?.trim() && (c.subtasks?.length ?? 0) > 0 }];
  });
  // each involved board's phases: which of the plan's cards sit in a phase that hasn't started
  const involved = [...new Set(st.cards.map((c) => c.board))];
  const ph = await Promise.all(involved.map((b) => plJson(`/phases?project=${encodeURIComponent(b)}`)));
  if (st.closed) return;
  involved.forEach((b, i) => {
    if (!ph[i].ok || !Array.isArray(ph[i].out)) return;
    st.phases.set(b, {
      active: ph[i].out.find((p) => p.status === 'active')?.id ?? null,
      byId: new Map(ph[i].out.map((p) => [p.id, { title: p.title, status: p.status }])),
    });
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
    // the card modal (open, or just closed by this Esc: its handler runs first) owns Esc
    if (e.key !== 'Escape' || openCardId || e.defaultPrevented) return;
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

// ── Governance: decision log + risk register (?view=governance[&tab=risks]) ──
// Lists come from GET /decisions|/risks?project=<this board>: the board's own items plus its
// workspace's (on a vertical) or its verticals' (on the workspace), each tagged with a scope.
// Rule: an item is edited on the board it lives on. Only 'own' items get Edit / Supersede /
// status controls here; workspace items seen from a vertical (and vertical items seen from the
// workspace) are read-only, with a link to open them on their own board.
// UI-only: the routes accept edits to any item from any loopback client.
const GV_TABS = [
  { id: 'decisions', label: 'Decisions' },
  { id: 'risks', label: 'Risks' },
];
const GV_RISK_STATUS = ['open', 'mitigating', 'closed', 'occurred'];
const GV_REFRESH_MS = 150;
const gov = { project: null, tab: 'decisions', q: '', decisions: null, risks: null, dErr: null, rErr: null, meta: null, seq: 0, timer: null, err: '', closedOpen: false, modal: false };

const gvFold = (s) => String(s ?? '').normalize('NFC').toLowerCase();
const gvSev = (score) => (score >= 15 ? 'hi' : score >= 8 ? 'mid' : 'low');
const gvDay = (ts) => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const gvIsClosed = (r) => r.status === 'closed' || r.status === 'occurred';

async function gvApi(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
  return out;
}

function gvWriteUrl() {
  const url = new URL(location.href);
  url.searchParams.set('view', 'governance');
  if (gov.tab === 'decisions') url.searchParams.delete('tab');
  else url.searchParams.set('tab', gov.tab);
  history.replaceState(null, '', url);
}

function openGovernance() {
  gov.tab = new URLSearchParams(location.search).get('tab') === 'risks' ? 'risks' : 'decisions';
  const project = currentProject();
  if (project) {
    gov.project = project;
    gvWriteUrl();
  }
  gvRenderShell();
  if (!project) return; // the init message calls back
  gvLoadMeta();
  gvLoad();
}
function closeGovernance() {
  gov.seq++;
  clearTimeout(gov.timer);
  const url = new URL(location.href);
  if (url.searchParams.get('view') === 'governance') url.searchParams.delete('view');
  url.searchParams.delete('tab');
  history.replaceState(null, '', url);
}

// Boards, phases, cards, plans of the workspace: link chip names + the link pickers.
function gvLoadMeta() {
  const project = gov.project;
  fbLoadMeta(project, { plans: true }).then(
    (meta) => {
      if (project !== gov.project) return;
      gov.meta = meta;
      if (activeView === 'governance') gvRenderBody();
    },
    () => {}, // chips fall back to ids, the pickers stay empty
  );
}

async function gvLoad() {
  const seq = ++gov.seq;
  const q = `?project=${encodeURIComponent(gov.project)}`;
  const [d, r] = await Promise.allSettled([gvApi('GET', `/decisions${q}`), gvApi('GET', `/risks${q}`)]);
  if (seq !== gov.seq) return;
  if (d.status === 'fulfilled') [gov.decisions, gov.dErr] = [d.value, null];
  else gov.dErr = d.reason.message;
  if (r.status === 'fulfilled') [gov.risks, gov.rErr] = [r.value, null];
  else gov.rErr = r.reason.message;
  if (activeView === 'governance') gvRenderBody();
}

// WS `governance`: another client (or this one) wrote an item this board lists.
function gvOnMessage() {
  if (activeView !== 'governance' || !gov.project) return;
  clearTimeout(gov.timer);
  gov.timer = setTimeout(gvLoad, GV_REFRESH_MS);
}

function gvRenderShell() {
  const head = node('div', 'mx-head');
  head.id = 'gv-head';
  const bar = node('div', 'gv-bar');
  bar.id = 'gv-bar';
  const body = node('div', 'gv-body');
  body.id = 'gv-body';
  const wrap = node('div', 'mx-wrap');
  wrap.append(head, bar, body);
  governanceView.replaceChildren(wrap);
  gvRenderHead();
  gvRenderBar();
  gvRenderBody();
}

function gvRenderHead() {
  const tabs = node('nav', 'mx-tabs');
  tabs.setAttribute('aria-label', 'Governance sections');
  for (const t of GV_TABS) {
    const b = node('button', 'mx-tab', t.label);
    b.type = 'button';
    b.dataset.tab = t.id;
    if (t.id === gov.tab) b.setAttribute('aria-current', 'page');
    b.onclick = () => {
      if (t.id === gov.tab) return;
      gov.tab = t.id;
      gov.err = '';
      if (gov.project) gvWriteUrl();
      gvRenderHead();
      gvRenderBar();
      gvRenderBody();
    };
    tabs.append(b);
  }
  const add = node('button', 'mx-btn primary gv-add', gov.tab === 'risks' ? 'Add risk' : 'Add decision');
  add.type = 'button';
  add.id = 'gv-add';
  add.disabled = !gov.project;
  add.onclick = () => (gov.tab === 'risks' ? gvRiskForm('add') : gvDecisionForm('add'));
  $('gv-head').replaceChildren(node('h1', 'mx-title', 'Governance'), tabs, node('div', 'mx-grow'), add);
}

// The search box (Decisions) is built once per shell so typing never loses focus.
function gvRenderBar() {
  const bar = $('gv-bar');
  let search = $('gv-search');
  if (!search) {
    search = node('input', 'gv-search');
    search.id = 'gv-search';
    search.type = 'search';
    search.placeholder = 'Search decisions';
    search.setAttribute('aria-label', 'Search decisions');
    search.value = gov.q;
    search.oninput = () => {
      gov.q = search.value;
      gvRenderBody();
    };
    const err = node('div', 'gv-err');
    err.id = 'gv-err';
    err.setAttribute('role', 'alert');
    bar.append(search, err);
  }
  search.hidden = gov.tab !== 'decisions';
  $('gv-err').textContent = gvErrText();
}

// The bar's alert: a failed status change, and a failed refresh of a list already shown (kept, stale).
function gvErrText() {
  const [items, err, what] = gov.tab === 'risks' ? [gov.risks, gov.rErr, 'risks'] : [gov.decisions, gov.dErr, 'decisions'];
  return [gov.err, items && err ? `Couldn't refresh the ${what}: ${err}` : ''].filter(Boolean).join(' · ');
}

function gvState(text, cls = '') {
  return node('div', `mx-state ${cls}`, text);
}

function gvRenderBody() {
  const body = $('gv-body');
  if (!body) return;
  const fk = document.activeElement?.dataset?.fk && body.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
  const scrollTop = body.closest('.mx-wrap')?.scrollTop;
  const [items, err, what] = gov.tab === 'risks' ? [gov.risks, gov.rErr, 'risks'] : [gov.decisions, gov.dErr, 'decisions'];
  const out = [];
  if (!gov.project || (!items && !err)) out.push(gvState('Loading…'));
  else if (err && !items) {
    const box = node('div', 'mx-state mx-error');
    box.setAttribute('role', 'alert');
    const retry = node('button', 'mx-btn', 'Retry');
    retry.type = 'button';
    retry.onclick = () => {
      gov.dErr = gov.rErr = null;
      gvRenderBody();
      gvLoad();
    };
    box.append(node('div', '', `Couldn't load the ${what}: ${err}`), retry);
    out.push(box);
  } else if (gov.tab === 'risks') out.push(...gvRiskList(items));
  else out.push(...gvDecisionList(items));
  body.replaceChildren(...out);
  if ($('gv-err')) $('gv-err').textContent = gvErrText();
  if (scrollTop !== undefined) body.closest('.mx-wrap').scrollTop = scrollTop;
  if (fk) body.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus();
}

// ---------- shared bits ----------
function gvScopeBadge(item) {
  const name = item.scope === 'vertical' ? (gov.meta?.boardById.get(item.project_id)?.name ?? 'vertical') : item.scope;
  const b = node('span', `gv-scope ${item.scope}`, name);
  b.title = item.scope === 'own' ? 'On this board' : item.scope === 'workspace' ? 'On the workspace board' : `On the ${name} board`;
  return b;
}

function gvLinkInfo(l) {
  const m = gov.meta;
  if (l.target_type === 'card') {
    const c = m?.cards.get(l.target_id);
    return { kind: 'card', label: c?.title ?? l.target_id, board: c?.board ?? null, known: !!c };
  }
  if (l.target_type === 'phase') {
    const p = fbPhaseById(m, l.target_id);
    return { kind: 'phase', label: p?.title ?? l.target_id, board: p?.board ?? null, known: !!p };
  }
  const p = m?.plans.find((x) => x.id === l.target_id);
  return { kind: 'plan', label: p?.title ?? l.target_id, board: m?.workspaceId ?? null, known: !!p };
}

function gvOpenLink(l, info) {
  if (l.target_type === 'card') return mxOpenCard(l.target_id, info.board);
  if (l.target_type === 'phase') {
    if (info.board === projectId) {
      selectedPhaseId = l.target_id;
      setView('phases');
      return renderPhaseList();
    }
    location.search = `?project=${encodeURIComponent(info.board)}&view=phases`;
    return;
  }
  const url = new URL(location.href);
  url.searchParams.set('plan', l.target_id);
  history.replaceState(null, '', url);
  setView('planner');
}

function gvLinkChip(l, itemId) {
  const info = gvLinkInfo(l);
  const chip = node('button', `gv-chip k-${info.kind}`);
  chip.type = 'button';
  chip.dataset.fk = `link:${itemId}:${l.target_type}:${l.target_id}`;
  chip.append(node('span', 'gv-chip-k', info.kind), node('span', 'gv-chip-v', info.label));
  const where = info.board && info.board !== projectId ? gov.meta?.boardById.get(info.board)?.label : null;
  if (where) chip.append(node('span', 'gv-chip-b', where));
  chip.disabled = !info.known;
  chip.title = info.known ? `Open ${info.kind} ${info.label}` : `${info.kind} ${l.target_id} (not found)`;
  chip.onclick = () => gvOpenLink(l, info);
  return chip;
}

function gvLinks(item) {
  const box = node('div', 'gv-links');
  for (const l of item.links) box.append(gvLinkChip(l, item.id));
  return box;
}

// A read-only item: where to edit it.
function gvElsewhere(item) {
  const board = gov.meta?.boardById.get(item.project_id);
  const b = node('button', 'gv-ro', `Read-only · edit on ${item.scope === 'workspace' ? 'the workspace' : (board?.name ?? 'its board')}`);
  b.type = 'button';
  b.dataset.fk = `ro:${item.id}`;
  b.onclick = () => (location.search = `?project=${encodeURIComponent(item.project_id)}&view=governance${gov.tab === 'risks' ? '&tab=risks' : ''}`);
  return b;
}

function gvActionBtn(text, fk, onClick, label) {
  const b = node('button', 'mx-btn', text);
  b.type = 'button';
  b.dataset.fk = fk;
  if (label) b.setAttribute('aria-label', label);
  b.onclick = onClick;
  return b;
}

// Scroll to an item (clearing a search that hides it) and flash it.
function gvReveal(id) {
  let el = document.querySelector(`#gv-body [data-id="${CSS.escape(id)}"]`);
  if (!el && gov.q) {
    gov.q = '';
    $('gv-search').value = '';
    gvRenderBody();
    el = document.querySelector(`#gv-body [data-id="${CSS.escape(id)}"]`);
  }
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.focus();
  el.classList.remove('gv-flash');
  void el.offsetWidth;
  el.classList.add('gv-flash');
}

// ---------- decisions ----------
function gvDecisionList(all) {
  if (!all.length) return [gvState('No decisions yet. Record the first with Add decision.', 'gv-empty')];
  const q = gvFold(gov.q.trim());
  const shown = q ? all.filter((d) => ['title', 'decision', 'rationale'].some((k) => gvFold(d[k]).includes(q))) : all;
  if (!shown.length) return [gvState(`No decisions match “${gov.q.trim()}”.`, 'gv-empty')];
  const list = node('div', 'gv-list');
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'Decisions, newest first');
  const byId = new Map(all.map((d) => [d.id, d]));
  for (const d of shown) {
    const row = node('article', `gv-item gv-decision ${d.status}`);
    row.setAttribute('role', 'listitem');
    row.dataset.id = d.id;
    row.tabIndex = -1;
    const top = node('div', 'gv-top');
    const pill = node('span', `gv-pill ${d.status}`, d.status);
    top.append(node('h3', 'gv-title', d.title), gvScopeBadge(d), pill, node('div', 'mx-grow'));
    if (d.scope !== 'own') top.append(gvElsewhere(d));
    else if (d.status === 'active')
      top.append(
        gvActionBtn('Edit', `edit:${d.id}`, () => gvDecisionForm('edit', d), `Edit decision ${d.title}`),
        gvActionBtn('Supersede', `sup:${d.id}`, () => gvDecisionForm('supersede', d), `Supersede decision ${d.title}`),
      ); // a superseded decision is read-only history
    row.append(top, node('p', 'gv-text', d.decision));
    if (d.rationale) {
      const why = node('p', 'gv-why');
      why.append(node('span', 'gv-k', 'Why '), document.createTextNode(d.rationale));
      row.append(why);
    }
    const meta = node('div', 'gv-meta', [d.decided_by, gvDay(d.decided_at)].filter(Boolean).join(' · '));
    row.append(meta);
    if (d.status === 'superseded' && d.superseded_by) {
      const sup = node('div', 'gv-super');
      const next = byId.get(d.superseded_by);
      const link = node('button', 'gv-super-link', next ? next.title : 'the replacement');
      link.type = 'button';
      link.dataset.fk = `next:${d.id}`;
      link.onclick = () => gvReveal(d.superseded_by);
      sup.append(document.createTextNode('Superseded by '), link);
      row.append(sup);
    }
    if (d.links.length) row.append(gvLinks(d));
    list.append(row);
  }
  return [list];
}

// ---------- risks ----------
function gvRiskRow(r) {
  const row = node('article', `gv-item gv-risk ${r.status}`);
  row.setAttribute('role', 'listitem');
  row.dataset.id = r.id;
  row.tabIndex = -1;
  const score = node('div', `gv-score ${gvSev(r.score)}`);
  score.append(node('span', 'gv-score-n', r.score), node('span', 'gv-score-f', `${r.likelihood}×${r.impact}`));
  score.title = `Score ${r.score}: likelihood ${r.likelihood} × impact ${r.impact}`;
  const main = node('div', 'gv-risk-main');
  const top = node('div', 'gv-top');
  top.append(node('h3', 'gv-title', r.title), gvScopeBadge(r), node('span', `gv-pill ${r.status}`, r.status), node('div', 'mx-grow'));
  if (r.scope === 'own') {
    const sel = node('select', 'gv-status');
    sel.dataset.fk = `status:${r.id}`;
    sel.setAttribute('aria-label', `Status of ${r.title}`);
    for (const s of GV_RISK_STATUS) sel.append(new Option(s, s));
    sel.value = r.status;
    sel.onchange = async () => {
      try {
        await gvApi('PATCH', `/risks/${encodeURIComponent(r.id)}`, { status: sel.value });
        gov.err = '';
        gvLoad();
      } catch (err) {
        gov.err = `Couldn't change the status of “${r.title}”: ${err.message}`;
        gvRenderBody();
      }
    };
    top.append(sel, gvActionBtn('Edit', `edit:${r.id}`, () => gvRiskForm('edit', r), `Edit risk ${r.title}`));
  } else top.append(gvElsewhere(r));
  main.append(top);
  if (r.description) main.append(node('p', 'gv-text', r.description));
  const facts = node('div', 'gv-facts');
  const fact = (k, v, cls = '') => {
    const f = node('div', `gv-fact ${cls}`);
    f.append(node('span', 'gv-k', k), node('span', v ? '' : 'gv-none', v || '—'));
    return f;
  };
  facts.append(fact('Owner', r.owner, 'owner'), fact('Mitigation', r.mitigation, 'mitigation'));
  main.append(facts);
  if (r.links.length) main.append(gvLinks(r));
  row.append(score, main);
  return row;
}

function gvRiskList(all) {
  if (!all.length) return [gvState('No risks yet. Log the first with Add risk.', 'gv-empty')];
  const open = all.filter((r) => !gvIsClosed(r));
  const closed = all.filter(gvIsClosed);
  const out = [];
  const legend = node('div', 'gv-legend');
  legend.append(
    node('span', 'mx-dim', 'Score = likelihood × impact, highest first'),
    node('span', 'gv-dot hi', '≥ 15'),
    node('span', 'gv-dot mid', '≥ 8'),
    node('span', 'gv-dot low', '< 8'),
  );
  out.push(legend);
  if (open.length) {
    const list = node('div', 'gv-list');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Open risks by score');
    list.append(...open.map(gvRiskRow));
    out.push(list);
  } else out.push(gvState('No open risks.', 'gv-empty'));
  if (closed.length) {
    const det = node('details', 'gv-closed');
    det.open = gov.closedOpen;
    det.ontoggle = () => (gov.closedOpen = det.open);
    const sum = node('summary', 'gv-closed-sum', `Closed & occurred (${closed.length})`);
    sum.dataset.fk = 'closed-summary';
    const list = node('div', 'gv-list');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Closed and occurred risks');
    list.append(...closed.map(gvRiskRow));
    det.append(sum, list);
    out.push(det);
  }
  return out;
}

// ---------- forms (openModal) ----------
let gvUid = 0;
function gvField(label, input, hint) {
  const id = `gv-f${++gvUid}`;
  input.id = id;
  const wrap = node('div', 'gv-field');
  const l = node('label', 'sv-label', label);
  l.htmlFor = id;
  wrap.append(l, input);
  if (hint) wrap.append(node('div', 'gv-hint', hint));
  return wrap;
}
function gvInput(value, { area = false, type = 'text' } = {}) {
  const el = node(area ? 'textarea' : 'input', 'sv-input');
  if (area) el.rows = 3;
  else el.type = type;
  el.value = value ?? '';
  return el;
}

// Link editor: chips (× removes) + a picker of the workspace's phases and cards.
function gvLinkEditor(initial) {
  const links = initial.map((l) => ({ ...l }));
  const wrap = node('div', 'gv-field');
  const chips = node('div', 'gv-links');
  const pick = node('select', 'sv-input gv-pick');
  pick.id = `gv-f${++gvUid}`;
  const label = node('label', 'sv-label', 'Links');
  label.htmlFor = pick.id;
  const key = (l) => `${l.target_type}:${l.target_id}`;
  function render() {
    chips.replaceChildren(
      ...links.map((l, i) => {
        const info = gvLinkInfo(l);
        const chip = node('span', `gv-chip k-${info.kind} static`);
        chip.append(node('span', 'gv-chip-k', info.kind), node('span', 'gv-chip-v', info.label));
        const x = node('button', 'gv-chip-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', `Remove link to ${info.kind} ${info.label}`);
        x.onclick = () => {
          links.splice(i, 1);
          render();
          pick.focus();
        };
        chip.append(x);
        return chip;
      }),
    );
    if (!links.length) chips.append(node('span', 'gv-hint', 'No links.'));
    const have = new Set(links.map(key));
    pick.replaceChildren(new Option(gov.meta ? 'Link a phase or card…' : 'Loading boards…', ''));
    for (const b of gov.meta?.boards ?? []) {
      const phasesG = document.createElement('optgroup');
      phasesG.label = `${b.label} · phases`;
      for (const p of gov.meta.phases.get(b.id) ?? []) if (!have.has(`phase:${p.id}`)) phasesG.append(new Option(p.title, `phase:${p.id}`));
      const cardsG = document.createElement('optgroup');
      cardsG.label = `${b.label} · cards`;
      for (const c of gov.meta.cards.values()) if (c.board === b.id && !have.has(`card:${c.id}`)) cardsG.append(new Option(c.title, `card:${c.id}`));
      for (const g of [phasesG, cardsG]) if (g.children.length) pick.append(g);
    }
  }
  pick.onchange = () => {
    if (!pick.value) return;
    const [target_type, target_id] = pick.value.split(/:(.*)/s);
    links.push({ target_type, target_id });
    render();
    pick.focus();
  };
  render();
  wrap.append(label, chips, pick);
  // {link, unlink} against the item's current links
  const diff = () => {
    const now = new Set(links.map(key));
    const was = new Set(initial.map(key));
    return { link: links.filter((l) => !was.has(key(l))), unlink: initial.filter((l) => !now.has(key(l))) };
  };
  return { el: wrap, links: () => links.map((l) => ({ ...l })), diff };
}

// The dialog chrome: title, subtitle, a <form> (Enter submits), inline server error, Cancel/Save.
function gvDialog({ title, sub, fields, submitText, fk, onSubmit }) {
  if (gov.modal) return;
  gov.modal = true;
  let busy = false;
  const n = ++gvUid;
  const modal = openModal({
    labelledBy: `gv-dlg-t${n}`,
    describedBy: `gv-dlg-s${n}`,
    busy: () => busy,
    onClose: () => (gov.modal = false),
    fallbackFocus: () => (fk && document.querySelector(`[data-fk="${CSS.escape(fk)}"]`)) || $('gv-add'),
  });
  const { dlg, close, mount } = modal;
  dlg.classList.add('gv-dialog');
  const h = node('h2', 'sv-title', title);
  h.id = `gv-dlg-t${n}`;
  const s = node('p', 'sv-sub', sub);
  s.id = `gv-dlg-s${n}`;
  const form = node('form', 'gv-form');
  form.noValidate = true;
  const err = node('div', 'sv-error gv-form-err');
  err.setAttribute('role', 'alert');
  const foot = node('div', 'sv-foot');
  const cancel = node('button', 'home-btn', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => !busy && close();
  const save = node('button', 'home-btn primary', submitText);
  save.type = 'submit';
  foot.append(node('span', 'sv-foot-note'), cancel, save);
  form.append(...fields, err, foot);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    save.disabled = cancel.disabled = true;
    err.textContent = '';
    try {
      await onSubmit();
      busy = false;
      close();
      gvLoad();
    } catch (ex) {
      busy = false;
      save.disabled = cancel.disabled = false;
      err.textContent = ex.message;
    }
  };
  // Cmd/Ctrl+Enter submits from a textarea too
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  dlg.append(h, s, form);
  mount();
  form.querySelector('input, textarea')?.focus();
}

const gvText = (el) => el.value.trim();
// add: omit empty optionals; edit: an emptied optional clears (null)
const gvOpt = (el, mode) => (gvText(el) ? el.value : mode === 'edit' ? null : undefined);

function gvDecisionForm(mode, d) {
  const title = gvInput(mode === 'edit' || mode === 'supersede' ? d.title : '');
  const decision = gvInput(mode === 'edit' ? d.decision : '', { area: true });
  const rationale = gvInput(mode === 'edit' ? d.rationale : '', { area: true });
  const by = gvInput(mode === 'edit' ? d.decided_by : '');
  const links = gvLinkEditor(mode === 'edit' ? d.links : []);
  const fields = [gvField('Title', title), gvField('Decision', decision), gvField('Rationale', rationale), gvField('Decided by', by), links.el];
  const text = () => ({ title: title.value, decision: decision.value, rationale: gvOpt(rationale, mode), decided_by: gvOpt(by, mode) });
  const cfg = {
    add: {
      title: 'Add a decision',
      sub: 'Recorded on this board.',
      submitText: 'Add decision',
      onSubmit: () => gvApi('POST', '/decisions', { project_id: gov.project, ...text(), links: links.links() }),
    },
    edit: {
      title: 'Edit decision',
      sub: d?.title,
      submitText: 'Save',
      onSubmit: () => gvApi('PATCH', `/decisions/${encodeURIComponent(d.id)}`, { ...text(), ...links.diff() }),
    },
    supersede: {
      title: 'Supersede decision',
      sub: `Replaces “${d?.title}”. The new decision keeps its links; add more below.`,
      submitText: 'Supersede',
      onSubmit: () => gvApi('POST', `/decisions/${encodeURIComponent(d.id)}/supersede`, { ...text(), links: links.links() }),
    },
  }[mode];
  gvDialog({ ...cfg, fields, fk: d ? `${mode === 'supersede' ? 'sup' : 'edit'}:${d.id}` : null });
}

function gvRiskForm(mode, r) {
  const edit = mode === 'edit';
  const title = gvInput(edit ? r.title : '');
  const desc = gvInput(edit ? r.description : '', { area: true });
  const lik = gvInput(edit ? r.likelihood : 3, { type: 'number' });
  const imp = gvInput(edit ? r.impact : 3, { type: 'number' });
  for (const el of [lik, imp]) Object.assign(el, { min: 1, max: 5, step: 1 });
  const score = node('div', 'gv-score-preview');
  score.setAttribute('aria-live', 'polite');
  const paint = () => {
    const s = Number(lik.value) * Number(imp.value);
    const okN = Number.isInteger(s) && s > 0;
    score.className = `gv-score-preview ${okN ? gvSev(s) : ''}`;
    score.textContent = okN ? `Score ${s}` : 'Score —';
  };
  lik.oninput = imp.oninput = paint;
  paint();
  const owner = gvInput(edit ? r.owner : '');
  const mit = gvInput(edit ? r.mitigation : '', { area: true });
  const status = node('select', 'sv-input');
  for (const s of GV_RISK_STATUS) status.append(new Option(s, s));
  status.value = edit ? r.status : 'open';
  const links = gvLinkEditor(edit ? r.links : []);
  const li = node('div', 'gv-row');
  li.append(gvField('Likelihood (1-5)', lik), gvField('Impact (1-5)', imp), score);
  const fields = [gvField('Title', title), gvField('Description', desc), li, gvField('Owner', owner), gvField('Mitigation', mit), gvField('Status', status), links.el];
  // a blank rating goes to the server as null, so its 400 text explains it
  const num = (el) => (el.value.trim() === '' ? null : Number(el.value));
  const body = () => ({
    title: title.value,
    description: gvOpt(desc, mode),
    likelihood: num(lik),
    impact: num(imp),
    owner: gvOpt(owner, mode),
    mitigation: gvOpt(mit, mode),
    status: status.value,
  });
  gvDialog({
    title: edit ? 'Edit risk' : 'Add a risk',
    sub: edit ? r.title : 'Logged on this board. Score = likelihood × impact.',
    submitText: edit ? 'Save' : 'Add risk',
    fields,
    fk: edit ? `edit:${r.id}` : null,
    onSubmit: () =>
      edit
        ? gvApi('PATCH', `/risks/${encodeURIComponent(r.id)}`, { ...body(), ...links.diff() })
        : gvApi('POST', '/risks', { project_id: gov.project, ...body(), links: links.links() }),
  });
}

// Show the landing view at once — no Kanban flash while the first board data and
// view setup are in flight. ?view=dashboard still waits for the workspace probe;
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
if (!EMBED) checkDaemonVersion();
