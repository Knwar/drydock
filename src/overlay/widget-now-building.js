// Dashboard widget: now-building. The hero in-flight card (chips, agent + live action,
// criteria progress, Open card / Watch terminal) plus compact rows for the others.
// Reads Home's /home (ctx.shared('home')); app.js globals are used read-only.

const WNB_ROWS = { M: 3, L: 6 };

function wnbAgent(name) {
  return teamByName.get(name) ?? { name };
}

// The card's phase title, from Home's card meta (any board) or this board's live cards.
function wnbPhase(item) {
  const pid = hctx.meta?.cards.get(item.id)?.phase_id ?? cards.get(item.id)?.phase_id;
  if (!pid) return null;
  return fbPhaseById(hctx.meta, pid)?.title ?? phases.find((p) => p.id === pid)?.title ?? null;
}

// The card's agent state + live action, by the rule Active agents uses too (dashboard.js
// dwAgentState, with the same reviewer signal): "Working · Edit foo.js", or "Working · waiting for
// next action" when the session is idle with the card still in flight (never a bare "idle").
function wnbState(it, activity, sessions) {
  return dwAgentState(it, activity || null, dwIsReviewer(it.agent ? wnbAgent(it.agent) : {}, it, sessions));
}

// The action line: its text, the pulsing dot only for live work, the attention colour for "Needs you".
function wnbPaintAction(act, st) {
  const txt = act.querySelector('.wnb-action-txt');
  txt.textContent = st.label;
  txt.classList.toggle('dw-attn', st.attention);
  act.parentElement.classList.toggle('on', st.live);
}

function wnbElapsed(since) {
  const el = node('span', 'wnb-elapsed', fmtElapsed(since));
  el.dataset.since = since; // Home's tick keeps it current
  return el;
}

function wnbHero(it, data, ctx) {
  const hero = node('div', 'wnb-hero');
  hero.tabIndex = 0;
  hero.setAttribute('role', 'group');
  hero.setAttribute('aria-label', `Now building: ${it.title}`);
  hero.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target === hero) ctx.openCard(it.id, it.board.id);
  };

  const chips = node('div', 'wnb-chips');
  if (data.workspace) chips.append(homeBoardChip(it.board));
  const phase = wnbPhase(it);
  if (phase) {
    const p = homeChip('wnb-phase', phase);
    p.title = `Phase: ${phase}`;
    chips.append(p);
  }
  chips.append(homeLaneChip(it.lane));
  if (it.blocked) chips.append(homeChip('blocked', 'blocked'));
  chips.append(wnbElapsed(it.since));

  const title = node('div', 'wnb-title', it.title);
  title.title = it.title;

  const who = node('div', 'wnb-who');
  if (it.agent) who.append(avatarEl(wnbAgent(it.agent), 20), node('span', 'wnb-agent', it.agent));
  else who.append(node('span', 'wnb-agent wnb-dim', 'unassigned'));
  const act = node('span', 'wnb-action');
  act.dataset.card = it.id;
  act._wnbItem = it; // onStatus re-derives the state from the card
  act.append(node('span', 'home-dot'), node('span', 'wnb-action-txt'));
  who.append(act);
  wnbPaintAction(act, wnbState(it, it.activity, dwAgentSessions(data)));

  hero.append(chips, title, who);

  const { done, total } = it.subtasks;
  if (total) {
    const prog = node('div', 'wnb-progress');
    const bar = node('div', 'home-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(total));
    bar.setAttribute('aria-valuenow', String(done));
    bar.setAttribute('aria-label', 'Acceptance criteria');
    const fill = node('span', 'home-bar-fill');
    fill.style.width = `${Math.round((100 * done) / total)}%`;
    bar.append(fill);
    prog.append(bar, node('span', 'wnb-progress-n', `${done} of ${total}`));
    hero.append(prog);
    if (it.next_criterion) {
      const nx = node('div', 'wnb-next');
      nx.title = it.next_criterion;
      nx.append(node('span', 'wnb-dim', 'Next: '), node('span', '', it.next_criterion));
      hero.append(nx);
    }
  }

  const actions = node('div', 'wnb-actions');
  const open = node('button', 'home-btn primary', 'Open card');
  open.type = 'button';
  open.onclick = () => ctx.openCard(it.id, it.board.id);
  actions.append(open);
  if (term.enabled) {
    const watch = node('button', 'home-btn', 'Watch terminal');
    watch.type = 'button';
    watch.onclick = () => openBoardTerminal(it.board.id);
    actions.append(watch);
  }
  hero.append(actions);
  return hero;
}

function wnbRow(it, ctx, showBoard) {
  const row = node('button', 'wnb-row');
  row.type = 'button';
  row.title = it.title;
  if (showBoard) row.append(node('span', 'wnb-row-board', homeBoardName(it.board)));
  row.append(node('span', 'wnb-row-title', it.title));
  if (it.blocked) row.append(homeChip('blocked', 'blocked'));
  row.append(node('span', 'wnb-row-agent', it.agent ?? 'unassigned'), homeLaneChip(it.lane), wnbElapsed(it.since));
  row.onclick = () => ctx.openCard(it.id, it.board.id);
  return row;
}

// Nothing in flight: the first ready Up-next card, with Queue when it's still in backlog.
function wnbEmpty(el, data, ctx) {
  const top = (data.up_next?.items ?? []).find((i) => i.ready);
  if (!top) return { empty: 'Nothing in flight and nothing ready to start' };
  const box = node('div', 'wnb-idle');
  if (ctx.size !== 'S') box.append(node('div', 'wnb-idle-head', 'Nothing in flight'));
  const row = node('div', 'wnb-idle-row');
  const txt = node('button', 'wnb-idle-txt');
  txt.type = 'button';
  txt.title = top.title;
  txt.append(node('span', 'wnb-dim', 'Up next: '), node('span', '', top.title));
  txt.onclick = () => ctx.openCard(top.id, top.board.id);
  row.append(txt);
  if (top.lane === 'backlog') {
    const q = node('button', 'home-btn', 'Queue');
    q.type = 'button';
    q.onclick = () => homeQueue(top.id, q); // success → Home refetches → this widget refreshes
    row.append(q);
  } else row.append(homeLaneChip(top.lane));
  box.append(row);
  el.append(box);
}

function wnbSmall(el, now, ctx) {
  const it = now[0];
  const line = node('button', 'wnb-s');
  line.type = 'button';
  line.title = it.title;
  line.append(node('span', 'wnb-s-n', `${now.length} building`), node('span', 'wnb-s-title', it.title));
  const { done, total } = it.subtasks;
  if (total) line.append(node('span', 'wnb-s-frac', `${done}/${total}`));
  line.onclick = () => ctx.openCard(it.id, it.board.id);
  el.append(line);
}

dwRegister({
  type: 'now-building',
  title: 'Now building',
  sizes: ['S', 'M', 'L'],
  load(ctx) {
    return ctx.shared('home', async () => {
      const q = fbNoRange(ctx.filters); // live: the range never narrows it
      const res = await fetch(`/home?project=${encodeURIComponent(ctx.projectId)}${q ? `&${q}` : ''}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
  },
  render(el, data, ctx) {
    el._wnbData = data; // onStatus: its sessions (the reviewer signal)
    const now = data.now_building ?? [];
    const root = node('div', `wnb wnb-${ctx.size}`);
    if (!now.length) {
      const r = wnbEmpty(root, data, ctx);
      if (r) return r;
      el.append(root);
      return;
    }
    if (ctx.size === 'S') {
      wnbSmall(root, now, ctx);
      el.append(root);
      return;
    }
    root.append(wnbHero(now[0], data, ctx));
    const rest = now.slice(1);
    if (rest.length) {
      const max = WNB_ROWS[ctx.size] ?? WNB_ROWS.M;
      const list = node('div', 'wnb-rows');
      const showBoard = ctx.size === 'L';
      for (const it of rest.slice(0, max)) list.append(wnbRow(it, ctx, showBoard));
      if (rest.length > max) {
        const more = node('button', 'wnb-more', `+${rest.length - max} more`);
        more.type = 'button';
        more.setAttribute('aria-label', `${now.length} in flight: list them all`);
        more.onclick = () => homeDrillNow();
        list.append(more);
      }
      root.append(list);
    }
    el.append(root);
  },
  // live action: applyHomeStatus has already written it onto the shared /home item
  onStatus(msg, el) {
    const st = msg.status;
    const data = el._wnbData;
    if (!data || !st) return;
    const sessions = dwAgentSessions(data);
    if (msg.session && msg.project_id) sessions.set(msg.project_id, msg.session);
    if (!st.task_id) return;
    for (const a of el.querySelectorAll('.wnb-action')) {
      if (a.dataset.card !== st.task_id) continue;
      const text = `${st.verb ?? ''} ${st.detail ?? ''}`.trim();
      wnbPaintAction(a, wnbState(a._wnbItem, text, sessions));
    }
  },
});
