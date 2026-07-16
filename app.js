'use strict';

/* ============================================================
   Checkpoint — local-first productivity checklist
   Data lives in IndexedDB in your browser. No server, no account.
   ============================================================ */

/* ---------- IndexedDB helpers ---------- */

const DB_NAME = 'checkpoint-db';
const DB_VERSION = 2;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('tasks')) d.createObjectStore('tasks', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('backlog')) d.createObjectStore('backlog', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('misc')) d.createObjectStore('misc', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbAll(store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).put(value);
    // every task/backlog change flows to the sync file (if connected)
    // and is announced to other open windows (widget <-> main app)
    t.oncomplete = () => { if (store !== 'misc') { scheduleSync(); broadcastChange(); } resolve(); };
    t.onerror = () => reject(t.error);
  });
}

function idbDelete(store, id) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).delete(id);
    t.oncomplete = () => { if (store !== 'misc') { scheduleSync(); broadcastChange(); } resolve(); };
    t.onerror = () => reject(t.error);
  });
}

/* ---------- Period logic (this is what makes tasks "reset") ----------
   A task is never actually un-checked by a timer. Instead each task keeps
   a map of period-keys it was completed in (e.g. "2026-07-15" for daily,
   "W2026-07-13" for the week starting Mon Jul 13, "2026-07" for monthly).
   A task shows as done only if the CURRENT period's key is in that map,
   so it automatically appears unchecked again when the day/week/month
   rolls over. Weeks start on Monday. */

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function periodKey(recurrence, d) {
  if (recurrence === 'daily') return fmtDate(d);
  if (recurrence === 'weekly') return 'W' + fmtDate(mondayOf(d));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function prevPeriodDate(recurrence, d) {
  if (recurrence === 'daily') return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  if (recurrence === 'weekly') return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7);
  return new Date(d.getFullYear(), d.getMonth() - 1, 1);
}

function computeStreak(task, now) {
  let d = new Date(now);
  if (!task.done[periodKey(task.recurrence, d)]) {
    d = prevPeriodDate(task.recurrence, d);
  }
  let streak = 0;
  while (task.done[periodKey(task.recurrence, d)]) {
    streak++;
    d = prevPeriodDate(task.recurrence, d);
  }
  return streak;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function periodLabel(recurrence, d) {
  if (recurrence === 'daily') return 'Today';
  if (recurrence === 'weekly') {
    const mon = mondayOf(d);
    return `Week of ${MONTHS[mon.getMonth()].slice(0, 3)} ${mon.getDate()}`;
  }
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/* ---------- State ---------- */

let tasks = [];
let backlog = [];
let activeTab = 'daily';
let typeFilter = 'all';
let statusFilter = 'all';

const STATUS_ORDER = { inprogress: 0, backlog: 1, done: 2 };
const STATUS_LABEL = { backlog: 'Backlog', inprogress: 'In progress', done: 'Done ✓' };
const STATUS_NEXT = { backlog: 'inprogress', inprogress: 'done', done: 'backlog' };
const TYPE_LABEL = { tv: '📺 TV', movie: '🎬 Movie', game: '🎮 Game', music: '🎵 Music' };
const RECURRENCE_LABEL = { daily: 'resets daily', weekly: 'resets weekly', monthly: 'resets monthly' };

/* Each task gets a stable pastel tile color derived from its id */
const TILE_COLORS = ['tile-lavender', 'tile-salmon', 'tile-yellow', 'tile-orange', 'tile-green', 'tile-teal'];

function tileColor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILE_COLORS[h % TILE_COLORS.length];
}

/* ---------- Settings ---------- */

const SETTINGS_KEY = 'checkpoint-settings';
const settings = { tabPosition: 'top', bgSharpen: true, customTabs: [], clockFont: 'default' };

const CLOCK_FONTS = {
  default: '"Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'Consolas, "Courier New", monospace',
  script: '"Segoe Script", "Comic Sans MS", cursive',
  impact: 'Impact, "Arial Black", sans-serif',
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch (e) { /* corrupt settings — fall back to defaults */ }

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  scheduleSync();
  broadcastChange();
}

function applySettings() {
  document.body.classList.toggle('tabs-bottom', settings.tabPosition === 'bottom');
  document.querySelectorAll('#tabpos-toggle .seg').forEach((b) => {
    b.classList.toggle('active', b.dataset.pos === settings.tabPosition);
  });
  document.body.classList.toggle('bg-sharpen', Boolean(settings.bgSharpen));
  document.querySelectorAll('#sharpen-toggle .seg').forEach((b) => {
    b.classList.toggle('active', (b.dataset.sharpen === 'on') === Boolean(settings.bgSharpen));
  });
  $('#clock').style.fontFamily = CLOCK_FONTS[settings.clockFont] || CLOCK_FONTS.default;
  $('#clock-font').value = CLOCK_FONTS[settings.clockFont] ? settings.clockFont : 'default';
}

/* ---------- Tab helpers ----------
   Tasks store the tab they live in separately from their recurrence,
   so custom tabs can hold a mix of one-time/daily/weekly/monthly tasks.
   Older tasks predate the tab field and fall back to their recurrence. */

const taskTab = (t) => t.tab || t.recurrence;
const customTab = (id) => settings.customTabs.find((t) => t.id === id);
const isTaskTab = (tab) => ['daily', 'weekly', 'monthly'].includes(tab) || Boolean(customTab(tab));

/* ---------- Custom background & adaptive theme ----------
   The image is downscaled onto a canvas and sampled: the average color
   sets the hue that tints every surface, and the most vibrant pixel
   becomes the accent. Surfaces switch to translucent dark glass so
   they blend with any image while text stays high-contrast. */

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

function extractTheme(img) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  let vibrant = null, vibrantScore = 0;

  for (let i = 0; i < data.length; i += 16) {
    if (data[i + 3] < 200) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    rSum += r; gSum += g; bSum += b; count++;
    const [h, s, l] = rgbToHsl(r, g, b);
    const score = s * (1 - Math.abs(l - 0.5) * 2);
    if (score > vibrantScore) { vibrantScore = score; vibrant = [h, s]; }
  }

  if (!count) return null;
  const [hue] = rgbToHsl(rSum / count, gSum / count, bSum / count);
  const accent = vibrantScore > 0.15 ? vibrant : [hue, 0.55];
  return { hue, accent };
}

const THEME_VARS = ['--bg', '--surface', '--surface-2', '--border', '--text', '--text-dim', '--accent', '--accent-soft'];

function applyThemeVars(theme) {
  if (!theme) return;
  const s = document.documentElement.style;
  const H = Math.round(theme.hue);
  const A = Math.round(theme.accent[0]);
  const AS = Math.round(Math.max(theme.accent[1], 0.45) * 100);
  s.setProperty('--bg', `hsl(${H}, 28%, 10%)`);
  s.setProperty('--surface', `hsla(${H}, 30%, 13%, 0.8)`);
  s.setProperty('--surface-2', `hsla(${H}, 28%, 22%, 0.85)`);
  s.setProperty('--border', `hsla(${H}, 35%, 60%, 0.35)`);
  s.setProperty('--text', '#f2f3fa');
  s.setProperty('--text-dim', `hsl(${H}, 20%, 80%)`);
  s.setProperty('--accent', `hsl(${A}, ${AS}%, 62%)`);
  s.setProperty('--accent-soft', `hsla(${A}, ${AS}%, 62%, 0.22)`);
}

let bgUrl = null;

function applyBackground(blob) {
  if (bgUrl) { URL.revokeObjectURL(bgUrl); bgUrl = null; }
  $('#bg-remove').hidden = !blob;

  if (!blob) {
    document.body.classList.remove('custom-bg');
    $('#bg-layer').style.backgroundImage = '';
    THEME_VARS.forEach((v) => document.documentElement.style.removeProperty(v));
    return;
  }

  bgUrl = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => applyThemeVars(extractTheme(img));
  img.src = bgUrl;
  $('#bg-layer').style.backgroundImage = `url("${bgUrl}")`;
  document.body.classList.add('custom-bg');
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ---------- DOM helpers ---------- */

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------- Rendering: recurring tasks ---------- */

function renderTasks() {
  const now = new Date();
  const list = $('#task-list');
  list.replaceChildren();

  // One-time tasks complete under the fixed key 'once' instead of a
  // period key, so they never reset when the day/week/month rolls over.
  const doneIn = (t) => Boolean(t.done[t.once ? 'once' : periodKey(t.recurrence, now)]);

  const visible = tasks
    .filter((t) => taskTab(t) === activeTab)
    .sort((a, b) => (doneIn(a) - doneIn(b)) || a.createdAt - b.createdAt);

  const doneCount = visible.filter(doneIn).length;
  $('#progress-label').textContent = visible.length
    ? `${doneCount} of ${visible.length} done`
    : 'No tasks yet';
  const custom = customTab(activeTab);
  $('#period-label').textContent = custom ? custom.name : periodLabel(activeTab, now);
  $('#progress-bar').style.width = visible.length
    ? `${Math.round((doneCount / visible.length) * 100)}%`
    : '0%';

  const empty = $('#tasks-empty');
  empty.hidden = visible.length > 0;
  empty.textContent = custom
    ? 'No tasks yet — add one above. Each task can be one-time or repeat daily, weekly, or monthly.'
    : `No ${activeTab} tasks yet — add one above. It will reset automatically each ${
        { daily: 'day', weekly: 'week', monthly: 'month' }[activeTab]
      }.`;

  for (const task of visible) {
    const isDone = doneIn(task);
    const li = el('li', `tile ${tileColor(task.id)}` + (isDone ? ' done' : ''));

    const main = el('button', 'tile-main');
    main.type = 'button';
    main.title = isDone ? 'Mark as not done' : 'Mark as done';
    main.addEventListener('click', () => toggleTask(task));

    const title = el('span', 'tile-title', task.title);
    let subText;
    if (task.once) {
      subText = isDone ? '📌 done' : '📌 one-time';
    } else {
      const streak = computeStreak(task, now);
      subText = (streak >= 2 ? `🔥 ${streak} · ` : '') + RECURRENCE_LABEL[task.recurrence];
    }
    const sub = el('span', 'tile-sub', subText);
    main.append(el('span', 'tile-check', isDone ? '✓' : ''), title, sub);
    li.append(main);

    const delBtn = el('button', 'btn-delete', '✕');
    delBtn.type = 'button';
    delBtn.title = 'Delete task';
    delBtn.addEventListener('click', () => deleteTask(task));
    li.append(delBtn);

    list.append(li);
  }

  renderStats();
}

async function toggleTask(task) {
  const key = task.once ? 'once' : periodKey(task.recurrence, new Date());
  if (task.done[key]) delete task.done[key];
  else task.done[key] = true;
  await idbPut('tasks', task);
  renderTasks();
}

async function deleteTask(task) {
  if (!confirm(`Delete "${task.title}"? Its history goes with it.`)) return;
  tasks = tasks.filter((t) => t.id !== task.id);
  await idbDelete('tasks', task.id);
  renderTasks();
}

/* ---------- Rendering: media backlog ---------- */

function renderBacklog() {
  const list = $('#backlog-list');
  list.replaceChildren();

  const visible = backlog
    .filter((b) => typeFilter === 'all' || b.type === typeFilter)
    .filter((b) => statusFilter === 'all' || b.status === statusFilter)
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.addedAt - b.addedAt);

  const empty = $('#backlog-empty');
  empty.hidden = visible.length > 0;
  empty.textContent = backlog.length
    ? 'Nothing matches these filters.'
    : 'Your backlog is empty — add the shows, movies, and games you want to get around to.';

  for (const item of visible) {
    const li = el('li', 'item backlog-item' + (item.status === 'done' ? ' done' : ''));

    const info = el('div', 'backlog-info');
    info.append(el('span', 'item-title', item.title));
    info.append(el('span', `type-badge type-${item.type}`, TYPE_LABEL[item.type]));
    li.append(info);

    const statusBtn = el('button', `status-pill status-${item.status}`, STATUS_LABEL[item.status]);
    statusBtn.title = 'Click to change status';
    statusBtn.addEventListener('click', () => cycleStatus(item));
    li.append(statusBtn);

    const delBtn = el('button', 'btn-delete', '✕');
    delBtn.title = 'Remove from backlog';
    delBtn.addEventListener('click', () => deleteBacklogItem(item));
    li.append(delBtn);

    list.append(li);
  }

  renderStats();
}

async function cycleStatus(item) {
  item.status = STATUS_NEXT[item.status];
  item.finishedAt = item.status === 'done' ? Date.now() : null;
  await idbPut('backlog', item);
  renderBacklog();
}

async function deleteBacklogItem(item) {
  if (!confirm(`Remove "${item.title}" from your backlog?`)) return;
  backlog = backlog.filter((b) => b.id !== item.id);
  await idbDelete('backlog', item.id);
  renderBacklog();
}

/* ---------- Footer stats ---------- */

function renderStats() {
  const finished = backlog.filter((b) => b.status === 'done').length;
  const parts = [`${tasks.length} recurring task${tasks.length === 1 ? '' : 's'}`];
  if (backlog.length) parts.push(`${finished}/${backlog.length} backlog items finished`);
  $('#stats-label').textContent = parts.join(' · ');
}

/* ---------- Tabs & filters ---------- */

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('#tabs .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  const taskTabActive = isTaskTab(tab);
  $('#tasks-panel').hidden = !taskTabActive;
  $('#backlog-panel').hidden = tab !== 'backlog';
  $('#settings-panel').hidden = tab !== 'settings';
  if (taskTabActive) {
    populateRepeatSelect(tab);
    renderTasks();
  } else if (tab === 'backlog') {
    renderBacklog();
  }
}

/* Built-in tabs offer "repeats <tab>" or one-time; custom tabs let
   each task pick its own cadence. */
function populateRepeatSelect(tab) {
  const sel = $('#task-repeat');
  sel.replaceChildren();
  const opt = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.append(o);
  };
  if (customTab(tab)) {
    opt('once', '📌 One-time');
    opt('daily', '🔁 Daily');
    opt('weekly', '🔁 Weekly');
    opt('monthly', '🔁 Monthly');
  } else {
    opt('repeat', `🔁 Repeats ${tab}`);
    opt('once', '📌 One-time');
  }
}

/* ---------- Custom tab management ---------- */

function renderNav() {
  document.querySelectorAll('#tabs .tab.custom').forEach((b) => b.remove());
  const settingsBtn = document.querySelector('#tabs .tab[data-tab="settings"]');
  for (const t of settings.customTabs) {
    const b = el('button', 'tab custom');
    b.type = 'button';
    b.dataset.tab = t.id;
    b.title = t.name;
    b.append(el('span', 'tab-icon', t.icon), el('span', '', t.name));
    settingsBtn.before(b);
  }
  document.querySelectorAll('#tabs .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === activeTab);
  });
}

function renderCustomTabList() {
  const ul = $('#custom-tab-list');
  ul.replaceChildren();
  for (const t of settings.customTabs) {
    const li = el('li', 'custom-tab-row');
    li.append(el('span', '', `${t.icon} ${t.name}`));
    const del = el('button', 'btn-delete', '✕');
    del.type = 'button';
    del.title = 'Delete this tab and its tasks';
    del.addEventListener('click', () => deleteCustomTab(t));
    li.append(del);
    ul.append(li);
  }
  ul.hidden = !settings.customTabs.length;
}

function addCustomTab() {
  const name = (prompt('Name for the new tab:') || '').trim().slice(0, 20);
  if (!name) return;
  const icon = ((prompt('Emoji icon for the tab (optional):') || '').trim() || '📝').slice(0, 4);
  const tab = { id: 'custom-' + uid(), name, icon };
  settings.customTabs.push(tab);
  saveSettings();
  renderNav();
  renderCustomTabList();
  switchTab(tab.id);
}

async function deleteCustomTab(tab) {
  const owned = tasks.filter((t) => t.tab === tab.id);
  const suffix = owned.length ? ` and its ${owned.length} task${owned.length === 1 ? '' : 's'}` : '';
  if (!confirm(`Delete the "${tab.name}" tab${suffix}?`)) return;
  for (const t of owned) await idbDelete('tasks', t.id);
  tasks = tasks.filter((t) => t.tab !== tab.id);
  settings.customTabs = settings.customTabs.filter((t) => t.id !== tab.id);
  saveSettings();
  renderNav();
  renderCustomTabList();
  if (activeTab === tab.id) switchTab('daily');
}

/* ---------- Cross-browser sync file ----------
   IndexedDB is separate per browser, so Edge and Chrome each keep their
   own copy of the data. Connecting a sync file (File System Access API)
   makes one JSON file on disk the shared source of truth: every change
   is written to it, and it is re-read at startup and whenever the window
   regains focus. Point each browser at the same file to keep them in
   sync. Last writer wins if two are open at once. */

let syncHandle = null;
let syncTimer = null;
let syncFileModified = 0; // last known mtime of the sync file

function snapshotObj() {
  return { app: 'checkpoint', savedAt: Date.now(), tasks, backlog, settings };
}

function snapshot() {
  return JSON.stringify(snapshotObj(), null, 2);
}

/* ---------- Server sync (when hosted as a web app) ----------
   Opened over http(s) — i.e. served by server.js — the server's
   /api/data endpoint is the shared source of truth for every device.
   Changes are PUT to it (debounced), and it is polled for newer data.
   Opened from file://, none of this runs and the file-based sync
   below works exactly as before. */

const SERVER_MODE = location.protocol === 'http:' || location.protocol === 'https:';
let serverToken = localStorage.getItem('checkpoint-token') || '';
let serverOk = true;
let serverNeedsAuth = false;
let serverPushPending = false;
// persisted so a restart doesn't mistake old server data for fresh changes
let serverSavedAt = Number(localStorage.getItem('checkpoint-server-savedat')) || 0;

function authHeaders() {
  return serverToken ? { Authorization: 'Bearer ' + serverToken } : {};
}

function rememberServerSavedAt(t) {
  serverSavedAt = t;
  try { localStorage.setItem('checkpoint-server-savedat', String(t)); } catch (e) {}
}

function setServerState(ok, needsAuth) {
  serverOk = ok;
  serverNeedsAuth = Boolean(needsAuth);
  if (ok) {
    $('#sync-banner').hidden = true;
  } else if (!bannerDismissed) {
    $('#sync-banner-text').textContent = needsAuth
      ? 'This server requires a passcode — click Reconnect to enter it.'
      : "Can't reach the server — changes are saved on this device and will sync when it's back.";
    $('#sync-banner').hidden = false;
  }
  $('#sync-status').textContent = ok
    ? 'Synced with this server — open this address on any device'
    : (needsAuth ? 'Passcode needed — click Reconnect in the banner' : 'Server unreachable — working offline');
}

async function serverPush() {
  const body = snapshotObj();
  try {
    const res = await fetch('api/data', {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(body),
    });
    if (res.status === 401) { serverPushPending = true; return setServerState(false, true); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    rememberServerSavedAt(body.savedAt);
    serverPushPending = false;
    setServerState(true);
  } catch (e) {
    serverPushPending = true; // retried by the poll once the server is back
    setServerState(false);
  }
}

/* Returns 'adopted' | 'current' | 'empty' | 'error' */
async function serverPull() {
  try {
    const res = await fetch('api/data', { headers: authHeaders(), cache: 'no-store' });
    if (res.status === 401) { setServerState(false, true); return 'error'; }
    if (res.status === 404) { setServerState(true); return 'empty'; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    setServerState(true);
    if (data && data.savedAt && data.savedAt > serverSavedAt) {
      rememberServerSavedAt(data.savedAt);
      if (await adoptData(data)) return 'adopted';
    }
    return 'current';
  } catch (e) {
    setServerState(false);
    return 'error';
  }
}

/* Debounced "something changed" hook: pushes to the server when hosted,
   or writes the sync file when running from disk. */
function scheduleSync() {
  clearTimeout(syncTimer);
  if (SERVER_MODE) {
    syncTimer = setTimeout(serverPush, 400);
    return;
  }
  if (!syncHandle) return;
  syncTimer = setTimeout(writeSyncFile, 400);
}

/* Probe whether the sync file is actually writable by opening (and
   immediately aborting) a write stream — the file is never modified.
   Needed because queryPermission can under-report on file:// pages,
   claiming "prompt" while real access still works. Cached for 30s
   since the poll would otherwise hit the disk every tick. */
let syncProbe = { t: 0, ok: false };

async function syncUsable() {
  if (!syncHandle) return false;
  const now = Date.now();
  if (now - syncProbe.t < 30000) return syncProbe.ok;
  let ok = false;
  try {
    const w = await syncHandle.createWritable({ keepExistingData: true });
    await w.abort();
    ok = true;
  } catch (e) { ok = false; }
  syncProbe = { t: now, ok };
  return ok;
}

async function ensureSyncPermission(interactive) {
  if (!syncHandle) return false;
  let state = null;
  try { state = await syncHandle.queryPermission({ mode: 'readwrite' }); } catch (e) { /* unsupported */ }
  if (state === 'granted') return true;
  if (interactive && state === 'prompt') {
    try {
      if ((await syncHandle.requestPermission({ mode: 'readwrite' })) === 'granted') return true;
    } catch (e) { /* no user gesture or refused */ }
  }
  // Reported state says no — but trust an actual write probe over the
  // reported state, since file:// pages can under-report permissions.
  return syncUsable();
}

async function writeSyncFile() {
  if (!syncHandle || !(await ensureSyncPermission(false))) return;
  try {
    const w = await syncHandle.createWritable();
    await w.write(snapshot());
    await w.close();
    syncFileModified = (await syncHandle.getFile()).lastModified;
  } catch (e) {
    console.warn('Sync write failed:', e);
  }
}

function replaceStore(store, items) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    os.clear();
    for (const item of items) os.put(item);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* Replace this browser's data with an imported/synced snapshot */
async function adoptData(data) {
  if (!data || !Array.isArray(data.tasks)) return false;
  tasks = data.tasks;
  backlog = Array.isArray(data.backlog) ? data.backlog : [];
  if (data.settings && typeof data.settings === 'object') Object.assign(settings, data.settings);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  await replaceStore('tasks', tasks);
  await replaceStore('backlog', backlog);
  applySettings();
  renderNav();
  renderCustomTabList();
  if (!isTaskTab(activeTab) && activeTab !== 'backlog' && activeTab !== 'settings') activeTab = 'daily';
  switchTab(activeTab);
  broadcastChange(); // let other open windows pick up the adopted data
  return true;
}

async function loadFromSyncFile() {
  try {
    const file = await syncHandle.getFile();
    syncFileModified = file.lastModified;
    const text = (await file.text()).trim();
    if (!text) return false;
    return await adoptData(JSON.parse(text));
  } catch (e) {
    console.warn('Sync read failed:', e);
    return false;
  }
}

const SYNC_FILE_TYPES = [{ description: 'Checkpoint data', accept: { 'application/json': ['.json'] } }];

async function connectSyncFile(createNew) {
  let handle = null;
  try {
    if (createNew) {
      handle = await window.showSaveFilePicker({
        suggestedName: 'checkpoint-data.json',
        types: SYNC_FILE_TYPES,
      });
    } else {
      [handle] = await window.showOpenFilePicker({ types: SYNC_FILE_TYPES, multiple: false });
    }
  } catch (e) {
    return; // user cancelled the picker
  }
  syncHandle = handle;
  syncProbe.t = 0; // new handle — re-test access instead of trusting the cache
  // the open picker grants read-only — ask for write access right away
  try { await handle.requestPermission({ mode: 'readwrite' }); } catch (e) { /* refused */ }
  await idbPut('misc', { id: 'syncHandle', handle });

  // If the chosen file already holds Checkpoint data (e.g. connecting a
  // second browser), offer to load it instead of overwriting it.
  let adopted = false;
  try {
    const text = ((await (await handle.getFile()).text()) || '').trim();
    if (text) {
      const data = JSON.parse(text);
      if (data && Array.isArray(data.tasks) && confirm(
        'This file already contains Checkpoint data.\n\n' +
        'OK = load the file’s data into this browser.\n' +
        'Cancel = overwrite the file with this browser’s data.'
      )) {
        adopted = await adoptData(data);
      }
    }
  } catch (e) { /* new or unreadable file — just write to it below */ }
  if (!adopted) await writeSyncFile();
  await updateSyncUI();
  broadcastChange(); // other open windows pick up the new sync file
}

/* Single source of truth for the sync UI: the banner shows exactly when
   a file is connected but access genuinely doesn't work (verified by a
   real write probe, not just the reported permission state). */
let bannerDismissed = false;

async function updateSyncUI() {
  if (SERVER_MODE) return; // server state drives the UI via setServerState
  const connected = Boolean(syncHandle);
  const usable = connected && await ensureSyncPermission(false);
  $('#sync-banner').hidden = !connected || usable || bannerDismissed;
  $('#sync-disconnect').hidden = !connected;
  $('#sync-status').textContent = connected
    ? (usable
        ? `Connected to "${syncHandle.name}" — point other browsers at the same file`
        : `"${syncHandle.name}" is paused — click Reconnect above`)
    : 'Share data across browsers and devices — keep the file in OneDrive';
}

/* ---------- Live sync between open windows (widget <-> main) ----------
   Windows in the SAME browser share IndexedDB, but each keeps an
   in-memory copy loaded at startup — so a task added in one window
   would never appear in an already-open widget. Every change is
   broadcast so other windows reload instantly; focus/visibility
   changes also trigger a reload as a fallback. */

let syncChannel = null;
try { syncChannel = new BroadcastChannel('checkpoint-sync'); } catch (e) { /* unsupported */ }

let lastSeenRev = null; // localStorage change-stamp this window is up to date with

function broadcastChange() {
  // Stamp the change in localStorage (polled by other windows — reliable
  // even where BroadcastChannel doesn't connect between file:// pages)
  // and also announce it on the channel for instant pickup where it works.
  try {
    lastSeenRev = String(Date.now());
    localStorage.setItem('checkpoint-rev', lastSeenRev);
  } catch (e) { /* storage unavailable */ }
  if (!syncChannel) return;
  try { syncChannel.postMessage('changed'); } catch (e) { /* channel closed */ }
}

/* Re-read this browser's stores + settings and re-render */
async function reloadData() {
  [tasks, backlog] = await Promise.all([idbAll('tasks'), idbAll('backlog')]);
  if (!SERVER_MODE) {
    // pick up a sync file connected/disconnected in another window
    const rec = await idbGet('misc', 'syncHandle');
    syncHandle = (rec && rec.handle) ? rec.handle : null;
    await updateSyncUI();
  }
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch (e) { /* keep current settings */ }
  applySettings();
  renderNav();
  renderCustomTabList();
  if (!isTaskTab(activeTab) && activeTab !== 'backlog' && activeTab !== 'settings') activeTab = 'daily';
  switchTab(activeTab);
}

/* Pull newest data: prefer the server/sync file, then local stores */
async function refreshFromOutside() {
  if (SERVER_MODE) {
    if (await serverPull() === 'adopted') return; // already re-rendered
    await reloadData();
    return;
  }
  if (syncHandle && await ensureSyncPermission(false)) {
    if (await loadFromSyncFile()) return; // adoptData already re-rendered
  }
  await reloadData();
}

if (syncChannel) syncChannel.onmessage = () => reloadData();

function wireChipRow(containerSel, dataAttr, onPick) {
  const container = $(containerSel);
  container.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    container.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    onPick(chip.dataset[dataAttr]);
  });
}

/* ---------- Init ---------- */

async function init() {
  // Widget mode (?widget=1): compact layout for a small floating window.
  // Same database, so the widget and the full app stay in sync.
  if (new URLSearchParams(location.search).has('widget')) {
    document.body.classList.add('widget');
    document.title = 'Checkpoint Widget'; // widget.ps1 pins the window by this exact title
  }

  db = await openDB();
  [tasks, backlog] = await Promise.all([idbAll('tasks'), idbAll('backlog')]);

  const bgRecord = await idbGet('misc', 'background');
  if (bgRecord && bgRecord.blob) applyBackground(bgRecord.blob);

  // Header clock + date: tick every second; the date rolls over with it
  const updateClock = () => {
    const now = new Date();
    $('#clock').textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    $('#today-label').textContent = now.toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
  };
  updateClock();
  setInterval(updateClock, 1000);
  $('#clock-font').addEventListener('change', (e) => {
    settings.clockFont = e.target.value;
    saveSettings();
    applySettings();
  });

  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) switchTab(btn.dataset.tab);
  });

  $('#task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#task-input');
    const title = input.value.trim();
    if (!title) return;
    const val = $('#task-repeat').value;
    const custom = customTab(activeTab);
    const once = val === 'once';
    const task = {
      id: uid(), title, tab: activeTab,
      recurrence: custom ? (once ? 'daily' : val) : activeTab,
      once, done: {}, createdAt: Date.now(),
    };
    tasks.push(task);
    await idbPut('tasks', task);
    input.value = '';
    $('#task-repeat').value = custom ? 'once' : 'repeat';
    renderTasks();
  });

  $('#backlog-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#backlog-input');
    const title = input.value.trim();
    if (!title) return;
    const item = {
      id: uid(), title, type: $('#backlog-type').value,
      status: 'backlog', addedAt: Date.now(), finishedAt: null,
    };
    backlog.push(item);
    await idbPut('backlog', item);
    input.value = '';
    renderBacklog();
  });

  wireChipRow('#type-filters', 'type', (v) => { typeFilter = v; renderBacklog(); });
  wireChipRow('#status-filters', 'status', (v) => { statusFilter = v; renderBacklog(); });

  applySettings();
  $('#tabpos-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    settings.tabPosition = btn.dataset.pos;
    saveSettings();
    applySettings();
  });

  $('#bg-choose').addEventListener('click', () => $('#bg-file').click());
  $('#bg-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    await idbPut('misc', { id: 'background', blob: file });
    applyBackground(file);
    e.target.value = '';
  });
  $('#bg-remove').addEventListener('click', async () => {
    await idbDelete('misc', 'background');
    applyBackground(null);
  });
  $('#sharpen-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    settings.bgSharpen = btn.dataset.sharpen === 'on';
    saveSettings();
    applySettings();
  });

  renderNav();
  renderCustomTabList();
  $('#add-tab').addEventListener('click', addCustomTab);

  $('#open-widget').addEventListener('click', () => {
    window.open(location.pathname + '?widget=1', 'checkpoint-widget', 'popup=yes,width=360,height=560');
  });

  if (SERVER_MODE) {
    // Hosted as a web app: the server is the sync backend — hide the
    // file-based controls and connect automatically.
    $('#sync-connect').hidden = true;
    $('#sync-create').hidden = true;
    $('#sync-disconnect').hidden = true;
    document.querySelector('#sync-row .setting-name').textContent = 'Server sync';
    $('#sync-reconnect').addEventListener('click', async () => {
      if (serverNeedsAuth) {
        const t = prompt('Enter the server passcode:');
        if (t === null) return;
        serverToken = t.trim();
        localStorage.setItem('checkpoint-token', serverToken);
      }
      const result = await serverPull();
      if (result === 'empty' || result === 'current') await serverPush();
    });
    // installable-app support (requires HTTPS or localhost)
    if ('serviceWorker' in navigator &&
        (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
    }
    const pulled = await serverPull(); // adopt server data if it's newer
    if (pulled === 'empty' || pulled === 'current') await serverPush(); // seed/refresh the server copy
  } else {
    // Sync file: reconnect a previously chosen file (a saved handle needs
    // a one-click permission grant per session in most browsers).
    if (!('showSaveFilePicker' in window)) $('#sync-row').hidden = true;
    const syncRec = await idbGet('misc', 'syncHandle');
    if (syncRec && syncRec.handle) {
      syncHandle = syncRec.handle;
      if (await ensureSyncPermission(false)) {
        await loadFromSyncFile();
      } else {
        // The first click anywhere doubles as the user gesture needed to
        // re-request file access, so reconnecting doesn't require finding
        // the banner button (especially helpful in the small widget).
        document.addEventListener('pointerdown', async () => {
          if (await ensureSyncPermission(true).catch(() => false)) {
            await loadFromSyncFile();
          }
          updateSyncUI();
        }, { capture: true, once: true });
      }
    }
    await updateSyncUI();
    $('#sync-connect').addEventListener('click', () => connectSyncFile(false));
    $('#sync-create').addEventListener('click', () => connectSyncFile(true));
    $('#sync-disconnect').addEventListener('click', async () => {
      await idbDelete('misc', 'syncHandle');
      syncHandle = null;
      await updateSyncUI();
      broadcastChange(); // other open windows drop the file too
    });
    $('#sync-reconnect').addEventListener('click', async () => {
      syncProbe.t = 0; // re-test access fresh
      if (await ensureSyncPermission(true).catch(() => false)) {
        await loadFromSyncFile();
        await updateSyncUI();
      } else {
        // The browser refused to re-grant the saved handle; re-picking the
        // file always re-grants, so open the picker directly.
        await connectSyncFile(false);
      }
    });
  }
  $('#sync-dismiss').addEventListener('click', () => {
    bannerDismissed = true;
    $('#sync-banner').hidden = true;
  });

  // Backup: manual export/import, works in any browser
  $('#export-data').addEventListener('click', () => {
    const blob = new Blob([snapshot()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'checkpoint-backup.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#import-data').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (await adoptData(data)) scheduleSync();
      else alert('That file is not a valid Checkpoint backup.');
    } catch (err) {
      alert('Could not read that file: ' + err.message);
    }
    e.target.value = '';
  });

  // On regaining focus or visibility: pull fresh data (sync file first,
  // then local stores) so changes from other windows/browsers and
  // day/week/month rollovers appear without a manual refresh.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshFromOutside();
  });
  window.addEventListener('focus', () => refreshFromOutside());

  // Polling safety net every 2s. Needed because (a) BroadcastChannel may
  // not connect between file:// windows and (b) a pinned always-on-top
  // widget stays "visible" so it never gets focus/visibility events.
  // Reloads only when something actually changed.
  lastSeenRev = localStorage.getItem('checkpoint-rev');
  setInterval(async () => {
    // same-browser changes: another window bumped the rev stamp
    const rev = localStorage.getItem('checkpoint-rev');
    if (rev !== lastSeenRev) {
      lastSeenRev = rev;
      await reloadData();
    }
    if (SERVER_MODE) {
      // other-device changes arrive via the server; also retry any push
      // that failed while the server was unreachable
      await serverPull();
      if (serverOk && serverPushPending) await serverPush();
      return;
    }
    // other-browser changes: the sync file on disk got newer
    if (syncHandle && await ensureSyncPermission(false)) {
      try {
        const f = await syncHandle.getFile();
        if (!syncFileModified) syncFileModified = f.lastModified;
        else if (f.lastModified > syncFileModified) await loadFromSyncFile();
      } catch (e) { /* file temporarily unreadable */ }
    }
  }, 2000);

  switchTab('daily');
}

init().catch((err) => {
  console.error(err);
  alert('Checkpoint could not open its local database: ' + err.message);
});
