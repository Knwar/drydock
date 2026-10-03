// Dashboard widget: tab group (type 'tabs', params.tabs = [{ id, title, rows }]).
// Only the active tab's rows exist (dwRenderRows); switching tabs rebuilds the panel
// and prunes the detached instances. The strip + panel DOM is kept per widget so a
// refresh cycle re-attaches it (the renderer's loop then refreshes the nested widgets)
// instead of rebuilding the active tab every time.

const dwTabsState = new WeakMap(); // ctx → { strip, panel, tabs, buttons, active, focused }
let dwTabsSeq = 0;

const dwTabsKey = (ctx) => `dw.tab.${ctx.projectId}.${ctx.id}`;

function dwTabsSelect(st, ctx, id, focus) {
  const tab = st.tabs.find((t) => t.id === id) ?? st.tabs[0];
  st.active = tab.id;
  for (const [i, t] of st.tabs.entries()) {
    const b = st.buttons[i];
    const on = t.id === tab.id;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    b.classList.toggle('selected', on);
    if (on) st.panel.setAttribute('aria-labelledby', b.id);
  }
  // the previous tab's widgets leave the DOM: drop them from the refresh / status loops
  st.panel.replaceChildren();
  dwPrune();
  if (tab.rows?.length) dwRenderRows(st.panel, tab.rows, ctx);
  else st.panel.append(node('div', 'dw-empty', 'Nothing in this tab'));
  st.panel.scrollTop = 0;
  if (focus) st.buttons[st.tabs.indexOf(tab)].focus();
}

function dwTabsBuild(el, tabs, ctx) {
  const uid = `dw-tabs-${++dwTabsSeq}`;
  const st = { tabs, buttons: [], active: null, focused: false };
  st.strip = node('div', 'dw-tabs-strip');
  st.strip.setAttribute('role', 'tablist');
  st.panel = node('div', 'dw-tabs-panel');
  st.panel.id = `${uid}-panel`;
  st.panel.setAttribute('role', 'tabpanel');
  st.panel.tabIndex = 0;
  const select = (id, focus) => {
    if (id === st.active) {
      if (focus) st.buttons[st.tabs.findIndex((t) => t.id === id)].focus();
      return;
    }
    dwTabsSelect(st, ctx, id, focus);
    try {
      localStorage.setItem(dwTabsKey(ctx), id);
    } catch {} // not persisted, still applies this session
  };
  tabs.forEach((t, i) => {
    const b = node('button', 'dw-tab', t.title);
    b.type = 'button';
    b.id = `${uid}-tab-${i}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', st.panel.id);
    b.onclick = () => select(t.id, false);
    st.buttons.push(b);
    st.strip.append(b);
  });
  st.strip.addEventListener('keydown', (e) => {
    const i = st.buttons.indexOf(e.target);
    if (i < 0) return;
    const n = st.buttons.length;
    const to = { ArrowLeft: (i - 1 + n) % n, ArrowRight: (i + 1) % n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(st.tabs[to].id, true);
  });
  st.strip.addEventListener('focusin', () => (st.focused = true));
  // a refresh detaches the focused tab (focusout) and re-attaches it in the same task:
  // settle afterwards, so render() can still hand focus back
  st.strip.addEventListener('focusout', () => setTimeout(() => (st.focused = st.strip.contains(document.activeElement))));
  el.append(st.strip, st.panel); // attached before the first tab's widgets load
  let stored = null;
  try {
    stored = localStorage.getItem(dwTabsKey(ctx));
  } catch {} // storage unavailable: the first tab
  dwTabsSelect(st, ctx, tabs.some((t) => t.id === stored) ? stored : tabs[0].id, false);
  dwTabsState.set(ctx, st);
  return st;
}

dwRegister({
  type: 'tabs',
  title: '',
  sizes: ['M', 'L', 'XL'],
  render(el, _data, ctx) {
    const tabs = (Array.isArray(ctx.params.tabs) ? ctx.params.tabs : []).filter((t) => t && t.id != null);
    if (!tabs.length) return { empty: 'No tabs configured' };
    // params belong to this instance (a layout change renders new instances)
    const st = dwTabsState.get(ctx) ?? dwTabsBuild(el, tabs, ctx);
    // a refresh cleared el: re-attach the same strip + panel (nested widgets stay alive
    // and the renderer's loop, which runs after this, refreshes them)
    el.append(st.strip, st.panel);
    if (st.focused && (!document.activeElement || document.activeElement === document.body))
      st.buttons[st.tabs.findIndex((t) => t.id === st.active)].focus();
  },
});
