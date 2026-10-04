// Dashboard widgets: lists — up-next, verticals, send-to-agent, workspace-boards.
// Classic script after dashboard.js; reuses app.js globals read-only (home, term,
// homeQueueBtn, homeDrillLane, homeBoardChip, homeLaneChip, mergeButton, ptySend,
// DASH_LANES, DASH_STATE, DASH_MAX_CARDS, teamByName, avatarEl, mxPlural, homeBoardName, EMBED)
// and dashboard.js' dwKanbanTarget / dwOpenKanban.
// Every user-controlled string goes in via node() / textContent.

const WL_UP_NEXT_MAX = { M: 3, L: 8 };
const WL_UP_NEXT_HL = 'Up next'; // the Kanban highlight banner's source: "N cards highlighted from Up next"
const WL_SEND_CHIPS = [
  ['Work next card', 'Work the next queued card on this board.'],
  ['Status report', "Give me a short status report on what you're doing."],
  ['Pause after this card', 'Finish the current card, then stop and wait for me.'],
];

async function wlJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Home's /home read (pre-seeded per refresh cycle); a widget's own refresh fetches it (live: no range).
function wlHome(ctx) {
  return ctx.shared('home', () => {
    const q = fbNoRange(ctx.filters);
    return wlJson(`/home?project=${encodeURIComponent(ctx.projectId)}${q ? `&${q}` : ''}`);
  });
}

const wlBoardName = (d, p) => (p.id === d.workspace?.workspace.id ? 'Main' : p.name);

// Widget shell: a scrolling list above an optional fixed footer.
function wlShell(el, cls) {
  const root = node('div', `wl ${cls}`);
  const list = node('div', 'wl-scroll');
  root.append(list);
  el.append(root);
  return { root, list };
}

function wlLink(text, onclick) {
  const b = node('button', 'home-link wl-foot', text);
  b.type = 'button';
  b.onclick = onclick;
  return b;
}

// A session state pill (the dashboard's .dt-pill); host carries data-state for its colours.
function wlPaintState(host, session) {
  const state = session?.state ?? 'offline';
  host.dataset.state = state;
  const pill = host.querySelector('.dt-pill');
  if (pill) pill.replaceChildren(node('span', 'dt-dot'), node('span', '', DASH_STATE[state] ?? state));
}
function wlPill() {
  return node('span', 'dt-pill');
}

// ── up next ──
function wlUpStatus(it) {
  if (it.ready) return node('div', 'home-status ready', 'Ready');
  const w = it.waiting_on.map((x) => (x.title == null ? 'an unknown card' : `${x.title} (${x.board_name})`)).join(', ');
  return node('div', 'home-status waiting', w === 'an unknown card' ? 'Waiting on an unknown card' : `Waiting on: ${w}`);
}

dwRegister({
  type: 'up-next',
  title: 'Up next',
  sizes: ['S', 'M', 'L'],
  load: wlHome,
  render(el, d, ctx) {
    const up = d.up_next;
    if (!up.items.length) return { empty: 'Backlog is clear' };
    if (ctx.size === 'S') {
      const ready = up.items.filter((i) => i.ready);
      const box = node('div', 'wl wl-upnext-s');
      const counts = node('div', 'wl-s-counts');
      counts.append(node('span', 'wl-s-ready', `${ready.length} ready`), node('span', 'wl-s-sep', ' · '), node('span', 'wl-s-waiting', `${up.items.length - ready.length} waiting`));
      box.append(counts);
      if (ready.length) box.append(node('div', 'wl-s-title', ready[0].title));
      el.append(box);
      return;
    }
    const { root, list } = wlShell(el, 'wl-upnext');
    for (const it of up.items.slice(0, WL_UP_NEXT_MAX[ctx.size] ?? WL_UP_NEXT_MAX.M)) {
      const row = node('div', 'home-uprow');
      const main = node('div', 'home-upmain');
      const top = node('div', 'home-chips-row');
      if (d.workspace) top.append(homeBoardChip(it.board));
      top.append(homeLaneChip(it.lane));
      main.append(top, node('div', 'home-uptitle', it.title), wlUpStatus(it));
      row.append(main);
      const q = homeQueueBtn(it);
      if (q) row.append(q);
      list.append(row);
    }
    // highlight them on the board holding the most (a workspace Home's own board may hold none)
    const target = dwKanbanTarget(up.pending ?? []);
    if (!target) return;
    // pending is capped (200): what isn't highlighted counts against total_pending
    const rest = up.total_pending - target.ids.length;
    const where = target.board.id === ctx.projectId ? 'Kanban' : `${homeBoardName(target.board)} Kanban`;
    const link = wlLink(rest > 0 ? `View ${target.ids.length} in ${where} →` : `View all ${up.total_pending} in ${where} →`, () => dwOpenKanban(target, WL_UP_NEXT_HL));
    if (rest > 0) link.title = `${mxPlural(rest, 'card')} on other boards ${rest === 1 ? 'isn’t' : 'aren’t'} shown there`;
    root.append(link);
  },
});

// ── verticals ──
dwRegister({
  type: 'verticals',
  title: 'Verticals',
  sizes: ['M', 'L'],
  load: wlHome,
  render(el, d, ctx) {
    if (!d.verticals.length) return { empty: 'This board has no verticals' };
    const { list } = wlShell(el, 'wl-verticals');
    const shown = d.verticals.filter((v) => v.shown !== false); // the server's call (scope; a phase → its board)
    const wsv = d.workspace?.verticals ?? [];
    for (const v of shown) {
      const name = wlBoardName(d, v.project);
      const row = node('div', 'home-vrow wl-vrow');
      row.dataset.id = v.project.id;
      const head = node('div', 'home-vhead');
      head.append(node('span', 'home-vname', name), wlPill());
      const mb = wsv.some((x) => x.id === v.project.id) ? mergeButton(v.project.id, v.project.name, wsv.length) : null;
      if (mb) head.append(mb);
      const open = node('a', 'wl-open', 'Open →');
      open.href = `?project=${encodeURIComponent(v.project.id)}`;
      open.title = `Open the ${name} board`;
      open.setAttribute('aria-label', `Open the ${name} board`);
      head.append(open);
      wlPaintState(row, v.session);
      // lane counts (the server's, under the filters), each opening its cards
      const lanes = node('div', 'wl-vlanes');
      for (const [lane, label] of DASH_LANES) {
        const n = v.lanes?.[lane] ?? 0;
        const b = node(EMBED ? 'span' : 'button', 'wl-vlane');
        b.dataset.lane = lane;
        b.append(node('span', 'wl-vlane-n', n), node('span', 'wl-vlane-l', label));
        if (!EMBED) {
          b.type = 'button';
          b.title = `List the ${LANE_LABELS[lane]} cards`;
          b.onclick = () => homeDrillLane(v.project, lane, ctx.title);
        }
        lanes.append(b);
      }
      row.append(head, lanes);
      list.append(row);
    }
    if (!shown.length) list.append(node('div', 'home-empty', 'No boards match the filters.'));
  },
  onStatus(msg, el) {
    if (!msg.session || !msg.project_id) return;
    const row = [...el.querySelectorAll('.wl-vrow')].find((r) => r.dataset.id === msg.project_id);
    if (row) wlPaintState(row, msg.session);
  },
});

// ── send to agent ──
// The DOM is kept per instance across re-renders so typing, the target and the last
// result survive refreshes (a focused textarea gets its focus + caret back).
const wlSends = new Map(); // `${board}:${widget id}` → state

// Drop kept send boxes that left the dashboard (another board, or a widget no longer laid out),
// so their detached DOM and listeners aren't retained.
function wlPruneSends(board) {
  const live = new Set(dw.instances.filter((i) => i.frame.isConnected).map((i) => i.w.id));
  for (const [key, st] of wlSends) {
    if (st.board !== board || (!st.root.isConnected && !live.has(st.id))) wlSends.delete(key);
  }
}

// Is the terminal on? term.* once initTerminal has run; until then one /config probe per
// page (dropped on failure so a later refresh retries).
let wlTermProbe = null;
function wlTerminalOn() {
  if (term.enabled && term.token) return Promise.resolve(true);
  if (!wlTermProbe) {
    wlTermProbe = wlJson('/config').then((c) => !!(c.terminal && c.token));
    wlTermProbe.catch(() => (wlTermProbe = null));
  }
  return wlTermProbe.catch(() => false);
}

function wlSendTargets(d) {
  return d.verticals.length ? d.verticals.map((v) => ({ id: v.project.id, name: wlBoardName(d, v.project) })) : [{ id: d.project.id, name: d.project.name }];
}
function wlSessionState(d, pid) {
  return home.sessions.get(pid)?.state ?? d.verticals.find((v) => v.project.id === pid)?.session?.state ?? 'offline';
}

function wlSendBuild(ctx) {
  const id = ctx.id;
  const st = { id, board: ctx.projectId, data: null, target: null, sending: false, gate: false, focused: false };
  st.root = node('div', 'wl wl-send');
  st.sel = node('select', 'st-select wl-send-target');
  st.sel.id = `${id}-send-target`;
  st.sel.setAttribute('aria-label', 'Send to');
  st.sel.onchange = () => {
    st.target = st.sel.value;
    st.res.textContent = '';
    st.res.className = 'wl-send-result';
    wlSendSync(st);
  };
  const chips = node('div', 'home-chips');
  for (const [label, text] of WL_SEND_CHIPS) {
    const c = node('button', 'home-chip', label);
    c.type = 'button';
    c.onclick = () => {
      st.ta.value = text;
      st.ta.focus();
    };
    chips.append(c);
  }
  st.ta = node('textarea', 'wl-send-text');
  st.ta.id = `${id}-send-text`;
  st.ta.rows = 3;
  st.ta.maxLength = 2000;
  st.ta.placeholder = 'Tell the agent what to do…';
  st.ta.setAttribute('aria-label', 'Message to the agent');
  st.ta.addEventListener('focus', () => (st.focused = true));
  st.ta.addEventListener('blur', () => {
    if (st.ta.isConnected) st.focused = false; // a blur from a re-render's detach keeps it
  });
  const foot = node('div', 'home-send-foot');
  st.res = node('span', 'wl-send-result');
  st.res.id = `${id}-send-result`;
  st.res.setAttribute('role', 'status');
  st.res.setAttribute('aria-live', 'polite');
  st.btn = node('button', 'home-btn primary', 'Send');
  st.btn.id = `${id}-send-btn`;
  st.btn.type = 'button';
  st.btn.onclick = () => wlSend(st);
  foot.append(st.res, st.btn);
  st.root.append(st.sel, chips, st.ta, foot);
  return st;
}

// Targets, the needs-you gate and the button from the latest /home + sessions.
function wlSendSync(st) {
  const d = st.data;
  if (!d) return;
  const targets = wlSendTargets(d);
  if (!targets.some((t) => t.id === st.target)) st.target = (targets.find((t) => t.id === currentProject()) ?? targets[0])?.id ?? null;
  st.sel.replaceChildren(
    ...targets.map((t) => {
      const s = wlSessionState(d, t.id);
      return Object.assign(document.createElement('option'), { value: t.id, textContent: `${t.name} — ${DASH_STATE[s] ?? s}` });
    }),
  );
  st.sel.value = st.target ?? '';
  const needs = !!st.target && wlSessionState(d, st.target) === 'needs_you';
  st.btn.disabled = needs || st.sending;
  if (needs) {
    st.res.textContent = 'Waiting for a decision — answer it in the terminal';
    st.res.className = 'wl-send-result warn';
  } else if (st.gate) {
    st.res.textContent = '';
    st.res.className = 'wl-send-result';
  }
  st.gate = needs;
}

async function wlSend(st) {
  const text = st.ta.value.trim();
  if (!text || !st.target || st.sending) return;
  st.sending = true;
  st.btn.disabled = true;
  st.res.textContent = 'Sending…';
  st.res.className = 'wl-send-result';
  const sent = await ptySend(st.target, text);
  st.res.textContent = sent.message;
  st.res.className = `wl-send-result ${sent.ok ? 'ok' : 'err'}`;
  if (sent.ok) st.ta.value = '';
  st.gate = false;
  st.sending = false;
  wlSendSync(st);
}

dwRegister({
  type: 'send-to-agent',
  title: 'Send to agent',
  sizes: ['M', 'L'],
  async load(ctx) {
    const d = await wlHome(ctx);
    const terminal = EMBED ? false : await wlTerminalOn(); // the terminal may still be starting up (initTerminal)
    return { home: d, terminal };
  },
  render(el, data, ctx) {
    if (EMBED || !data.terminal) return { empty: 'The terminal is off, so there is no session to send to' };
    const key = `${ctx.projectId}:${ctx.id}`;
    wlPruneSends(ctx.projectId);
    let st = wlSends.get(key);
    if (!st) wlSends.set(key, (st = wlSendBuild(ctx)));
    st.data = data.home;
    st.root.dataset.size = ctx.size;
    el.append(st.root);
    wlSendSync(st);
    if (st.focused) {
      const { selectionStart: a, selectionEnd: b } = st.ta;
      st.ta.focus({ preventScroll: true });
      st.ta.setSelectionRange(a, b);
    }
  },
  onStatus(_msg, _el, ctx) {
    const st = wlSends.get(`${ctx.projectId}:${ctx.id}`);
    if (st?.root.isConnected) wlSendSync(st); // home.sessions was updated in place (applyHomeStatus)
  },
});

// ── workspace boards ──
// A compact Dashboard tile per board from GET /workspace/summary (dashTile itself is bound to
// the Dashboard view's state and filters, so it isn't reused here).
const WL_TILE_CARDS = { L: 3, XL: DASH_MAX_CARDS };

const wlAgentsText = (s) => (s.agents?.length ? `+${s.agents.length} agent${s.agents.length === 1 ? '' : 's'}` : '');
function wlTileWhat(s) {
  return s.main ? `${s.main.verb} ${s.main.detail ?? ''}`.trim() : s.state === 'offline' ? 'no session' : '—';
}

function wlTile(b, isMain, size) {
  const s = b.session ?? { state: 'offline', main: null, agents: [] };
  const name = isMain ? 'Main' : b.project.name;
  const tile = node(EMBED ? 'div' : 'a', 'dash-tile wl-tile');
  tile.dataset.id = b.project.id;
  if (!EMBED) {
    tile.href = `?project=${encodeURIComponent(b.project.id)}`;
    tile.title = `Open ${name} board`;
  }
  const head = node('div', 'dt-head');
  const nm = node('div', 'dt-name', name);
  if (isMain) nm.append(node('span', 'dt-kind', 'workspace'));
  head.append(nm, wlPill());
  tile.append(head);
  wlPaintState(tile, s);

  const sub = node('div', 'dt-sub');
  sub.append(node('span', 'dt-what', wlTileWhat(s)));
  sub.append(node('span', 'dt-agents', wlAgentsText(s)));
  tile.append(sub);

  const lanes = node('div', 'dt-lanes');
  for (const [lane, label] of DASH_LANES) {
    const l = node('span', 'dt-lane');
    l.dataset.lane = lane;
    l.append(node('span', 'dt-lane-n', b.lanes?.[lane] ?? 0), node('span', 'dt-lane-l', label));
    lanes.append(l);
  }
  tile.append(lanes);

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

  const max = WL_TILE_CARDS[size] ?? WL_TILE_CARDS.L;
  const list = node('div', 'dt-cards');
  const active = b.active ?? [];
  if (!active.length) list.append(node('div', 'dt-empty', 'nothing in flight'));
  for (const c of active.slice(0, max)) {
    const row = node('div', `dt-card${c.blocked ? ' blocked' : ''}`);
    row.dataset.lane = c.lane;
    row.append(node('span', 'dt-card-mark'), node('span', 'dt-card-title', c.title));
    if (c.blocked) row.append(node('span', 'dt-card-blocked', '✋ blocked'));
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
  if (active.length > max) list.append(node('div', 'dt-more', `+${active.length - max} more`));
  tile.append(list);

  const foot = node('div', 'dt-foot');
  foot.append(node('span', `dt-blocked${b.blocked ? ' on' : ''}`, `${b.blocked ?? 0} blocked`));
  tile.append(foot);
  return tile;
}

dwRegister({
  type: 'workspace-boards',
  title: 'Boards',
  sizes: ['L', 'XL'],
  async load(ctx) {
    const d = await wlHome(ctx);
    if (!d.workspace) return { summary: null };
    const ws = d.workspace.workspace.id;
    const q = fbNoRange(ctx.filters); // live tiles: the range never narrows them
    const summary = await ctx.shared('workspace-summary', () => wlJson(`/workspace/summary?project=${encodeURIComponent(ws)}${q ? `&${q}` : ''}`));
    return { summary };
  },
  render(el, data, ctx) {
    if (!data.summary) return { empty: 'Not a workspace' };
    const { list } = wlShell(el, 'wl-boards');
    list.classList.add('wl-boards-grid');
    const main = data.summary.boards[0];
    const shown = data.summary.boards.filter((b) => b.shown !== false);
    for (const b of shown) list.append(wlTile(b, b === main, ctx.size));
    if (!shown.length) list.append(node('div', 'home-empty', 'No boards match the filters.'));
  },
  onStatus(msg, el) {
    if (!msg.session || !msg.project_id) return;
    const tile = [...el.querySelectorAll('.wl-tile')].find((t) => t.dataset.id === msg.project_id);
    if (!tile) return;
    wlPaintState(tile, msg.session);
    const what = tile.querySelector('.dt-what');
    if (what) what.textContent = wlTileWhat(msg.session);
    const agents = tile.querySelector('.dt-agents');
    if (agents) agents.textContent = wlAgentsText(msg.session);
  },
});
