'use strict';
/* global Terminal, FitAddon, SearchAddon, WebLinksAddon, WebglAddon, TERMINAL_THEMES, icon, hydrateIcons */

const api = window.termx;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const posixJoin = (a, b) => (a.endsWith('/') ? a + b : a + '/' + b);
const posixParent = (p) => (p === '/' ? '/' : p.replace(/\/[^/]+\/?$/, '') || '/');

const COLORS = ['#7c5cff', '#22d3ee', '#34d399', '#fbbf24', '#f87171', '#f472b6', '#60a5fa', '#a3e635'];
const SHELL_STYLE = {
  pwsh: { icon: 'terminal', color: '#3b82f6' },
  powershell: { icon: 'terminal', color: '#2563eb' },
  cmd: { icon: 'windows', color: '#475569' },
  bash: { icon: 'terminal', color: '#f97316' },
  wsl: { icon: 'penguin', color: '#e11d48' },
};
const shellStyle = (sh) => SHELL_STYLE[sh?.kind] || SHELL_STYLE.bash;

// ---------- settings ----------
const DEFAULTS = {
  theme: 'TermX Night',
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
  lineHeight: 1.15,
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: true,
  rightClickPaste: true,
  defaultShell: '',
  sidebarW: 280,
  selectionColor: '#fbbf24',
  highlightColor: '#34d399',
  autoUpdateCheck: true,
};
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('termx.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem('termx.settings', JSON.stringify(settings)); } catch {}
}

// A "tab" in the strip is a group; each group holds a split tree of panes.
// state.tabs is the flat list of panes (one terminal each).
const state = {
  tabs: [],
  active: null,
  groups: [],
  activeGroup: null,
  sessions: [],
  shells: [],
  info: {},
  multiExec: false,
  panel: 'sessions',
  collapsed: new Set(),
  selectedSession: null,
  folders: [], // saved folder paths, so empty folders persist
  folderColors: {}, // folder path -> color
  flows: [],
  selectedFlow: null,
  recording: null, // { tab, steps, last } while a flow is being recorded
};
const byTermId = new Map();
const pendingData = new Map();

// ---------- small UI utils ----------
function toast(msg, kind = 'ok') {
  const t = el(`<div class="toast ${kind}">${icon(kind === 'err' ? 'x' : 'sparkle')}<span>${esc(msg)}</span></div>`);
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 220); }, kind === 'err' ? 5000 : 2600);
}

let menuCleanup = null;
function showMenu(x, y, items) {
  hideMenu();
  const m = $('#ctx-menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.append(el('<hr>')); continue; }
    if (!it) continue;
    const b = el(`<button class="${it.danger ? 'danger' : ''}">${icon(it.icon || 'chevronRight')}<span>${esc(it.label)}</span>${it.kbd ? `<span class="mk">${esc(it.kbd)}</span>` : ''}</button>`);
    b.onclick = () => { hideMenu(); it.action(); };
    m.append(b);
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  const off = (e) => { if (!m.contains(e.target)) hideMenu(); };
  const key = (e) => { if (e.key === 'Escape') hideMenu(); };
  setTimeout(() => { addEventListener('mousedown', off, true); addEventListener('keydown', key, true); addEventListener('blur', hideMenu); });
  menuCleanup = () => { removeEventListener('mousedown', off, true); removeEventListener('keydown', key, true); removeEventListener('blur', hideMenu); };
}
function hideMenu() {
  $('#ctx-menu').classList.add('hidden');
  if (menuCleanup) { menuCleanup(); menuCleanup = null; }
}

let modalClose = null;
function openModal(node, { onClose } = {}) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = '';
  root.append(node);
  root.classList.remove('hidden');
  hydrateIcons(node);
  node.querySelectorAll('input[type=password]').forEach(addReveal);
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeModal(); } };
  const click = (e) => { if (e.target === root) closeModal(); };
  addEventListener('keydown', key, true);
  root.addEventListener('mousedown', click);
  modalClose = () => {
    removeEventListener('keydown', key, true);
    root.removeEventListener('mousedown', click);
    root.classList.add('hidden');
    root.innerHTML = '';
    modalClose = null;
    onClose?.();
    state.active?.term.focus();
  };
  setTimeout(() => node.querySelector('[autofocus]')?.focus());
}
function closeModal() { modalClose?.(); }

// Wraps a password input with a show/hide toggle.
function addReveal(input) {
  const wrap = el('<div class="pw-wrap"></div>');
  input.replaceWith(wrap);
  wrap.append(input);
  const b = el(`<button type="button" class="pw-eye" tabindex="-1" title="Show password">${icon('eye')}</button>`);
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.innerHTML = icon(show ? 'eyeOff' : 'eye');
    b.title = show ? 'Hide password' : 'Show password';
    input.focus();
  };
  wrap.append(b);
}

function promptDialog({ title, sub, fields, check, ok = 'Continue' }) {
  return new Promise((resolve) => {
    let done = false;
    const node = el(`<form class="modal sm">
      <div class="modal-head"><div><h3>${esc(title)}</h3>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div></div>
      <div class="modal-body">
        ${fields.map((f, i) => `<div class="field"><label>${esc(f.label)}</label>
          <input class="input" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" spellcheck="false" ${i === (fields.findIndex((x) => !x.value) + 1 || 1) - 1 ? 'autofocus' : ''}>
          ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`).join('')}
        ${check ? `<label class="check"><input type="checkbox" name="__check" ${check.value ? 'checked' : ''}> ${esc(check.label)}</label>` : ''}
      </div>
      <div class="modal-foot"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">${esc(ok)}</button></div>
    </form>`);
    node.querySelector('[data-x]').onclick = () => closeModal();
    node.onsubmit = (e) => {
      e.preventDefault();
      const out = {};
      fields.forEach((f) => (out[f.name] = node.elements[f.name].value));
      if (check) out.check = node.elements.__check.checked;
      done = true;
      closeModal();
      resolve(out);
    };
    openModal(node, { onClose: () => { if (!done) resolve(null); } });
  });
}

function confirmDialog(title, message, ok = 'Delete') {
  return new Promise((resolve) => {
    let done = false;
    const node = el(`<div class="modal sm">
      <div class="modal-head"><div><h3>${esc(title)}</h3><div class="sub">${esc(message)}</div></div></div>
      <div class="modal-foot"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok autofocus>${esc(ok)}</button></div></div>`);
    node.querySelector('[data-x]').onclick = () => closeModal();
    node.querySelector('[data-ok]').onclick = () => { done = true; closeModal(); resolve(true); };
    openModal(node, { onClose: () => { if (!done) resolve(false); } });
  });
}

const fmtBytes = (n) => {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
};
const fmtUptime = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

// ---------- terminal tabs ----------
// Selected text uses the chosen colour on every theme; while a find bar is open the
// active match is a selection too, so that pane shows it in the search colour instead.
function termTheme(tab) {
  const c = tab?.finding ? settings.highlightColor : settings.selectionColor;
  return { ...(TERMINAL_THEMES[settings.theme] || TERMINAL_THEMES['TermX Night']), selectionBackground: c + '70', selectionInactiveBackground: c + '45' };
}

// Decorations are drawn opaque, so fainter shades are mixed with the terminal background.
function mixHex(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('');
}

const findDecorations = () => {
  const c = settings.highlightColor;
  const bg = (TERMINAL_THEMES[settings.theme] || TERMINAL_THEMES['TermX Night']).background;
  return { matchBackground: mixHex(c, bg, 0.3), matchBorder: mixHex(c, bg, 0.6), matchOverviewRuler: c, activeMatchBackground: c, activeMatchBorder: '#ffffff', activeMatchColorOverviewRuler: c };
};

// ---------- fonts ----------
// Fonts worth offering even when the system font list can't be read.
const KNOWN_MONO = ['Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', 'Fira Code', 'Fira Mono', 'Consolas', 'Source Code Pro',
  'Hack', 'IBM Plex Mono', 'Roboto Mono', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', 'Inconsolata',
  'Menlo', 'Monaco', 'SF Mono', 'Courier New', 'Lucida Console', 'Lucida Sans Typewriter', 'Victor Mono', 'Iosevka', 'Space Mono'];
// A family is usable when it is installed and monospaced. Measured with a proportional fallback,
// so a missing font falls back to serif and fails the equal-width test.
let monoCtx = null;
function isMonoFont(fam) {
  monoCtx ||= document.createElement('canvas').getContext('2d');
  monoCtx.font = `20px "${fam.replace(/"/g, '')}", serif`;
  const a = monoCtx.measureText('iiiiiiiiii').width;
  return a > 0 && Math.abs(a - monoCtx.measureText('MMMMMMMMMM').width) < 0.5 && Math.abs(a - monoCtx.measureText('..........').width) < 0.5;
}
let monoFonts = null;
let monoFontsLoading = null;
function loadMonoFonts() {
  monoFontsLoading ||= (async () => {
    const names = new Set(KNOWN_MONO);
    try { for (const f of await window.queryLocalFonts()) names.add(f.family); } catch {}
    monoFonts = [...names].filter((f) => !/dings|^marlett$|^symbol$|^mt extra$/i.test(f) && isMonoFont(f)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return monoFonts;
  })();
  return monoFontsLoading;
}
const firstFamily = (css) => (css || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
const familyCss = (fam) => `'${fam.replace(/'/g, '')}', 'Cascadia Mono', Consolas, monospace`;

function termOptions(tab) {
  return {
    theme: termTheme(tab),
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily || DEFAULTS.fontFamily,
    lineHeight: settings.lineHeight,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
  };
}

function applyTermBg() {
  const bg = (TERMINAL_THEMES[settings.theme] || TERMINAL_THEMES['TermX Night']).background;
  document.documentElement.style.setProperty('--term-bg', bg);
  document.documentElement.style.setProperty('--hl', settings.highlightColor);
}

// ---------- split layout ----------
// node: { pane } | { dir: 'row' | 'col', a, b, ratio }
const leaves = (node) => (!node ? [] : node.pane ? [node.pane] : [...leaves(node.a), ...leaves(node.b)]);
function insertPane(node, target, pane, dir) {
  if (node.pane) return node.pane === target ? { dir, a: node, b: { pane }, ratio: 0.5 } : node;
  node.a = insertPane(node.a, target, pane, dir);
  node.b = insertPane(node.b, target, pane, dir);
  return node;
}
function removePane(node, target) {
  if (node.pane) return node.pane === target ? null : node;
  const a = removePane(node.a, target), b = removePane(node.b, target);
  if (!a) return b;
  if (!b) return a;
  node.a = a;
  node.b = b;
  return node;
}

let groupSeq = 0;
function newGroup(pane) {
  const g = { key: ++groupSeq, root: { pane }, activePane: pane, el: el('<div class="term-group"></div>') };
  $('#stack').append(g.el);
  state.groups.push(g);
  return g;
}

function layoutGroup(g) {
  const build = (node) => {
    if (node.pane) return node.pane.box;
    const wrap = el(`<div class="split ${node.dir}"></div>`);
    const a = build(node.a), b = build(node.b);
    const divider = el('<div class="divider"></div>');
    const setFlex = () => { a.style.flex = `${node.ratio} 1 0`; b.style.flex = `${1 - node.ratio} 1 0`; };
    setFlex();
    divider.onmousedown = (e) => {
      e.preventDefault();
      divider.classList.add('dragging');
      document.body.style.cursor = node.dir === 'row' ? 'col-resize' : 'row-resize';
      const move = (ev) => {
        const r = wrap.getBoundingClientRect();
        const pos = node.dir === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
        node.ratio = Math.max(0.1, Math.min(0.9, pos));
        setFlex();
      };
      const up = () => {
        divider.classList.remove('dragging');
        document.body.style.cursor = '';
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        state.active?.term.focus();
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    };
    divider.ondblclick = () => { node.ratio = 0.5; setFlex(); };
    wrap.append(a, divider, b);
    return wrap;
  };
  const root = build(g.root);
  root.style.flex = '1 1 0';
  g.el.replaceChildren(root);
  g.el.classList.toggle('multi-pane', !!g.root.dir);
  leaves(g.root).forEach(fitTab);
}

let tabSeq = 0;
function createTab({ type, title, color, session, shellId, config, split }) {
  const tab = { key: ++tabSeq, type, title, color, session, shellId, config, termId: null, status: 'connecting', stats: null, files: null };
  tab.box = el(`<div class="pane"><div class="pane-head"><span class="tdot"></span><span class="ptitle"></span>
    <button class="pbtn" data-grep title="Grep: filter output (Ctrl+Shift+G)">${icon('filter')}</button>
    <button class="pbtn" data-split title="Split right (Ctrl+Shift+D)">${icon('columns')}</button>
    <button class="pbtn" data-close title="Close pane (Ctrl+Shift+W)">${icon('x')}</button></div><div class="term-host"></div></div>`);
  tab.host = tab.box.querySelector('.term-host');
  tab.box.querySelector('[data-close]').onclick = () => closeTab(tab);
  tab.box.querySelector('[data-split]').onclick = () => splitPane('row', tab);
  tab.box.querySelector('[data-grep]').onclick = () => (tab.grep ? closeGrep(tab) : openGrep(tab));
  tab.box.addEventListener('focusin', () => { if (state.active !== tab) activate(tab, { skipFocus: true }); });
  tab.box.addEventListener('mousedown', () => { if (state.active !== tab) activate(tab); });
  if (split?.from && state.tabs.includes(split.from)) {
    tab.group = split.from.group;
    tab.group.root = insertPane(tab.group.root, split.from, tab, split.dir);
  } else {
    tab.group = newGroup(tab);
  }
  state.tabs.push(tab);
  layoutGroup(tab.group);
  const term = new Terminal({
    ...termOptions(),
    allowProposedApi: true,
    windowsPty: type === 'local' && state.info.platform === 'win32' ? { backend: 'conpty', buildNumber: state.info.build } : undefined,
  });
  tab.term = term;
  tab.fit = new FitAddon.FitAddon();
  tab.search = new SearchAddon.SearchAddon();
  term.loadAddon(tab.fit);
  term.loadAddon(tab.search);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => api.openExternal(uri)));
  activate(tab, { skipFocus: true });
  term.open(tab.host);
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch { /* falls back to DOM renderer */ }
  fitTab(tab);

  term.attachCustomKeyEventHandler((e) => !handleShortcut(e, true));
  term.onData((d) => sendInput(tab, d));
  term.onResize(({ cols, rows }) => { if (tab.termId) api.resize(tab.termId, cols, rows); if (tab === state.active) renderStatus(); });
  term.onSelectionChange(() => {
    if (settings.copyOnSelect && term.hasSelection()) api.clipboardWrite(term.getSelection());
  });
  tab.host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (settings.rightClickPaste) {
      if (term.hasSelection()) { api.clipboardWrite(term.getSelection()); term.clearSelection(); }
      else paste(tab);
      return;
    }
    showMenu(e.clientX, e.clientY, [
      { label: 'Copy', icon: 'copy', kbd: 'Ctrl+Shift+C', action: () => copySel(tab) },
      { label: 'Paste', icon: 'edit', kbd: 'Ctrl+Shift+V', action: () => paste(tab) },
      '-',
      { label: 'Split right', icon: 'columns', kbd: 'Ctrl+Shift+D', action: () => splitPane('row', tab) },
      { label: 'Split down', icon: 'rows', kbd: 'Ctrl+Shift+E', action: () => splitPane('col', tab) },
      '-',
      { label: 'Find…', icon: 'search', kbd: 'Ctrl+Shift+F', action: () => openFind(tab) },
      { label: tab.grep ? 'Close Grep' : 'Grep: filter output…', icon: 'filter', kbd: 'Ctrl+Shift+G', action: () => (tab.grep ? closeGrep(tab) : openGrep(tab)) },
      { label: 'Clear', icon: 'trash', action: () => term.clear() },
    ]);
  });
  tab.ro = new ResizeObserver(() => fitTab(tab));
  tab.ro.observe(tab.host);
  renderTabs();
  term.focus();
  return tab;
}

function fitTab(tab) {
  if (tab.group !== state.activeGroup || !tab.term?.element) return;
  cancelAnimationFrame(tab.fitRaf);
  tab.fitRaf = requestAnimationFrame(() => { try { tab.fit.fit(); } catch {} });
}

// Tell the main process once output has been drawn, so it can pause a shell that floods faster than we render.
const ACK_EVERY = 32 * 1024;
const unackedDrawn = new Map();
function writeOut(tab, id, data) {
  tab.term.write(data, () => {
    if (tab.grep) scheduleGrep(tab);
    const n = (unackedDrawn.get(id) || 0) + data.length;
    if (n >= ACK_EVERY) { api.ack(id, n); unackedDrawn.delete(id); } else unackedDrawn.set(id, n);
  });
}

function bindTerm(tab, id) {
  tab.termId = id;
  byTermId.set(id, tab);
  const p = pendingData.get(id);
  if (p) { writeOut(tab, id, p); pendingData.delete(id); }
  api.resize(id, tab.term.cols, tab.term.rows);
}

function setStatus(tab, status) {
  tab.status = status;
  renderTabs();
  renderSessions();
  if (tab === state.active) renderStatus();
}

function sendInput(tab, data) {
  if (tab.status === 'closed') {
    if (data === '\r') restartTab(tab);
    return;
  }
  if (!tab.termId) return;
  if (state.recording?.tab === tab) recordInput(data);
  if (state.multiExec) {
    for (const t of state.tabs) if (t.termId && t.status === 'connected') api.write(t.termId, data);
  } else {
    api.write(tab.termId, data);
  }
}

function copySel(tab) {
  if (tab.term.hasSelection()) { api.clipboardWrite(tab.term.getSelection()); toast('Copied to clipboard'); }
}
async function paste(tab) {
  const text = await api.clipboardRead();
  if (text) tab.term.paste(text);
}

function activate(tab, { skipFocus } = {}) {
  state.active = tab;
  const g = tab?.group || null;
  state.activeGroup = g;
  if (g) g.activePane = tab;
  for (const gr of state.groups) gr.el.classList.toggle('active', gr === g);
  for (const t of state.tabs) t.box.classList.toggle('focused', t === tab);
  $('#welcome').classList.toggle('hidden', !!tab);
  if (g) {
    leaves(g.root).forEach(fitTab);
    if (!skipFocus) setTimeout(() => tab.term.focus());
  }
  renderTabs();
  renderStatus();
  updateRail();
  if (state.panel === 'files') renderFiles(true);
}

function closeTab(tab) {
  if (!tab) return;
  if (state.recording?.tab === tab) stopRecording();
  flowRuns.get(tab)?.cancel();
  if (tab.termId && tab.status !== 'closed') api.kill(tab.termId);
  if (tab.termId) byTermId.delete(tab.termId);
  tab.ro.disconnect();
  tab.term.dispose();
  tab.box.remove();
  state.tabs.splice(state.tabs.indexOf(tab), 1);
  const g = tab.group;
  g.root = removePane(g.root, tab);
  if (g.root) {
    layoutGroup(g);
    if (g.activePane === tab) g.activePane = leaves(g.root)[0];
    if (state.active === tab) activate(g.activePane);
    else renderTabs();
  } else {
    const gi = state.groups.indexOf(g);
    state.groups.splice(gi, 1);
    g.el.remove();
    if (state.activeGroup === g) activate(state.groups[Math.min(gi, state.groups.length - 1)]?.activePane || null);
    else renderTabs();
  }
  renderSessions();
  if (!state.groups.length) renderWelcome();
}

function closeGroup(g) {
  leaves(g.root).forEach(closeTab);
}

function splitPane(dir, from = state.active) {
  if (!from) return openLocal();
  if (from.type === 'local') return openLocal(from.shellId, { from, dir });
  const t = createTab({ type: 'ssh', title: from.title, color: from.color, session: from.session, config: from.config, split: { from, dir } });
  t.password = from.password;
  connectSsh(t);
}

// Move focus to the nearest pane in a direction (dx/dy = -1, 0, 1).
function focusPane(dx, dy) {
  const g = state.activeGroup;
  if (!g || !g.root.dir) return false;
  const c = state.active.box.getBoundingClientRect();
  const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
  let best = null, bestD = Infinity;
  for (const p of leaves(g.root)) {
    if (p === state.active) continue;
    const r = p.box.getBoundingClientRect();
    const ox = r.left + r.width / 2 - cx, oy = r.top + r.height / 2 - cy;
    if ((dx && Math.sign(ox) !== dx) || (dy && Math.sign(oy) !== dy)) continue;
    const d = dx ? Math.abs(ox) + 2 * Math.abs(oy) : Math.abs(oy) + 2 * Math.abs(ox);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best) activate(best);
  return !!best;
}

function restartTab(tab) {
  tab.term.reset();
  if (tab.type === 'local') startLocal(tab);
  else connectSsh(tab);
}

function overlay(tab, html) {
  tab.host.querySelector('.conn-overlay')?.remove();
  if (!html) return;
  const o = el(`<div class="conn-overlay"><div class="conn-card">${html}</div></div>`);
  tab.host.append(o);
  return o;
}

// ---------- local ----------
function defaultShell() {
  return state.shells.find((s) => s.id === settings.defaultShell) || state.shells[0];
}
function openLocal(shellId, split) {
  const sh = state.shells.find((s) => s.id === shellId) || defaultShell();
  if (!sh) return toast('No shells found', 'err');
  const tab = createTab({ type: 'local', title: sh.name, color: shellStyle(sh).color, shellId: sh.id, split });
  startLocal(tab);
}
async function startLocal(tab) {
  try {
    const r = await api.openLocal({ shellId: tab.shellId, cols: tab.term.cols, rows: tab.term.rows });
    bindTerm(tab, r.id);
    setStatus(tab, 'connected');
  } catch (e) {
    setStatus(tab, 'closed');
    tab.term.write(`\x1b[31mFailed to start shell: ${cleanErr(e)}\x1b[0m\r\n`);
  }
}

// ---------- SSH ----------
function sessionLabel(s) { return `${s.username ? s.username + '@' : ''}${s.host}${s.port && Number(s.port) !== 22 ? ':' + s.port : ''}`; }

async function openSsh(session, extra = {}) {
  const s = session || extra.config;
  let password = extra.password;
  if (s.auth === 'password' && !s.hasPassword && password === undefined) {
    const r = await promptDialog({
      title: `Connect to ${s.name || s.host}`,
      sub: sessionLabel(s),
      fields: [{ name: 'password', label: 'Password', type: 'password' }],
      check: session ? { label: 'Remember password', value: false } : null,
      ok: 'Connect',
    });
    if (!r) return;
    password = r.password;
    if (r.check && session) {
      await api.sessions.save({ id: session.id, password, savePassword: true });
      refreshSessions();
    }
  }
  const tab = createTab({ type: 'ssh', title: s.name || sessionLabel(s), color: s.color || COLORS[0], session, config: extra.config });
  tab.password = password;
  connectSsh(tab);
}

async function connectSsh(tab) {
  const s = tab.session || tab.config;
  setStatus(tab, 'connecting');
  overlay(tab, `<div class="spinner"></div><h3>Connecting…</h3><p>${esc(sessionLabel(s))}</p>
    <div class="actions"><button class="btn sm" data-cancel>Cancel</button></div>`)
    .querySelector('[data-cancel]').onclick = () => closeTab(tab);
  try {
    const r = await api.openSsh({
      sessionId: tab.session?.id,
      config: tab.session ? null : tab.config,
      password: tab.password,
      cols: tab.term.cols,
      rows: tab.term.rows,
    });
    if (!state.tabs.includes(tab)) { api.kill(r.id); return; }
    if (tab.rememberPw && tab.session) await api.sessions.save({ id: tab.session.id, password: tab.password, savePassword: true });
    tab.rememberPw = false;
    overlay(tab, null);
    bindTerm(tab, r.id);
    setStatus(tab, 'connected');
    tab.term.focus();
    refreshSessions();
    if (state.panel === 'files' && state.active === tab) renderFiles(true);
    const startup = tab.session?.startupFlow && state.flows.find((x) => x.id === tab.session.startupFlow);
    if (startup) setTimeout(() => runFlow(startup, [tab]), 500);
  } catch (e) {
    if (!state.tabs.includes(tab)) return;
    const msg = cleanErr(e);
    // The server turned down every sign-in method we had (typical for imported sessions with no
    // saved password): ask for the password instead of showing an error.
    if (/authentication methods failed/i.test(msg) && s.auth !== 'key' && s.auth !== 'agent') {
      if (await askPassword(tab, s, !!tab.password)) return connectSsh(tab);
    }
    setStatus(tab, 'closed');
    const o = overlay(tab, `<div class="err-icon">${icon('x')}</div><h3>Connection failed</h3><p>${esc(msg)}</p>
      <div class="actions"><button class="btn sm" data-close>Close tab</button>
      ${s.auth !== 'key' && s.auth !== 'agent' ? '<button class="btn sm" data-pw>' + icon('key') + 'Enter password</button>' : ''}
      <button class="btn sm primary" data-retry>${icon('refresh')}Retry</button></div>`);
    o.querySelector('[data-close]').onclick = () => closeTab(tab);
    o.querySelector('[data-retry]').onclick = () => connectSsh(tab);
    const pw = o.querySelector('[data-pw]');
    if (pw) pw.onclick = async () => { if (await askPassword(tab, s)) connectSsh(tab); };
  }
}

// Where saved passwords are encrypted, in the words each OS uses.
const secretStore = () => ({ win32: 'your Windows account', darwin: 'your macOS Keychain' })[state.info.platform] || 'your system keyring';

async function askPassword(tab, s, retry) {
  const r = await promptDialog({
    title: retry ? 'Wrong password' : 'Password',
    sub: retry ? `The server rejected it. Try again for ${sessionLabel(s)}.` : sessionLabel(s),
    fields: [{ name: 'password', label: 'Password', type: 'password' }],
    check: tab.session ? { label: `Remember password (encrypted with ${secretStore()})`, value: true } : null,
    ok: 'Connect',
  });
  if (!r) return false;
  tab.password = r.password;
  tab.rememberPw = !!r.check;
  return true;
}

function parseQuick(str) {
  let s = str.trim().replace(/^ssh\s+/i, '');
  let port;
  s = s.replace(/\s*-p\s*(\d+)\s*/, (_m, p) => { port = p; return ' '; }).trim();
  const m = s.match(/^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/);
  if (!m) return null;
  return { username: m[1] || '', host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3] || port || 22) };
}

async function quickConnect(str) {
  const q = parseQuick(str);
  if (!q) return toast('Use the form user@host:port', 'err');
  const r = await promptDialog({
    title: `Connect to ${q.host}`,
    sub: 'Leave the password empty to use your SSH keys or agent.',
    fields: [
      { name: 'username', label: 'Username', value: q.username, placeholder: 'root' },
      { name: 'password', label: 'Password', type: 'password', placeholder: 'optional' },
    ],
    check: { label: 'Save as a session', value: false },
    ok: 'Connect',
  });
  if (!r || !r.username) return;
  const config = { name: `${r.username}@${q.host}`, host: q.host, port: q.port, username: r.username, auth: 'auto' };
  if (r.check) {
    const saved = await api.sessions.save({
      ...config, auth: r.password ? 'password' : 'auto', color: COLORS[state.sessions.length % COLORS.length],
      password: r.password, savePassword: !!r.password,
    });
    await refreshSessions();
    return openSsh(state.sessions.find((x) => x.id === saved.id), { password: r.password || '' });
  }
  openSsh(null, { config, password: r.password || '' });
}

// ---------- tabs strip ----------
function renderTabs() {
  const wrap = $('#tabs');
  wrap.innerHTML = '';
  for (const p of state.tabs) {
    p.box.style.setProperty('--tab-color', p.color);
    p.box.className = `pane ${p.status} ${p === state.active ? 'focused' : ''}`;
    p.box.querySelector('.ptitle').textContent = p.title;
  }
  for (const g of state.groups) {
    const tab = g.activePane;
    const count = leaves(g.root).length;
    const t = el(`<div class="tab ${g === state.activeGroup ? 'active' : ''} ${tab.status}" draggable="true" style="--tab-color:${tab.color}" title="${esc(tab.title)}">
      <span class="tdot"></span><span class="ttitle">${esc(tab.title)}</span>
      ${count > 1 ? `<span class="tcount" title="${count} panes">${icon('columns')}${count}</span>` : ''}
      <button class="tclose" title="Close tab">${icon('x')}</button></div>`);
    t.onmousedown = (e) => { if (e.button === 1) { e.preventDefault(); closeGroup(g); } };
    t.onclick = (e) => { if (!e.target.closest('.tclose')) activate(g.activePane); };
    t.querySelector('.tclose').onclick = (e) => { e.stopPropagation(); closeGroup(g); };
    t.ondblclick = () => renameTab(tab, t);
    t.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: 'Split right', icon: 'columns', kbd: 'Ctrl+Shift+D', action: () => splitPane('row', tab) },
        { label: 'Split down', icon: 'rows', kbd: 'Ctrl+Shift+E', action: () => splitPane('col', tab) },
        '-',
        { label: 'Rename', icon: 'edit', action: () => renameTab(tab, t) },
        { label: 'Duplicate', icon: 'copy', action: () => duplicateTab(tab) },
        { label: tab.type === 'ssh' ? 'Reconnect' : 'Restart', icon: 'refresh', action: () => { if (tab.termId && tab.status !== 'closed') api.kill(tab.termId); restartTab(tab); } },
        '-',
        { label: 'Close others', icon: 'x', action: () => state.groups.filter((x) => x !== g).forEach(closeGroup) },
        { label: count > 1 ? `Close tab (${count} panes)` : 'Close', icon: 'x', danger: true, action: () => closeGroup(g) },
      ]);
    };
    t.ondragstart = (e) => { e.dataTransfer.setData('termx/tab', String(g.key)); e.dataTransfer.effectAllowed = 'move'; };
    t.ondragover = (e) => { if (e.dataTransfer.types.includes('termx/tab')) { e.preventDefault(); t.classList.add('drag-over'); } };
    t.ondragleave = () => t.classList.remove('drag-over');
    t.ondrop = (e) => {
      e.preventDefault();
      const from = state.groups.findIndex((x) => x.key === Number(e.dataTransfer.getData('termx/tab')));
      if (from < 0) return;
      const [moved] = state.groups.splice(from, 1);
      state.groups.splice(state.groups.indexOf(g), 0, moved);
      renderTabs();
    };
    wrap.append(t);
  }
  wrap.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renameTab(tab, node) {
  const span = node.querySelector('.ttitle');
  const input = el(`<input value="${esc(tab.title)}" spellcheck="false">`);
  span.innerHTML = '';
  span.append(input);
  input.select();
  const done = (save) => {
    if (save && input.value.trim()) tab.title = input.value.trim();
    renderTabs();
    tab.term.focus();
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  input.onblur = () => done(true);
}

function duplicateTab(tab) {
  if (tab.type === 'local') return openLocal(tab.shellId);
  const t = createTab({ type: 'ssh', title: tab.title, color: tab.color, session: tab.session, config: tab.config });
  t.password = tab.password;
  connectSsh(t);
}

// ---------- find ----------
function openFind(tab) {
  if (!tab) return;
  let bar = tab.host.querySelector('.findbar');
  if (!bar) {
    bar = el(`<div class="findbar"><input placeholder="Find" spellcheck="false">
      <button class="icon-btn sm" data-p title="Previous">${icon('chevronUp')}</button>
      <button class="icon-btn sm" data-n title="Next">${icon('chevronDown')}</button>
      <button class="icon-btn sm" data-x title="Close">${icon('x')}</button></div>`);
    const input = bar.querySelector('input');
    const opts = { get decorations() { return findDecorations(); } };
    const close = () => { tab.search.clearDecorations(); bar.remove(); tab.finding = false; tab.term.options.theme = termTheme(tab); tab.term.focus(); };
    input.oninput = () => tab.search.findNext(input.value, { ...opts, incremental: true });
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') e.shiftKey ? tab.search.findPrevious(input.value, opts) : tab.search.findNext(input.value, opts);
      if (e.key === 'Escape') close();
    };
    bar.querySelector('[data-n]').onclick = () => tab.search.findNext(input.value, opts);
    bar.querySelector('[data-p]').onclick = () => tab.search.findPrevious(input.value, opts);
    bar.querySelector('[data-x]').onclick = close;
    tab.host.append(bar);
    tab.finding = true;
    tab.term.options.theme = termTheme(tab);
  }
  const input = bar.querySelector('input');
  const sel = tab.term.getSelection();
  if (sel && !sel.includes('\n')) input.value = sel;
  input.focus();
  input.select();
}

// ---------- global search ----------
// One box that looks through every open terminal's scrollback, saved sessions and flows.
const search = { q: '', case: false, regex: false, timer: 0 };
const SEARCH_MAX_LINES = 200;

function searchMatcher() {
  const { q } = search;
  if (!q) return null;
  let src = search.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return new RegExp(src, search.case ? 'g' : 'gi'); } catch { return 'bad'; }
}

// Wrapped rows are joined so a match that spans a line break is still found.
function bufferLines(term) {
  const b = term.buffer.active;
  const out = [];
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y);
    if (!line) continue;
    if (line.isWrapped && out.length) {
      const prev = out[out.length - 1];
      prev.text = prev.text.padEnd(prev.width, ' ') + line.translateToString(true);
      prev.width += term.cols;
    } else out.push({ row: y, text: line.translateToString(true), width: term.cols });
  }
  return out;
}

function highlight(text, re) {
  let html = '', last = 0;
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) break;
    html += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return html + esc(text.slice(last));
}

// Trim long lines to a window around the first match so it stays visible.
function snippet(text, idx) {
  text = text.replace(/\s+$/, '');
  if (text.length <= 90 || idx < 30) return text.trimStart();
  return '…' + text.slice(idx - 24).trimStart();
}

function renderSearch() {
  const box = $('#search-results');
  box.innerHTML = '';
  const re = searchMatcher();
  if (!re) {
    box.append(el(`<div class="empty">${icon('search')}<div>Search the output of every open terminal, plus your saved sessions and flows.</div></div>`));
    return;
  }
  if (re === 'bad') { box.append(el(`<div class="empty">${icon('x')}<div>That isn't a valid regular expression.</div></div>`)); return; }
  const has = (...xs) => xs.some((x) => { re.lastIndex = 0; return x && re.test(String(x)); });
  let total = 0;

  const group = (title, count, more) => {
    box.append(el(`<div class="group-title"><span>${esc(title)}</span><span class="count">${count}${more ? '+' : ''}</span></div>`));
  };

  const titles = state.tabs.map((t) => t.title);
  for (const [i, tab] of state.tabs.entries()) {
    const hits = [];
    let more = false;
    for (const l of bufferLines(tab.term)) {
      re.lastIndex = 0;
      const m = re.exec(l.text);
      if (!m || !m[0]) continue;
      if (hits.length >= SEARCH_MAX_LINES) { more = true; break; }
      hits.push({ ...l, idx: m.index, len: m[0].length });
    }
    if (!hits.length) continue;
    total += hits.length;
    const same = titles.filter((t) => t === tab.title).length > 1;
    group(same ? `${tab.title} #${titles.slice(0, i + 1).filter((t) => t === tab.title).length}` : tab.title, hits.length, more);
    for (const h of hits) {
      const text = snippet(h.text, h.idx);
      const it = el(`<div class="sr-line" title="Line ${h.row + 1}"><span class="ln">${h.row + 1}</span><span class="tx">${highlight(text, re)}</span></div>`);
      it.onclick = () => revealMatch(tab, h);
      box.append(it);
    }
  }

  const sessions = state.sessions.filter((s) => has(s.name, s.host, s.username, s.folder));
  if (sessions.length) {
    total += sessions.length;
    group('Sessions', sessions.length);
    for (const s of sessions) {
      const it = el(`<div class="item"><div class="avatar" style="background:${s.color || COLORS[0]}">${icon('server')}</div>
        <div class="meta"><div class="name">${highlight(s.name, re)}</div><div class="sub">${highlight(sessionLabel(s), re)}</div></div>
        <span class="go" title="Connect">${icon('play')}</span></div>`);
      it.onclick = () => openSsh(s);
      box.append(it);
    }
  }

  const flows = state.flows.filter((f) => has(f.name, ...f.steps.map((s) => s.v)));
  if (flows.length) {
    total += flows.length;
    group('Flows', flows.length);
    for (const f of flows) {
      const step = f.steps.find((s) => has(s.v));
      const it = el(`<div class="item" title="Click to edit"><div class="avatar" style="background:${f.color || COLORS[0]}">${icon('workflow')}</div>
        <div class="meta"><div class="name">${highlight(f.name, re)}</div><div class="sub">${step ? highlight(String(step.v), re) : esc(flowSummary(f))}</div></div>
        <span class="go" title="Run in the active terminal">${icon('play')}</span></div>`);
      it.onclick = (e) => (e.target.closest('.go') ? runFlow(f) : editFlow(f));
      box.append(it);
    }
  }

  if (!total) box.append(el(`<div class="empty">${icon('search')}<div>No matches for “${esc(search.q)}”.</div></div>`));
}

// Bring the pane forward, scroll the line into the middle and select the match.
function revealMatch(tab, h) {
  if (!state.tabs.includes(tab)) return renderSearch();
  activate(tab, { skipFocus: true });
  const { term } = tab;
  const cols = term.cols;
  const row = h.row + Math.floor(h.idx / cols);
  const col = h.idx % cols;
  term.scrollToLine(Math.max(0, row - Math.floor(term.rows / 2)));
  term.clearSelection();
  clearSearchMark();
  const b = term.buffer.active;
  const marker = term.registerMarker(row - (b.baseY + b.cursorY));
  const c = settings.highlightColor;
  const deco = marker && term.registerDecoration({ marker, x: col, width: Math.max(1, Math.min(h.len, cols - col)), backgroundColor: c, foregroundColor: '#0b0d12', layer: 'top', overviewRulerOptions: { color: c } });
  search.mark = { marker, deco };
}

function clearSearchMark() {
  search.mark?.deco?.dispose();
  search.mark?.marker?.dispose();
  search.mark = null;
}

function scheduleSearch() {
  clearTimeout(search.timer);
  search.timer = setTimeout(() => { if (state.panel === 'search') renderSearch(); }, 120);
}

function openSearch() {
  const sidebar = $('#sidebar');
  if (state.panel !== 'search' || sidebar.classList.contains('collapsed')) { state.panel = ''; showPanel('search'); }
  const input = $('#global-search');
  const sel = state.active?.term.getSelection();
  if (sel && !sel.includes('\n') && sel.trim()) { input.value = sel.trim(); search.q = input.value; renderSearch(); }
  input.focus();
  input.select();
}

function setupSearchPanel() {
  const input = $('#global-search');
  input.oninput = () => { search.q = input.value; scheduleSearch(); };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') $('#search-results .sr-line, #search-results .item')?.click();
    if (e.key === 'Escape') { input.value = ''; search.q = ''; clearSearchMark(); renderSearch(); state.active?.term.focus(); }
  };
  for (const b of $$('#search-opts [data-opt]')) {
    b.onclick = () => {
      search[b.dataset.opt] = !search[b.dataset.opt];
      b.classList.toggle('on', search[b.dataset.opt]);
      renderSearch();
      input.focus();
    };
  }
}

// ---------- import / export ----------
const IMPORT_SOURCES = {
  moba: { label: 'MobaXterm', icon: 'terminal', color: '#3b82f6' },
  putty: { label: 'PuTTY', icon: 'key', color: '#f59e0b' },
  ssh: { label: 'OpenSSH config', icon: 'fileCode', color: '#34d399' },
  termx: { label: 'TermX export', icon: 'server', color: '#7c5cff' },
};
const sessionKey = (s) => `${String(s.host).toLowerCase()}|${Number(s.port) || 22}|${s.username || ''}`;

async function openImport() {
  const node = el(`<div class="modal import-modal">
    <div class="modal-head"><div><h3>Import connections</h3><div class="sub">From MobaXterm, PuTTY, your OpenSSH config, or a TermX export. Passwords aren't imported.</div></div></div>
    <div class="modal-body">
      <div class="import-sources"><div class="import-scanning">${icon('refresh')}Looking for saved connections on this computer…</div></div>
      <div class="import-list hidden"></div>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn left" data-export>${icon('upload')}Export my sessions…</button>
      <button type="button" class="btn" data-x>Cancel</button>
      <button type="button" class="btn primary" data-import disabled>${icon('download')}Import</button>
    </div></div>`);
  const sourcesBox = node.querySelector('.import-sources');
  const listBox = node.querySelector('.import-list');
  const importBtn = node.querySelector('[data-import]');
  const sources = [];
  let current = null;
  const saved = new Set(state.sessions.map(sessionKey));

  const drawSources = () => {
    sourcesBox.innerHTML = '';
    for (const src of sources) {
      const meta = IMPORT_SOURCES[src.source];
      const chip = el(`<button type="button" class="import-src ${src === current ? 'on' : ''}" title="${esc(src.path)}">
        <span class="avatar" style="background:${meta.color}">${icon(meta.icon)}</span>
        <span class="meta"><span class="name">${esc(meta.label)}</span><span class="sub">${src.sessions.length} connection${src.sessions.length === 1 ? '' : 's'}</span></span></button>`);
      chip.onclick = () => { current = src; drawSources(); drawList(); };
      sourcesBox.append(chip);
    }
    const pick = el(`<button type="button" class="import-src file"><span class="avatar">${icon('folder')}</span>
      <span class="meta"><span class="name">Choose a file…</span><span class="sub">.mxtsessions, .reg, ssh config, .json</span></span></button>`);
    pick.onclick = pickFile;
    sourcesBox.append(pick);
  };

  const drawList = () => {
    listBox.classList.toggle('hidden', !current);
    if (!current) { importBtn.disabled = true; return; }
    const rows = current.sessions;
    listBox.innerHTML = `<div class="import-bar"><label class="check"><input type="checkbox" data-all><span></span></label>
      <span class="import-path" title="${esc(current.path)}">${esc(current.path)}</span></div><div class="import-rows"></div>`;
    const box = listBox.querySelector('.import-rows');
    if (!rows.length) box.append(el(`<div class="empty">${icon('search')}<div>No SSH connections in this file.</div></div>`));
    rows.forEach((s) => {
      const dup = saved.has(sessionKey(s));
      const r = el(`<label class="import-row ${dup ? 'dup' : ''}"><input type="checkbox" ${s.pick ? 'checked' : ''}>
        <span class="meta"><span class="name">${esc(s.name)}</span><span class="sub">${esc(sessionLabel(s))}</span></span>
        ${s.folder ? `<span class="tag">${icon('folder')}${esc(s.folder)}</span>` : ''}
        ${s.auth === 'key' ? `<span class="tag" title="${esc(s.keyPath)}">${icon('key')}key</span>` : ''}
        ${dup ? '<span class="tag warn">already saved</span>' : ''}</label>`);
      r.querySelector('input').onchange = (e) => { s.pick = e.target.checked; sync(); };
      box.append(r);
    });
    listBox.querySelector('[data-all]').onchange = (e) => { rows.forEach((s) => (s.pick = e.target.checked)); drawList(); };
    sync();
  };

  const sync = () => {
    const rows = current?.sessions || [];
    const n = rows.filter((s) => s.pick).length;
    importBtn.disabled = !n;
    importBtn.lastChild.textContent = n ? `Import ${n}` : 'Import';
    const all = listBox.querySelector('[data-all]');
    if (all) {
      all.checked = n > 0 && n === rows.length;
      all.indeterminate = n > 0 && n < rows.length;
      all.nextElementSibling.textContent = `${n} of ${rows.length} selected`;
    }
  };

  const add = (src) => {
    // Already-saved connections start unticked so a second import doesn't make duplicates.
    src.sessions.forEach((s) => (s.pick = !saved.has(sessionKey(s))));
    const same = sources.findIndex((x) => x.path === src.path);
    if (same >= 0) sources[same] = src; else sources.push(src);
    current = src;
  };

  async function pickFile() {
    const r = await api.importer.file();
    if (!r) return;
    if (r.error) { toast(r.error, 'err'); return; }
    add(r);
    drawSources();
    drawList();
  }

  node.querySelector('[data-x]').onclick = () => closeModal();
  node.querySelector('[data-export]').onclick = exportSessions;
  importBtn.onclick = async () => {
    const picked = current.sessions.filter((s) => s.pick);
    let i = state.sessions.length;
    const added = await api.sessions.import(picked.map(({ pick, ...s }) => ({ ...s, color: s.color || COLORS[i++ % COLORS.length] })));
    closeModal();
    await refreshSessions();
    if (state.panel !== 'sessions' || $('#sidebar').classList.contains('collapsed')) { state.panel = ''; showPanel('sessions'); }
    toast(`Imported ${added.length} connection${added.length === 1 ? '' : 's'} from ${IMPORT_SOURCES[current.source].label}`);
  };

  openModal(node);
  const found = await api.importer.scan().catch(() => []);
  found.forEach(add);
  current = sources[0] || null;
  drawSources();
  drawList();
}

async function exportSessions() {
  if (!state.sessions.length) { toast('There are no saved sessions to export', 'err'); return; }
  const r = await api.sessions.export();
  if (r) toast(`Exported ${r.count} session${r.count === 1 ? '' : 's'} (without passwords)`);
}

// ---------- grep console ----------
// Grep reads the terminal's own text buffer, so it sees exactly what is on screen and in scrollback
// (local shells on Windows redraw through ConPTY, so the raw output stream isn't reliable lines).
// A marker remembers where it stopped reading; only lines after it are checked as output arrives.
const GREP_SHOW = 5000;   // matching lines kept in the Grep view
const LEVELS = [[/\b(ERROR|FATAL|SEVERE|CRITICAL)\b/, 'err'], [/\bWARN(ING)?\b/, 'warn'], [/\bINFO\b/, 'info'], [/\b(DEBUG|TRACE)\b/, 'dim']];

// Complete lines in rows [from, to), with wrapped rows joined back into one line.
function logicalLines(term, from, to) {
  const b = term.buffer.active;
  const out = [];
  for (let y = from; y < to; y++) {
    const line = b.getLine(y);
    if (!line) continue;
    const text = line.translateToString(!b.getLine(y + 1)?.isWrapped);
    if (line.isWrapped && out.length) out[out.length - 1].text += text;
    else if (!line.isWrapped) out.push({ row: y, text });
  }
  for (const l of out) l.text = l.text.replace(/\s+$/, '');
  return out;
}

// The row where the line holding the cursor starts; everything above it is finished output.
function doneRows(term) {
  const b = term.buffer.active;
  let y = b.baseY + b.cursorY;
  while (y > 0 && b.getLine(y)?.isWrapped) y--;
  return y;
}

function grepMatchers(g) {
  const make = (q) => {
    if (!q) return null;
    try { return new RegExp(g.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), g.case ? 'g' : 'gi'); } catch { return 'bad'; }
  };
  return { inc: make(g.inc), exc: make(g.exc) };
}

function grepTest(m, line) {
  if (m.exc) { m.exc.lastIndex = 0; if (m.exc.test(line)) return false; }
  if (!m.inc) return true;
  m.inc.lastIndex = 0;
  return m.inc.test(line);
}

function grepRow(tab, line, m) {
  const lvl = LEVELS.find(([re]) => re.test(line))?.[1] || '';
  let html = m.inc ? highlight(line, m.inc) : esc(line);
  if (lvl) html = html.replace(LEVELS.find(([, k]) => k === lvl)[0], (w) => `<b class="lv">${w}</b>`);
  const r = el(`<div class="gl ${lvl}">${html || ' '}</div>`);
  r.onclick = () => revealLine(tab, line, m.inc);
  return r;
}

// Scroll the terminal to the most recent place this line appears and mark it.
function revealLine(tab, line, re) {
  const want = line.trim();
  if (!want) return;
  const lines = bufferLines(tab.term);
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].text.indexOf(want);
    if (idx < 0) continue;
    let at = idx, len = want.length;
    if (re) { re.lastIndex = 0; const mm = re.exec(lines[i].text.slice(idx)); if (mm?.[0]) { at = idx + mm.index; len = mm[0].length; } }
    revealMatch(tab, { row: lines[i].row, idx: at, len });
    return;
  }
  toast('That line has scrolled out of the terminal', 'err');
}

// full = run the filter over the whole buffer (Refresh, or the filter changed); otherwise only new lines.
function runGrep(tab, full) {
  const g = tab.grep;
  if (!g) return;
  const { term } = tab;
  const m = grepMatchers(g);
  g.input.classList.toggle('bad', m.inc === 'bad');
  g.exInput.classList.toggle('bad', m.exc === 'bad');
  if (m.inc === 'bad' || m.exc === 'bad') return;
  // A disposed marker means the rows scrolled out or the screen was cleared: start over.
  if (g.next?.isDisposed || (g.cleared?.isDisposed && !full)) full = true;
  const start = full ? (g.cleared && !g.cleared.isDisposed ? g.cleared.line : 0) : g.next.line;
  const end = doneRows(term);
  if (full) { g.list.innerHTML = ''; g.count = 0; g.total = 0; }
  const atBottom = g.list.scrollHeight - g.list.scrollTop - g.list.clientHeight < 30;
  const hits = [];
  for (const l of logicalLines(term, Math.max(0, start), end)) {
    g.total++;
    if (grepTest(m, l.text)) hits.push(l.text);
  }
  g.count += hits.length;
  // Only build rows that will stay on screen.
  const frag = document.createDocumentFragment();
  for (const line of hits.slice(-GREP_SHOW)) frag.append(grepRow(tab, line, m));
  g.list.append(frag);
  while (g.list.childElementCount > GREP_SHOW) g.list.firstElementChild.remove();
  g.next?.dispose();
  g.next = term.registerMarker(end - (term.buffer.active.baseY + term.buffer.active.cursorY));
  g.empty.classList.toggle('hidden', g.list.childElementCount > 0);
  g.empty.textContent = g.total ? 'No lines match this filter yet. New output is checked as it arrives.' : 'Nothing printed yet. Matching lines appear here as output arrives.';
  g.stat.textContent = `${g.count.toLocaleString()} of ${g.total.toLocaleString()} lines${g.count > GREP_SHOW ? ` · last ${GREP_SHOW.toLocaleString()} shown` : ''}`;
  if (g.follow && (full || atBottom || hits.length)) g.list.scrollTop = g.list.scrollHeight;
}

function scheduleGrep(tab) {
  const g = tab.grep;
  if (g.timer) return;
  g.timer = setTimeout(() => { g.timer = 0; runGrep(tab, false); }, 100);
}

function grepHistory(q) {
  if (!q) return;
  settings.grepHistory = [q, ...(settings.grepHistory || []).filter((x) => x !== q)].slice(0, 12);
  saveSettings();
  $('#grep-history').innerHTML = settings.grepHistory.map((x) => `<option value="${esc(x)}">`).join('');
}

function toggleGrep(tab = state.active) {
  if (!tab) return;
  if (tab.grep) {
    if (tab.grep.el.contains(document.activeElement)) closeGrep(tab);
    else tab.grep.input.focus();
    return;
  }
  openGrep(tab);
}

function openGrep(tab) {
  const node = el(`<div class="grep" style="height:${settings.grepH || 260}px">
    <div class="grep-resize" title="Drag to resize"></div>
    <div class="grep-bar">
      <span class="grep-title">${icon('filter')}<span>Grep</span></span>
      <div class="grep-field"><input data-inc placeholder="Show lines containing…" spellcheck="false" list="grep-history">
        <span class="search-opts"><button data-opt="case" title="Match case">Aa</button><button data-opt="regex" title="Regular expression">.*</button></span></div>
      <div class="grep-field ex">${icon('eyeOff')}<input data-exc placeholder="Hide lines containing…" spellcheck="false" list="grep-history"></div>
      <span class="grep-stat"></span>
      <div class="grep-tools">
      <button class="icon-btn sm on" data-follow title="Follow new output">${icon('arrowDown')}</button>
      <button class="icon-btn sm" data-refresh title="Refresh: run the filter again over all output (F5)">${icon('refresh')}</button>
      <button class="icon-btn sm" data-copy title="Copy matching lines">${icon('copy')}</button>
      <button class="icon-btn sm" data-clear title="Clear (only new output is shown until you refresh)">${icon('trash')}</button>
      <button class="icon-btn sm" data-close title="Close Grep (Ctrl+Shift+G)">${icon('x')}</button>
      </div>
    </div>
    <div class="grep-list"></div><div class="grep-empty hidden"></div></div>`);
  const g = tab.grep = {
    el: node, list: node.querySelector('.grep-list'), empty: node.querySelector('.grep-empty'), stat: node.querySelector('.grep-stat'),
    input: node.querySelector('[data-inc]'), exInput: node.querySelector('[data-exc]'),
    inc: '', exc: '', case: false, regex: false, follow: true, next: null, cleared: null, count: 0, total: 0, timer: 0,
  };
  const sel = tab.term.getSelection();
  if (sel && !sel.includes('\n') && sel.trim()) g.input.value = g.inc = sel.trim();
  let debounce = 0;
  const changed = () => {
    g.inc = g.input.value; g.exc = g.exInput.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => runGrep(tab, true), 150);
  };
  g.input.oninput = changed;
  g.exInput.oninput = changed;
  for (const inp of [g.input, g.exInput]) {
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { grepHistory(inp.value.trim()); runGrep(tab, true); }
      if (e.key === 'F5') { e.preventDefault(); runGrep(tab, true); }
      if (e.key === 'Escape') tab.term.focus();
    };
  }
  for (const b of node.querySelectorAll('[data-opt]')) {
    b.onclick = () => { g[b.dataset.opt] = !g[b.dataset.opt]; b.classList.toggle('on', g[b.dataset.opt]); runGrep(tab, true); };
  }
  const follow = node.querySelector('[data-follow]');
  follow.onclick = () => { g.follow = !g.follow; follow.classList.toggle('on', g.follow); if (g.follow) g.list.scrollTop = g.list.scrollHeight; };
  // Scrolling up pauses following, like a terminal; scrolling back to the bottom resumes it.
  g.list.onscroll = () => {
    const bottom = g.list.scrollHeight - g.list.scrollTop - g.list.clientHeight < 30;
    if (bottom !== g.follow) { g.follow = bottom; follow.classList.toggle('on', bottom); }
  };
  node.querySelector('[data-refresh]').onclick = () => {
    g.cleared?.dispose();
    g.cleared = null;
    grepHistory(g.inc.trim());
    runGrep(tab, true);
    node.querySelector('[data-refresh] .ico').animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], 450);
  };
  node.querySelector('[data-copy]').onclick = () => {
    const text = [...g.list.children].map((r) => r.textContent).join('\n');
    if (!text) return toast('Nothing to copy', 'err');
    api.clipboardWrite(text);
    toast(`Copied ${g.list.childElementCount.toLocaleString()} lines`);
  };
  node.querySelector('[data-clear]').onclick = () => {
    g.cleared?.dispose();
    const b = tab.term.buffer.active;
    g.cleared = tab.term.registerMarker(doneRows(tab.term) - (b.baseY + b.cursorY));
    runGrep(tab, true);
  };
  node.querySelector('[data-close]').onclick = () => closeGrep(tab);
  node.querySelector('.grep-resize').onmousedown = (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = node.offsetHeight;
    const max = tab.box.clientHeight - 90;
    const move = (ev) => { node.style.height = Math.max(110, Math.min(max, startH - (ev.clientY - startY))) + 'px'; };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); settings.grepH = node.offsetHeight; saveSettings(); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  };
  hydrateIcons(node);
  tab.box.append(node);
  runGrep(tab, true);
  if (tab === state.active) { renderStatus(); updateRail(); }
  g.input.focus();
  g.input.select();
}

// The rail and status bar buttons open or close; the shortcut also jumps back to an open panel.
const toggleGrepButton = (tab) => (tab.grep ? closeGrep(tab) : openGrep(tab));

function closeGrep(tab) {
  if (!tab.grep) return;
  clearTimeout(tab.grep.timer);
  tab.grep.next?.dispose();
  tab.grep.cleared?.dispose();
  tab.grep.el.remove();
  tab.grep = null;
  tab.term.focus();
  if (tab === state.active) { renderStatus(); updateRail(); }
}

// ---------- sessions sidebar ----------
async function refreshSessions() {
  [state.sessions, state.folders, state.folderColors] = await Promise.all([api.sessions.list(), api.folders.list(), api.folders.colors()]);
  renderSessions();
  if (!state.tabs.length) renderWelcome();
}

function isLive(sessionId) {
  return state.tabs.some((t) => t.session?.id === sessionId && t.status === 'connected');
}

function renderSessions() {
  const list = $('#session-list');
  const q = $('#session-filter').value.trim().toLowerCase();
  const match = (...xs) => !q || xs.some((x) => String(x || '').toLowerCase().includes(q));
  list.innerHTML = '';

  const group = (key, title, count) => {
    const g = el(`<div class="group-title clickable ${state.collapsed.has(key) ? 'collapsed' : ''}">${icon('chevronDown')}<span>${esc(title)}</span><span class="count">${count}</span></div>`);
    g.onclick = () => { state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key); renderSessions(); };
    list.append(g);
    return !state.collapsed.has(key);
  };

  const shells = state.shells.filter((s) => match(s.name));
  if (shells.length && group('__local', 'Local terminals', shells.length)) {
    for (const sh of shells) {
      const st = shellStyle(sh);
      const it = el(`<div class="item"><div class="avatar" style="background:${st.color}">${icon(st.icon)}</div>
        <div class="meta"><div class="name">${esc(sh.name)}</div><div class="sub">${esc(sh.kind === 'wsl' ? 'WSL' : 'local')}</div></div>
        <span class="go">${icon('play')}</span></div>`);
      it.onclick = () => openLocal(sh.id);
      it.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: 'Open', icon: 'play', action: () => openLocal(sh.id) },
          { label: 'Set as default shell', icon: 'sparkle', action: () => { settings.defaultShell = sh.id; saveSettings(); renderSettings(); toast(`${sh.name} is now the default`); } },
        ]);
      };
      list.append(it);
    }
  }

  // Saved sessions as a folder tree. A folder is a path like "Prod / DB"; parents exist implicitly.
  const tree = folderTree(q ? state.sessions.filter((s) => match(s.name, s.host, s.username, s.folder)) : state.sessions, !q);
  const total = tree.count;
  if (state.sessions.length || state.folders.length) {
    const root = el(`<div class="group-title clickable droppable ${state.collapsed.has('__saved') ? 'collapsed' : ''}">${icon('chevronDown')}<span>Saved sessions</span>
      <button class="gbtn" title="New folder">${icon('folderPlus')}</button><span class="count">${total}</span></div>`);
    root.onclick = (e) => {
      if (e.target.closest('.gbtn')) return newFolder('');
      state.collapsed.has('__saved') ? state.collapsed.delete('__saved') : state.collapsed.add('__saved');
      renderSessions();
    };
    root.oncontextmenu = (e) => { e.preventDefault(); folderMenu(e.clientX, e.clientY, tree); };
    dropTarget(root, '');
    list.append(root);
    if (!state.collapsed.has('__saved') || q) drawFolder(list, tree, 0, !!q);
  }

  if (!state.sessions.length && !state.folders.length && !q) {
    const empty = el(`<div class="empty">${icon('server')}<div>No saved sessions yet.</div>
      <div class="empty-actions"><button class="btn sm primary" data-new>${icon('plus')}New session</button><button class="btn sm" data-import>${icon('download')}Import</button></div></div>`);
    empty.querySelector('[data-new]').onclick = () => editSession();
    empty.querySelector('[data-import]').onclick = openImport;
    list.append(empty);
  }
}

// ---------- session folders ----------
const normFolder = (f) => String(f || '').split('/').map((x) => x.trim()).filter(Boolean).join(' / ');
const inFolder = (folder, path) => folder === path || folder.startsWith(path + ' / ');
const folderName = (path) => path.split(' / ').pop();
const parentFolder = (path) => path.split(' / ').slice(0, -1).join(' / ');

// withEmpty: include saved empty folders (left out while filtering, so results stay tight).
function folderTree(sessions, withEmpty) {
  const root = { path: '', name: '', children: new Map(), sessions: [], count: 0 };
  const node = (path) => {
    let n = root;
    let acc = '';
    for (const part of path ? path.split(' / ') : []) {
      acc = acc ? acc + ' / ' + part : part;
      if (!n.children.has(part)) n.children.set(part, { path: acc, name: part, children: new Map(), sessions: [], count: 0 });
      n = n.children.get(part);
    }
    return n;
  };
  if (withEmpty) state.folders.forEach((f) => node(normFolder(f)));
  for (const s of sessions) node(normFolder(s.folder)).sessions.push(s);
  const count = (n) => (n.count = n.sessions.length + [...n.children.values()].reduce((t, c) => t + count(c), 0));
  count(root);
  return root;
}

function findFolder(path) {
  let n = folderTree(state.sessions, true);
  for (const part of path ? path.split(' / ') : []) n = n?.children.get(part);
  return n;
}

const subtreeSessions = (n) => [...n.sessions, ...[...n.children.values()].flatMap(subtreeSessions)];

function drawFolder(list, n, depth, open) {
  const pad = (d) => `--depth:${d}`;
  for (const child of [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = 'f:' + child.path;
    const shut = !open && state.collapsed.has(key);
    const row = el(`<div class="folder-row droppable ${shut ? 'collapsed' : ''}" style="${pad(depth)}" draggable="true" title="${esc(child.path)}">
      ${icon('chevronDown')}<span class="fico" ${state.folderColors[child.path] ? `style="--fc:${state.folderColors[child.path]}"` : ''}>${icon('folder')}</span><span class="fname">${esc(child.name)}</span>
      <button class="gbtn" title="Folder actions">${icon('more')}</button><span class="count">${child.count}</span></div>`);
    row.onclick = (e) => {
      if (e.target.closest('.gbtn')) { const r = e.target.closest('.gbtn').getBoundingClientRect(); return folderMenu(r.left, r.bottom + 4, child); }
      state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key);
      renderSessions();
    };
    row.oncontextmenu = (e) => { e.preventDefault(); folderMenu(e.clientX, e.clientY, child); };
    row.ondragstart = (e) => { e.dataTransfer.setData('termx/folder', child.path); e.dataTransfer.effectAllowed = 'move'; };
    dropTarget(row, child.path);
    list.append(row);
    if (!shut) drawFolder(list, child, depth + 1, open);
  }
  for (const s of [...n.sessions].sort((a, b) => a.name.localeCompare(b.name))) list.append(sessionItem(s, depth));
}

function sessionItem(s, depth) {
  const initials = (s.name || s.host).replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
  const it = el(`<div class="item ${state.selectedSession === s.id ? 'selected' : ''}" style="--depth:${depth}" draggable="true" title="${esc(sessionLabel(s))}">
    <div class="avatar" style="background:${s.color || COLORS[0]}">${esc(initials)}</div>
    <div class="meta"><div class="name">${esc(s.name)}</div><div class="sub">${esc(sessionLabel(s))}</div></div>
    ${isLive(s.id) ? '<span class="live" title="Connected"></span>' : ''}
    <span class="go">${icon('play')}</span></div>`);
  it.onclick = (e) => {
    state.selectedSession = s.id;
    if (e.target.closest('.go')) openSsh(s); else renderSessions();
  };
  it.ondblclick = () => openSsh(s);
  it.oncontextmenu = (e) => { e.preventDefault(); state.selectedSession = s.id; renderSessions(); sessionMenu(e.clientX, e.clientY, s); };
  it.ondragstart = (e) => { e.dataTransfer.setData('termx/session', s.id); e.dataTransfer.effectAllowed = 'move'; };
  return it;
}

// Sessions and folders can be dropped on a folder row (or on "Saved sessions" for the top level).
function dropTarget(row, path) {
  row.ondragover = (e) => {
    const t = e.dataTransfer.types;
    if (!t.includes('termx/session') && !t.includes('termx/folder')) return;
    e.preventDefault();
    row.classList.add('drop');
  };
  row.ondragleave = () => row.classList.remove('drop');
  row.ondrop = async (e) => {
    e.preventDefault();
    row.classList.remove('drop');
    const id = e.dataTransfer.getData('termx/session');
    const from = e.dataTransfer.getData('termx/folder');
    if (id) await moveSessions([id], path);
    else if (from) {
      if (inFolder(path, from)) return toast('A folder can\'t go inside itself', 'err');
      if (parentFolder(from) === path) return;
      await renameFolder(from, path ? path + ' / ' + folderName(from) : folderName(from));
    }
  };
}

async function saveFolders(list) {
  state.folders = [...new Set(list.map(normFolder).filter(Boolean))].sort();
  await api.folders.save(state.folders);
}

async function saveFolderColors(map) {
  state.folderColors = map;
  await api.folders.saveColors(map);
}

const FOLDER_COLOR = '#fcd34d';
function pickFolderColor(n) {
  const current = state.folderColors[n.path] || FOLDER_COLOR;
  const swatches = [FOLDER_COLOR, ...COLORS.filter((c) => c !== '#fbbf24')];
  const node = el(`<div class="modal sm">
    <div class="modal-head"><div><h3>Folder color</h3><div class="sub">${esc(n.path)}</div></div></div>
    <div class="modal-body"><div class="colors folder-colors">
      ${swatches.map((c) => `<button type="button" data-c="${c}" style="background:${c};color:${c}" class="${current === c ? 'on' : ''}" title="${c === FOLDER_COLOR ? 'Default' : c}"></button>`).join('')}
      <label class="custom-color ${swatches.includes(current) ? '' : 'on'}" title="Custom color" style="color:${current}"><input type="color" value="${current}"></label>
    </div></div>
    <div class="modal-foot"><button class="btn" data-x>Close</button></div></div>`);
  const set = async (c) => {
    c = c.toLowerCase();
    const next = { ...state.folderColors };
    if (c === FOLDER_COLOR) delete next[n.path]; else next[n.path] = c;
    await saveFolderColors(next);
    closeModal();
    renderSessions();
  };
  $$('button[data-c]', node).forEach((b) => (b.onclick = () => set(b.dataset.c)));
  node.querySelector('input[type=color]').onchange = (e) => set(e.target.value);
  node.querySelector('[data-x]').onclick = () => closeModal();
  openModal(node);
}

async function moveSessions(ids, folder) {
  await api.sessions.setFolders(ids.map((id) => ({ id, folder })));
  if (folder) await saveFolders([...state.folders, folder]);
  if (folder) for (let p = folder; p; p = parentFolder(p)) state.collapsed.delete('f:' + p);
  await refreshSessions();
}

async function newFolder(parent) {
  const r = await promptDialog({ title: parent ? 'New subfolder' : 'New folder', sub: parent ? `Inside ${parent}` : 'Group your saved sessions.', fields: [{ name: 'name', label: 'Folder name', placeholder: 'e.g. Production' }], ok: 'Create' });
  const name = normFolder(r?.name);
  if (!name) return;
  const path = parent ? parent + ' / ' + name : name;
  await saveFolders([...state.folders, path]);
  state.collapsed.delete('__saved');
  for (let p = parent; p; p = parentFolder(p)) state.collapsed.delete('f:' + p);
  renderSessions();
  toast(`Folder “${folderName(path)}” created`);
}

// Moves a folder and everything under it; renaming in place is a move to a new name.
async function renameFolder(from, to) {
  to = normFolder(to);
  if (!to || to === from) return;
  const swap = (f) => (inFolder(f, from) ? to + f.slice(from.length) : f);
  const changes = state.sessions.filter((s) => inFolder(normFolder(s.folder), from)).map((s) => ({ id: s.id, folder: swap(normFolder(s.folder)) }));
  if (changes.length) await api.sessions.setFolders(changes);
  await saveFolders([...state.folders.map((f) => swap(normFolder(f))), to]);
  await saveFolderColors(Object.fromEntries(Object.entries(state.folderColors).map(([k, v]) => [swap(k), v])));
  for (const k of [...state.collapsed]) if (k.startsWith('f:') && inFolder(k.slice(2), from)) { state.collapsed.delete(k); state.collapsed.add('f:' + swap(k.slice(2))); }
  for (let p = parentFolder(to); p; p = parentFolder(p)) state.collapsed.delete('f:' + p);
  await refreshSessions();
}

async function promptRename(n) {
  const r = await promptDialog({ title: 'Rename folder', sub: n.path, fields: [{ name: 'name', label: 'Folder name', value: n.name }], ok: 'Rename' });
  const name = normFolder(r?.name);
  if (!name) return;
  const parent = parentFolder(n.path);
  await renameFolder(n.path, parent ? parent + ' / ' + name : name);
}

function deleteFolder(n) {
  const inside = subtreeSessions(n);
  const parent = parentFolder(n.path);
  const forget = async () => {
    await saveFolders(state.folders.filter((f) => !inFolder(normFolder(f), n.path)));
    await saveFolderColors(Object.fromEntries(Object.entries(state.folderColors).filter(([k]) => !inFolder(k, n.path))));
  };
  if (!inside.length) {
    return confirmDialog('Delete folder?', `“${n.name}” is empty and will be removed.`).then(async (ok) => { if (ok) { await forget(); renderSessions(); } });
  }
  const many = `${inside.length} session${inside.length === 1 ? '' : 's'}`;
  const node = el(`<div class="modal sm">
    <div class="modal-head"><div><h3>Delete “${esc(n.name)}”?</h3><div class="sub">This folder holds ${many}. What should happen to ${inside.length === 1 ? 'it' : 'them'}?</div></div></div>
    <div class="modal-body"><div class="choice-list">
      <button class="choice" data-keep>${icon('folder')}<span><b>Keep the sessions</b><small>Move ${many} to ${parent ? `“${esc(folderName(parent))}”` : 'Saved sessions'}</small></span></button>
      <button class="choice danger" data-all>${icon('trash')}<span><b>Delete everything</b><small>Remove the folder and its ${many}</small></span></button>
    </div></div>
    <div class="modal-foot"><button class="btn" data-x>Cancel</button></div></div>`);
  node.querySelector('[data-x]').onclick = () => closeModal();
  node.querySelector('[data-keep]').onclick = async () => {
    closeModal();
    // Subfolders move up a level with their sessions, keeping their own structure.
    const lift = (f) => (inFolder(f, n.path) ? normFolder(parent + ' / ' + f.slice(n.path.length).replace(/^ \/ /, '')) : f);
    await api.sessions.setFolders(inside.map((s) => ({ id: s.id, folder: lift(normFolder(s.folder)) })));
    await saveFolders(state.folders.map((f) => normFolder(f)).filter((f) => f !== n.path).map(lift));
    await saveFolderColors(Object.fromEntries(Object.entries(state.folderColors).filter(([k]) => k !== n.path).map(([k, v]) => [lift(k), v])));
    await refreshSessions();
    toast(`Folder removed, ${many} kept`);
  };
  node.querySelector('[data-all]').onclick = async () => {
    closeModal();
    if (inside.some((s) => isLive(s.id))) toast('Open connections stay open until you close them');
    await api.sessions.deleteMany(inside.map((s) => s.id));
    await forget();
    await refreshSessions();
    toast(`Deleted “${n.name}” and ${many}`);
  };
  openModal(node);
}

function folderMenu(x, y, n) {
  const all = subtreeSessions(n);
  if (!n.path) {
    return showMenu(x, y, [
      { label: 'New folder…', icon: 'folderPlus', action: () => newFolder('') },
      { label: 'New session…', icon: 'plus', action: () => editSession() },
      { label: 'Import connections…', icon: 'download', action: openImport },
    ]);
  }
  showMenu(x, y, [
    { label: 'New session here…', icon: 'plus', action: () => editSession(null, { folder: n.path }) },
    { label: 'New subfolder…', icon: 'folderPlus', action: () => newFolder(n.path) },
    all.length ? { label: `Connect all (${all.length})`, icon: 'play', action: () => all.forEach((s) => openSsh(s)) } : null,
    '-',
    { label: 'Rename…', icon: 'edit', action: () => promptRename(n) },
    { label: 'Change color…', icon: 'palette', action: () => pickFolderColor(n) },
    parentFolder(n.path) ? { label: 'Move to top level', icon: 'arrowUp', action: () => renameFolder(n.path, n.name) } : null,
    '-',
    { label: 'Delete folder…', icon: 'trash', danger: true, action: () => deleteFolder(n) },
  ]);
}

async function pickFolder(s) {
  const all = [...new Set([...state.folders, ...state.sessions.map((x) => normFolder(x.folder))].filter(Boolean))].sort();
  const r = await promptDialog({ title: 'Move to folder', sub: s.name, fields: [{ name: 'folder', label: 'Folder', value: normFolder(s.folder), placeholder: 'Leave empty for the top level', hint: all.length ? 'Existing: ' + all.slice(0, 6).join(', ') + (all.length > 6 ? '…' : '') : 'Use / for subfolders, e.g. Production / DB' }], ok: 'Move' });
  if (r) await moveSessions([s.id], normFolder(r.folder));
}

function sessionMenu(x, y, s) {
  showMenu(x, y, [
    { label: 'Connect', icon: 'play', action: () => openSsh(s) },
    { label: 'Edit…', icon: 'edit', action: () => editSession(s) },
    { label: 'Move to folder…', icon: 'folder', action: () => pickFolder(s) },
    { label: 'Duplicate', icon: 'copy', action: async () => { const { id, hasPassword, hasPassphrase, lastUsed, created, ...rest } = s; await api.sessions.save({ ...rest, name: s.name + ' (copy)' }); refreshSessions(); } },
    { label: 'Copy SSH command', icon: 'terminal', action: () => { api.clipboardWrite(`ssh ${s.port && Number(s.port) !== 22 ? `-p ${s.port} ` : ''}${s.username}@${s.host}`); toast('Copied'); } },
    s.hasPassword ? { label: 'Forget password', icon: 'lock', action: async () => { await api.sessions.forgetPassword(s.id); refreshSessions(); toast('Password removed'); } } : null,
    '-',
    { label: 'Delete', icon: 'trash', danger: true, action: async () => {
      if (await confirmDialog('Delete session?', `“${s.name}” will be removed from your saved sessions.`)) { await api.sessions.remove(s.id); refreshSessions(); }
    } },
  ]);
}

function editSession(existing, preset = {}) {
  const s = existing || { port: 22, auth: 'password', color: COLORS[state.sessions.length % COLORS.length], ...preset };
  const folders = [...new Set([...state.folders, ...state.sessions.map((x) => x.folder)].filter(Boolean))].sort();
  let auth = s.auth === 'auto' ? 'password' : s.auth;
  let color = s.color || COLORS[0];
  const node = el(`<form class="modal" autocomplete="off">
    <div class="modal-head"><div><h3>${existing ? 'Edit session' : 'New SSH session'}</h3><div class="sub">Saved locally. Passwords are encrypted with ${secretStore()}.</div></div></div>
    <div class="modal-body">
      <div class="grid2"><div class="field"><label>Host</label><input class="input" name="host" required placeholder="example.com or 10.0.0.5" value="${esc(s.host)}" autofocus spellcheck="false"></div>
        <div class="field"><label>Port</label><input class="input" name="port" type="number" min="1" max="65535" value="${esc(s.port || 22)}"></div></div>
      <div class="grid2 even"><div class="field"><label>Username</label><input class="input" name="username" required placeholder="root" value="${esc(s.username)}" spellcheck="false"></div>
        <div class="field"><label>Display name</label><input class="input" name="name" placeholder="optional" value="${esc(existing ? s.name : '')}"></div></div>
      <div class="field"><span class="field-label">Authentication</span>
        <div class="seg" data-auth>
          <button type="button" data-v="password">${icon('lock')}Password</button>
          <button type="button" data-v="key">${icon('key')}Private key</button>
          <button type="button" data-v="agent">${icon('sparkle')}SSH agent</button>
        </div></div>
      <div data-pane="password"><div class="field"><label>Password</label>
        <input class="input" name="password" type="password" placeholder="${s.hasPassword ? '•••••••• (saved — leave blank to keep)' : 'leave blank to ask every time'}"></div></div>
      <div data-pane="key">
        <div class="field"><label>Private key file</label><div class="with-btn"><input class="input" name="keyPath" placeholder="~/.ssh/id_ed25519 (default)" value="${esc(s.keyPath)}" spellcheck="false"><button type="button" class="btn" data-browse>Browse…</button></div></div>
        <div class="field"><label>Key passphrase</label><input class="input" name="passphrase" type="password" placeholder="${s.hasPassphrase ? '•••••••• (saved)' : 'if the key is encrypted'}"></div>
      </div>
      <div data-pane="agent"><div class="hint" style="margin:-4px 0 14px">Uses the Windows OpenSSH agent (<code>ssh-agent</code> service).</div></div>
      <div class="grid2 even"><div class="field"><label>Folder</label><input class="input" name="folder" list="folder-list" placeholder="e.g. Production" value="${esc(s.folder)}">
        <datalist id="folder-list">${folders.map((f) => `<option value="${esc(f)}">`).join('')}</datalist></div>
        <div class="field"><span class="field-label">Color</span><div class="colors">${COLORS.map((c) => `<button type="button" data-c="${c}" style="background:${c};color:${c}"></button>`).join('')}</div></div></div>
      ${state.flows.length ? `<div class="field"><label>Run a flow after connecting</label><select class="input" name="startupFlow"><option value="">None</option>
        ${state.flows.map((fl) => `<option value="${esc(fl.id)}" ${s.startupFlow === fl.id ? 'selected' : ''}>${esc(fl.name)}</option>`).join('')}</select></div>` : ''}
    </div>
    <div class="modal-foot">
      ${existing ? `<button type="button" class="btn danger left" data-del>${icon('trash')}Delete</button>` : ''}
      <button type="button" class="btn" data-x>Cancel</button>
      <button type="submit" class="btn" data-save>Save</button>
      <button type="submit" class="btn primary" data-connect>${icon('play')}Save & connect</button>
    </div></form>`);
  const sync = () => {
    $$('[data-auth] button', node).forEach((b) => b.classList.toggle('on', b.dataset.v === auth));
    $$('[data-pane]', node).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== auth));
    $$('.colors button', node).forEach((b) => b.classList.toggle('on', b.dataset.c === color));
  };
  $$('[data-auth] button', node).forEach((b) => (b.onclick = () => { auth = b.dataset.v; sync(); }));
  $$('.colors button', node).forEach((b) => (b.onclick = () => { color = b.dataset.c; sync(); }));
  node.querySelector('[data-browse]').onclick = async () => { const p = await api.pickKey(); if (p) node.elements.keyPath.value = p; };
  node.querySelector('[data-x]').onclick = () => closeModal();
  node.querySelector('[data-del]')?.addEventListener('click', async () => {
    closeModal();
    if (await confirmDialog('Delete session?', `“${s.name}” will be removed.`)) { await api.sessions.remove(s.id); refreshSessions(); }
  });
  sync();
  node.onsubmit = async (e) => {
    e.preventDefault();
    const f = node.elements;
    const data = {
      id: existing?.id,
      host: f.host.value.trim(),
      port: Number(f.port.value) || 22,
      username: f.username.value.trim(),
      name: f.name.value.trim() || `${f.username.value.trim()}@${f.host.value.trim()}`,
      auth, color,
      keyPath: f.keyPath.value.trim(),
      folder: normFolder(f.folder.value),
      startupFlow: f.startupFlow?.value ?? s.startupFlow ?? '',
    };
    if (f.password.value) { data.password = f.password.value; data.savePassword = true; }
    if (f.passphrase.value) { data.passphrase = f.passphrase.value; data.savePassword = true; }
    if (data.password && !state.info.canEncrypt) { toast('Secure storage unavailable — password not saved', 'err'); }
    const saved = await api.sessions.save(data);
    closeModal();
    await refreshSessions();
    if (e.submitter?.dataset.connect !== undefined) openSsh(state.sessions.find((x) => x.id === saved.id));
  };
  openModal(node);
}

// ---------- SFTP panel ----------
function sftpTab() {
  const t = state.active;
  return t && t.type === 'ssh' && t.status === 'connected' ? t : null;
}

async function renderFiles(reload) {
  const tab = sftpTab();
  const list = $('#file-list');
  const buttons = ['#sftp-upload', '#sftp-mkdir', '#sftp-newfile', '#sftp-refresh', '#sftp-up', '#sftp-home'].map((s) => $(s));
  buttons.forEach((b) => (b.disabled = !tab));
  $('#sftp-path').disabled = !tab;
  if (!tab) {
    $('#sftp-path').value = '';
    list.innerHTML = `<div class="empty">${icon('folder')}<div>Connect to an SSH session to browse its files here.</div></div>`;
    return;
  }
  if (!tab.files) tab.files = { path: null, items: [], selected: new Set(), anchor: null };
  if (reload || !tab.files.path) await loadDir(tab, tab.files.path);
  else drawFiles(tab);
}

async function loadDir(tab, dir) {
  const list = $('#file-list');
  if (!tab.files.items.length) list.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
  try {
    const r = await api.sftp.list(tab.termId, dir || (await api.sftp.home(tab.termId)));
    tab.files.path = r.path;
    tab.files.items = r.items;
    tab.files.selected = new Set();
    tab.files.anchor = null;
    if (sftpTab() === tab) drawFiles(tab);
  } catch (e) {
    toast(cleanErr(e), 'err');
    if (!tab.files.path) list.innerHTML = `<div class="empty">${icon('x')}<div>${esc(cleanErr(e))}</div></div>`;
  }
}

function fileIcon(f) {
  if (f.isDir) return 'folder';
  if (f.isLink) return 'link';
  if (/\.(js|ts|py|sh|json|ya?ml|conf|ini|toml|go|rs|c|h|cpp|java|php|rb|html|css|xml|sql|env)$/i.test(f.name)) return 'fileCode';
  return 'file';
}

function drawFiles(tab) {
  const fs = tab.files;
  $('#sftp-path').value = fs.path;
  const list = $('#file-list');
  list.innerHTML = '';
  const showHidden = settings.showHidden;
  const items = fs.items.filter((f) => showHidden || !f.name.startsWith('.'));
  const hiddenCount = fs.items.length - items.length;
  if (fs.path !== '/') {
    const up = el(`<div class="frow dir">${icon('folder')}<span class="fname">..</span><span class="fsize"></span></div>`);
    up.ondblclick = () => loadDir(tab, posixParent(fs.path));
    list.append(up);
  }
  items.forEach((f, idx) => {
    const p = posixJoin(fs.path, f.name);
    const row = el(`<div class="frow ${f.isDir ? 'dir' : 'file'} ${f.isLink ? 'link' : ''} ${fs.selected.has(p) ? 'selected' : ''}"
      title="${esc(f.name)}\n${f.isDir ? 'Folder' : fmtBytes(f.size)} · ${new Date(f.mtime).toLocaleString()}">
      ${icon(fileIcon(f))}<span class="fname">${esc(f.name)}</span><span class="fsize">${f.isDir ? '' : fmtBytes(f.size)}</span></div>`);
    row.onclick = (e) => {
      if (e.shiftKey && fs.anchor !== null) {
        const [a, b] = [fs.anchor, idx].sort((x, y) => x - y);
        fs.selected = new Set(items.slice(a, b + 1).map((x) => posixJoin(fs.path, x.name)));
      } else if (e.ctrlKey) {
        fs.selected.has(p) ? fs.selected.delete(p) : fs.selected.add(p);
        fs.anchor = idx;
      } else {
        fs.selected = new Set([p]);
        fs.anchor = idx;
      }
      drawFiles(tab);
    };
    row.ondblclick = () => (f.isDir ? loadDir(tab, p) : openRemote(tab, p));
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!fs.selected.has(p)) { fs.selected = new Set([p]); fs.anchor = idx; drawFiles(tab); }
      const sel = [...fs.selected];
      showMenu(e.clientX, e.clientY, [
        f.isDir ? { label: 'Open folder', icon: 'folder', action: () => loadDir(tab, p) } : { label: 'Open / edit', icon: 'edit', action: () => openRemote(tab, p) },
        { label: sel.length > 1 ? `Download ${sel.length} items…` : 'Download…', icon: 'download', action: () => download(tab, sel) },
        sel.length === 1 ? { label: 'Rename', icon: 'edit', kbd: 'F2', action: () => renameRemote(tab, p) } : null,
        { label: 'Copy path', icon: 'copy', action: () => { api.clipboardWrite(sel.join('\n')); toast('Path copied'); } },
        f.isDir ? { label: 'cd here in terminal', icon: 'terminal', action: () => { api.write(tab.termId, `cd '${p.replace(/'/g, "'\\''")}'\r`); tab.term.focus(); } } : null,
        '-',
        { label: sel.length > 1 ? `Delete ${sel.length} items` : 'Delete', icon: 'trash', danger: true, kbd: 'Del', action: () => removeRemote(tab, sel) },
      ]);
    };
    list.append(row);
  });
  if (hiddenCount) {
    const more = el(`<div class="group-title clickable" style="padding-left:12px">${icon('eye')}<span>${hiddenCount} hidden item${hiddenCount > 1 ? 's' : ''}</span></div>`);
    more.onclick = () => { settings.showHidden = true; saveSettings(); drawFiles(tab); };
    list.append(more);
  }
}

async function openRemote(tab, p) {
  try {
    await api.sftp.open(tab.termId, p);
    toast(`Opened ${p.split('/').pop()} — saving it uploads changes`);
  } catch (e) { toast(cleanErr(e), 'err'); }
}
async function download(tab, paths) {
  try { await api.sftp.download(tab.termId, paths); } catch (e) { toast(cleanErr(e), 'err'); }
}
async function upload(tab, localPaths) {
  const dir = tab.files.path;
  try {
    if (await api.sftp.upload(tab.termId, dir, localPaths)) loadDir(tab, dir);
  } catch (e) { toast(cleanErr(e), 'err'); loadDir(tab, dir); }
}
async function renameRemote(tab, p) {
  const name = p.split('/').pop();
  const r = await promptDialog({ title: 'Rename', fields: [{ name: 'name', label: 'New name', value: name }], ok: 'Rename' });
  if (!r || !r.name || r.name === name) return;
  try { await api.sftp.rename(tab.termId, p, posixJoin(posixParent(p), r.name)); loadDir(tab, tab.files.path); } catch (e) { toast(cleanErr(e), 'err'); }
}
async function removeRemote(tab, paths) {
  const what = paths.length > 1 ? `${paths.length} items` : `“${paths[0].split('/').pop()}”`;
  if (!(await confirmDialog('Delete permanently?', `${what} will be deleted from the server. Folders are deleted with their contents.`))) return;
  try { await api.sftp.remove(tab.termId, paths); } catch (e) { toast(cleanErr(e), 'err'); }
  loadDir(tab, tab.files.path);
}
async function newRemote(tab, kind) {
  const r = await promptDialog({ title: kind === 'dir' ? 'New folder' : 'New file', fields: [{ name: 'name', label: 'Name' }], ok: 'Create' });
  if (!r || !r.name) return;
  const p = posixJoin(tab.files.path, r.name);
  try {
    await (kind === 'dir' ? api.sftp.mkdir(tab.termId, p) : api.sftp.touch(tab.termId, p));
    loadDir(tab, tab.files.path);
  } catch (e) { toast(cleanErr(e), 'err'); }
}

const transfers = new Map();
function onProgress(p) {
  let node = transfers.get(p.tid);
  if (!node) {
    node = el(`<div class="transfer"><div class="row"><span></span><span></span></div><div class="bar"><i style="width:0"></i></div></div>`);
    node.querySelector('.row span').textContent = `${p.kind === 'upload' ? '↑' : '↓'} ${p.name}`;
    $('#transfers').append(node);
    transfers.set(p.tid, node);
  }
  const [, right] = node.querySelectorAll('.row span');
  if (p.finished) {
    node.classList.add(p.error ? 'error' : 'done');
    right.textContent = p.error ? 'failed' : 'done';
    node.querySelector('.bar i').style.width = '100%';
    if (!p.error && p.kind === 'download') toast(`Downloaded ${p.name}`);
    setTimeout(() => { node.remove(); transfers.delete(p.tid); }, p.error ? 6000 : 2500);
  } else {
    node.querySelector('.bar i').style.width = (p.total ? (p.done / p.total) * 100 : 0) + '%';
    right.textContent = `${fmtBytes(p.done)} / ${fmtBytes(p.total)}`;
  }
}

function setupFilesPanel() {
  const list = $('#file-list');
  $('#sftp-refresh').onclick = () => { const t = sftpTab(); if (t) loadDir(t, t.files.path); };
  $('#sftp-up').onclick = () => { const t = sftpTab(); if (t) loadDir(t, posixParent(t.files.path)); };
  $('#sftp-home').onclick = () => { const t = sftpTab(); if (t) loadDir(t, null); };
  $('#sftp-upload').onclick = () => { const t = sftpTab(); if (t) upload(t); };
  $('#sftp-mkdir').onclick = () => { const t = sftpTab(); if (t) newRemote(t, 'dir'); };
  $('#sftp-newfile').onclick = () => { const t = sftpTab(); if (t) newRemote(t, 'file'); };
  $('#sftp-path').onkeydown = (e) => { if (e.key === 'Enter') { const t = sftpTab(); if (t) loadDir(t, e.target.value.trim() || '/'); } };
  list.oncontextmenu = (e) => {
    const t = sftpTab();
    if (!t) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: 'Upload files…', icon: 'upload', action: () => upload(t) },
      { label: 'New folder', icon: 'folderPlus', action: () => newRemote(t, 'dir') },
      { label: 'New file', icon: 'filePlus', action: () => newRemote(t, 'file') },
      { label: settings.showHidden ? 'Hide hidden files' : 'Show hidden files', icon: 'eye', action: () => { settings.showHidden = !settings.showHidden; saveSettings(); drawFiles(t); } },
      { label: 'Refresh', icon: 'refresh', action: () => loadDir(t, t.files.path) },
    ]);
  };
  list.tabIndex = 0;
  list.onkeydown = (e) => {
    const t = sftpTab();
    if (!t || !t.files.selected.size) return;
    const sel = [...t.files.selected];
    if (e.key === 'Delete') removeRemote(t, sel);
    if (e.key === 'F2' && sel.length === 1) renameRemote(t, sel[0]);
  };
  list.ondragover = (e) => {
    if (!sftpTab() || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    list.classList.add('drop');
  };
  list.ondragleave = (e) => { if (!list.contains(e.relatedTarget)) list.classList.remove('drop'); };
  list.ondrop = (e) => {
    e.preventDefault();
    list.classList.remove('drop');
    const t = sftpTab();
    if (!t) return;
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) upload(t, paths);
  };
}

// ---------- flows ----------
// A flow is a list of steps replayed into terminals:
//   { k: 'type', v: text, enter } | { k: 'key', v: name } | { k: 'wait', v: ms } | { k: 'expect', v: text, timeout: s }
// {{name}} inside typed text asks for a value each time the flow runs.
const FLOW_KEYS = {
  Enter: '\r', Tab: '\t', Esc: '\x1b', Backspace: '\x7f', 'Ctrl+C': '\x03', 'Ctrl+D': '\x04', 'Ctrl+Z': '\x1a', 'Ctrl+L': '\x0c',
  Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D',
};
const KEY_BY_SEQ = { ...Object.fromEntries(Object.entries(FLOW_KEYS).map(([k, v]) => [v, k])), '\x1bOA': 'Up', '\x1bOB': 'Down', '\x1bOC': 'Right', '\x1bOD': 'Left' };
const STEP_KINDS = { type: 'Type', key: 'Press key', wait: 'Wait', expect: 'Wait for text' };
const NEW_STEP = { type: () => ({ k: 'type', v: '', enter: true }), key: () => ({ k: 'key', v: 'Enter' }), wait: () => ({ k: 'wait', v: 1000 }), expect: () => ({ k: 'expect', v: '$ ', timeout: 30 }) };
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const VAR = /\{\{\s*([\w-]+)\s*\}\}/g;
const flowRuns = new Map(); // pane -> run in progress

async function refreshFlows() {
  state.flows = await api.flows.list();
  renderFlows();
}
async function saveFlows() {
  await api.flows.save(state.flows);
  renderFlows();
}
const flowVars = (flow) => [...new Set(flow.steps.flatMap((s) => (s.k === 'type' || s.k === 'expect' ? [...s.v.matchAll(VAR)].map((m) => m[1]) : [])))];
const fillVars = (text, vars) => text.replace(VAR, (_, n) => vars[n] ?? '');
function flowSummary(f) {
  const n = f.steps.length;
  const vars = flowVars(f);
  return `${n} step${n === 1 ? '' : 's'}${vars.length ? ' · asks for ' + vars.join(', ') : ''}`;
}

function renderFlows() {
  const list = $('#flow-list');
  list.innerHTML = '';
  const rec = state.recording;
  if (rec) {
    const card = el(`<div class="rec-card"><span class="rec-dot"></span><div class="meta"><div class="name">Recording</div>
      <div class="sub">${esc(rec.tab.title)} · ${rec.steps.length} step${rec.steps.length === 1 ? '' : 's'}</div></div>
      <button class="btn sm">${icon('stop')}Stop</button></div>`);
    card.querySelector('button').onclick = stopRecording;
    list.append(card);
  }
  if (!state.flows.length) {
    if (rec) return;
    const empty = el(`<div class="empty">${icon('workflow')}<div>Flows replay input into your terminals. Record what you type once, then run it on any session.</div>
      <div class="empty-actions"><button class="btn sm primary" data-rec>${icon('record')}Record</button><button class="btn sm" data-new>${icon('plus')}Build one</button></div></div>`);
    empty.querySelector('[data-rec]').onclick = startRecording;
    empty.querySelector('[data-new]').onclick = () => editFlow();
    list.append(empty);
    return;
  }
  const running = new Set([...flowRuns.values()].map((r) => r.flow.id));
  for (const f of state.flows) {
    const it = el(`<div class="item ${state.selectedFlow === f.id ? 'selected' : ''}" title="Double-click to run in the active terminal">
      <div class="avatar" style="background:${f.color || COLORS[0]}">${icon('workflow')}</div>
      <div class="meta"><div class="name">${esc(f.name)}</div><div class="sub">${esc(flowSummary(f))}</div></div>
      ${running.has(f.id) ? '<span class="live run" title="Running"></span>' : ''}
      <span class="go" title="Run in the active terminal">${icon('play')}</span></div>`);
    it.onclick = (e) => {
      state.selectedFlow = f.id;
      if (e.target.closest('.go')) runFlow(f); else renderFlows();
    };
    it.ondblclick = () => runFlow(f);
    it.oncontextmenu = (e) => { e.preventDefault(); state.selectedFlow = f.id; renderFlows(); flowMenu(e.clientX, e.clientY, f); };
    list.append(it);
  }
}

function flowMenu(x, y, f) {
  const multi = state.activeGroup && leaves(state.activeGroup.root).length > 1;
  showMenu(x, y, [
    { label: 'Run in this terminal', icon: 'play', action: () => runFlow(f, 'pane') },
    multi ? { label: 'Run in every pane of this tab', icon: 'columns', action: () => runFlow(f, 'tab') } : null,
    { label: 'Run in all connected terminals', icon: 'broadcast', action: () => runFlow(f, 'all') },
    '-',
    { label: 'Edit…', icon: 'edit', action: () => editFlow(f) },
    { label: 'Duplicate', icon: 'copy', action: () => { state.flows.push({ ...structuredClone(f), id: newId(), name: f.name + ' (copy)' }); saveFlows(); } },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, action: async () => {
      if (await confirmDialog('Delete flow?', `“${f.name}” will be removed.`)) { state.flows = state.flows.filter((x) => x.id !== f.id); saveFlows(); }
    } },
  ]);
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// scope: 'pane' | 'tab' | 'all', or an explicit list of panes
async function runFlow(flow, scope = 'pane') {
  const panes = Array.isArray(scope) ? scope
    : scope === 'all' ? state.tabs
    : scope === 'tab' ? (state.activeGroup ? leaves(state.activeGroup.root) : [])
    : [state.active];
  const targets = panes.filter((t) => t?.termId && t.status === 'connected');
  if (!targets.length) return toast('Open a connected terminal to run a flow in', 'err');
  const names = flowVars(flow);
  let vars = {};
  if (names.length) {
    vars = await promptDialog({
      title: `Run “${flow.name}”`,
      sub: targets.length > 1 ? `In ${targets.length} terminals` : targets[0].title,
      fields: names.map((n) => ({ name: n, label: n, type: /pass|secret|token|key/i.test(n) ? 'password' : 'text' })),
      ok: 'Run',
    });
    if (!vars) return;
  }
  targets.forEach((t) => runFlowIn(t, flow, vars));
}

async function runFlowIn(tab, flow, vars) {
  flowRuns.get(tab)?.cancel();
  const run = { flow, step: 0, cancelled: false, cancel() { this.cancelled = true; this.wake?.(); } };
  flowRuns.set(tab, run);
  // "Wait for text" matches output that arrives after the last thing sent; seed it with the current line so a waiting prompt counts.
  const b = tab.term.buffer.active;
  tab.flowOut = b.getLine(b.baseY + b.cursorY)?.translateToString(true) || '';
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); run.wake = () => { clearTimeout(t); r(); }; });
  let echo = '';
  const send = (data) => { tab.flowOut = ''; echo = data.replace(/\r$/, ''); api.write(tab.termId, data); };
  // The terminal echoes what was typed, so leave that out when looking for text.
  const seen = () => (echo ? tab.flowOut.replace(echo, '') : tab.flowOut);
  renderFlows();
  renderStatus();
  let error = null;
  try {
    for (const [i, st] of flow.steps.entries()) {
      if (run.cancelled) break;
      if (!tab.termId || tab.status !== 'connected') throw new Error('the terminal closed');
      run.step = i;
      if (tab === state.active) renderStatus();
      if (st.k === 'type') send(fillVars(st.v, vars) + (st.enter ? '\r' : ''));
      else if (st.k === 'key') send(FLOW_KEYS[st.v] || '');
      else if (st.k === 'wait') await sleep(Number(st.v) || 0);
      else if (st.k === 'expect') {
        const want = fillVars(st.v, vars);
        const secs = Number(st.timeout) || 30;
        const until = Date.now() + secs * 1000;
        while (!run.cancelled && !seen().includes(want)) {
          if (Date.now() > until) throw new Error(`“${want}” didn't appear within ${secs}s`);
          await sleep(50);
        }
      }
      // A short gap between sends keeps line-buffered programs (and slow links) in step.
      if (st.k === 'type' || st.k === 'key') await sleep(30);
    }
  } catch (e) { error = e; }
  if (flowRuns.get(tab) === run) { flowRuns.delete(tab); tab.flowOut = undefined; }
  renderFlows();
  if (tab === state.active) renderStatus();
  if (error) toast(`${flow.name}: ${error.message}`, 'err');
  else if (run.cancelled) toast(`Stopped “${flow.name}”`);
}

function toggleRecording() {
  if (state.recording) stopRecording(); else startRecording();
}
function startRecording() {
  const tab = state.active;
  if (!tab?.termId || tab.status !== 'connected') return toast('Open a terminal to record in', 'err');
  state.recording = { tab, steps: [], last: 0 };
  tab.host.classList.add('recording');
  if (state.panel !== 'flows' || $('#sidebar').classList.contains('collapsed')) { state.panel = ''; showPanel('flows'); }
  renderFlows();
  renderStatus();
  updateRail();
  toast(`Recording what you type in ${tab.title}. Press Ctrl+Shift+R to stop.`);
  tab.term.focus();
}
function stopRecording() {
  const rec = state.recording;
  if (!rec) return;
  state.recording = null;
  rec.tab.host.classList.remove('recording');
  renderFlows();
  renderStatus();
  updateRail();
  if (!rec.steps.length) return toast('Nothing was recorded');
  editFlow({ name: '', steps: rec.steps }, { recorded: true });
}
// Turns raw keystrokes into readable steps: text runs become Type steps, Enter closes them,
// Backspace edits them, and pauses of over 1.5s between commands become Wait steps.
function recordInput(data) {
  const rec = state.recording;
  const steps = rec.steps;
  const now = Date.now();
  const last = steps[steps.length - 1];
  if (last && (last.k === 'key' || last.enter) && now - rec.last > 1500) {
    steps.push({ k: 'wait', v: Math.min(10000, Math.round((now - rec.last) / 100) * 100) });
  }
  rec.last = now;
  const open = () => { const l = steps[steps.length - 1]; return l?.k === 'type' && !l.enter ? l : null; };
  const enter = () => { const o = open(); if (o) o.enter = true; else steps.push({ k: 'key', v: 'Enter' }); };
  const key = KEY_BY_SEQ[data];
  if (key === 'Enter') enter();
  else if (key === 'Backspace' && open()) { const o = open(); o.v = o.v.slice(0, -1); if (!o.v) steps.pop(); }
  else if (key) steps.push({ k: 'key', v: key });
  else if (data.startsWith('\x1b')) return; // mouse reports and replies to terminal queries
  else {
    const lines = data.replace(/\r\n?/g, '\r').split('\r');
    lines.forEach((line, i) => {
      const text = line.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '');
      if (text) { const o = open(); if (o) o.v += text; else steps.push({ k: 'type', v: text, enter: false }); }
      if (i < lines.length - 1) enter();
    });
  }
  renderFlows();
}

function editFlow(existing, { recorded } = {}) {
  const flow = structuredClone(existing || { name: '', steps: [NEW_STEP.type()] });
  let color = flow.color || COLORS[state.flows.length % COLORS.length];
  const node = el(`<form class="modal flow-modal" autocomplete="off">
    <div class="modal-head"><div><h3>${recorded ? 'Save recorded flow' : existing?.id ? 'Edit flow' : 'New flow'}</h3>
      <div class="sub">Steps run from top to bottom. Write <code>{{name}}</code> in text to be asked for a value when the flow runs.</div></div></div>
    <div class="modal-body">
      <div class="grid2 even"><div class="field"><label>Name</label><input class="input" name="name" required placeholder="e.g. Update and restart app" value="${esc(flow.name)}" autofocus spellcheck="false"></div>
        <div class="field"><span class="field-label">Color</span><div class="colors">${COLORS.map((c) => `<button type="button" data-c="${c}" style="background:${c};color:${c}"></button>`).join('')}</div></div></div>
      <div class="field"><span class="field-label">Steps</span><div class="steps" data-steps></div>
        <div class="add-steps">${Object.entries(STEP_KINDS).map(([k, label]) => `<button type="button" class="btn sm" data-add="${k}">${icon('plus')}${label}</button>`).join('')}</div></div>
    </div>
    <div class="modal-foot">
      ${existing?.id ? `<button type="button" class="btn danger left" data-del>${icon('trash')}Delete</button>` : ''}
      <button type="button" class="btn" data-x>Cancel</button>
      <button type="submit" class="btn" data-save>Save</button>
      <button type="submit" class="btn primary" data-run>${icon('play')}Save & run</button>
    </div></form>`);
  const stepsEl = node.querySelector('[data-steps]');
  const drawSteps = () => {
    stepsEl.innerHTML = '';
    flow.steps.forEach((st, i) => {
      let value;
      if (st.k === 'type') {
        value = `<input class="input" data-f="v" value="${esc(st.v)}" placeholder="text or command" spellcheck="false">
          <button type="button" class="enter ${st.enter ? 'on' : ''}" data-enter title="Press Enter after typing">↵ Enter</button>`;
      } else if (st.k === 'key') {
        value = `<select class="input" data-f="v">${Object.keys(FLOW_KEYS).map((k) => `<option ${k === st.v ? 'selected' : ''}>${k}</option>`).join('')}</select>`;
      } else if (st.k === 'wait') {
        value = `<input class="input num" type="number" min="0" step="100" data-f="v" value="${esc(st.v)}"><span class="unit">ms</span>`;
      } else {
        value = `<input class="input" data-f="v" value="${esc(st.v)}" placeholder="text to wait for, e.g. password:" spellcheck="false">
          <span class="unit">within</span><input class="input num sm" type="number" min="1" data-f="timeout" value="${esc(st.timeout ?? 30)}"><span class="unit">s</span>`;
      }
      const row = el(`<div class="step"><span class="snum">${i + 1}</span>
        <select class="input" data-kind>${Object.entries(STEP_KINDS).map(([k, l]) => `<option value="${k}" ${k === st.k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="sval">${value}</div>
        <div class="sacts">
          <button type="button" class="icon-btn sm" data-mv="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('arrowUp')}</button>
          <button type="button" class="icon-btn sm" data-mv="1" title="Move down" ${i === flow.steps.length - 1 ? 'disabled' : ''}>${icon('arrowDown')}</button>
          <button type="button" class="icon-btn sm" data-rm title="Remove step">${icon('x')}</button>
        </div></div>`);
      row.querySelector('[data-kind]').onchange = (e) => { flow.steps[i] = NEW_STEP[e.target.value](); drawSteps(); };
      row.querySelectorAll('[data-f]').forEach((inp) => (inp.oninput = inp.onchange = () => {
        st[inp.dataset.f] = inp.type === 'number' ? Number(inp.value) : inp.value;
      }));
      row.querySelector('[data-enter]')?.addEventListener('click', (e) => { st.enter = !st.enter; e.currentTarget.classList.toggle('on', st.enter); });
      row.querySelectorAll('[data-mv]').forEach((b) => (b.onclick = () => {
        const j = i + Number(b.dataset.mv);
        [flow.steps[i], flow.steps[j]] = [flow.steps[j], flow.steps[i]];
        drawSteps();
      }));
      row.querySelector('[data-rm]').onclick = () => { flow.steps.splice(i, 1); drawSteps(); };
      stepsEl.append(row);
    });
    if (!flow.steps.length) stepsEl.append(el('<div class="hint">No steps yet. Add one below.</div>'));
  };
  const syncColors = () => $$('.colors button', node).forEach((b) => b.classList.toggle('on', b.dataset.c === color));
  $$('.colors button', node).forEach((b) => (b.onclick = () => { color = b.dataset.c; syncColors(); }));
  $$('[data-add]', node).forEach((b) => (b.onclick = () => {
    flow.steps.push(NEW_STEP[b.dataset.add]());
    drawSteps();
    stepsEl.lastElementChild.querySelector('[data-f]')?.focus();
  }));
  node.querySelector('[data-x]').onclick = () => closeModal();
  node.querySelector('[data-del]')?.addEventListener('click', async () => {
    closeModal();
    if (await confirmDialog('Delete flow?', `“${flow.name}” will be removed.`)) { state.flows = state.flows.filter((x) => x.id !== flow.id); saveFlows(); }
  });
  node.onsubmit = async (e) => {
    e.preventDefault();
    const saved = { ...flow, id: flow.id || newId(), name: node.elements.name.value.trim(), color, steps: flow.steps.filter((s) => s.k !== 'type' || s.v || s.enter) };
    const i = state.flows.findIndex((x) => x.id === saved.id);
    if (i >= 0) state.flows[i] = saved; else state.flows.push(saved);
    closeModal();
    await saveFlows();
    if (e.submitter?.dataset.run !== undefined) runFlow(saved);
  };
  syncColors();
  drawSteps();
  openModal(node);
}

// ---------- status bar ----------
function renderStatus() {
  const sb = $('#statusbar');
  const tab = state.active;
  const parts = [];
  if (!tab) {
    parts.push(`<span class="sb">${icon('sparkle')}Ready</span>`);
  } else {
    if (tab.type === 'ssh') {
      const s = tab.session || tab.config;
      parts.push(`<span class="sb ${tab.status === 'connected' ? 'ok' : ''}">${icon('server')}${esc(sessionLabel(s))}</span>`);
    } else {
      parts.push(`<span class="sb">${icon('terminal')}${esc(tab.title)}</span>`);
    }
    parts.push(`<span class="sb">${tab.status === 'connected' ? 'Connected' : tab.status === 'connecting' ? 'Connecting…' : 'Disconnected — press Enter to restart'}</span>`);
    const st = tab.stats;
    if (st && tab.status === 'connected') {
      const cpu = Math.min(100, Math.round((st.load / st.cpus) * 100));
      const mem = st.memTotal ? Math.round((st.memUsed / st.memTotal) * 100) : 0;
      const disk = st.diskTotal ? Math.round((st.diskUsed / st.diskTotal) * 100) : 0;
      const bar = (v) => `<span class="mini ${v > 85 ? 'hot' : ''}"><i style="width:${v}%"></i></span>`;
      parts.push(`<span class="sb" title="Load average ${st.load} on ${st.cpus} cores">${icon('cpu')}${cpu}% ${bar(cpu)}</span>`);
      parts.push(`<span class="sb" title="${fmtBytes(st.memUsed)} of ${fmtBytes(st.memTotal)}">${icon('memory')}${mem}% ${bar(mem)}</span>`);
      parts.push(`<span class="sb" title="/ — ${fmtBytes(st.diskUsed)} of ${fmtBytes(st.diskTotal)}">${icon('disk')}${disk}% ${bar(disk)}</span>`);
      parts.push(`<span class="sb">${icon('clock')}${fmtUptime(st.uptime)}</span>`);
    }
  }
  parts.push('<span class="grow"></span>');
  if (state.recording) parts.push(`<span class="sb pill rec" data-rec title="Stop recording (Ctrl+Shift+R)"><i class="rec-dot"></i>REC ${state.recording.steps.length}</span>`);
  const run = tab && flowRuns.get(tab);
  if (run) parts.push(`<span class="sb pill run" data-run title="Click to stop">${icon('play')}${esc(run.flow.name)} ${run.step + 1}/${run.flow.steps.length}</span>`);
  if (state.multiExec) parts.push('<span class="sb pill">MULTI-EXEC</span>');
  if (tab) parts.push(`<span class="sb pill grep-pill ${tab.grep ? 'on' : ''}" data-grep title="Grep: filter this terminal's output (Ctrl+Shift+G)">${icon('filter')}Grep</span>`);
  if (tab) parts.push(`<span class="sb">${tab.term.cols}×${tab.term.rows}</span>`);
  parts.push('<span class="sb">UTF-8</span>');
  sb.innerHTML = parts.join('');
  sb.querySelector('[data-rec]')?.addEventListener('click', stopRecording);
  sb.querySelector('[data-run]')?.addEventListener('click', () => run.cancel());
  sb.querySelector('[data-grep]')?.addEventListener('click', () => (tab.grep ? closeGrep(tab) : openGrep(tab)));
}

function updateRail() {
  const btn = $('.rail-btn[data-panel="files"]');
  btn.querySelector('.badge')?.remove();
  if (sftpTab()) btn.append(el('<span class="badge"></span>'));
  const fbtn = $('.rail-btn[data-panel="flows"]');
  fbtn.querySelector('.badge')?.remove();
  if (state.recording) fbtn.append(el('<span class="badge rec"></span>'));
  $('#rail-grep').classList.toggle('on', !!state.active?.grep);
}

// ---------- welcome ----------
// Tilts a card toward the pointer and moves its glare highlight with it.
function tilt(card, max = 8) {
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    card.style.setProperty('--ry', ((x - 0.5) * max * 2).toFixed(2) + 'deg');
    card.style.setProperty('--rx', ((0.5 - y) * max * 2).toFixed(2) + 'deg');
    card.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
    card.style.setProperty('--my', (y * 100).toFixed(1) + '%');
  });
  card.addEventListener('pointerleave', () => { card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); });
  return card;
}

function renderWelcome() {
  const recent = [...state.sessions].filter((s) => s.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 6);
  const w = $('#welcome');
  w.innerHTML = `<div class="welcome-inner">
    <div class="hero"><img class="hero-logo" src="../assets/icon.svg" alt="" draggable="false"><div><h1>Welcome to <b>TermX</b></h1><p>Terminals, SSH and SFTP — in one fast, modern workspace.</p></div></div>
    <div class="section-label" style="margin-top:34px">Start</div>
    <div class="cards" data-start></div>
    ${recent.length ? '<div class="section-label" style="margin-top:28px">Recent sessions</div><div class="cards" data-recent></div>' : ''}
    <div class="section-label" style="margin-top:28px">Shortcuts</div>
    <div class="shortcuts">
      ${[['Command palette', 'Ctrl+Shift+P'], ['Search everything', 'Ctrl+Shift+S'], ['New terminal', 'Ctrl+Shift+T'], ['New SSH session', 'Ctrl+Shift+N'], ['Close pane', 'Ctrl+Shift+W'],
        ['Split right / down', 'Ctrl+Shift+D / E'], ['Move between panes', 'Alt+Arrows'],
        ['Next / previous tab', 'Ctrl+Tab'], ['Find in terminal', 'Ctrl+Shift+F'], ['Grep (filter output)', 'Ctrl+Shift+G'], ['Copy / paste', 'Ctrl+Shift+C / V'], ['Multi-exec', 'Ctrl+Shift+M'],
        ['Toggle sidebar', 'Ctrl+Shift+B'], ['Record a flow', 'Ctrl+Shift+R'], ['Zoom', 'Ctrl + = / − / 0']].map(([a, k]) => `<div><span>${a}</span><kbd>${k}</kbd></div>`).join('')}
    </div></div>`;
  const start = w.querySelector('[data-start]');
  const card = (cls, iconName, color, title, sub, onClick) => {
    const c = el(`<button class="card ${cls}"><div class="cicon" style="background:${color}">${icon(iconName)}</div><div><div class="ct">${esc(title)}</div><div class="cs">${esc(sub)}</div></div></button>`);
    c.onclick = onClick;
    return tilt(c);
  };
  start.append(card('primary', 'server', 'var(--grad)', 'New SSH session', 'Save a server', () => editSession()));
  if (!state.sessions.length) start.append(card('', 'download', '#3b82f6', 'Import connections', 'MobaXterm, PuTTY, OpenSSH', openImport));
  for (const sh of state.shells) start.append(card('', shellStyle(sh).icon, shellStyle(sh).color, sh.name, sh.kind === 'wsl' ? 'WSL distro' : 'Local shell', () => openLocal(sh.id)));
  const rec = w.querySelector('[data-recent]');
  for (const s of recent) {
    const initials = (s.name || s.host).replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();
    const c = el(`<button class="card"><div class="cicon" style="background:${s.color || COLORS[0]}"><b style="font-size:12px">${esc(initials)}</b></div><div><div class="ct">${esc(s.name)}</div><div class="cs">${esc(sessionLabel(s))}</div></div></button>`);
    c.onclick = () => openSsh(s);
    rec.append(tilt(c));
  }
}

// ---------- settings ----------
function applySettings() {
  applyTermBg();
  for (const t of state.tabs) {
    Object.assign(t.term.options, termOptions(t));
    if (t === state.active) fitTab(t);
  }
}

// Font family: a list of the installed monospace fonts, plus "Custom…" for a hand-written CSS font stack.
function setupFontPicker(root) {
  const pick = root.querySelector('[name=fontPick]');
  const custom = root.querySelector('[name=fontFamily]');
  const isDefault = !settings.fontFamily || settings.fontFamily === DEFAULTS.fontFamily;
  const current = firstFamily(settings.fontFamily);
  // A stack we wrote ourselves maps back to its font; anything else is a custom stack.
  const picked = !isDefault && settings.fontFamily === familyCss(current) ? current : null;
  const fill = (list) => {
    const fams = picked && !list.includes(picked) ? [picked, ...list] : list;
    pick.innerHTML = `<option value="">Default (${esc(firstFamily(DEFAULTS.fontFamily))})</option>`
      + fams.map((f) => `<option value="${esc(f)}" style="font-family:'${esc(f)}'">${esc(f)}</option>`).join('')
      + '<option value="__custom__">Custom…</option>';
    pick.value = isDefault ? '' : picked ?? '__custom__';
    custom.hidden = pick.value !== '__custom__';
  };
  fill(monoFonts || [picked || firstFamily(DEFAULTS.fontFamily)]);
  if (!monoFonts) loadMonoFonts().then((list) => { if (pick.isConnected) fill(list); });
  pick.onchange = () => {
    const v = pick.value;
    custom.hidden = v !== '__custom__';
    if (v === '__custom__') { if (!custom.value.trim()) custom.value = settings.fontFamily || DEFAULTS.fontFamily; custom.focus(); custom.select(); return; }
    settings.fontFamily = v ? familyCss(v) : DEFAULTS.fontFamily;
    custom.value = settings.fontFamily;
    saveSettings();
    applySettings();
  };
  custom.onchange = () => {
    let v = custom.value.trim().replace(/,\s*$/, '');
    if (!v) {
      // An empty custom font goes back to the default instead of leaving a blank box behind.
      settings.fontFamily = DEFAULTS.fontFamily;
      custom.value = settings.fontFamily;
      pick.value = '';
      custom.hidden = true;
    } else {
      // Without a generic family, a misspelt or missing font would fall back to a proportional font.
      if (!/\bmonospace\s*$/i.test(v)) v += ', monospace';
      settings.fontFamily = custom.value = v;
    }
    saveSettings();
    applySettings();
  };
}

function renderSettings() {
  const root = $('#settings');
  root.innerHTML = `
    <div class="section-label" style="margin-top:4px">Terminal theme</div>
    <div class="theme-grid">${Object.entries(TERMINAL_THEMES).map(([name, th]) => `
      <button class="theme-chip ${settings.theme === name ? 'on' : ''}" data-theme="${esc(name)}" style="background:${th.background};color:${th.foreground}">
        <div class="tn">${esc(name)}</div><div class="sw">${['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].map((c) => `<i style="background:${th[c]}"></i>`).join('')}</div></button>`).join('')}
    </div>
    <div class="section-label">Text</div>
    <div class="field"><label>Font size</label><div class="range-row"><input type="range" min="9" max="28" name="fontSize" value="${settings.fontSize}"><output>${settings.fontSize}</output></div></div>
    <div class="field"><label>Line height</label><div class="range-row"><input type="range" min="1" max="1.6" step="0.05" name="lineHeight" value="${settings.lineHeight}"><output>${settings.lineHeight}</output></div></div>
    <div class="field"><label>Font family</label>
      <select class="input" name="fontPick"></select>
      <input class="input font-custom" name="fontFamily" value="${esc(settings.fontFamily)}" spellcheck="false" placeholder="e.g. 'Fira Code', monospace" hidden></div>
    <div class="field"><span class="field-label">Cursor</span><div class="seg" data-cursor>
      ${['bar', 'block', 'underline'].map((c) => `<button type="button" data-v="${c}" class="${settings.cursorStyle === c ? 'on' : ''}">${c[0].toUpperCase() + c.slice(1)}</button>`).join('')}</div></div>
    <div class="section-label">Highlight colors</div>
    ${[['selectionColor', 'Selected text'], ['highlightColor', 'Search highlight']].map(([k, label]) => `
    <div class="field"><span class="field-label">${label}</span><div class="colors hl-colors" data-hl="${k}">
      ${COLORS.map((c) => `<button type="button" data-c="${c}" style="background:${c};color:${c}" class="${settings[k] === c ? 'on' : ''}" title="${c}"></button>`).join('')}
      <label class="custom-color ${COLORS.includes(settings[k]) ? '' : 'on'}" title="Custom color" style="color:${settings[k]}"><input type="color" value="${settings[k]}"></label>
    </div></div>`).join('')}
    <div class="hl-preview"><span style="background:${settings.selectionColor}70">selected text</span><span style="background:${settings.highlightColor};color:#0b0d12">search match</span></div>
    <div class="section-label">Behavior</div>
    ${[['cursorBlink', 'Blinking cursor'], ['copyOnSelect', 'Copy on select'], ['rightClickPaste', 'Right-click pastes (copies if selected)'], ['showHidden', 'Show hidden files in SFTP'], ['autoUpdateCheck', 'Check for updates on startup']]
      .map(([k, label]) => `<label class="toggle"><span>${label}</span><span class="switch"><input type="checkbox" name="${k}" ${settings[k] ? 'checked' : ''}><i></i></span></label>`).join('')}
    <div class="field" style="margin-top:12px"><label>Scrollback lines</label>
      <select class="input" name="scrollback">${[1000, 5000, 10000, 50000, 100000].map((n) => `<option value="${n}" ${settings.scrollback === n ? 'selected' : ''}>${n.toLocaleString()}</option>`).join('')}</select></div>
    <div class="field"><label>Default shell</label>
      <select class="input" name="defaultShell">${state.shells.map((s) => `<option value="${esc(s.id)}" ${defaultShell()?.id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div class="section-label">About</div>
    <div class="hint" style="color:var(--muted);font-size:11.5px">TermX ${esc(state.info.version || '')} · Electron · xterm.js · ssh2</div>
    <button class="btn" data-update style="margin-top:10px">${icon('upgrade')}<span>Check for updates</span></button>`;
  // Group each labelled section into its own card.
  let card = null;
  for (const n of [...root.children]) {
    if (n.classList.contains('section-label')) { card = el('<div class="set-card"></div>'); n.before(card); }
    if (card) card.append(n);
  }
  $$('.theme-chip', root).forEach((b) => (b.onclick = () => { settings.theme = b.dataset.theme; saveSettings(); applySettings(); renderSettings(); }));
  $$('[data-cursor] button', root).forEach((b) => (b.onclick = () => { settings.cursorStyle = b.dataset.v; saveSettings(); applySettings(); renderSettings(); }));
  $$('input[type=range]', root).forEach((r) => (r.oninput = () => {
    settings[r.name] = Number(r.value);
    r.nextElementSibling.textContent = r.value;
    saveSettings();
    applySettings();
  }));
  setupFontPicker(root);
  $$('input[type=checkbox]', root).forEach((c) => (c.onchange = () => {
    settings[c.name] = c.checked;
    saveSettings();
    applySettings();
    if (c.name === 'showHidden' && sftpTab()?.files) drawFiles(sftpTab());
  }));
  root.querySelector('[name=scrollback]').onchange = (e) => { settings.scrollback = Number(e.target.value); saveSettings(); applySettings(); };
  for (const row of $$('[data-hl]', root)) {
    const set = (c) => { settings[row.dataset.hl] = c.toLowerCase(); saveSettings(); applySettings(); renderSettings(); };
    $$('button', row).forEach((b) => (b.onclick = () => set(b.dataset.c)));
    row.querySelector('input[type=color]').onchange = (e) => set(e.target.value);
  }
  root.querySelector('[name=defaultShell]').onchange = (e) => { settings.defaultShell = e.target.value; saveSettings(); };
  root.querySelector('[data-update]').onclick = () => checkForUpdates();
}

function setFontSize(n) {
  settings.fontSize = Math.max(8, Math.min(32, n));
  saveSettings();
  applySettings();
  if (state.panel === 'settings') renderSettings();
}

// ---------- panels / layout ----------
function showPanel(name) {
  const sidebar = $('#sidebar');
  if (state.panel === name && !sidebar.classList.contains('collapsed')) {
    sidebar.classList.add('collapsed');
  } else {
    sidebar.classList.remove('collapsed');
    state.panel = name;
  }
  $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === state.panel && !sidebar.classList.contains('collapsed')));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === state.panel));
  if (state.panel === 'files') renderFiles(false);
  if (state.panel === 'settings') renderSettings();
  if (state.panel === 'flows') renderFlows();
  if (state.panel === 'search') renderSearch();
  if (state.active) fitTab(state.active);
}

function toggleSidebar() {
  const sidebar = $('#sidebar');
  sidebar.classList.toggle('collapsed');
  $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === state.panel && !sidebar.classList.contains('collapsed')));
  if (state.active) fitTab(state.active);
}

function setupResizer() {
  const handle = $('#sidebar-resizer');
  const apply = (w) => document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  apply(settings.sidebarW);
  handle.onmousedown = (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = $('#sidebar').offsetWidth;
    handle.classList.add('dragging');
    const move = (ev) => { settings.sidebarW = Math.max(200, Math.min(560, startW + ev.clientX - startX)); apply(settings.sidebarW); if (state.active) fitTab(state.active); };
    const up = () => { handle.classList.remove('dragging'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); saveSettings(); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  };
}

function toggleMultiExec() {
  state.multiExec = !state.multiExec;
  $('#btn-multiexec').classList.toggle('on', state.multiExec);
  state.tabs.forEach((t) => t.host.classList.toggle('multi', state.multiExec));
  renderStatus();
  toast(state.multiExec ? 'Multi-exec on — keystrokes go to every connected tab' : 'Multi-exec off');
}

// ---------- command palette ----------
function paletteItems() {
  const items = [
    { label: 'New SSH session…', icon: 'plus', kbd: 'Ctrl+Shift+N', run: () => editSession() },
    { label: 'New terminal (default shell)', icon: 'terminal', kbd: 'Ctrl+Shift+T', run: () => openLocal() },
    { label: 'Toggle multi-exec', icon: 'broadcast', kbd: 'Ctrl+Shift+M', run: toggleMultiExec },
    { label: 'Toggle sidebar', icon: 'server', kbd: 'Ctrl+Shift+B', run: toggleSidebar },
    { label: 'Open SFTP browser', icon: 'folder', run: () => { state.panel = ''; showPanel('files'); } },
    { label: 'Open settings', icon: 'settings', run: () => { state.panel = ''; showPanel('settings'); } },
    { label: state.recording ? 'Stop recording flow' : 'Record a flow', icon: state.recording ? 'stop' : 'record', kbd: 'Ctrl+Shift+R', run: toggleRecording },
    { label: 'New flow…', icon: 'workflow', run: () => editFlow() },
    { label: 'Import connections…', icon: 'download', sub: 'MobaXterm, PuTTY, OpenSSH', run: openImport },
    { label: 'Export sessions…', icon: 'upload', run: exportSessions },
    state.active ? { label: 'Split right', icon: 'columns', kbd: 'Ctrl+Shift+D', run: () => splitPane('row') } : null,
    state.active ? { label: 'Split down', icon: 'rows', kbd: 'Ctrl+Shift+E', run: () => splitPane('col') } : null,
    { label: 'Search everything', icon: 'search', kbd: 'Ctrl+Shift+S', run: openSearch },
    state.active ? { label: 'Grep: filter output', icon: 'filter', kbd: 'Ctrl+Shift+G', run: () => toggleGrep(state.active) } : null,
    state.active ? { label: 'Find in terminal', icon: 'search', kbd: 'Ctrl+Shift+F', run: () => openFind(state.active) } : null,
    state.active ? { label: 'Clear terminal', icon: 'trash', run: () => state.active.term.clear() } : null,
    state.active ? { label: 'Close pane', icon: 'x', kbd: 'Ctrl+Shift+W', run: () => closeTab(state.active) } : null,
    { label: 'Toggle developer tools', icon: 'fileCode', kbd: 'F12', run: () => api.devtools() },
  ].filter(Boolean);
  for (const sh of state.shells) items.push({ label: `Open ${sh.name}`, icon: shellStyle(sh).icon, sub: 'local', run: () => openLocal(sh.id) });
  for (const s of state.sessions) items.push({ label: `Connect: ${s.name}`, icon: 'server', sub: sessionLabel(s), run: () => openSsh(s) });
  for (const f of state.flows) items.push({ label: `Run flow: ${f.name}`, icon: 'workflow', sub: flowSummary(f), run: () => runFlow(f) });
  for (const t of state.tabs) items.push({ label: `Switch to: ${t.title}`, icon: 'chevronRight', run: () => activate(t) });
  for (const name of Object.keys(TERMINAL_THEMES)) items.push({ label: `Theme: ${name}`, icon: 'sparkle', run: () => { settings.theme = name; saveSettings(); applySettings(); if (state.panel === 'settings') renderSettings(); } });
  return items;
}

function fuzzy(q, text) {
  q = q.toLowerCase(); text = text.toLowerCase();
  if (!q) return 1;
  const i = text.indexOf(q);
  if (i >= 0) return 100 - i;
  let ti = 0, score = 0;
  for (const ch of q) {
    const f = text.indexOf(ch, ti);
    if (f < 0) return 0;
    score += f === ti ? 2 : 1;
    ti = f + 1;
  }
  return score;
}

function openPalette() {
  const all = paletteItems();
  let sel = 0, shown = all;
  const node = el(`<div class="modal palette"><div class="pinput">${icon('search')}<input placeholder="Type a command, session or shell…" autofocus spellcheck="false"></div><div class="plist"></div></div>`);
  const input = node.querySelector('input');
  const list = node.querySelector('.plist');
  const draw = () => {
    list.innerHTML = '';
    shown.forEach((it, i) => {
      const r = el(`<div class="pitem ${i === sel ? 'on' : ''}">${icon(it.icon)}<span>${esc(it.label)}</span>${it.sub ? `<span class="ps">${esc(it.sub)}</span>` : ''}${it.kbd ? `<span class="pk">${esc(it.kbd)}</span>` : ''}</div>`);
      r.onmousemove = () => { if (sel !== i) { sel = i; draw(); } };
      r.onclick = () => { closeModal(); it.run(); };
      list.append(r);
    });
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  input.oninput = () => {
    shown = all.map((it) => [it, fuzzy(input.value, it.label + ' ' + (it.sub || ''))]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([it]) => it);
    sel = 0;
    draw();
  };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    if (e.key === 'Enter' && shown[sel]) { const it = shown[sel]; closeModal(); it.run(); }
  };
  draw();
  openModal(node);
}

// ---------- keyboard ----------
function handleShortcut(e, fromTerm) {
  if (e.type !== 'keydown') {
    // Swallow keypress/keyup of shortcut combos inside xterm too.
    return fromTerm && e.ctrlKey && e.shiftKey && /^[TWCVFNPMBDERSG]$/i.test(e.key);
  }
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const tab = state.active;
  const groups = state.groups;
  const run = (fn) => { e.preventDefault(); fn(); return true; };
  if (k === 'F12') return run(() => api.devtools());
  if (e.ctrlKey && k === 'Tab' && groups.length) {
    return run(() => {
      const i = groups.indexOf(state.activeGroup);
      activate(groups[(i + (e.shiftKey ? -1 : 1) + groups.length) % groups.length].activePane);
    });
  }
  if (e.altKey && !e.ctrlKey && /^[1-9]$/.test(k) && groups.length) {
    const g = k === '9' ? groups[groups.length - 1] : groups[Number(k) - 1];
    if (g) return run(() => activate(g.activePane));
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (e.altKey && !e.ctrlKey && !e.shiftKey && arrows[k] && state.activeGroup?.root.dir) {
    if (focusPane(...arrows[k])) { e.preventDefault(); return true; }
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (k === '=' || k === '+')) return run(() => setFontSize(settings.fontSize + 1));
  if (e.ctrlKey && !e.shiftKey && !e.altKey && k === '-') return run(() => setFontSize(settings.fontSize - 1));
  if (e.ctrlKey && !e.shiftKey && !e.altKey && k === '0') return run(() => setFontSize(DEFAULTS.fontSize));
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    switch (k) {
      case 'T': return run(() => openLocal());
      case 'D': return run(() => splitPane('row'));
      case 'E': return run(() => splitPane('col'));
      case 'W': return run(() => closeTab(tab));
      case 'N': return run(() => editSession());
      case 'P': return run(openPalette);
      case 'M': return run(toggleMultiExec);
      case 'B': return run(toggleSidebar);
      case 'R': return run(toggleRecording);
      case 'F': return run(() => openFind(tab));
      case 'S': return run(openSearch);
      case 'G': return run(() => toggleGrep(tab));
      case 'C': return run(() => tab && copySel(tab));
      case 'V': return run(() => tab && paste(tab));
    }
  }
  return false;
}

// ---------- updates ----------
let updateInfo = null;
let updating = false;
async function checkForUpdates({ quiet = false } = {}) {
  if (updating) return toast('The update is already downloading');
  const btn = $('#btn-update');
  btn.classList.add('busy');
  try {
    updateInfo = await api.update.check();
  } catch (err) {
    if (!quiet) toast('Could not check for updates: ' + cleanErr(err), 'err');
    return;
  } finally {
    btn.classList.remove('busy');
  }
  btn.classList.toggle('has-update', updateInfo.available);
  btn.title = updateInfo.available ? `Update to TermX ${updateInfo.latest}` : 'Check for updates';
  if (!updateInfo.available) { if (!quiet) toast(`You're on the latest version (${updateInfo.current})`); return; }
  if (quiet) toast(`TermX ${updateInfo.latest} is available. Click the update button to install it.`);
  else openUpdate();
}

function openUpdate() {
  if (updating) return toast('The update is already downloading');
  const u = updateInfo;
  // Builds run from source, or a release missing this platform's file, can only point at the release page.
  const auto = u.kind !== 'source' && u.asset;
  const node = el(`<div class="modal sm update-modal">
    <div class="modal-head"><div><h3>TermX ${esc(u.latest)} is available</h3><div class="sub">You have ${esc(u.current)}.${auto && state.tabs.length ? ' Open terminals will close when TermX restarts.' : ''}</div></div></div>
    <div class="modal-body">
      <div class="bar hidden"><i style="width:0"></i></div>
      <div class="status">${auto ? `Downloads ${esc(u.asset.name)} (${fmtBytes(u.asset.size)}), installs it and restarts TermX.` : u.kind === 'source' ? 'TermX is running from source. Pull the latest code to update.' : 'This release has no installer for your system yet.'}</div>
    </div>
    <div class="modal-foot"><button class="btn left" data-page>Release page</button><button class="btn" data-x>Later</button>${auto ? '<button class="btn primary" data-go autofocus>Update now</button>' : ''}</div></div>`);
  const status = node.querySelector('.status');
  const bar = node.querySelector('.bar');
  node.querySelector('[data-page]').onclick = () => api.openExternal(u.page);
  node.querySelector('[data-x]').onclick = () => closeModal();
  const go = node.querySelector('[data-go]');
  if (go) go.onclick = async () => {
    updating = true;
    go.disabled = true;
    go.textContent = 'Updating…';
    bar.classList.remove('hidden');
    const off = api.on('update:progress', (got, total) => {
      bar.firstElementChild.style.width = (total ? Math.min(100, (got / total) * 100) : 0) + '%';
      status.textContent = got >= total ? 'Installing… TermX will restart.' : `Downloading ${fmtBytes(got)} of ${fmtBytes(total)}`;
    });
    try {
      const r = await api.update.install();
      if (r.manual) { closeModal(); toast('The installer has opened. Finish the update there.'); }
      else status.textContent = 'Installing… TermX will restart.';
    } catch (err) {
      updating = false;
      status.textContent = cleanErr(err);
      bar.classList.add('hidden');
      go.disabled = false;
      go.textContent = 'Try again';
    } finally {
      off();
    }
  };
  openModal(node);
}

// ---------- init ----------
async function init() {
  hydrateIcons();
  applyTermBg();
  setupResizer();
  setupFilesPanel();
  setupSearchPanel();
  $('#grep-history').innerHTML = (settings.grepHistory || []).map((x) => `<option value="${esc(x)}">`).join('');
  [state.info, state.shells] = await Promise.all([api.info(), api.shells()]);
  document.body.classList.add('platform-' + state.info.platform);
  await Promise.all([refreshSessions(), refreshFlows()]);
  renderSettings();
  renderStatus();
  renderWelcome();

  api.on('term:data', (id, data) => {
    const tab = byTermId.get(id);
    if (tab) {
      writeOut(tab, id, data);
      if (tab.flowOut !== undefined) tab.flowOut = (tab.flowOut + data.replace(ANSI, '')).slice(-8192);
      if (search.q && state.panel === 'search') scheduleSearch();
    } else pendingData.set(id, (pendingData.get(id) || '') + data);
  });
  api.on('term:exit', (id, code) => {
    const tab = byTermId.get(id);
    if (!tab) return;
    byTermId.delete(id);
    unackedDrawn.delete(id);
    tab.termId = null;
    tab.stats = null;
    tab.term.write(`\r\n\x1b[2m${tab.type === 'ssh' ? 'Connection closed' : `Process exited with code ${code}`}. Press Enter to ${tab.type === 'ssh' ? 'reconnect' : 'restart'}.\x1b[0m\r\n`);
    setStatus(tab, 'closed');
    if (state.panel === 'files' && state.active === tab) renderFiles(false);
  });
  api.on('ssh:stats', (id, stats) => {
    const tab = byTermId.get(id);
    if (!tab) return;
    tab.stats = stats;
    if (tab === state.active) renderStatus();
  });
  api.on('sftp:progress', onProgress);
  api.on('sftp:synced', (r) => toast(r.ok ? `Saved ${r.remote.split('/').pop()} to server` : `Upload failed: ${r.error}`, r.ok ? 'ok' : 'err'));

  addEventListener('keydown', (e) => {
    if ($('#modal-root').classList.contains('hidden') && !e.target.closest?.('.xterm')) handleShortcut(e, false);
  });
  $$('.rail-btn[data-panel]').forEach((b) => (b.onclick = () => showPanel(b.dataset.panel)));
  $('#rail-grep').onclick = () => (state.active ? toggleGrepButton(state.active) : toast('Open a terminal first, then Grep filters its output', 'err'));
  $('#btn-new-session').onclick = () => editSession();
  $('#btn-import').onclick = openImport;
  $('#btn-new-folder').onclick = () => newFolder('');
  $('#btn-record-flow').onclick = toggleRecording;
  $('#btn-new-flow').onclick = () => editFlow();
  $('#btn-new-tab').onclick = () => openLocal();
  $('#btn-shell-menu').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const from = state.active;
    showMenu(r.left, r.bottom + 4, [
      ...state.shells.map((sh) => ({ label: sh.name, icon: shellStyle(sh).icon, action: () => openLocal(sh.id) })),
      ...(from ? ['-', ...state.shells.map((sh) => ({ label: `Split right: ${sh.name}`, icon: 'columns', action: () => openLocal(sh.id, { from, dir: 'row' }) }))] : []),
      '-',
      { label: 'New SSH session…', icon: 'server', action: () => editSession() },
    ]);
  };
  $('#btn-palette').onclick = openPalette;
  $('#btn-multiexec').onclick = toggleMultiExec;
  $('#btn-update').onclick = () => (updateInfo?.available ? openUpdate() : checkForUpdates());
  // Coming back to the window (after the host-key prompt, or another app) puts the cursor back in
  // the active terminal, unless a dialog or another field is holding focus.
  addEventListener('focus', () => setTimeout(() => {
    const a = document.activeElement;
    if (state.active && (!a || a === document.body) && $('#modal-root').classList.contains('hidden')) state.active.term.focus();
  }));
  if (settings.autoUpdateCheck) setTimeout(() => checkForUpdates({ quiet: true }), 4000);
  $('#session-filter').oninput = renderSessions;
  $('#quick-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#quick-input').value;
    if (!v.trim()) return;
    $('#quick-input').value = '';
    quickConnect(v);
  };
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => e.preventDefault());
}

init();
