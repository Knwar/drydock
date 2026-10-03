// Dashboard widget: active-agents. Who is on what right now, from Home's GET /home
// (agents[] + now_building to join agent → current card). Live status messages
// (onStatus) update activity and session state in place, without a refetch.
// Uses app.js globals read-only: node, avatarEl, teamByName, openAgentEditor,
// openModal, svModal, fmtElapsed, LANE_NAME, home, tick.

const AA_STATES = {
  blocked: { icon: '⚠', text: 'Blocked', rank: 0 },
  working: { icon: '▶', text: 'Working', rank: 1 },
  reviewing: { icon: '◎', text: 'Reviewing', rank: 1 },
  idle: { icon: '○', text: 'Idle', rank: 2 },
};
const AA_MAX_STACK = 5;
const aaPanel = { close: null, agentId: null, paint: null }; // the open side panel (one at a time)

// board id → SessionView: /home's verticals carry them; standalone Home reads its
// own (app.js home.sessions); status messages overwrite them (onStatus).
function aaSessions(data) {
  if (!data._aaSessions) {
    const m = new Map(typeof home !== 'undefined' ? home.sessions : []);
    for (const v of data.verticals ?? []) if (v.session) m.set(v.project.id, v.session);
    Object.defineProperty(data, '_aaSessions', { value: m, enumerable: false, writable: true });
  }
  return data._aaSessions;
}

const aaOwns = (a, nb) => !!nb.agent && (nb.agent === a.name || nb.agent === a.id);

// The agent's current card: a blocked one first, else the one that most recently moved.
function aaCard(data, a) {
  const mine = (data.now_building ?? []).filter((nb) => aaOwns(a, nb));
  mine.sort((x, y) => Number(y.blocked) - Number(x.blocked) || y.since - x.since);
  return mine[0] ?? null;
}

// Reviewer role: no role field on team members, so the persona (name/skill) or a live
// reviewer subagent on the agent's card says so.
function aaIsReviewer(a, card, sessions) {
  if (/review/i.test(a.skill ?? '') || /review/i.test(a.name ?? '')) return true;
  if (!card) return false;
  const s = sessions.get(card.board.id);
  return !!s?.agents?.some((e) => e.task_id === card.id && /review/i.test(e.agent));
}

function aaInfo(data, a) {
  const sessions = aaSessions(data);
  const card = aaCard(data, a);
  const needsYou = !!card && sessions.get(card.board.id)?.state === 'needs_you';
  let state = 'idle';
  if (card?.blocked || needsYou) state = 'blocked';
  else if (card?.lane === 'in_review' || (aaIsReviewer(a, card, sessions) && (card || a.now))) state = 'reviewing';
  else if (card || a.now) state = 'working';
  return { a, card, state, needsYou };
}

function aaRows(data) {
  return (data.agents ?? [])
    .map((a) => aaInfo(data, a))
    .sort((x, y) => AA_STATES[x.state].rank - AA_STATES[y.state].rank || x.a.name.localeCompare(y.a.name));
}

function aaPill(state) {
  const s = AA_STATES[state];
  const p = node('span', `aa-pill aa-${state}`);
  const icon = node('span', 'aa-pill-icon', s.icon);
  icon.setAttribute('aria-hidden', 'true');
  p.append(icon, node('span', 'aa-pill-text', s.text));
  return p;
}

function aaSince(since, cls) {
  const el = node('span', cls, fmtElapsed(since));
  el.dataset.since = String(since); // app.js's Home tick keeps it current
  return el;
}

function aaSummary(rows) {
  const n = (st) => rows.filter((r) => st.includes(r.state)).length;
  const el = node('div', 'aa-summary');
  el.append(
    node('span', 'aa-sum-n', `${n(['working', 'reviewing'])} active`),
    node('span', 'aa-sum-sep', '·'),
    node('span', `aa-sum-n${n(['blocked']) ? ' aa-sum-blocked' : ''}`, `${n(['blocked'])} blocked`),
    node('span', 'aa-sum-sep', '·'),
    node('span', 'aa-sum-n', `${n(['idle'])} idle`),
  );
  return el;
}

function aaStack(rows) {
  const stack = node('div', 'aa-stack');
  for (const r of rows.slice(0, AA_MAX_STACK)) {
    const av = avatarEl(r.a, 32);
    av.classList.add('aa-stack-av', `aa-${r.state}`);
    av.title = `${r.a.name} · ${AA_STATES[r.state].text}`;
    stack.append(av);
  }
  const more = rows.length - AA_MAX_STACK;
  if (more > 0) stack.append(node('span', 'aa-stack-more', `+${more}`));
  stack.setAttribute('aria-label', rows.map((r) => `${r.a.name}, ${AA_STATES[r.state].text}`).join('; '));
  stack.setAttribute('role', 'img');
  return stack;
}

function aaRow(r, data, ctx) {
  const { a, card } = r;
  const row = node('button', `aa-row aa-row-${r.state}`);
  row.type = 'button';
  row.dataset.agent = a.id;
  row.setAttribute('aria-label', `${a.name}, ${AA_STATES[r.state].text}${card ? `, ${card.title}` : ''}. Open details`);
  const main = node('div', 'aa-main');
  const top = node('div', 'aa-top');
  const id = node('div', 'aa-id');
  id.append(node('span', 'aa-name', a.name), node('span', 'aa-skill', a.skill ?? 'no skill'));
  top.append(id, aaPill(r.state));
  const line = node('div', 'aa-line');
  if (card) {
    line.append(node('span', 'aa-card', card.title), node('span', 'aa-lane', LANE_NAME(card.lane)), aaSince(card.since, 'aa-elapsed'));
  } else {
    line.append(node('span', 'aa-card aa-muted', a.now ?? 'No current card'));
  }
  main.append(top, line);
  if (ctx.size === 'L') main.append(node('div', 'aa-quiet', `${a.cards} card${a.cards === 1 ? '' : 's'} · ${a.hours} h all-time`));
  row.append(avatarEl(a, 30), main);
  row.onclick = () => aaOpenPanel(a.id, data, ctx);
  return row;
}

function aaPaint(el, data, ctx) {
  const rows = aaRows(data);
  const focused = el.contains(document.activeElement) ? document.activeElement.dataset.agent : null;
  el.replaceChildren();
  if (ctx.size === 'S') {
    const wrap = node('div', 'aa-s');
    wrap.append(aaSummary(rows), aaStack(rows));
    el.append(wrap);
    return;
  }
  const list = node('div', 'aa-list');
  list.setAttribute('role', 'list');
  for (const r of rows) {
    const item = node('div', 'aa-item');
    item.setAttribute('role', 'listitem');
    item.append(aaRow(r, data, ctx));
    list.append(item);
  }
  el.append(aaSummary(rows), list);
  // a live repaint keeps keyboard focus on the same agent's row
  if (focused) list.querySelector(`[data-agent="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

// ── side panel ──
function aaOpenPanel(agentId, data, ctx) {
  if (svModal || aaPanel.close) return;
  const { backdrop, dlg, close, mount } = openModal({
    labelledBy: 'aa-panel-title',
    describedBy: 'aa-panel-sub',
    busy: () => false,
    onClose: () => Object.assign(aaPanel, { close: null, agentId: null, paint: null }),
  });
  backdrop.classList.add('aa-backdrop');
  dlg.classList.add('aa-panel');
  let reasonFor = null; // card id whose blocker reason is loaded / loading
  let reason = null;

  const paint = (d) => {
    const a = (d.agents ?? []).find((x) => x.id === agentId);
    if (!a) return close();
    const r = aaInfo(d, a);
    const card = r.card;

    const head = node('div', 'aa-p-head');
    const id = node('div', 'aa-p-id');
    const title = node('h2', 'aa-p-name', a.name);
    title.id = 'aa-panel-title';
    const sub = node('div', 'aa-p-skill', a.skill ?? 'no skill');
    sub.id = 'aa-panel-sub';
    id.append(title, sub);
    const x = node('button', 'aa-p-close', '✕');
    x.type = 'button';
    x.dataset.k = 'close';
    x.setAttribute('aria-label', 'Close');
    x.onclick = close;
    head.append(avatarEl(a, 48), id, x);
    const edit = node('button', 'home-btn aa-p-edit', 'Edit');
    edit.type = 'button';
    edit.dataset.k = 'edit';
    edit.setAttribute('aria-label', `Edit ${a.name}`);
    edit.onclick = () => {
      close(); // the editor runs its own focus trap / Esc
      openAgentEditor(teamByName.get(a.name) ?? a);
    };
    const ident = node('div', 'aa-p-actions');
    ident.append(aaPill(r.state), edit);

    const now = node('section', 'aa-p-sec');
    now.append(node('h3', 'aa-p-label', 'Now'));
    if (card) {
      now.append(node('div', 'aa-p-card', card.title));
      const meta = node('div', 'aa-p-meta');
      meta.append(node('span', 'aa-lane', LANE_NAME(card.lane)), node('span', 'aa-sum-sep', '·'), 'in this state for ', aaSince(card.since, 'aa-elapsed'));
      now.append(meta);
      if (a.now) now.append(node('div', 'aa-p-activity', a.now));
      if (card.blocked) {
        const why = node('div', 'aa-p-reason');
        why.append(node('span', 'aa-p-reason-k', 'Blocker'));
        if (reasonFor !== card.id) {
          reasonFor = card.id;
          reason = null;
          fetch(`/task/${encodeURIComponent(card.id)}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((t) => {
              if (reasonFor !== card.id) return;
              reason = t?.blocked_reason || 'No reason given';
              if (aaPanel.paint === paint) paint(aaPanel.data);
            })
            .catch(() => {
              if (reasonFor !== card.id) return;
              reason = 'Couldn’t load the reason';
              if (aaPanel.paint === paint) paint(aaPanel.data);
            });
        }
        why.append(node('span', 'aa-p-reason-v', reason ?? 'Loading…'));
        now.append(why);
      } else if (r.needsYou) {
        now.append(node('div', 'aa-p-reason', 'The session is waiting for a decision from you.'));
      }
      const open = node('button', 'home-btn aa-p-open', 'Open card');
      open.type = 'button';
      open.dataset.k = 'open';
      open.onclick = () => {
        close();
        ctx.openCard(card.id, card.board.id);
      };
      now.append(open);
    } else {
      now.append(node('div', 'aa-p-muted', a.now ?? 'No current card'));
    }

    const stats = node('section', 'aa-p-sec');
    stats.append(node('h3', 'aa-p-label', 'All-time'));
    const grid = node('dl', 'aa-p-stats');
    const stat = (k, v) => {
      const d1 = node('div', 'aa-p-stat');
      d1.append(node('dt', null, k), node('dd', null, v));
      grid.append(d1);
    };
    stat('Cards', String(a.cards));
    stat('Hours', String(a.hours));
    stat('Lines', `+${a.lines_added} / −${a.lines_removed}`);
    stats.append(grid, node('p', 'aa-p-note', 'Stats for the selected range and full history arrive in a later update'));

    const hadFocus = dlg.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    dlg.replaceChildren(head, ident, now, stats);
    // a live repaint keeps focus on the same control (else the close button)
    if (hadFocus) (dlg.querySelector(`[data-k="${hadFocus}"]`) ?? x).focus();
    return x;
  };

  Object.assign(aaPanel, { close, agentId, paint, data });
  const closeBtn = paint(data);
  mount();
  closeBtn?.focus();
}

// keep the open panel's elapsed time current (it lives outside Home's view)
tick.add(() => {
  if (!aaPanel.close) return;
  for (const el of document.querySelectorAll('.aa-panel [data-since]')) el.textContent = fmtElapsed(Number(el.dataset.since));
});

dwRegister({
  type: 'active-agents',
  title: 'Active agents',
  sizes: ['S', 'M', 'L'],
  load(ctx) {
    return ctx.shared('home', async () => {
      const f = ctx.filters;
      const res = await fetch(`/home?project=${encodeURIComponent(ctx.projectId)}${f ? `&${f}` : ''}`);
      if (!res.ok) throw new Error(`Couldn’t load agents (HTTP ${res.status})`);
      return res.json();
    });
  },
  render(el, data, ctx) {
    if (!data?.agents?.length) return { empty: 'No agents yet. Agents appear once a card is assigned.' };
    el._aaData = data;
    aaPaint(el, data, ctx);
    if (aaPanel.paint) {
      aaPanel.data = data;
      aaPanel.paint(data);
    }
  },
  // live: session state + activity text, applied to this widget's data, then repaint
  onStatus(msg, el, ctx) {
    const data = el._aaData;
    if (!data || !msg.status) return;
    if (msg.session && msg.project_id) aaSessions(data).set(msg.project_id, msg.session);
    const st = msg.status;
    const act = `${st.verb} ${st.detail ?? ''}`.trim();
    for (const nb of data.now_building ?? []) {
      if (nb.id !== st.task_id) continue;
      nb.activity = act;
      for (const a of data.agents) if (aaOwns(a, nb)) a.now = act;
    }
    const scroll = el.querySelector('.aa-list')?.scrollTop ?? 0;
    aaPaint(el, data, ctx);
    const list = el.querySelector('.aa-list');
    if (list) list.scrollTop = scroll;
    if (aaPanel.paint && aaPanel.data === data) aaPanel.paint(data);
  },
});
