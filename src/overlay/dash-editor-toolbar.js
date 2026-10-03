// Dashboard editor: toolbar (globals prefix deTb). A sticky bar above #dash-root while editing:
// badge, Add widget (deLibraryOpen, when loaded), Undo / Redo, More (templates), Cancel, Save.
// Owns the save PUT (see dash-editor.js "Saving"), the "changed elsewhere" notice, the
// undo / redo shortcuts and the template dialogs. Builds on dash-editor.js (deState, deApply,
// deUndo/deRedo, deOn, deMenu, deAnnounce, deExit, deRequestExit, deBeginSave/deEndSave,
// deDialogOpen) and layout-ops.js (loFind). Never mutates a layout.

const deTb = { el: null, undo: null, redo: null, save: null, cancel: null, add: null, more: null, notice: null, noticeText: null, theirs: null, errors: null, status: null };
const DE_TB_NOTICE = 'This dashboard was changed elsewhere.';
let deTbStatusTimer = 0;
let deTbReloading = false; // "Reload theirs" is fetching: the other actions wait

const deTbPid = () => dw.board || currentProject();

function deTbButton(cls, text, label, onClick) {
  const b = node('button', `de-tb-btn ${cls}`, text);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.addEventListener('click', onClick);
  return b;
}

function deTbBuild() {
  const bar = node('div', 'de-tb');
  bar.id = 'de-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Dashboard editing');

  const main = node('div', 'de-tb-main');
  const left = node('div', 'de-tb-left');
  const badge = node('span', 'de-tb-badge', 'Editing dashboard');
  deTb.status = node('span', 'de-tb-status');
  deTb.status.setAttribute('role', 'status');
  left.append(badge, deTb.status);

  const right = node('div', 'de-tb-right');
  deTb.add = deTbButton('de-tb-add', '+ Add widget', 'Add widget', () => {
    if (typeof deLibraryOpen === 'function') deLibraryOpen();
  });
  deTb.undo = deTbButton('de-tb-icon', '↶', 'Undo', () => deTbUndo());
  deTb.redo = deTbButton('de-tb-icon', '↷', 'Redo', () => deTbRedo());
  deTb.undo.title = 'Undo (⌘Z / Ctrl+Z)';
  deTb.redo.title = 'Redo (⇧⌘Z / Ctrl+Y)';
  deTb.more = deTbButton('de-tb-more', 'More', 'More dashboard actions', (e) => {
    e.stopPropagation();
    const open = deMenuState?.anchor === deTb.more;
    deMenuClose(false);
    if (!open) deTbMoreMenu();
  });
  deTb.more.setAttribute('aria-haspopup', 'menu');
  deTb.more.setAttribute('aria-expanded', 'false');
  deTb.cancel = deTbButton('de-tb-cancel', 'Cancel', 'Cancel editing', () => deRequestExit());
  deTb.save = deTbButton('de-tb-save', 'Save', 'Save dashboard', () => deTbSave());
  const sep = node('span', 'de-tb-sep');
  sep.setAttribute('aria-hidden', 'true');
  right.append(deTb.add, deTb.undo, deTb.redo, deTb.more, sep, deTb.cancel, deTb.save);
  main.append(left, right);

  // the "changed elsewhere" notice
  deTb.notice = node('div', 'de-tb-notice hidden');
  deTb.notice.setAttribute('role', 'status');
  const nText = node('span', 'de-tb-notice-text', DE_TB_NOTICE);
  deTb.noticeText = nText;
  const theirs = deTbButton('de-tb-link', 'Reload theirs', 'Reload theirs: discard your edits and load the latest dashboard', () => deTbReloadTheirs());
  const mine = deTbButton('de-tb-link', 'Keep mine', 'Keep mine: saving will overwrite the other change', () => deTbHideNotice('Keeping your edits. Saving will overwrite the other change'));
  deTb.theirs = theirs;
  deTb.notice.append(nText, theirs, mine);

  // save errors
  deTb.errors = node('div', 'de-tb-errors hidden');
  deTb.errors.setAttribute('role', 'alert');

  bar.append(main, deTb.notice, deTb.errors);
  deTb.el = bar;
  // keep focused handles / scrollIntoView clear of the sticky bar: #home-body's scroll-padding
  new ResizeObserver(() => {
    if (bar.isConnected) $('home-body')?.style.setProperty('--de-tb-h', `${bar.offsetHeight}px`);
  }).observe(bar);
}

function deTbSync() {
  if (!deTb.el) return;
  const busy = deState.saving;
  const hold = busy || deTbReloading;
  deTb.undo.disabled = hold || !deCanUndo();
  deTb.redo.disabled = hold || !deCanRedo();
  deTb.save.disabled = hold || !deState.dirty;
  deTb.cancel.disabled = hold;
  deTb.more.disabled = hold;
  deTb.add.disabled = hold;
  deTb.add.hidden = typeof deLibraryOpen !== 'function';
  deTb.save.textContent = busy ? 'Saving…' : 'Save';
  deTb.save.setAttribute('aria-busy', String(busy));
  deTb.el.classList.toggle('busy', busy);
}

function deTbFlash(text) {
  if (!deTb.status) return;
  clearTimeout(deTbStatusTimer);
  deTb.status.textContent = text;
  deTbStatusTimer = setTimeout(() => deTb.status && (deTb.status.textContent = ''), 4000);
}

function deTbUndo() {
  if (deState.saving || deTbReloading) return;
  deUndo();
}
function deTbRedo() {
  if (deState.saving || deTbReloading) return;
  deRedo();
}

// ── lifecycle ──
deOn('enter', () => {
  if (!deTb.el) deTbBuild();
  deTbHideNotice();
  deTbClearErrors();
  deTb.status.textContent = '';
  const root = $('dash-root');
  root?.before(deTb.el);
  deTbSync();
});
deOn('exit', () => {
  deTbHideNotice();
  deTbClearErrors();
  deTb.el?.remove();
});
deOn('change', deTbSync);
deOn('external-change', () => {
  if (!deTb.notice) return;
  deTb.notice.classList.remove('hidden');
});

// ── no edits and no exits while a save is in flight (wraps the core's globals) ──
// Feature modules call these by their global names at call time, so the wrappers cover them,
// and the core's own Esc / narrow-viewport / Done handlers go through deRequestExit.
const deTbBusyNote = () => deAnnounce('Wait for the save to finish');
for (const name of ['deApply', 'deUndo', 'deRedo']) {
  const core = window[name];
  window[name] = function (...args) {
    if (deState.saving) {
      deTbBusyNote();
      return false;
    }
    return core.apply(this, args);
  };
}
const deTbCoreRequestExit = deRequestExit;
deRequestExit = function () {
  if (deState.saving) return void deTbBusyNote(); // Esc / Cancel / viewport < 800px mid-save
  return deTbCoreRequestExit();
};

function deTbHideNotice(say) {
  if (!deTb.notice) return;
  const wasShown = !deTb.notice.classList.contains('hidden');
  deTb.notice.classList.add('hidden');
  deTb.noticeText.textContent = DE_TB_NOTICE;
  deTb.theirs.disabled = false;
  if (say && wasShown) {
    deAnnounce(say);
    deTb.save?.focus();
  }
}

// "Reload theirs": fetch the stored layout first; only then discard, show it and edit it.
async function deTbReloadTheirs() {
  if (!deState.active || deState.saving || deTbReloading) return;
  const pid = deTbPid();
  deTb.theirs.disabled = true;
  deTbReloading = true;
  deTbSync();
  try {
    await deTbReloadRun(pid);
  } finally {
    deTbReloading = false;
    deTbSync();
  }
}
async function deTbReloadRun(pid) {
  let layout;
  try {
    const res = await fetch(`/project/${encodeURIComponent(pid)}/layout`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    layout = (await res.json()).layout;
    if (!layout) throw new Error('no layout');
  } catch (e) {
    if (!deState.active) return;
    deTb.theirs.disabled = false;
    deTb.noticeText.textContent = `${DE_TB_NOTICE} Couldn’t load it (${e.message}).`;
    deAnnounce(`Couldn’t load the latest dashboard (${e.message})`);
    return;
  }
  if (!deState.active || deTbPid() !== pid) return; // left edit mode / switched board meanwhile
  if (deState.saving) {
    // a save started anyway (another module / the core): never discard under it
    deTb.theirs.disabled = false;
    deTb.noticeText.textContent = `${DE_TB_NOTICE} A save is in progress, so it wasn’t reloaded.`;
    return void deAnnounce('A save is in progress, so the dashboard wasn’t reloaded');
  }
  deTbHideNotice();
  deExit(); // discard (its refetch, if any, returns early: we're editing again by then)
  dwRenderLayout(layout); // becomes dw.layout: the base deEnter copies
  if (deEnter()) deAnnounce('Loaded the latest dashboard');
}

// ── shortcuts: ⌘/Ctrl-Z undo, ⇧⌘/Ctrl-Z and Ctrl-Y redo ──
document.addEventListener('keydown', (e) => {
  if (!deState.active || e.defaultPrevented || e.altKey || !(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  const redo = (k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey && !e.shiftKey);
  const undo = k === 'z' && !e.shiftKey;
  if (!undo && !redo) return;
  if (activeView !== 'home' || deDialogOpen() || deMenuState || document.querySelector('[role="menu"]')) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], dialog')) return;
  e.preventDefault();
  if (redo) deTbRedo();
  else deTbUndo();
});

// ── save ──
async function deTbSave() {
  if (!deState.active || deState.saving || deTbReloading || !deState.dirty) return;
  const pid = deTbPid();
  const draft = deState.draft;
  const snap = JSON.stringify(draft);
  deTbClearErrors();
  deBeginSave();
  deTbSync();
  let ok = false;
  let failure = null;
  try {
    const res = await fetch(`/project/${encodeURIComponent(pid)}/layout`, { method: 'PUT', body: JSON.stringify({ layout: draft }) });
    ok = res.ok;
    if (!ok) {
      const body = await res.json().catch(() => ({}));
      failure = { status: res.status, message: body.error || `HTTP ${res.status}`, errors: Array.isArray(body.errors) ? body.errors : [] };
    }
  } catch (e) {
    failure = { status: 0, message: e.message || 'network error', errors: [] };
  }
  if (!deState.active) return void deEndSave(false); // the board changed under us mid-save
  if (ok && JSON.stringify(deState.draft) !== snap) {
    // the draft moved while the PUT was in flight (edits are blocked, but never claim it's stored)
    deEndSave(false);
    deTbSync();
    deTbFlash('Changes made during save were kept — save again');
    return void deAnnounce('Changes made during save were kept — save again');
  }
  deEndSave(ok);
  if (ok) return void deExit({ saved: true }); // announces "Dashboard saved"; the core's echo window assumes we exit
  deTbSync();
  deTbShowErrors(failure, draft);
  if (!deWide()) deRequestExit(); // the viewport narrowed mid-save: what it would have done
}

function deTbClearErrors() {
  if (!deTb.errors) return;
  deTb.errors.replaceChildren();
  deTb.errors.classList.add('hidden');
}

function deTbShowErrors(failure, layout) {
  const box = deTb.errors;
  box.replaceChildren();
  const head = node('div', 'de-tb-errors-head');
  const title =
    failure.status === 400
      ? 'The dashboard couldn’t be saved: the layout isn’t valid.'
      : failure.status === 403
        ? 'The dashboard couldn’t be saved: editing is only allowed from this machine.'
        : `The dashboard couldn’t be saved (${failure.message}).`;
  head.append(node('span', 'de-tb-errors-title', title));
  const close = deTbButton('de-tb-x', '✕', 'Dismiss save errors', () => {
    deTbClearErrors();
    deTb.save?.focus();
  });
  head.append(close);
  box.append(head);
  if (failure.errors.length) {
    const MAX = 8;
    const list = node('ul', 'de-tb-errors-list');
    for (const err of failure.errors.slice(0, MAX)) {
      const li = node('li', 'de-tb-error');
      const where = deTbWhere(layout, err.path);
      li.append(node('span', 'de-tb-error-msg', deTbSentence(err.message)));
      if (where) li.append(node('span', 'de-tb-error-where', where));
      list.append(li);
    }
    if (failure.errors.length > MAX) list.append(node('li', 'de-tb-error more', `and ${failure.errors.length - MAX} more`));
    box.append(list);
  } else if (failure.status === 400) {
    box.append(node('div', 'de-tb-error-msg', deTbSentence(failure.message)));
  }
  box.classList.remove('hidden');
  deAnnounce(title);
}

const deTbSentence = (s) => {
  const t = String(s || 'invalid');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// sections[0].rows[1].slots[2].widgets[0].size → "Widget “Now building” in Row 2 of “Delivery”"
function deTbWhere(layout, path) {
  if (!path) return '';
  let cur = layout;
  let lastId = null;
  for (const tok of String(path).match(/[^.[\]]+/g) ?? []) {
    if (cur == null || typeof cur !== 'object') break;
    cur = cur[/^\d+$/.test(tok) ? Number(tok) : tok];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && typeof cur.id === 'string' && cur.id) lastId = cur.id;
  }
  const loc = lastId != null && typeof loFind === 'function' ? loFind(layout, lastId) : null;
  return loc ? deTbDescribe(layout, loc) : '';
}

function deTbDescribe(layout, loc) {
  const { kind, node: n, parent } = loc;
  const q = (s) => `“${s || 'Untitled'}”`;
  const containerName = (c) => (c && c.id ? q(c.title) : '');
  const rowName = (row, container) => {
    const i = (container?.rows ?? []).indexOf(row);
    const c = containerName(container);
    return `Row ${i + 1}${c ? ` of ${c}` : ''}`;
  };
  if (kind === 'section') return `Section ${q(n.title)}`;
  if (kind === 'tab') return `Tab ${q(n.title)}`;
  if (kind === 'row') return rowName(n, parent);
  if (kind === 'slot') {
    const rowLoc = parent?.id ? loFind(layout, parent.id) : null;
    const i = (parent?.slots ?? []).indexOf(n);
    return `Slot ${i + 1}${rowLoc ? ` in ${rowName(rowLoc.node, rowLoc.parent)}` : ''}`;
  }
  if (kind === 'widget') {
    const def = typeof dwDef === 'function' ? dwDef(n.type) : null;
    const params = n.params && typeof n.params === 'object' ? n.params : {};
    let t = params.title;
    if (!t && def) t = typeof def.title === 'function' ? def.title(params) : def.title;
    return `Widget ${q(t || n.type)}`;
  }
  return '';
}

// ── More menu ──
function deTbMoreMenu() {
  deMenu(deTb.more, [
    { label: 'Save as template…', onSelect: () => deTbSaveTemplate() },
    { label: 'Reset to template…', onSelect: () => deTbResetDialog() },
  ]);
}

// ── Save as template… ──
function deTbSaveTemplate() {
  if (!deState.active || svModal) return;
  const layout = deState.draft;
  let busy = false;
  const { dlg, close, mount } = openModal({ labelledBy: 'de-tpl-title', describedBy: 'de-tpl-sub', busy: () => busy, fallbackFocus: () => deTb.more });
  dlg.classList.add('de-tb-dlg');
  const title = node('h2', 'sv-title', 'Save as template');
  title.id = 'de-tpl-title';
  const sub = node('p', 'sv-sub', 'Saves the dashboard as it looks now, including unsaved edits, as a template any board can use.');
  sub.id = 'de-tpl-sub';
  const form = node('form', 'de-tb-form');
  form.noValidate = true;
  const label = node('label', 'sv-label', 'Name');
  label.htmlFor = 'de-tpl-name';
  const input = document.createElement('input');
  input.id = 'de-tpl-name';
  input.className = 'sv-input';
  input.type = 'text';
  input.maxLength = 60;
  input.autocomplete = 'off';
  input.required = true;
  input.placeholder = 'e.g. Release week';
  const err = node('div', 'sv-error');
  err.id = 'de-tpl-err';
  err.setAttribute('role', 'alert');
  input.setAttribute('aria-describedby', 'de-tpl-err');
  const foot = node('div', 'sv-foot');
  const cancel = node('button', 'home-btn', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => !busy && close();
  const ok = node('button', 'home-btn primary', 'Save template');
  ok.type = 'submit';
  foot.append(node('span', 'sv-foot-note'), cancel, ok);
  form.append(label, input, err, foot);
  input.oninput = () => {
    err.textContent = '';
    input.removeAttribute('aria-invalid');
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const name = input.value.trim();
    if (!name) {
      err.textContent = 'Give the template a name.';
      input.setAttribute('aria-invalid', 'true');
      return void input.focus();
    }
    busy = true;
    ok.disabled = cancel.disabled = input.disabled = true;
    ok.textContent = 'Saving…';
    try {
      const res = await fetch('/dashboard/templates', { method: 'POST', body: JSON.stringify({ name, layout }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 403 ? 'Templates can only be saved from this machine.' : deTbSentence(body.errors?.[0]?.message || body.error || `HTTP ${res.status}`));
      busy = false;
      close();
      deTbFlash(`Template “${name}” saved`);
      deAnnounce(`Saved template ${name}`);
    } catch (ex) {
      busy = false;
      ok.disabled = cancel.disabled = input.disabled = false;
      ok.textContent = 'Save template';
      err.textContent = `Couldn’t save the template: ${ex.message}`;
      input.focus();
    }
  };
  dlg.append(title, sub, form);
  mount();
  input.focus();
}

// ── Reset to template… ──
function deTbResetDialog() {
  if (!deState.active || svModal) return;
  const pid = deTbPid();
  let busy = false;
  const { dlg, close, mount } = openModal({ labelledBy: 'de-reset-title', describedBy: 'de-reset-sub', busy: () => busy, fallbackFocus: () => deTb.more });
  dlg.classList.add('de-tb-dlg');

  const showList = () => {
    const title = node('h2', 'sv-title', 'Reset to template');
    title.id = 'de-reset-title';
    const sub = node('p', 'sv-sub', 'Replaces your draft with a template. Nothing is stored until you save.');
    sub.id = 'de-reset-sub';
    const list = node('div', 'de-tb-tpls');
    list.setAttribute('aria-busy', 'true');
    list.append(node('div', 'sv-empty', 'Loading templates…'));
    const foot = node('div', 'sv-foot');
    const def = node('button', 'home-btn', 'Reset to board default…');
    def.type = 'button';
    def.onclick = () => showConfirm();
    const cancel = node('button', 'home-btn', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = close;
    foot.append(def, node('span', 'sv-foot-note'), cancel);
    dlg.replaceChildren(title, sub, list, foot);
    cancel.focus();
    loadTemplates(list);
  };

  const loadTemplates = async (list) => {
    let items;
    try {
      const res = await fetch(`/dashboard/templates?project=${encodeURIComponent(pid)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      items = await res.json();
    } catch (e) {
      if (!list.isConnected) return;
      list.removeAttribute('aria-busy');
      const msg = node('div', 'sv-error', `Couldn’t load templates (${e.message}).`);
      const retry = node('button', 'home-btn', 'Retry');
      retry.type = 'button';
      retry.onclick = () => {
        list.replaceChildren(node('div', 'sv-empty', 'Loading templates…'));
        list.setAttribute('aria-busy', 'true');
        loadTemplates(list);
      };
      list.replaceChildren(msg, retry);
      return;
    }
    if (!list.isConnected) return;
    list.removeAttribute('aria-busy');
    const sorted = [...(Array.isArray(items) ? items : [])].sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin));
    if (!sorted.length) return void list.replaceChildren(node('div', 'sv-empty', 'No templates yet.'));
    list.replaceChildren(
      ...sorted.map((t) => {
        const b = node('button', 'de-tb-tpl');
        b.type = 'button';
        b.setAttribute('aria-label', `Apply template ${t.name}${t.builtin ? ' (built-in)' : ''}`);
        b.append(node('span', 'de-tb-tpl-name', t.name));
        if (t.builtin) b.append(node('span', 'de-tb-tpl-badge', 'Built-in'));
        b.onclick = () => {
          close();
          if (deApply(structuredClone(t.layout), `Applied template ${t.name}`)) deTbFlash(`Applied “${t.name}”. Save to keep it.`);
        };
        return b;
      }),
    );
  };

  const showConfirm = () => {
    const title = node('h2', 'sv-title', 'Reset to the board default?');
    title.id = 'de-reset-title';
    const sub = node('p', 'sv-sub', 'This deletes the saved layout for this board at once, for everyone viewing it, and discards your unsaved edits.');
    sub.id = 'de-reset-sub';
    const err = node('div', 'sv-error');
    err.setAttribute('role', 'alert');
    const foot = node('div', 'sv-foot');
    const back = node('button', 'home-btn', 'Back');
    back.type = 'button';
    back.onclick = () => !busy && showList();
    const go = node('button', 'home-btn pl-danger', 'Reset dashboard');
    go.type = 'button';
    go.onclick = async () => {
      if (busy) return;
      busy = true;
      go.disabled = back.disabled = true;
      go.textContent = 'Resetting…';
      let stored;
      deBeginSave(); // the DELETE's live echo is ours: no "changed elsewhere" notice
      try {
        const res = await fetch(`/project/${encodeURIComponent(pid)}/layout`, { method: 'DELETE' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(res.status === 403 ? 'only allowed from this machine' : body.error || `HTTP ${res.status}`);
        stored = body.layout;
      } catch (e) {
        deEndSave(false);
        busy = false;
        go.disabled = back.disabled = false;
        go.textContent = 'Reset dashboard';
        err.textContent = `Couldn’t reset the dashboard (${e.message}).`;
        return;
      }
      deEndSave(true);
      busy = false;
      close();
      if (!deState.active) return;
      deExit(); // leave edit mode; then the default the DELETE returned replaces it, in the same frame
      if (stored) dwRenderLayout(stored);
      else dwLoadLayout();
      deAnnounce('Dashboard reset to the board default');
    };
    foot.append(node('span', 'sv-foot-note'), back, go);
    dlg.replaceChildren(title, sub, err, foot);
    back.focus();
  };

  showList();
  mount();
  dlg.querySelector('.sv-foot button:last-child')?.focus();
}
