// 보정값 텍스트 파서.
// 규칙: 별칭 사전으로 항목 인식, 괄호 설명은 무시(숫자만 믿는다), 부호 처리(유니코드 마이너스 등),
//       인식 못 한 줄은 따로 돌려준다. 여러 프리셋 묶음도 지원.
import { KEYS, clampValue } from './adjustments.js';

// 정규화된 이름(소문자, 글자/숫자만) → 키
const ALIASES = {
  exposure: ['노출', 'exposure', '노출값'],
  brilliance: ['휘도', 'brilliance', '브릴리언스', '브릴리안스', '광채'],
  highlights: ['하이라이트', 'highlights', 'highlight', '밝은영역'],
  shadows: ['그림자', 'shadows', 'shadow', '섀도', '섀도우', '쉐도우', '어두운영역'],
  contrast: ['대비', 'contrast', '콘트라스트'],
  brightness: ['밝기', 'brightness'],
  blackPoint: ['블랙포인트', 'blackpoint', '블랙', '검정점', '검은점'],
  saturation: ['채도', 'saturation'],
  vibrance: ['색선명도', 'vibrance', '생동감', '바이브런스', '자연채도'],
  warmth: ['따뜻함', 'warmth', '색온도', '온도', 'temperature', 'temp'],
  tint: ['색조', 'tint', '틴트'],
  sharpness: ['선명도', 'sharpness', '샤프니스', '샤픈', 'sharpen'],
  definition: ['명료도', 'definition', 'clarity', '정의', '디피니션'],
  noiseReduction: ['노이즈감소', 'noisereduction', '노이즈제거', '노이즈', 'noise'],
  vignette: ['비네트', 'vignette', '비네팅', 'vignetting'],
};

const ALIAS_MAP = new Map();
for (const [key, names] of Object.entries(ALIASES)) {
  if (!KEYS.includes(key)) throw new Error(`unknown key in ALIASES: ${key}`);
  for (const n of names) ALIAS_MAP.set(normName(n), key);
}

function normName(s) {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// 마이너스로 취급할 문자: - − ‒ – — ﹣ －  (NFKC 후에도 남는 것 포함)
const NEG = '\\-\u2212\u2012\u2013\u2014\uFE63\uFF0D';
const SEGMENT_RE = new RegExp(
  `^(.*?)\\s*[:=→>]*\\s*([+\uFF0B${NEG}])?\\s*(\\d+(?:\\.\\d+)?)\\s*%?$`, 'u');
const BULLET_RE = /^(?:[•·∙◦▪▫●○■□▶►✓✔\-–—*>]|\d+[.)])\s+/u;
const HEADER_RES = [
  /^\[(.+)\]$/u,
  /^【(.+)】$/u,
  /^#+\s*(.+)$/u,
  /^(?:프리셋|preset|필터|filter)\s*\d*\s*[:：]\s*(.+)$/iu,
  /^([^\d:：]+)[:：]$/u, // 숫자 없이 콜론으로 끝나는 줄
];

function stripParens(s) {
  // 닫히지 않은 괄호는 줄 끝까지 지운다
  return s.replace(/\([^)]*(?:\)|$)/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseSegment(seg) {
  const m = seg.match(SEGMENT_RE);
  if (!m) return null;
  const key = ALIAS_MAP.get(normName(m[1]));
  if (!key) return null;
  const raw = Number(m[3]);
  const signed = m[2] && m[2] !== '+' && m[2] !== '\uFF0B' ? -raw : raw;
  return { key, value: clampValue(signed, key), clamped: clampValue(signed, key) !== Math.round(signed) };
}

/**
 * @param {string} text
 * @returns {{presets: {name: string|null, values: Record<string, number>}[],
 *            unrecognized: {line: number, text: string}[]}}
 *   values 에는 텍스트에 나온 항목만 들어 있다 (나머지는 0 으로 간주).
 */
export function parsePresetText(text) {
  const presets = [];
  const unrecognized = [];
  let cur = null;
  let prevBlank = true;

  const startPreset = (name) => {
    cur = { name, values: {} };
    presets.push(cur);
  };
  const hasValues = () => cur && Object.keys(cur.values).length > 0;

  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((raw, i) => {
    let line = raw.normalize('NFKC').trim();
    line = line.replace(BULLET_RE, '').replace(/[*`_]+/g, '').trim();
    if (!line) {
      prevBlank = true;
      return;
    }
    const report = () => unrecognized.push({ line: i + 1, text: raw.trim() });

    // 명시적 헤더: [이름], 【이름】, # 이름, 프리셋: 이름
    for (const re of HEADER_RES) {
      const m = line.match(re);
      if (m && !parseSegment(stripParens(m[1]))) {
        startPreset(stripParens(m[1]).replace(/[:：]$/, '').trim());
        prevBlank = false;
        return;
      }
    }

    line = stripParens(line);
    if (!line) {
      prevBlank = false;
      return; // 괄호 설명만 있는 줄
    }
    const segs = line.split(/\s*[·,;|]\s*|\s+\/\s+/u).filter(Boolean);
    const parsed = segs.map(parseSegment);

    if (parsed.every((p) => !p)) {
      // 숫자 없는 줄은 이름 후보: 첫 줄이거나 빈 줄 뒤일 때만 새 프리셋 이름으로 본다
      const name = line.replace(/[:：]$/, '').trim();
      if (!/\d/.test(line) && (!cur || prevBlank || !hasValues())) {
        if (cur && !hasValues()) {
          if (cur.name === null) cur.name = name;
          else report(); // 이름 다음의 설명 줄
        } else {
          startPreset(name);
        }
      } else {
        report();
      }
      prevBlank = false;
      return;
    }

    if (!cur) startPreset(null);
    parsed.forEach((p, j) => {
      if (p) cur.values[p.key] = p.value;
      else unrecognized.push({ line: i + 1, text: segs[j] });
    });
    prevBlank = false;
  });

  return { presets: presets.filter((p) => Object.keys(p.values).length > 0), unrecognized };
}
