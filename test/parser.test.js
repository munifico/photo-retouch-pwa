import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePresetText } from '../parser.js';

const VINTAGE = {
  exposure: -35, highlights: -70, shadows: -30, contrast: 35,
  brightness: 10, blackPoint: 5, saturation: 25, vibrance: 20,
};

const EXAMPLE = `• 노출: -35
• 하이라이트: -70
• 그림자: -30
• 대비: +35
• 밝기: +10
• 블랙 포인트: +5
• 채도: +25
• 색 선명도: +20`;

const one = (text) => {
  const r = parsePresetText(text);
  assert.equal(r.presets.length, 1, JSON.stringify(r));
  return r;
};

test('원본 예시', () => {
  const r = one(EXAMPLE);
  assert.deepEqual(r.presets[0].values, VINTAGE);
  assert.equal(r.presets[0].name, null);
  assert.deepEqual(r.unrecognized, []);
});

test('괄호 설명은 무시하고 숫자만 믿는다 (블랙 포인트 설명이 반대여도)', () => {
  const r = one(`노출: -35 (전체를 살짝 어둡게)
블랙 포인트: +5 (블랙을 띄운다)
대비 +35（중간톤 기준）
채도: +25 (닫히지 않은 설명`);
  assert.deepEqual(r.presets[0].values, { exposure: -35, blackPoint: 5, contrast: 35, saturation: 25 });
  assert.deepEqual(r.unrecognized, []);
});

test('영문', () => {
  const r = one(`Exposure: -35
Highlights: -70
Shadows: -30
Contrast: +35
Brightness: +10
Black Point: +5
Saturation: +25
Vibrance: +20
Warmth: 15
Tint: -5
Sharpness: 10
Definition: 20
Noise Reduction: 30
Vignette: 25
Brilliance: 40`);
  assert.deepEqual(r.presets[0].values, {
    ...VINTAGE, warmth: 15, tint: -5, sharpness: 10, definition: 20,
    noiseReduction: 30, vignette: 25, brilliance: 40,
  });
});

test('부호 없음 = 양수, 구분자 다양', () => {
  const r = one(`노출 -35
대비 35
채도=25
밝기 → 10
색선명도:20`);
  assert.deepEqual(r.presets[0].values, { exposure: -35, contrast: 35, saturation: 25, brightness: 10, vibrance: 20 });
});

test('유니코드 마이너스 / 대시 / 전각 부호', () => {
  const r = one(`노출: −35
하이라이트: –70
그림자: —30
대비: ＋35
밝기: －10
블랙 포인트: - 5`);
  assert.deepEqual(r.presets[0].values, {
    exposure: -35, highlights: -70, shadows: -30, contrast: 35, brightness: -10, blackPoint: -5,
  });
});

test('여러 프리셋 묶음 — 빈 줄 + 이름', () => {
  const r = parsePresetText(`빈티지 필름
${EXAMPLE}

따뜻한 오후
• 따뜻함: +30
• 노출: +10`);
  assert.equal(r.presets.length, 2);
  assert.equal(r.presets[0].name, '빈티지 필름');
  assert.deepEqual(r.presets[0].values, VINTAGE);
  assert.equal(r.presets[1].name, '따뜻한 오후');
  assert.deepEqual(r.presets[1].values, { warmth: 30, exposure: 10 });
});

test('여러 프리셋 묶음 — 명시적 헤더 형식', () => {
  const r = parsePresetText(`[빈티지 필름]
노출 -35
## 차가운 아침
따뜻함 -40
프리셋 3: 흑백
채도 -100
**쨍한 하늘**:
대비 +20`);
  assert.deepEqual(r.presets.map((p) => p.name), ['빈티지 필름', '차가운 아침', '흑백', '쨍한 하늘']);
  assert.deepEqual(r.presets[2].values, { saturation: -100 });
  assert.deepEqual(r.presets[3].values, { contrast: 20 });
});

test('한 줄 요약 형식 (목록 요약을 그대로 붙여넣기)', () => {
  const r = one('노출 -35 · 대비 +35 · 채도 +25');
  assert.deepEqual(r.presets[0].values, { exposure: -35, contrast: 35, saturation: 25 });
  const r2 = one('Exposure -35, Contrast 35; Saturation 25');
  assert.deepEqual(r2.presets[0].values, { exposure: -35, contrast: 35, saturation: 25 });
});

test('번호 목록 / 마크다운 굵게 / 별칭', () => {
  const r = one(`1. **노출**: -35
2) 섀도우: -30
- 블랙: 5
* 생동감: 20
- 비네팅: 10`);
  assert.deepEqual(r.presets[0].values, { exposure: -35, shadows: -30, blackPoint: 5, vibrance: 20, vignette: 10 });
});

test('인식 못 한 줄은 표시하고 나머지는 계속', () => {
  const r = one(`노출: -35
광택: +20
대비: 높게
채도: +25`);
  assert.deepEqual(r.presets[0].values, { exposure: -35, saturation: 25 });
  assert.deepEqual(r.unrecognized, [
    { line: 2, text: '광택: +20' },
    { line: 3, text: '대비: 높게' },
  ]);
});

test('이름 다음 설명 줄은 인식 못 함으로', () => {
  const r = one(`빈티지 필름
바랜 느낌의 필름 톤
노출 -35`);
  assert.equal(r.presets[0].name, '빈티지 필름');
  assert.deepEqual(r.unrecognized, [{ line: 2, text: '바랜 느낌의 필름 톤' }]);
});

test('범위 밖 값은 ±100 으로, 소수는 반올림', () => {
  const r = one('노출: -150\n대비: 12.6');
  assert.deepEqual(r.presets[0].values, { exposure: -100, contrast: 13 });
});

test('같은 항목이 두 번이면 마지막 값', () => {
  assert.deepEqual(one('노출 -10\n노출 -35').presets[0].values, { exposure: -35 });
});

test('선명도와 색 선명도를 구분', () => {
  assert.deepEqual(one('선명도 10\n색 선명도 20').presets[0].values, { sharpness: 10, vibrance: 20 });
});

test('빈 입력 / 값 없는 텍스트', () => {
  assert.deepEqual(parsePresetText(''), { presets: [], unrecognized: [] });
  assert.deepEqual(parsePresetText('그냥 메모').presets, []);
  assert.deepEqual(parsePresetText(null).presets, []);
});

test('CRLF 줄바꿈', () => {
  assert.deepEqual(one('노출: -35\r\n대비: +35\r\n').presets[0].values, { exposure: -35, contrast: 35 });
});

test('선명도·명료도·노이즈 감소는 0~100 (음수는 0)', () => {
  assert.deepEqual(one('선명도 -20\n명료도 30\n노이즈 감소 -5').presets[0].values, { sharpness: 0, definition: 30, noiseReduction: 0 });
});
