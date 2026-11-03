(() => {
'use strict';

const LS_DATA = 'memo-board:data';
const LS_VIEW = 'memo-board:view';
const LS_SYNC = 'memo-board:sync';
const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple'];
const GIST_FILE = 'memo-board.json';
const GIST_DESC = 'memo-board-backup';
const SNAP_EVERY = 3 * 60 * 1000;
const SNAP_KEEP = 100;
const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000;
const PULL_EVERY = 2 * 60 * 1000;

const $ = (s) => document.querySelector(s);
const board = $('#board');
const world = $('#world');
const hint = $('#hint');
const statusEl = $('#status');
const search = $('#search');

const now = () => Date.now();
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : now().toString(36) + Math.random().toString(36).slice(2));
const clone = (o) => JSON.parse(JSON.stringify(o));

function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function writeJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) { console.error(e); return false; }
}

let data = readJSON(LS_DATA, null) || { version: 1, notes: {} };
let view = readJSON(LS_VIEW, null) || { x: 0, y: 0, s: 1 };
let sync = readJSON(LS_SYNC, null) || {};
let maxZ = 0;
const els = new Map();

const live = () => Object.values(data.notes).filter((n) => !n.deleted);

function fmtTime(t) {
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- view ---------- */

let viewT;
function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  const g = 24 * view.s;
  board.style.backgroundSize = `${g}px ${g}px`;
  board.style.backgroundPosition = `${view.x}px ${view.y}px`;
  $('#zoom-reset').textContent = Math.round(view.s * 100) + '%';
  clearTimeout(viewT);
  viewT = setTimeout(() => writeJSON(LS_VIEW, view), 300);
}

function toWorld(cx, cy) {
  return { x: (cx - view.x) / view.s, y: (cy - view.y) / view.s };
}

function zoomTo(s, cx = innerWidth / 2, cy = innerHeight / 2) {
  s = Math.min(3, Math.max(0.2, s));
  const p = toWorld(cx, cy);
  view.s = s;
  view.x = cx - p.x * s;
  view.y = cy - p.y * s;
  applyView();
}

function centerOn(n) {
  view.x = innerWidth / 2 - (n.x + n.w / 2) * view.s;
  view.y = innerHeight / 2 - (n.y + n.h / 2) * view.s;
  applyView();
}

function fitAll() {
  const ns = live();
  if (!ns.length) { view = { x: 0, y: 0, s: 1 }; applyView(); return; }
  const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y));
  const x1 = Math.max(...ns.map((n) => n.x + n.w)), y1 = Math.max(...ns.map((n) => n.y + n.h));
  const pad = 80, top = 70;
  const s = Math.min(1, (innerWidth - pad * 2) / (x1 - x0), (innerHeight - pad - top) / (y1 - y0));
  view.s = Math.max(0.2, s);
  view.x = (innerWidth - (x1 - x0) * view.s) / 2 - x0 * view.s;
  view.y = top + (innerHeight - top - (y1 - y0) * view.s) / 2 - y0 * view.s;
  applyView();
}

/* ---------- rendering ---------- */

const resizeObs = new ResizeObserver((entries) => {
  for (const en of entries) {
    const el = en.target;
    const n = data.notes[el.dataset.id];
    if (!n || n.deleted) continue;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (Math.abs(w - n.w) > 1 || Math.abs(h - n.h) > 1) { n.w = w; n.h = h; touch(n); }
  }
});

function createEl(n) {
  const el = document.createElement('div');
  el.className = 'note';
  el.dataset.id = n.id;
  el.innerHTML = '<div class="bar"><span class="time"></span>'
    + '<button class="color" title="색 바꾸기" aria-label="색 바꾸기"></button>'
    + '<button class="del" title="삭제" aria-label="삭제">×</button></div>'
    + '<textarea spellcheck="false" placeholder="메모…"></textarea>';
  world.appendChild(el);
  els.set(n.id, el);
  resizeObs.observe(el);
  return el;
}

function paint(n) {
  let el = els.get(n.id);
  if (n.deleted) {
    if (el) { resizeObs.unobserve(el); el.remove(); els.delete(n.id); }
    return;
  }
  if (!el) el = createEl(n);
  el.style.left = n.x + 'px';
  el.style.top = n.y + 'px';
  el.style.width = n.w + 'px';
  el.style.height = n.h + 'px';
  el.style.zIndex = n.z || 0;
  for (const c of COLORS) el.classList.toggle('c-' + c, c === n.color);
  const ta = el.querySelector('textarea');
  if (ta.value !== n.text) ta.value = n.text;
  el.querySelector('.time').textContent = fmtTime(n.createdAt);
}

function paintAll() {
  for (const n of Object.values(data.notes)) paint(n);
  for (const [id, el] of els) {
    if (!data.notes[id]) { resizeObs.unobserve(el); el.remove(); els.delete(id); }
  }
  maxZ = Math.max(0, ...Object.values(data.notes).map((n) => n.z || 0));
  hint.hidden = live().length > 0;
  applySearch();
}

function applySearch() {
  const q = search.value.trim().toLowerCase();
  for (const [id, el] of els) {
    el.classList.toggle('dim', !!q && !data.notes[id].text.toLowerCase().includes(q));
  }
}

/* ---------- mutations ---------- */

function touch(n) { n.updatedAt = now(); changed(); }

function changed() {
  saveLocalSoon();
  dirtySnap = true;
  schedulePush();
}

function addNote(x, y) {
  const t = now();
  const n = {
    id: uid(), x: Math.round(x), y: Math.round(y), w: 220, h: 180,
    text: '', color: 'yellow', z: ++maxZ, createdAt: t, updatedAt: t,
  };
  data.notes[n.id] = n;
  paint(n);
  changed();
  hint.hidden = true;
  els.get(n.id).querySelector('textarea').focus();
  return n;
}

function addNoteAtCenter() {
  const p = toWorld(innerWidth / 2, innerHeight / 2);
  const k = live().length % 6;
  addNote(p.x - 110 + k * 24, p.y - 90 + k * 24);
}

function deleteNote(id, silent) {
  const n = data.notes[id];
  if (!n) return;
  n.deleted = true;
  touch(n);
  paint(n);
  hint.hidden = live().length > 0;
  if (!silent) {
    toast('메모를 삭제했어요', '되돌리기', () => {
      const m = data.notes[id];
      m.deleted = false;
      m.z = ++maxZ;
      touch(m);
      paint(m);
      hint.hidden = true;
    });
  }
}

function bringToFront(n) {
  if ((n.z || 0) >= maxZ) return;
  n.z = ++maxZ;
  els.get(n.id).style.zIndex = n.z;
  touch(n);
}

function purgeTombstones() {
  const cutoff = now() - TOMBSTONE_TTL;
  for (const [id, n] of Object.entries(data.notes)) {
    if (n.deleted && n.updatedAt < cutoff) delete data.notes[id];
  }
}

// Per-note last-writer-wins merge, so edits from several devices/tabs never clobber each other.
function mergeIn(other) {
  const cutoff = now() - TOMBSTONE_TTL;
  let localChanged = false, otherBehind = false;
  for (const [id, on] of Object.entries(other || {})) {
    if (!on || !on.id || (on.deleted && on.updatedAt < cutoff)) continue;
    const ln = data.notes[id];
    if (!ln || on.updatedAt > ln.updatedAt) { data.notes[id] = on; localChanged = true; }
  }
  for (const [id, ln] of Object.entries(data.notes)) {
    const on = other && other[id];
    if (!on || ln.updatedAt > on.updatedAt) otherBehind = true;
  }
  return { localChanged, otherBehind };
}

/* ---------- local save + status ---------- */

let saveT = null, saveFailed = false;
function saveLocalSoon() {
  clearTimeout(saveT);
  saveT = setTimeout(saveLocal, 250);
  refreshStatus();
}
function saveLocal() {
  clearTimeout(saveT);
  saveT = null;
  saveFailed = !writeJSON(LS_DATA, data);
  refreshStatus();
}

let syncState = sync.token ? 'ok' : 'off';
function setSync(s) { syncState = s; refreshStatus(); renderGist(); }

function refreshStatus() {
  const local = saveFailed ? '⚠ 브라우저 저장 실패 — 내보내기로 백업하세요'
    : saveT ? '저장 중…' : '저장됨';
  const remote = {
    off: '',
    pending: '☁ 대기',
    syncing: '☁ 동기화 중…',
    ok: sync.lastSync ? '☁ ' + fmtTime(sync.lastSync) : '☁',
    error: '⚠ 동기화 실패, 재시도 예정',
    auth: '⚠ 토큰을 확인하세요',
  }[syncState];
  statusEl.textContent = [local, remote].filter(Boolean).join(' · ');
  statusEl.classList.toggle('warn', saveFailed || syncState === 'error' || syncState === 'auth');
}

/* ---------- snapshots (IndexedDB) ---------- */

const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('memo-board', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('snaps', { keyPath: 't' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('snaps', mode);
      const req = fn(tx.objectStore('snaps'));
      tx.oncomplete = () => res(req.result);
      tx.onerror = () => rej(tx.error);
    });
  };
  return {
    put: (s) => run('readwrite', (st) => st.put(s)),
    all: () => run('readonly', (st) => st.getAll()),
    del: (t) => run('readwrite', (st) => st.delete(t)),
  };
})();

let dirtySnap = false, lastSnap = 0;
async function takeSnapshot(label = '') {
  dirtySnap = false;
  lastSnap = now();
  try {
    await idb.put({ t: lastSnap, label, count: live().length, data: clone(data) });
    const all = await idb.all();
    if (all.length > SNAP_KEEP) {
      all.sort((a, b) => a.t - b.t);
      for (const s of all.slice(0, all.length - SNAP_KEEP)) await idb.del(s.t);
    }
  } catch (e) { console.warn('snapshot failed', e); }
}

/* ---------- GitHub Gist sync ---------- */

async function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + sync.token };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch('https://api.github.com' + path, { ...opts, headers, cache: 'no-store' });
  if (!r.ok) { const e = new Error('GitHub ' + r.status); e.status = r.status; throw e; }
  return r.status === 204 ? null : r.json();
}

const serialize = () => JSON.stringify({ version: 1, savedAt: now(), notes: data.notes });
const saveSync = () => writeJSON(LS_SYNC, sync);

async function findOrCreateGist() {
  for (let page = 1; page <= 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files && g.files[GIST_FILE]);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  const g = await gh('/gists', {
    method: 'POST',
    body: JSON.stringify({ description: GIST_DESC, public: false, files: { [GIST_FILE]: { content: serialize() } } }),
  });
  return g.id;
}

async function pullRemote() {
  const g = await gh('/gists/' + sync.gistId);
  const f = g.files[GIST_FILE];
  if (!f) return null;
  const text = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
  return JSON.parse(text);
}

let pushT, syncing = false, syncAgain = false;
function schedulePush() {
  if (!sync.token) return;
  if (!syncing) setSync('pending');
  clearTimeout(pushT);
  pushT = setTimeout(syncNow, 2000);
}

async function syncNow() {
  if (!sync.token) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  clearTimeout(pushT);
  setSync('syncing');
  try {
    if (!sync.gistId) { sync.gistId = await findOrCreateGist(); saveSync(); }
    const remote = await pullRemote();
    const { localChanged, otherBehind } = mergeIn(remote && remote.notes);
    if (localChanged) { saveLocal(); paintAll(); }
    if (otherBehind || !remote) {
      purgeTombstones();
      await gh('/gists/' + sync.gistId, {
        method: 'PATCH',
        body: JSON.stringify({ files: { [GIST_FILE]: { content: serialize() } } }),
      });
    }
    sync.lastSync = now();
    saveSync();
    setSync('ok');
  } catch (e) {
    console.warn('sync failed', e);
    if (e.status === 404 && sync.gistId) { sync.gistId = null; saveSync(); }
    if (e.status === 401 || e.status === 403) setSync('auth');
    else { setSync('error'); pushT = setTimeout(syncNow, 30000); }
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; schedulePush(); }
  }
}

/* ---------- toast ---------- */

let toastT;
function toast(msg, action, fn) {
  const t = $('#toast');
  t.replaceChildren(msg);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.onclick = () => { t.hidden = true; fn(); };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 6000);
}

/* ---------- board interactions ---------- */

const isBg = (t) => t === board || t === world;
const pointers = new Map();
let pan = null, pinch = null;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

board.addEventListener('pointerdown', (e) => {
  if (!isBg(e.target) || (e.button !== 0 && e.button !== 1)) return;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  board.setPointerCapture(e.pointerId);
  if (pointers.size === 1) {
    pan = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
  } else if (pointers.size === 2) {
    pan = null;
    const [a, b] = [...pointers.values()];
    pinch = { d: dist(a, b), s: view.s };
  }
  board.classList.add('panning');
});

board.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    zoomTo(pinch.s * dist(a, b) / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
  } else if (pan) {
    view.x = pan.ox + e.clientX - pan.sx;
    view.y = pan.oy + e.clientY - pan.sy;
    applyView();
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) { pan = null; board.classList.remove('panning'); }
}
board.addEventListener('pointerup', endPointer);
board.addEventListener('pointercancel', endPointer);

board.addEventListener('dblclick', (e) => {
  if (!isBg(e.target)) return;
  const p = toWorld(e.clientX, e.clientY);
  addNote(p.x - 24, p.y - 14);
});

board.addEventListener('wheel', (e) => {
  const ta = e.target.closest('textarea');
  if (ta && !e.ctrlKey && ta.scrollHeight > ta.clientHeight) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const dy = Math.max(-30, Math.min(30, e.deltaY));
    zoomTo(view.s * Math.exp(-dy * 0.01), e.clientX, e.clientY);
  }
  else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
}, { passive: false });

/* ---------- note interactions ---------- */

const noteOf = (t) => {
  const el = t.closest('.note');
  return el && data.notes[el.dataset.id];
};

let drag = null;
world.addEventListener('pointerdown', (e) => {
  const bar = e.target.closest('.bar');
  if (!bar || e.target.closest('button')) return;
  const n = noteOf(bar);
  if (!n) return;
  bringToFront(n);
  drag = { id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false };
  bar.setPointerCapture(e.pointerId);
  els.get(n.id).classList.add('dragging');
  e.preventDefault();
});

world.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const n = data.notes[drag.id];
  const dx = (e.clientX - drag.sx) / view.s, dy = (e.clientY - drag.sy) / view.s;
  if (!drag.moved && Math.hypot(dx, dy) < 2) return;
  drag.moved = true;
  n.x = Math.round(drag.ox + dx);
  n.y = Math.round(drag.oy + dy);
  const el = els.get(n.id);
  el.style.left = n.x + 'px';
  el.style.top = n.y + 'px';
});

function endDrag() {
  if (!drag) return;
  const n = data.notes[drag.id];
  els.get(drag.id)?.classList.remove('dragging');
  if (drag.moved && n) touch(n);
  drag = null;
}
world.addEventListener('pointerup', endDrag);
world.addEventListener('pointercancel', endDrag);

world.addEventListener('input', (e) => {
  if (e.target.tagName !== 'TEXTAREA') return;
  const n = noteOf(e.target);
  if (!n) return;
  n.text = e.target.value;
  touch(n);
  if (search.value) applySearch();
});

world.addEventListener('focusin', (e) => {
  const n = e.target.tagName === 'TEXTAREA' && noteOf(e.target);
  if (n) bringToFront(n);
});

world.addEventListener('focusout', (e) => {
  if (e.target.tagName !== 'TEXTAREA') return;
  const n = noteOf(e.target);
  // An empty note left behind (e.g. an accidental double-click) is removed quietly.
  if (n && !n.deleted && !n.text.trim()) deleteNote(n.id, true);
});

world.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const n = noteOf(btn);
  if (!n) return;
  if (btn.classList.contains('color')) {
    n.color = COLORS[(COLORS.indexOf(n.color) + 1) % COLORS.length];
    touch(n);
    paint(n);
  } else if (btn.classList.contains('del')) {
    deleteNote(n.id, !n.text.trim());
  }
});

world.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.tagName === 'TEXTAREA') e.target.blur();
});

/* ---------- toolbar ---------- */

$('#btn-new').addEventListener('click', addNoteAtCenter);
$('#zoom-in').addEventListener('click', () => zoomTo(view.s * 1.2));
$('#zoom-out').addEventListener('click', () => zoomTo(view.s / 1.2));
$('#zoom-reset').addEventListener('click', () => zoomTo(1));
$('#zoom-fit').addEventListener('click', fitAll);

search.addEventListener('input', applySearch);
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = search.value.trim().toLowerCase();
    const hit = q && live().find((n) => n.text.toLowerCase().includes(q));
    if (hit) centerOn(hit);
  } else if (e.key === 'Escape') {
    search.value = '';
    applySearch();
    search.blur();
  }
});

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('#backup').open) return;
  if (e.key === 'n' || e.key === 'N' || e.key === 'ㅜ') { e.preventDefault(); addNoteAtCenter(); }
  else if (e.key === '/') { e.preventDefault(); search.focus(); }
});

/* ---------- backup dialog ---------- */

const dlg = $('#backup');
$('#btn-backup').addEventListener('click', () => { renderGist(); renderSnaps(); dlg.showModal(); });

function renderGist() {
  $('#gist-off').hidden = !!sync.token;
  $('#gist-on').hidden = !sync.token;
  if (!sync.token) return;
  const info = $('#gist-info');
  info.replaceChildren();
  const label = {
    ok: sync.lastSync ? `마지막 동기화 ${fmtTime(sync.lastSync)}` : '연결됨',
    pending: '변경 사항 업로드 대기 중',
    syncing: '동기화 중…',
    error: '동기화 실패 — 30초 후 다시 시도해요',
    auth: '토큰이 만료됐거나 gist 권한이 없어요. 연결 해제 후 새 토큰으로 연결하세요.',
  }[syncState] || '';
  info.append(label);
  if (sync.gistId) {
    const a = document.createElement('a');
    a.href = 'https://gist.github.com/' + sync.gistId;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Gist 열기';
    info.append(' · ', a);
  }
}

async function renderSnaps() {
  const ul = $('#snaps');
  let all = [];
  try { all = await idb.all(); } catch {}
  all.sort((a, b) => b.t - a.t);
  ul.replaceChildren();
  if (!all.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '아직 복원 지점이 없어요. 메모를 쓰면 3분마다 자동으로 생겨요.';
    ul.append(li);
    return;
  }
  for (const s of all.slice(0, 40)) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `${fmtTime(s.t)} · 메모 ${s.count}개${s.label ? ' · ' + s.label : ''}`;
    const b = document.createElement('button');
    b.textContent = '복원';
    b.onclick = () => restoreSnapshot(s);
    li.append(span, b);
    ul.append(li);
  }
}

async function restoreSnapshot(s) {
  if (!confirm(`${fmtTime(s.t)} 시점으로 되돌릴까요?\n지금 상태도 복원 지점으로 먼저 저장해 둘게요.`)) return;
  await takeSnapshot('복원 전');
  const t = now();
  const restored = clone(s.data.notes);
  // Bump timestamps so the restored state wins over newer copies on other devices.
  for (const n of Object.values(restored)) n.updatedAt = t;
  for (const [id, n] of Object.entries(data.notes)) {
    if (!restored[id]) restored[id] = { ...n, deleted: true, updatedAt: t };
  }
  data.notes = restored;
  paintAll();
  changed();
  renderSnaps();
  toast('복원했어요');
}

$('#exp').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: now(), notes: data.notes }, null, 2)], { type: 'application/json' });
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `memo-board-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#imp').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed.notes !== 'object') throw new Error('bad file');
    await takeSnapshot('가져오기 전');
    const before = live().length;
    mergeIn(parsed.notes);
    paintAll();
    changed();
    renderSnaps();
    toast(`가져왔어요 (메모 ${before}개 → ${live().length}개)`);
  } catch (err) {
    console.warn(err);
    toast('이 파일은 메모 보드 백업 파일이 아니에요');
  }
});

$('#gist-connect').addEventListener('click', async () => {
  const token = $('#token').value.trim();
  if (!token) return;
  sync = { token };
  saveSync();
  $('#token').value = '';
  await syncNow();
  if (syncState === 'ok') toast('Gist 동기화를 켰어요');
});
$('#gist-sync').addEventListener('click', syncNow);
$('#gist-disconnect').addEventListener('click', () => {
  if (!confirm('Gist 동기화를 끌까요? 이 브라우저의 메모와 Gist의 백업은 그대로 남아요.')) return;
  clearTimeout(pushT);
  sync = {};
  saveSync();
  setSync('off');
});

/* ---------- lifecycle ---------- */

function flush() {
  if (saveT) saveLocal();
  if (dirtySnap) takeSnapshot();
}
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { flush(); if (syncState === 'pending') syncNow(); }
  else if (sync.token) syncNow();
});
addEventListener('online', () => { if (sync.token) syncNow(); });

// Another tab of this app saved: merge its notes in.
addEventListener('storage', (e) => {
  if (e.key !== LS_DATA || !e.newValue) return;
  try {
    const { localChanged } = mergeIn(JSON.parse(e.newValue).notes);
    if (localChanged) { saveLocal(); paintAll(); }
  } catch {}
});

setInterval(() => { if (dirtySnap && now() - lastSnap >= SNAP_EVERY) takeSnapshot(); }, 30000);
setInterval(() => {
  if (sync.token && document.visibilityState === 'visible' && !syncing && syncState !== 'auth') syncNow();
}, PULL_EVERY);

async function boot() {
  if (!localStorage.getItem(LS_DATA)) {
    // Browser storage was wiped but IndexedDB survived: recover from the latest restore point.
    try {
      const all = await idb.all();
      if (all.length) {
        all.sort((a, b) => b.t - a.t);
        data = clone(all[0].data);
        saveLocal();
        toast('최근 복원 지점에서 메모를 불러왔어요');
      }
    } catch {}
  }
  purgeTombstones();
  applyView();
  paintAll();
  refreshStatus();
  if (live().length) { lastSnap = now(); dirtySnap = true; }
  if (sync.token) syncNow();
}
boot();
})();
