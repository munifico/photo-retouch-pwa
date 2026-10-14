import { ADJUSTMENTS, KEYS, emptyValues, clampValue } from './adjustments.js';
import { parsePresetText } from './parser.js';
import { Renderer } from './renderer.js';
import { decodeImage, releaseSource, exportJpeg, exportName, maxPixelsFor, MAX_RES_OPTIONS, IOS_MAX_PIXELS } from './imageio.js';
import {
  loadPresets, savePresets, loadSettings, saveSettings, newId, fullValues, summarize, sameName, uniqueName,
  backupBlob, parseBackup, shareLink, presetsFromHash,
} from './store.js';
import { createDial } from './dial.js';

const PREVIEW_MAX_PIXELS = 3_000_000;
const PREVIEW_MAX_SIDE = 2048;

const $ = (sel) => document.querySelector(sel);
const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

// ── 상태 ─────────────────────────────────────────────────
const state = {
  presets: loadPresets(),
  settings: loadSettings(),
  photos: [], // File[]
  current: -1,
  previewSource: null,
  presetId: null, // 선택한 프리셋 (null = 원본)
  values: emptyValues(), // 현재 적용 값 (프리셋 + 미세 조정)
  adjKey: KEYS[0],
  comparing: false,
  persisted: null,
};
savePresets(state.presets); // 첫 실행이면 기본 프리셋 기록

let renderer = null;
let rafId = 0;
let loadToken = 0;

const findPreset = (id) => state.presets.find((p) => p.id === id);
const displayOrder = () => [...state.presets.filter((p) => p.fav), ...state.presets.filter((p) => !p.fav)];
const sameValues = (a, b) => KEYS.every((k) => (a[k] || 0) === (b[k] || 0));

function persistPresets() {
  if (!savePresets(state.presets)) toast('저장 공간에 기록하지 못했습니다. 백업을 내보내 두세요.');
}

// ── 공통 UI ──────────────────────────────────────────────
let toastTimer = 0;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/** 모달. buttons: [{label, value, cls}] → 누른 버튼의 value (배경 탭 = null) */
function modal({ title = '', body = null, buttons = [] }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modal-title').textContent = title;
    const bodyEl = $('#modal-body');
    bodyEl.replaceChildren();
    if (typeof body === 'string') bodyEl.append(h('p', { textContent: body }));
    else if (body) bodyEl.append(body);
    const btns = $('#modal-btns');
    btns.replaceChildren();
    const done = (v) => {
      m.hidden = true;
      m.onclick = null;
      resolve(v);
    };
    for (const b of buttons) {
      btns.append(h('button', { className: `btn ${b.cls || ''}`, textContent: b.label, onclick: () => done(b.value) }));
    }
    m.onclick = (e) => { if (e.target === m) done(null); };
    m.hidden = false;
    bodyEl.querySelector('input, textarea')?.focus();
  });
}

const confirmDialog = (title, msg, okLabel = '확인', cls = 'primary') =>
  modal({ title, body: msg, buttons: [{ label: okLabel, value: true, cls }, { label: '취소', value: false }] });

async function promptName(title, initial, exceptId) {
  let value = initial;
  let error = '';
  for (;;) {
    const input = h('input', { type: 'text', value, maxLength: 40, autocomplete: 'off' });
    const body = h('div', {}, input);
    if (error) body.append(h('p', { className: 'warn', textContent: error }));
    const ok = await modal({ title, body, buttons: [{ label: '확인', value: true, cls: 'primary' }, { label: '취소', value: false }] });
    if (!ok) return null;
    value = input.value.trim();
    error = nameError(value, exceptId);
    if (!error) return value;
  }
}

function nameError(name, exceptId) {
  if (!name) return '이름을 입력하세요.';
  if (state.presets.some((p) => p.id !== exceptId && sameName(p.name, name))) return '같은 이름의 프리셋이 이미 있습니다.';
  return '';
}

function onLongPress(el, fn, ms = 500) {
  let timer = 0;
  let sx = 0;
  let sy = 0;
  let fired = false;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, .handle')) return;
    fired = false;
    sx = e.clientX;
    sy = e.clientY;
    timer = setTimeout(() => { fired = true; timer = 0; fn(); }, ms);
  });
  el.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, cancel);
  el.addEventListener('click', (e) => {
    if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; }
  }, true);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function openSheet(id) { $(id).hidden = false; }
function closeSheet(id) { $(id).hidden = true; }
for (const btn of document.querySelectorAll('.sheet [data-close]')) {
  btn.addEventListener('click', () => {
    const sheet = btn.closest('.sheet');
    if (sheet.id === 'sheet-editor') closeEditor();
    else sheet.hidden = true;
  });
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

async function shareOrDownload(files) {
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      toast('공유 시트를 열지 못했습니다. 다운로드로 저장합니다.');
    }
  }
  download(files);
  return true;
}

function download(files) {
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = h('a', { href: url, download: f.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

// ── 화면 전환 ────────────────────────────────────────────
function switchView(name) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${name}`);
  for (const b of document.querySelectorAll('.tabbar button')) b.classList.toggle('active', b.dataset.view === name);
  $('#title').textContent = name === 'edit' ? '보정' : '프리셋';
  if (name === 'presets') renderList();
}
for (const b of document.querySelectorAll('.tabbar button')) b.addEventListener('click', () => switchView(b.dataset.view));

// ── 미리보기 렌더러 ──────────────────────────────────────
function createPreviewRenderer() {
  const old = $('#preview');
  const canvas = old.cloneNode(false); // 컨텍스트 옵션을 바꾸려면 캔버스를 새로 만들어야 한다
  old.replaceWith(canvas);
  renderer?.dispose();
  renderer = new Renderer(canvas, { p3: state.settings.p3 });
  renderer.onRestore = scheduleRender;
  if (state.previewSource) renderer.setSource(state.previewSource, { keep: true });
  bindCompare(canvas);
  scheduleRender();
}

function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (renderer && state.previewSource) renderer.render(state.comparing ? emptyValues() : state.values);
  });
}

// 길게 누르면 원본
function bindCompare(canvas) {
  let timer = 0;
  const end = () => {
    clearTimeout(timer);
    if (state.comparing) {
      state.comparing = false;
      $('#compare-badge').hidden = true;
      scheduleRender();
    }
  };
  canvas.addEventListener('pointerdown', () => {
    timer = setTimeout(() => {
      state.comparing = true;
      $('#compare-badge').hidden = false;
      scheduleRender();
    }, 250);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(ev, end);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function stageMsg(msg) {
  const el = $('#stage-msg');
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ── 사진 ─────────────────────────────────────────────────
const pickPhotos = () => $('#file-photos').click();
$('#btn-pick').addEventListener('click', pickPhotos);
$('#btn-pick-empty').addEventListener('click', pickPhotos);
$('#file-photos').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  state.photos = files;
  switchView('edit');
  buildThumbs();
  showPhoto(0);
});

function previewMaxSide() {
  const st = $('#stage');
  const css = Math.max(st.clientWidth, st.clientHeight) || 800;
  return Math.min(renderer.maxSide, PREVIEW_MAX_SIDE, Math.max(1024, Math.ceil(css * (devicePixelRatio || 1))));
}

async function showPhoto(i) {
  const token = ++loadToken;
  state.current = i;
  for (const [j, t] of [...$('#thumbs').children].entries()) t.classList.toggle('on', j === i);
  stageMsg(null);
  try {
    const dec = await decodeImage(state.photos[i], { maxPixels: PREVIEW_MAX_PIXELS, maxSide: previewMaxSide() });
    if (token !== loadToken) { releaseSource(dec.source); return; }
    releaseSource(state.previewSource);
    state.previewSource = dec.source;
    renderer.setSource(dec.source, { keep: true });
    renderer.canvas.hidden = false;
    $('#empty').hidden = true;
    scheduleRender();
  } catch (e) {
    if (token !== loadToken) return;
    releaseSource(state.previewSource);
    state.previewSource = null;
    renderer.canvas.hidden = true;
    $('#empty').hidden = false;
    stageMsg(e.message);
  }
}

// 썸네일은 한 장씩 작게 디코딩하고 바로 해제
async function buildThumbs() {
  const box = $('#thumbs');
  box.replaceChildren();
  box.hidden = state.photos.length < 2;
  if (box.hidden) return;
  const photos = state.photos;
  const els = photos.map((_, i) => {
    const c = h('canvas', { width: 88, height: 88, onclick: () => showPhoto(i) });
    box.append(c);
    return c;
  });
  for (const [i, file] of photos.entries()) {
    if (state.photos !== photos) return; // 그 사이 다시 선택함
    try {
      const dec = await decodeImage(file, { maxPixels: 40_000, maxSide: 200 });
      const ctx = els[i].getContext('2d');
      const s = Math.max(88 / dec.width, 88 / dec.height);
      ctx.drawImage(dec.source, (88 - dec.width * s) / 2, (88 - dec.height * s) / 2, dec.width * s, dec.height * s);
      releaseSource(dec.source);
    } catch {
      els[i].replaceWith(h('div', { className: 'ph', textContent: '!', onclick: () => showPhoto(i) }));
    }
  }
  for (const [j, t] of [...box.children].entries()) t.classList.toggle('on', j === state.current);
}

// ── 보정 패널 (프리셋 칩 / 조정 다이얼) ──────────────────
for (const b of document.querySelectorAll('.seg button')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.seg button')) x.classList.toggle('active', x === b);
    $('#panel-presets').hidden = b.dataset.mode !== 'presets';
    $('#panel-adjust').hidden = b.dataset.mode !== 'adjust';
    if (b.dataset.mode === 'adjust') selectAdj(state.adjKey);
  });
}

function isModified() {
  const p = findPreset(state.presetId);
  return !sameValues(state.values, p ? p.values : emptyValues());
}

function renderChips() {
  const box = $('#panel-presets');
  box.replaceChildren();
  const mod = isModified();
  const chip = (label, id) => {
    const on = state.presetId === id;
    const c = h('button', { className: `chip${on ? ' on' : ''}`, textContent: label, onclick: () => selectPreset(id) });
    if (on && mod) c.append(h('span', { className: 'mod', textContent: '수정됨' }));
    box.append(c);
  };
  chip('원본', null);
  for (const p of displayOrder()) chip((p.fav ? '★ ' : '') + p.name, p.id);
  box.querySelector('.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function selectPreset(id) {
  const p = findPreset(id);
  state.presetId = p ? p.id : null;
  state.values = p ? { ...p.values } : emptyValues();
  renderChips();
  renderAdjTabs();
  dial.set(state.values[state.adjKey]);
  scheduleRender();
}

function renderAdjTabs() {
  const box = $('#adj-tabs');
  if (!box.children.length) {
    for (const a of ADJUSTMENTS) {
      box.append(h('button', { className: 'adj-tab', onclick: () => selectAdj(a.key) }, h('b'), a.label));
      box.lastChild.dataset.key = a.key;
    }
  }
  for (const t of box.children) {
    const v = state.values[t.dataset.key];
    t.querySelector('b').textContent = v > 0 ? `+${v}` : `${v}`;
    t.classList.toggle('nz', v !== 0);
    t.classList.toggle('on', t.dataset.key === state.adjKey);
  }
}

function selectAdj(key) {
  state.adjKey = key;
  renderAdjTabs();
  dial.set(state.values[key]);
  $(`#adj-tabs [data-key="${key}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

const dial = createDial($('#dial'), {
  onInput: (v) => {
    state.values[state.adjKey] = v;
    renderAdjTabs();
    renderChips();
    scheduleRender();
  },
});

$('#btn-reset').addEventListener('click', () => selectPreset(null));
$('#btn-save-preset').addEventListener('click', () => {
  const p = findPreset(state.presetId);
  openEditor({ values: state.values, name: p && isModified() ? uniqueName(`${p.name} 수정`, state.presets) : '', fromEdit: true });
});

// ── 프리셋 목록 ──────────────────────────────────────────
function renderList() {
  const ul = $('#preset-list');
  ul.replaceChildren();
  for (const p of displayOrder()) {
    const li = h('li', { className: `prow${p.id === state.presetId ? ' on' : ''}` },
      h('div', { className: 'handle', textContent: '≡', ariaLabel: '순서 변경' }),
      h('div', { className: 'main' }, h('div', { className: 'name', textContent: p.name }), h('div', { className: 'sum', textContent: summarize(p.values) })),
      h('button', { className: `fav${p.fav ? ' on' : ''}`, textContent: p.fav ? '★' : '☆', ariaLabel: '즐겨찾기' }),
      h('button', { className: 'more', textContent: '···', ariaLabel: '메뉴' }));
    li.dataset.id = p.id;
    li.querySelector('.main').addEventListener('click', () => {
      selectPreset(p.id);
      renderList();
      if (state.previewSource) switchView('edit');
      else toast(`'${p.name}' 선택됨 — 사진을 선택하세요`);
    });
    li.querySelector('.fav').addEventListener('click', () => {
      p.fav = !p.fav;
      persistPresets();
      renderList();
      renderChips();
    });
    li.querySelector('.more').addEventListener('click', () => presetMenu(p));
    onLongPress(li, () => presetMenu(p));
    bindDrag(li);
    ul.append(li);
  }
}

async function presetMenu(p) {
  const action = await modal({
    title: p.name,
    body: h('p', { textContent: summarize(p.values) }),
    buttons: [
      { label: '편집', value: 'edit' },
      { label: '복제', value: 'dup' },
      { label: '이름 변경', value: 'rename' },
      { label: '공유 링크', value: 'share' },
      { label: '삭제', value: 'del', cls: 'danger' },
      { label: '취소', value: null },
    ],
  });
  if (action === 'edit') openEditor({ id: p.id });
  if (action === 'dup') {
    const copy = { id: newId(), name: uniqueName(`${p.name} 복사본`, state.presets), values: { ...p.values }, fav: false };
    state.presets.splice(state.presets.indexOf(p) + 1, 0, copy);
    afterPresetAdded();
  }
  if (action === 'rename') {
    const name = await promptName('이름 변경', p.name, p.id);
    if (name) { p.name = name; persistPresets(); }
  }
  if (action === 'share') await sharePreset(p);
  if (action === 'del' && await confirmDialog('프리셋 삭제', `'${p.name}' 을(를) 삭제할까요?`, '삭제', 'danger')) {
    state.presets.splice(state.presets.indexOf(p), 1);
    if (state.presetId === p.id) state.presetId = null;
    persistPresets();
  }
  renderList();
  renderChips();
}

async function sharePreset(p) {
  const url = shareLink(p);
  if (navigator.share) {
    try {
      await navigator.share({ title: p.name, text: `사진 보정 프리셋: ${p.name}`, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('공유 링크를 복사했습니다');
  } catch {
    await modal({ title: '공유 링크', body: h('textarea', { value: url, readOnly: true }), buttons: [{ label: '닫기', value: null }] });
  }
}

// 핸들(≡)을 끌어 순서 변경. 화면 순서(즐겨찾기 먼저)를 그대로 저장 순서로 쓴다.
function bindDrag(li) {
  const handle = li.querySelector('.handle');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const rows = [...li.parentNode.children];
    const from = rows.indexOf(li);
    const step = li.offsetHeight + 6;
    const startY = e.clientY;
    let to = from;
    li.classList.add('dragging');
    const move = (ev) => {
      const dy = ev.clientY - startY;
      li.style.transform = `translateY(${dy}px)`;
      to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / step)));
      rows.forEach((r, j) => {
        if (r === li) return;
        const shift = from < to && j > from && j <= to ? -step : to < from && j >= to && j < from ? step : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      li.classList.remove('dragging');
      for (const r of rows) r.style.transform = '';
      if (to !== from) {
        const order = displayOrder();
        const [moved] = order.splice(from, 1);
        order.splice(to, 0, moved);
        state.presets = order;
        persistPresets();
        renderChips();
      }
      renderList();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

function afterPresetAdded() {
  persistPresets();
  renderList();
  renderChips();
  maybeBackupHint();
}

async function maybeBackupHint() {
  if (state.presets.length < 3 || state.settings.backupHintShown) return;
  state.settings.backupHintShown = true;
  saveSettings(state.settings);
  const go = await modal({
    title: '백업해 두세요',
    body: '프리셋은 이 브라우저에만 저장됩니다. 사파리 데이터를 지우거나 오래 쓰지 않으면 사라질 수 있어요. 백업 파일을 내보내 두면 언제든 다시 가져올 수 있습니다.',
    buttons: [{ label: '지금 백업 내보내기', value: true, cls: 'primary' }, { label: '나중에', value: false }],
  });
  if (go) exportBackup();
}

$('#btn-new-preset').addEventListener('click', () => openEditor({}));

// ── 프리셋 편집기 ────────────────────────────────────────
const ed = { id: null, values: emptyValues(), renderer: null, fromEdit: false, raf: 0 };
const edRows = {};

for (const a of ADJUSTMENTS) {
  const range = h('input', { type: 'range', min: -100, max: 100, step: 1, value: 0 });
  const num = h('input', { type: 'text', className: 'num', inputMode: 'numeric', autocomplete: 'off', value: '0' });
  num.setAttribute('enterkeyhint', 'done');
  const pm = h('button', { className: 'pm', textContent: '±', type: 'button', ariaLabel: '부호 바꾸기' });
  const row = h('div', { className: 'ed-row' }, h('label', { textContent: a.label }), range, pm, num);
  range.addEventListener('input', () => edSet(a.key, Number(range.value)));
  num.addEventListener('input', () => {
    const t = num.value.replace(/[−–—]/g, '-').replace(/[^\d-]/g, '');
    if (/^-?\d+$/.test(t)) edSet(a.key, Number(t), { keepText: clampValue(t) === Number(t) });
  });
  num.addEventListener('change', () => edSet(a.key, ed.values[a.key]));
  num.addEventListener('focus', () => num.select());
  // 아이폰 숫자 키패드에는 마이너스가 없어서 ± 버튼을 둔다
  pm.addEventListener('click', () => {
    const v = ed.values[a.key];
    if (v) edSet(a.key, -v);
    else { num.value = num.value.startsWith('-') ? '' : '-'; num.focus(); }
  });
  edRows[a.key] = { row, range, num };
  $('#ed-rows').append(row);
}

function edSet(key, v, { keepText = false } = {}) {
  v = clampValue(v);
  ed.values[key] = v;
  const r = edRows[key];
  r.range.value = v;
  if (!keepText) r.num.value = String(v);
  r.row.classList.toggle('nz', v !== 0);
  edRender();
}

function edRender() {
  if (!ed.renderer || ed.raf) return;
  ed.raf = requestAnimationFrame(() => {
    ed.raf = 0;
    ed.renderer?.render(ed.values);
  });
}

function edCheckName() {
  const err = $('#ed-name').value.trim() ? nameError($('#ed-name').value.trim(), ed.id) : '';
  $('#ed-name-warn').textContent = err;
  $('#ed-name-warn').hidden = !err;
}
$('#ed-name').addEventListener('input', edCheckName);

function openEditor({ id = null, values = null, name = '', fromEdit = false }) {
  const p = id ? findPreset(id) : null;
  ed.id = p ? p.id : null;
  ed.fromEdit = fromEdit;
  $('#ed-title').textContent = p ? '프리셋 편집' : '새 프리셋';
  $('#ed-name').value = p ? p.name : name;
  $('#ed-name-warn').hidden = true;
  $('#ed-parse-note').hidden = true;
  const vals = fullValues(p ? p.values : values);
  for (const k of KEYS) edSet(k, vals[k]);

  // 샘플 사진이 있으면 실시간 미리보기
  const wrap = $('#ed-preview-wrap');
  wrap.hidden = !state.previewSource;
  if (state.previewSource) {
    const canvas = h('canvas', { id: 'ed-canvas' });
    $('#ed-canvas').replaceWith(canvas);
    try {
      ed.renderer = new Renderer(canvas, { p3: state.settings.p3 });
      ed.renderer.setSource(state.previewSource);
      edRender();
    } catch {
      ed.renderer = null;
      wrap.hidden = true;
    }
  }
  openSheet('#sheet-editor');
}

function closeEditor() {
  ed.renderer?.dispose();
  ed.renderer = null;
  closeSheet('#sheet-editor');
}

$('#ed-save').addEventListener('click', () => {
  const name = $('#ed-name').value.trim();
  const err = nameError(name, ed.id);
  if (err) {
    $('#ed-name-warn').textContent = err;
    $('#ed-name-warn').hidden = false;
    $('#ed-name').focus();
    return;
  }
  const values = { ...ed.values };
  if (ed.id) {
    const p = findPreset(ed.id);
    p.name = name;
    p.values = values;
    if (state.presetId === p.id) { state.values = { ...values }; scheduleRender(); }
    persistPresets();
    renderList();
    renderChips();
    renderAdjTabs();
    toast('저장했습니다');
  } else {
    const p = { id: newId(), name, values, fav: false };
    state.presets.push(p);
    if (ed.fromEdit) { state.presetId = p.id; state.values = { ...values }; }
    afterPresetAdded();
    toast(`'${name}' 프리셋을 만들었습니다`);
  }
  closeEditor();
});

$('#ed-zero').addEventListener('click', () => { for (const k of KEYS) edSet(k, 0); });

// 텍스트로 채우기: 파싱해서 폼에 채우기만 한다 (저장은 사용자가 확인 후)
$('#ed-fill-text').addEventListener('click', async () => {
  let text = '';
  let error = '';
  let result;
  for (;;) {
    const ta = h('textarea', { value: text, placeholder: '예)\n• 노출: -35\n• 하이라이트: -70\n• 대비: +35' });
    const body = h('div', {}, ta);
    if (error) body.append(h('p', { className: 'warn', textContent: error }));
    const ok = await modal({ title: '텍스트로 채우기', body, buttons: [{ label: '채우기', value: true, cls: 'primary' }, { label: '취소', value: false }] });
    if (!ok) return;
    text = ta.value;
    result = parsePresetText(text);
    if (result.presets.length) break;
    error = '인식한 보정 항목이 없습니다. "노출: -35" 처럼 한 줄에 하나씩 적어 주세요.';
  }
  let chosen = result.presets[0];
  if (result.presets.length > 1) {
    const idx = await modal({
      title: `${result.presets.length}개의 프리셋이 있습니다`,
      body: '폼에 채울 프리셋을 고르세요.',
      buttons: [...result.presets.map((p, i) => ({ label: p.name || `프리셋 ${i + 1}`, value: i })), { label: '취소', value: null }],
    });
    if (idx === null) return;
    chosen = result.presets[idx];
  }
  const vals = fullValues(chosen.values);
  for (const k of KEYS) edSet(k, vals[k]);
  if (chosen.name && !$('#ed-name').value.trim()) $('#ed-name').value = chosen.name;
  edCheckName();

  const note = $('#ed-parse-note');
  note.replaceChildren(h('b', { textContent: `${Object.keys(chosen.values).length}개 항목을 채웠습니다.` }), ' 확인하고 저장하세요.');
  if (result.unrecognized.length) {
    note.append(h('div', { textContent: '인식하지 못한 줄:' }),
      h('code', { textContent: result.unrecognized.map((u) => `${u.line}행: ${u.text}`).join('\n') }));
  }
  note.hidden = false;
});

// ── 가져오기 (백업 파일 / 공유 링크) ─────────────────────
let importCandidates = [];
function openImport(list) {
  importCandidates = list;
  const ul = $('#imp-list');
  ul.replaceChildren();
  for (const [i, p] of list.entries()) {
    const cb = h('input', { type: 'checkbox', checked: true });
    cb.dataset.i = i;
    ul.append(h('li', {}, h('label', {}, cb, h('div', {},
      h('div', { className: 'name', textContent: p.name }),
      h('div', { className: 'hint left', textContent: summarize(p.values) })))));
  }
  openSheet('#sheet-import');
}

$('#imp-ok').addEventListener('click', () => {
  const picked = [...document.querySelectorAll('#imp-list input:checked')].map((cb) => importCandidates[cb.dataset.i]);
  for (const p of picked) state.presets.push({ ...p, id: newId(), name: uniqueName(p.name, state.presets) });
  closeSheet('#sheet-import');
  if (picked.length) {
    afterPresetAdded();
    toast(`${picked.length}개 프리셋을 가져왔습니다`);
    switchView('presets');
  }
});

function checkHash() {
  const list = presetsFromHash(location.hash);
  if (list === null) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (!list.length) { toast('공유 링크를 읽지 못했습니다'); return; }
  openImport(list);
}
window.addEventListener('hashchange', checkHash);

// ── 저장 (풀해상도, 한 장씩) ─────────────────────────────
let exported = [];
$('#btn-export').addEventListener('click', async () => {
  if (!state.photos.length) { pickPhotos(); return; }
  const values = { ...state.values };
  const photos = state.photos;
  const maxPixels = maxPixelsFor(state.settings.maxRes);
  exported = [];
  const errors = [];
  $('#ex-title').textContent = '처리 중…';
  $('#ex-actions').hidden = true;
  $('#ex-progress').value = 0;
  openSheet('#sheet-export');
  for (const [i, file] of photos.entries()) {
    $('#ex-detail').textContent = `${i + 1} / ${photos.length} · ${file.name || ''}`;
    await nextFrame();
    try {
      const { blob, width, height } = await exportJpeg(file, values, { maxPixels, p3: state.settings.p3 });
      exported.push(new File([blob], exportName(file), { type: 'image/jpeg', lastModified: Date.now() }));
      $('#ex-detail').textContent = `${i + 1} / ${photos.length} · ${width}×${height}`;
    } catch (e) {
      errors.push(`${file.name || i + 1}: ${e.message}`);
    }
    $('#ex-progress').value = (i + 1) / photos.length;
  }
  // 공유 시트는 사용자 탭(제스처) 안에서만 열리므로 버튼을 한 번 더 누르게 한다
  $('#ex-title').textContent = exported.length ? `${exported.length}장 준비됨` : '저장할 사진이 없습니다';
  $('#ex-detail').textContent = errors.length ? `실패 ${errors.length}장 — ${errors.join(' / ')}` : '“사진에 저장” → 공유 시트에서 “이미지 저장”';
  $('#ex-share').hidden = !exported.length;
  $('#ex-download').hidden = !exported.length;
  $('#ex-actions').hidden = false;
});

$('#ex-share').addEventListener('click', async () => {
  if (await shareOrDownload(exported)) toast('저장했습니다');
});
$('#ex-download').addEventListener('click', () => download(exported));
$('#ex-close').addEventListener('click', () => {
  exported = [];
  closeSheet('#sheet-export');
});

// ── 설정 / 백업 ──────────────────────────────────────────
function renderSettings() {
  const box = $('#set-res');
  box.replaceChildren();
  for (const o of MAX_RES_OPTIONS) {
    const radio = h('input', { type: 'radio', name: 'res', checked: state.settings.maxRes === o.id });
    radio.addEventListener('change', () => { state.settings.maxRes = o.id; saveSettings(state.settings); });
    box.append(h('label', {}, o.label, radio));
  }
  const side = renderer?.maxSide || 0;
  const mp = Math.min(side * side, IOS_MAX_PIXELS) / 1e6;
  $('#set-limits').textContent = `이 기기 한도: 긴 변 ${side}px, 약 ${mp.toFixed(1)}MP. 넘는 사진(예: 48MP)은 긴 변 기준으로 축소해 저장합니다. 큰 해상도는 느리고 메모리를 많이 씁니다.`;
  $('#set-p3').checked = state.settings.p3;
  $('#set-persist').textContent = state.persisted === true
    ? '저장소 영구 보관: 허용됨'
    : '저장소 영구 보관: 허용 안 됨 — 홈 화면에 추가해서 쓰면 더 안전합니다. 그래도 백업을 권합니다.';
}

$('#btn-settings').addEventListener('click', () => { renderSettings(); openSheet('#sheet-settings'); });
$('#set-p3').addEventListener('change', (e) => {
  state.settings.p3 = e.target.checked;
  saveSettings(state.settings);
  createPreviewRenderer();
});

function exportBackup() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const file = new File([backupBlob(state.presets)], `retouch-presets-${stamp}.json`, { type: 'application/json' });
  shareOrDownload([file]);
}
$('#set-export').addEventListener('click', exportBackup);
$('#set-import').addEventListener('click', () => $('#file-backup').click());
$('#file-backup').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const list = parseBackup(await file.text());
    closeSheet('#sheet-settings');
    openImport(list);
  } catch (err) {
    toast(`가져오지 못했습니다: ${err.message}`, 3500);
  }
});

// ── 시작 ─────────────────────────────────────────────────
try {
  createPreviewRenderer();
} catch (e) {
  $('#empty').replaceChildren(h('p', { textContent: `이 브라우저에서 WebGL 을 쓸 수 없어 보정할 수 없습니다. (${e.message})` }));
}
renderChips();
renderAdjTabs();
checkHash();

navigator.storage?.persist?.().then((granted) => { state.persisted = granted; }).catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
