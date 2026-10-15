// 프리셋/설정 저장 (localStorage), 백업 JSON, 공유 링크.
import { ADJUSTMENTS, KEYS, emptyValues, clampValue } from './adjustments.js';

const PRESETS_KEY = 'retouch.presets.v1';
const SETTINGS_KEY = 'retouch.settings.v1';
const BACKUP_APP = 'photo-retouch-pwa';

export const DEFAULT_PRESETS = [
  {
    name: '빈티지 필름',
    values: { exposure: -35, highlights: -70, shadows: -30, contrast: 35, brightness: 10, blackPoint: 5, saturation: 25, vibrance: 20 },
  },
  {
    // 실사판 《룩백》(2026, 35mm 필름) 스틸 측정: 블랙이 뜸, 낮은 채도, 그림자 살짝 차갑고 밝은 곳 따뜻함
    name: '룩백 필름',
    values: { exposure: 25, brightness: 40, contrast: -20, highlights: -40, saturation: -20, warmth: 25, tint: -5, fade: 45, shadowTone: -20, highlightTone: 40, grain: 30 },
  },
];

const DEFAULT_SETTINGS = { maxRes: '12', p3: true, backupHintShown: false };

function readJSON(key) {
  try {
    const s = localStorage.getItem(key);
    return s == null ? null : JSON.parse(s);
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function fullValues(values) {
  const v = emptyValues();
  for (const k of KEYS) if (values && k in values) v[k] = clampValue(values[k], k);
  return v;
}

export function nonZero(values) {
  return Object.fromEntries(KEYS.filter((k) => values?.[k]).map((k) => [k, values[k]]));
}

export function normalizePreset(p) {
  return {
    id: typeof p?.id === 'string' && p.id ? p.id : newId(),
    name: String(p?.name ?? '').trim().slice(0, 40) || '이름 없음',
    values: fullValues(p?.values),
    fav: !!p?.fav,
  };
}

/** 처음 실행이면 기본 프리셋을 넣어서 돌려준다. */
export function loadPresets() {
  const data = readJSON(PRESETS_KEY);
  if (Array.isArray(data?.presets)) return data.presets.map(normalizePreset);
  return DEFAULT_PRESETS.map(normalizePreset);
}

export function savePresets(presets) {
  return writeJSON(PRESETS_KEY, { version: 1, presets });
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(readJSON(SETTINGS_KEY) || {}) };
}

export function saveSettings(s) {
  return writeJSON(SETTINGS_KEY, s);
}

const fmt = (v) => (v > 0 ? `+${v}` : `${v}`);

/** "노출 -35 · 대비 +35 · 채도 +25" */
export function summarize(values) {
  const parts = ADJUSTMENTS.filter((a) => values?.[a.key]).map((a) => `${a.label} ${fmt(values[a.key])}`);
  return parts.length ? parts.join(' · ') : '변경 없음';
}

export function sameName(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** 겹치지 않는 이름: "이름", "이름 (2)", ... */
export function uniqueName(name, presets, exceptId = null) {
  const taken = (n) => presets.some((p) => p.id !== exceptId && sameName(p.name, n));
  if (!taken(name)) return name;
  for (let i = 2; ; i++) if (!taken(`${name} (${i})`)) return `${name} (${i})`;
}

// ── 백업 ─────────────────────────────────────────────────
export function backupBlob(presets) {
  const data = {
    app: BACKUP_APP,
    version: 1,
    exportedAt: new Date().toISOString(),
    presets: presets.map((p) => ({ name: p.name, values: nonZero(p.values), fav: p.fav })),
  };
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

/** 백업 JSON → 프리셋 배열 (id 는 새로). 형식이 틀리면 throw. */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSON 형식이 아닙니다');
  }
  const list = Array.isArray(data) ? data : data?.presets;
  if (!Array.isArray(list) || !list.length) throw new Error('프리셋이 들어 있지 않습니다');
  return list.map((p) => normalizePreset({ name: p?.name, values: p?.values, fav: p?.fav }));
}

// ── 공유 링크 (#p=<base64url JSON>) ──────────────────────
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function shareLink(preset, base = location.href) {
  const payload = b64urlEncode(JSON.stringify({ n: preset.name, v: nonZero(preset.values) }));
  return base.replace(/#.*$/, '') + '#p=' + payload;
}

/** location.hash → 프리셋 배열 또는 null */
export function presetsFromHash(hash) {
  const m = /^#p=([A-Za-z0-9_-]+)$/.exec(hash || '');
  if (!m) return null;
  try {
    const d = JSON.parse(b64urlDecode(m[1]));
    const list = Array.isArray(d) ? d : [d];
    return list.map((x) => normalizePreset({ name: x.n, values: x.v }));
  } catch {
    return [];
  }
}
