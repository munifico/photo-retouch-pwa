// 보정 항목 정의 + 계수 + 셰이더. 튜닝은 이 파일만 고치면 된다.
//
// 구조는 iOS 18 사진 앱(PhotoImaging/CoreImage) 역공학 분석을 따라 다시 짰다 (계산식은 직접 다시 씀).
// 확실도 표시: [V] 디컴파일 코드에서 확인 / [I] 간접 근거로 추론 / [U] 모름 — 보정 사진으로 맞출 값.
//
// 값 흐름: UI 값(-100~100) → uniformValue() 에서 /100 × UI_SCALE → 셰이더 u_<key>.
// 작업 공간은 선형 RGB [V]. 커널 내부의 sqrt/제곱은 Apple 커널이 쓰는 "지각 공간" 트릭이다.

export const ADJUSTMENTS = [
  { key: 'exposure', label: '노출', en: 'Exposure' },
  { key: 'brilliance', label: '휘도', en: 'Brilliance' },
  { key: 'highlights', label: '하이라이트', en: 'Highlights' },
  { key: 'shadows', label: '그림자', en: 'Shadows' },
  { key: 'contrast', label: '대비', en: 'Contrast' },
  { key: 'brightness', label: '밝기', en: 'Brightness' },
  { key: 'blackPoint', label: '블랙 포인트', en: 'Black Point' },
  { key: 'saturation', label: '채도', en: 'Saturation' },
  { key: 'vibrance', label: '색 선명도', en: 'Vibrance' },
  { key: 'warmth', label: '따뜻함', en: 'Warmth' },
  { key: 'tint', label: '색조', en: 'Tint' },
  // 아래 셋은 아이폰처럼 0~100 단방향 [I] (스키마 최솟값 0)
  { key: 'sharpness', label: '선명도', en: 'Sharpness', min: 0 },
  { key: 'definition', label: '명료도', en: 'Definition', min: 0 },
  { key: 'noiseReduction', label: '노이즈 감소', en: 'Noise Reduction', min: 0 },
  { key: 'vignette', label: '비네트', en: 'Vignette' },
  // 필름 [앱 전용 — 아이폰 사진 앱에 없는 항목. 아이폰 값을 붙여넣으면 0]
  { key: 'grain', label: '그레인', en: 'Grain', min: 0 },
  { key: 'fade', label: '바랜 검정', en: 'Fade', min: 0 },
  { key: 'shadowTone', label: '그림자 색감', en: 'Shadow Tone' }, // − 차갑게(청록) / + 따뜻하게
  { key: 'highlightTone', label: '밝은 곳 색감', en: 'Highlight Tone' },
];

export const KEYS = ADJUSTMENTS.map((a) => a.key);
export const LABELS = Object.fromEntries(ADJUSTMENTS.map((a) => [a.key, a.label]));
export const MAX = 100;
const MINS = Object.fromEntries(ADJUSTMENTS.map((a) => [a.key, a.min ?? -100]));
export const minOf = (key) => MINS[key] ?? -100;

export function emptyValues() {
  return Object.fromEntries(KEYS.map((k) => [k, 0]));
}

// 숫자 하나를 그 항목의 범위(-100~100 또는 0~100) 정수로
export function clampValue(v, key) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(minOf(key), Math.min(MAX, n));
}

// ── UI ±100 이 필터 입력 몇에 해당하나 ─────────────────────
// 슬라이더 표시값 = 입력 × 100 / ui_max [V]. ui_max 자체는 디컴파일에 없다.
// ⚠️ 미결정 (2026-10-14): 캘리브레이션 차트(SDR PNG)는 모든 톤 항목이 1.0 에서 아이폰과 RMSE ≤0.4/255 로 일치했다.
// 0.3 은 HDR(게인맵) 카메라 사진 1장(빈티지 프리셋)에 우연히 맞춘 값이다. 아이폰은 HDR 사진을 별도 경로로 처리하므로
// 배율 하나로는 둘 다 맞출 수 없다 — handoff.md "다음에 할 일" 참고.
export const UI_SCALE = {
  exposure: 0.3, // [실측 1장] 0.3 → 노출 -100 = 게인 2^-0.6
  brilliance: 0.3, // [추정] 같은 SmartTone 그룹이라 같이 둠
  highlights: 0.3, // [실측 1장]
  shadows: 0.3, // [실측 1장]
  contrast: 0.3, // [실측 1장]
  brightness: 0.3, // [실측 1장]
  blackPoint: 0.3, // [실측 1장]
  saturation: 1.0, // [I] 실측 1장과도 대체로 맞음
  vibrance: 1.0, // [I] 실측 1장과도 대체로 맞음
  warmth: 0.5, // [U] 붙여넣기 fallback 이 ±0.5
  tint: 1.0, // [U] 붙여넣기 fallback 이 ±1.0
  sharpness: 1.0, // [U] intensity 0~?
  definition: 1.0, // [U] intensity 0~? (필터에는 ×2)
  noiseReduction: 1.0, // [U] 반경 단위 모름 — 아래 COEF.noiseStrength 로 근사
  vignette: 1.0, // [I] intensity -1~1
};

export function uniformValue(key, v) {
  return ((Number(v) || 0) / 100) * (UI_SCALE[key] ?? 1);
}

// ── 튜닝 계수 ([U] 항목 위주) ─────────────────────────────
// 셰이더에는 `#define K_<이름> <값>` 으로 들어간다.
export const COEF = {
  wbStrength: 1.0, // [U] PIColorBalanceFilter inputStrength 기본값

  // 그림자 −: 원래 CIHighlightShadowAdjust(상수 소실). 차트 실측(−100)에 맞춘 채널별 식
  //   c − s·A·max(1 − c/B, 0)  (선형, 0 에서 자름). 중간 값(−30 등)은 s 에 비례한다고 가정 [실측 −100 만]
  shadowsNegA: 0.0475, // [실측] RMSE 1.5/255
  shadowsNegB: 0.48, // [실측]

  // 밝기 +: 실측 차트에선 iOS 18 커널의 c^… 혼합항이 없고 1−(1−c)^γ 항만 맞았다 (현재 iOS 에서 바뀐 듯)
  brightnessGain: 1.45, // [실측] γ = 1 + 이것·b. RMSE 1.1/255

  noiseStrength: 1.0, // [U] Apple 은 바이래터럴. 여기선 3x3 평탄부 블러로 근사
  noiseEdgeLo: 0.02,
  noiseEdgeHi: 0.12,

  sharpenFalloff: 1.0, // [V] sharpen.falloff 기본 1 → 세 스케일 같은 가중

  blurRadiusFrac: 0.03, // [U] 명료도 국소 평균 블러 반경 = 짧은 변 × 이것

  vignetteRadius: 0.4, // [V] 새 비네트의 radius 기본값
  vignetteStart: 0.5, // [실측] CIVignetteEffect 감쇠 시작 거리 (반경 R 대비). RMSE 0.1/255
  vignetteWidth: 1.0, // [실측] 감쇠 폭 (반경 R 대비)

  // 필름 (앱 전용, 눈으로 맞춘 값). 인코딩(sRGB 곡선) 공간 기준
  fadeBlack: 0.18, // 바랜 검정 100 → 순수 블랙이 이만큼 뜸 (≈46/255)
  fadeWhite: 0.05, // 바랜 검정 100 → 순수 흰색이 이만큼 내려감
  toneAmount: 0.07, // 색감 ±100 일 때 색 이동 크기
  grainAmount: 0.10, // 그레인 100 일 때 중간톤 노이즈 폭
  grainCells: 1100.0, // 짧은 변을 몇 칸으로 나눈 입자 크기인가 (해상도와 무관하게 같은 질감)
};

// ── 휘도/그림자용 라이트맵 [V] ─────────────────────────────
// 이미지를 31×31 칸으로 나눠 칸마다 선형 mean(RGB) 8비트 히스토그램의 p50, p98 을 구한다.
// R = (c2 + 1.2) / 3.4, c2 = 2.4413·(p50 − 0.435) (셰이더에서 3.4·R − 1.2 로 복원), G = p98.
export const LIGHTMAP_GRID = 31;
export const LIGHTMAP_CELL = 16; // 칸당 16×16 표본 → 축소 이미지 496×496

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

/** rgba: (GRID·CELL)² 픽셀, 인코딩(sRGB 곡선) 값, 위쪽 행부터 → GRID² RGBA 바이트 */
export function buildLightMap(rgba) {
  const n = LIGHTMAP_GRID;
  const cell = LIGHTMAP_CELL;
  const size = n * cell;
  const out = new Uint8Array(n * n * 4);
  const hist = new Uint32Array(256);
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      hist.fill(0);
      for (let y = cy * cell; y < (cy + 1) * cell; y++) {
        for (let x = cx * cell; x < (cx + 1) * cell; x++) {
          const i = (y * size + x) * 4;
          const m = (SRGB_TO_LINEAR[rgba[i]] + SRGB_TO_LINEAR[rgba[i + 1]] + SRGB_TO_LINEAR[rgba[i + 2]]) / 3;
          hist[Math.round(m * 255)]++;
        }
      }
      const total = cell * cell;
      let acc = 0;
      let p50 = -1;
      let p98 = 1;
      for (let b = 0; b < 256; b++) {
        acc += hist[b];
        if (p50 < 0 && acc >= 0.5 * total) p50 = b / 255;
        if (acc >= 0.98 * total) { p98 = b / 255; break; }
      }
      const c2 = 2.4413 * (p50 - 0.435);
      const o = (cy * n + cx) * 4;
      out[o] = Math.round(255 * Math.max(0, Math.min(1, (c2 + 1.2) / 3.4)));
      out[o + 1] = Math.round(255 * p98);
      out[o + 3] = 255;
    }
  }
  return out;
}

// ── 프래그먼트 셰이더 ─────────────────────────────────────
// GLSL ES 1.00 (WebGL1/2 공용). 순서 [V]: 노이즈 감소 → 화이트밸런스 → 라이트맵(휘도, 그림자+)
// → 노출·블랙 → 밝기 → 그림자− → 하이라이트 → 대비 → 채도 → 색 선명도 → 선명도 → 명료도 → 비네트
// 그 뒤에 앱 전용 필름 단계 (인코딩 공간): 색감 → 바랜 검정 → 그레인
export const FRAGMENT_BODY = /* glsl */ `
float mean3(vec3 c) { return dot(c, vec3(0.333333)); }
float y601(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// 정확한 sRGB 전달 함수 (Display P3 도 같은 커브)
vec3 toLinear(vec3 c) {
  c = max(c, 0.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toEncoded(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

// Apple 톤 커널들이 공유하는 sqrt 공간의 중간톤 피벗 보정 [V]
// cs: sqrt 공간 색, y2 = y(1-y), 결과도 sqrt 공간
vec3 pivotMix(vec3 cs, float y2, float midAmt, float pivot, float w) {
  float a = midAmt * y2;
  vec3 pix = cs + vec3(a * y601(cs) - pivot * a);
  cs = mix(cs, vec3(pivot), -y2 * midAmt);
  return mix(cs, pix, w);
}
vec3 sq(vec3 cs) { cs = max(cs, 0.0); return cs * cs; }

// 따뜻함/색조 [V 수식, U 스케일]: 감마 1/4 YIQ 에서 I/Q 이동, 채도 낮은 픽셀(회색)은 거의 안 움직임
vec3 whiteBalance(vec3 c) {
  float t = u_warmth * 0.25;
  float ti = u_tint * 0.25;
  vec2 shift = vec2(0.9615 * t + 0.0385 * ti, -0.1923 * t + 0.1923 * ti);
  c = c.r * vec3(0.615429622, 0.114831839, 0.011544127) + c.g * vec3(0.367479647, 0.797943554, 0.064077744) + c.b * vec3(0.016956660, 0.087783443, 0.924405601);
  vec3 q = pow(clamp(c, 0.0, 1.0), vec3(0.25));
  vec3 yiq = q.r * vec3(0.299, 0.595716, 0.211456) + q.g * vec3(0.587, -0.274453, -0.522591) + q.b * vec3(0.114, -0.321263, 0.311135);
  float chroma = min(1.0, 2.0 * length(yiq.yz));
  yiq.yz += shift * K_wbStrength * pow(chroma, 0.4);
  q = yiq.x + yiq.y * vec3(0.956296, -0.272122, -1.10699) + yiq.z * vec3(0.621024, -0.647381, 1.70461);
  c = pow(max(q, 0.0), vec3(4.0));
  return c.r * vec3(1.777445503, -0.255296595, -0.004500434) + c.g * vec3(-0.822224875, 1.380948854, -0.085456232) + c.b * vec3(0.045475917, -0.126454738, 1.089973874);
}

// 휘도(lm) + 그림자 양수(sh) [V]: 칸의 중앙값이 0.435 보다 어두우면 밝히고 밝으면 누름
vec3 localLight(vec3 c, vec2 adj, float lm, float sh) {
  float r = 3.4 * adj.x - 1.2;
  vec3 ex = c - clamp(c, 0.0, 1.0); // 범위 밖은 떼어 뒀다가 되돌림 (Apple 커널 공통) [V]
  c -= ex;
  if (lm != 0.0) {
    float y = sqrt(mean3(c));
    float s = r * lm;
    vec3 gain = s > 0.0 ? vec3(1.5 * s) : vec3(1.75 * s, 1.75 * s, 1.55 * s);
    c = clamp(c * c * gain + c * (1.0 - gain), 0.0, 1.0);
    c = clamp(sq(pivotMix(sqrt(c), y * (1.0 - y), min(lm, 0.5), max(adj.y, 0.5), 0.8)), 0.0, 1.0);
  }
  if (sh > 0.0) {
    float y = sqrt(mean3(c));
    float s = r * sh;
    vec3 gain = s > 0.0 ? vec3(0.0) : vec3(s * s) * vec3(-2.75, -2.75, -2.5);
    c = c * c * gain + c * (1.0 - gain);
    c = clamp((1.0 + 1.85 * s * max(0.1 - y, 0.0)) * c, 0.0, 1.0);
    float midAmt = s < 0.0 ? min(s * s, 1.0) : 0.0;
    c = clamp(sq(pivotMix(sqrt(c), y * (1.0 - y), midAmt, 0.4, 0.8)), 0.0, 1.0);
  }
  return c + ex;
}

// 노이즈 감소·선명도를 뺀 전역/국소 톤·색 처리 (선형 입력 → 선형 출력)
vec3 process(vec3 c, vec2 adj) {
  if (u_warmth != 0.0 || u_tint != 0.0) c = whiteBalance(c);
  if (u_brilliance != 0.0 || u_shadows > 0.0) c = localLight(c, adj, u_brilliance, max(u_shadows, 0.0));

  // 노출 + 블랙 포인트 [V]: G = 1/(2^-2e − bk/20), out = G(c − bk/20). + 블랙은 더 진하게
  if (u_exposure != 0.0 || u_blackPoint != 0.0) {
    float B = u_blackPoint / 20.0;
    float G = 1.0 / (exp2(-2.0 * u_exposure) - B);
    c = G * (c - B);
  }

  // 밝기 + [실측 차트]: 1 − ((1−c)^γ + 0.6(γ−1)m(1−m²)/γ²)
  if (u_brightness > 0.0) {
    float g = 1.0 + K_brightnessGain * u_brightness;
    vec3 x = clamp(c, 0.0, 1.0);
    vec3 m = 1.0 - x;
    c = 1.0 - (pow(m, vec3(g)) + 0.6 * ((g - 1.0) * m * (1.0 - m * m)) / (g * g)) + (c - x);
  } else if (u_brightness < 0.0) { // [V 커널, 실측 없음]
    float g = 1.0 - 1.5 * u_brightness;
    vec3 x = max(c, 0.0);
    float lum = dot(x, vec3(0.39, 0.5, 0.11));
    vec3 p2 = lum > 0.0 ? x * pow(lum, g) / lum : vec3(0.0);
    c = mix(pow(x, vec3(g)), p2, 0.8);
  }

  // 그림자 음수 [실측 차트 −100]: 어두운 곳을 빼서 누름, 0 에서 자름
  if (u_shadows < 0.0) {
    c = max(c + u_shadows * K_shadowsNegA * max(1.0 - c / K_shadowsNegB, 0.0), 0.0);
  }

  // 하이라이트 [V]: 밝은 픽셀(lum²)에만
  if (u_highlights != 0.0) {
    float h = u_highlights;
    float E = exp(-h * h / 0.75);
    float highAmt = h <= 0.0 ? 0.55 + 0.45 * E : 1.45 - 0.45 * E;
    float satP = abs(h) < 0.6 ? 0.2 : (abs(h) - 0.6) * 2.0 + 0.2;
    vec3 x = clamp(c, 0.0, 1.0);
    float lum = clamp(mean3(x), 0.0, 1.0);
    vec3 high = pow(x, vec3(3.0 - 2.0 * highAmt));
    vec3 pix1 = (high - 0.8) * (4.0 - 3.0 * highAmt) + 0.8;
    float h4 = highAmt * highAmt * highAmt * highAmt;
    vec3 pix2 = (lum - 0.8) * (4.0 - 3.0 * h4) + 0.8 + high - lum;
    c = mix(x, mix(pix2, pix1, satP), lum * lum) + (c - x);
  }

  // 대비 [V]: sqrt 공간, 중간톤(y(1-y)) 가중
  if (u_contrast != 0.0) {
    float midAmt = 3.4 * u_contrast;
    vec3 x = clamp(c, 0.0, 1.0);
    float y = sqrt(mean3(x));
    vec3 d = x - y;
    float sat = dot(d, d);
    float y2 = y * (1.0 - y);
    vec3 cs = sqrt(x);
    float a = midAmt * y2;
    vec3 pix = cs + vec3(a * y601(cs) - 0.5 * a);
    cs = mix(cs, vec3(0.5), -y2 * midAmt);
    c = sq(mix(cs, pix, 0.8 + sat)) + (c - x);
  }

  // 채도 [V]: v ≤ 0 → 평균 회색 쪽으로, v > 0 → amt = 3v+1 (중간 밝기·푸른 쪽 과포화 억제)
  if (u_saturation != 0.0) {
    float amt = u_saturation <= 0.0 ? u_saturation + 1.0 : 3.0 * u_saturation + 1.0;
    if (amt < 1.0) {
      c = mix(vec3(mean3(c)), c, amt);
    } else {
      vec3 x = clamp(c, 0.0, 1.0);
      float gray = dot(x, vec3(0.3, 0.5, 0.2));
      float yy = dot(x, vec3(0.4, 0.2, 0.1));
      float damp = 1.0 - 4.0 * yy * (1.0 - yy);
      float s = 1.0 / max(c.r + c.g + c.b, 1e-5);
      damp *= 1.0 - 0.8 * smoothstep(0.2, 0.4, (c.r - c.b) * s);
      if (amt > 2.5) damp = min(damp + (amt - 2.5) / 5.0, 1.0);
      c = mix(c, (c - gray) * min(amt, 3.0) + gray, damp);
    }
  }

  // 색 선명도 [V 커널, I 배선]: 저채도일수록 세게, 피부톤 보호
  if (u_vibrance != 0.0) {
    float a = clamp(u_vibrance, -1.0, 1.0);
    vec3 x = clamp(c, 1e-4, 0.9999);
    vec3 ext = c - x;
    float m = mean3(x);
    vec3 dev = max((x - m) / (1.0 - m), (m - x) / m);
    float s = max(dev.r, max(dev.g, dev.b));
    float skin = clamp((1.0 - dev.r) * 4.0 * min(x.r - x.g, 2.0 * x.g - x.b) / m, 0.0, 1.0);
    float prot = 0.15 + 0.7 * skin;
    float k;
    if (a >= 0.0) {
      float a2 = a * a, a3 = a2 * a;
      float g = 3.0 * a + (-1.5 * a - 4.5 * a2) * s + (-0.5 * a + 4.5 * a3) * s * s + (4.5 * a2 - 4.5 * a3 - a) * s * s * s;
      k = (1.0 - prot) * g;
    } else {
      k = (1.0 - prot) * (s * s - s + 1.0) * a;
    }
    c = clamp(x + (x - m) * k, 0.0, 1.0) + ext;
  }
  return c;
}

float lumaLin(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float sY(vec2 uv) { return sqrt(max(lumaLin(toLinear(texture2D(u_src, uv).rgb)), 0.0)); }
// 3x3 [1 2 1]⊗[1 2 1]/16 를 간격 d 로 (sqrt 휘도)
float blurY(vec2 uv, float y0, float d) {
  vec2 o = u_texel * d;
  return (sY(uv + vec2(-o.x, -o.y)) + sY(uv + vec2(o.x, -o.y)) + sY(uv + vec2(-o.x, o.y)) + sY(uv + vec2(o.x, o.y))) * 0.0625
       + (sY(uv + vec2(-o.x, 0.0)) + sY(uv + vec2(o.x, 0.0)) + sY(uv + vec2(0.0, -o.y)) + sY(uv + vec2(0.0, o.y))) * 0.125
       + y0 * 0.25;
}

// 필름 색감 방향: + 따뜻하게(주황), − 차갑게(청록). 크기는 K_toneAmount 로
vec3 filmTone(float v) {
  return v >= 0.0 ? v * vec3(1.0, 0.25, -0.9) : -v * vec3(-0.85, 0.15, 0.7);
}
// 그레인용 해시 (sin 없이 — 큰 좌표에서도 모바일 GPU 정밀도 문제 없음)
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec3 src = texture2D(u_src, v_uv).rgb;
  vec2 adj = texture2D(u_light, v_uv).rg;

  // 노이즈 감소 [U]: 평탄한 곳만 3x3 블러 쪽으로
  if (u_noiseReduction > 0.0) {
    vec2 o = u_texel;
    vec3 small = (texture2D(u_src, v_uv + vec2(-o.x, -o.y)).rgb + texture2D(u_src, v_uv + vec2(o.x, -o.y)).rgb
                + texture2D(u_src, v_uv + vec2(-o.x, o.y)).rgb + texture2D(u_src, v_uv + vec2(o.x, o.y)).rgb) * 0.0625
               + (texture2D(u_src, v_uv + vec2(-o.x, 0.0)).rgb + texture2D(u_src, v_uv + vec2(o.x, 0.0)).rgb
                + texture2D(u_src, v_uv + vec2(0.0, -o.y)).rgb + texture2D(u_src, v_uv + vec2(0.0, o.y)).rgb) * 0.125
               + src * 0.25;
    float flatW = 1.0 - smoothstep(K_noiseEdgeLo, K_noiseEdgeHi, abs(y601(src) - y601(small)));
    src = mix(src, small, clamp(u_noiseReduction * K_noiseStrength * flatW, 0.0, 1.0));
  }

  // Apple 작업 공간은 sRGB 선형 [V]. P3 로 받은 경우 sRGB 선형으로 바꿔 처리하고 마지막에 되돌린다
  // (넓은 색역 색은 범위 밖 값이 되지만 커널들이 범위 밖 부분을 떼었다 되돌리므로 유지된다)
  vec3 c = toLinear(src);
  if (u_p3 > 0.5) c = c.r * vec3(1.224940, -0.042057, -0.019638) + c.g * vec3(-0.224940, 1.042057, -0.078636) + c.b * vec3(0.0, 0.0, 1.098274);
  c = process(c, adj);

  // 선명도 [구조 V, 상수 일부 U]: sqrt 휘도 3스케일 언샤프, 색은 유지
  if (u_sharpness > 0.0) {
    float u = 1.0 - 2.0 * u_sharpness;
    float L = u >= 0.0 ? log(9.0 * u + 1.0) / log(10.0) : -log(-9.0 * u + 1.0) / log(10.0);
    float f = K_sharpenFalloff;
    float S = (1.0 - L) / (1.0 + f + f * f);
    float w0 = S >= 0.1 ? S : 0.0;
    float w1 = f * S >= 0.1 ? f * S : 0.0;
    float w2 = f * f * S >= 0.1 ? f * f * S : 0.0;
    float y0 = sY(v_uv);
    float detail = w0 * (y0 - blurY(v_uv, y0, 1.0)) + w1 * (y0 - blurY(v_uv, y0, 2.0)) + w2 * (y0 - blurY(v_uv, y0, 4.0));
    float yp = sqrt(max(lumaLin(c), 0.0));
    float yn = max(yp + detail, 0.0);
    c *= min((yn * yn) / max(yp * yp, 1e-6), 4.0);
  }

  // 명료도 [V 커널, U 블러 크기]: 국소 평균(블러를 같은 처리에 통과)을 피벗으로 sqrt 공간 대비
  if (u_definition > 0.0) {
    float amt = 2.0 * u_definition;
    vec3 bl = toLinear(texture2D(u_blur, v_uv).rgb);
    if (u_p3 > 0.5) bl = bl.r * vec3(1.224940, -0.042057, -0.019638) + bl.g * vec3(-0.224940, 1.042057, -0.078636) + bl.b * vec3(0.0, 0.0, 1.098274);
    vec3 shc = process(bl, adj);
    float pivot = sqrt(max(mean3(shc), 0.0));
    vec3 x = clamp(c, 0.0, 1.0);
    float y = sqrt(mean3(x));
    c = sq(pivotMix(sqrt(x), y * (1.0 - y), amt, pivot, 0.8)) + (c - x);
  }

  // 비네트 [커널 V, 시작/폭 U]: 반경 R = k·긴 변, smootherstep, + 는 ≈x^2.2 로 어둡게, − 는 밝게
  if (u_vignette != 0.0) {
    vec2 size = 1.0 / u_texel;
    float ip = sign(u_vignette) * pow(abs(u_vignette), 0.6);
    float k = u_vignette >= 0.0 ? (0.5 - K_vignetteRadius) * 0.3 + 0.5 : (0.5 - K_vignetteRadius) * 0.4 + 0.7;
    float r = length((v_uv - 0.5) * size) / (k * max(size.x, size.y));
    float t = clamp((r - K_vignetteStart) / K_vignetteWidth, 0.0, 1.0);
    float S = t * t * t * (t * (6.0 * t - 15.0) + 10.0);
    float m = S * abs(ip);
    if (ip > 0.0) {
      float x = 1.0 - m;
      c *= x * (0.0376 + x * (0.5388 + x * (0.5439 - 0.1206 * x)));
    } else {
      c *= 1.0 + 16.0 * m;
    }
  }

  if (u_p3 > 0.5) c = c.r * vec3(0.822462, 0.033194, 0.017083) + c.g * vec3(0.177538, 0.966806, 0.072397) + c.b * vec3(0.0, 0.0, 0.910520);
  vec3 e = toEncoded(clamp(c, 0.0, 1.0));

  // ── 필름 [앱 전용]: 눈에 보이는 밝기 기준이라 인코딩 공간에서 ──
  // 색감: 그림자/밝은 곳에 따로 색을 얹는다. 밝기는 유지 (색 이동에서 휘도 성분을 뺌)
  if (u_shadowTone != 0.0 || u_highlightTone != 0.0) {
    float y = y601(e);
    vec3 t = filmTone(u_shadowTone) * (1.0 - y) * (1.0 - y) + filmTone(u_highlightTone) * y * y;
    e += (t - y601(t)) * K_toneAmount;
  }
  // 바랜 검정: 블랙을 띄우고(아래쪽 3제곱) 흰색 끝을 살짝 누름(위쪽 4제곱). 단조 증가 유지
  if (u_fade > 0.0) {
    vec3 x = clamp(e, 0.0, 1.0);
    vec3 m = 1.0 - x;
    vec3 x2 = x * x;
    e = x + u_fade * (K_fadeBlack * m * m * m - K_fadeWhite * x2 * x2);
  }
  // 그레인: 흑백 입자, 중간톤에서 가장 강함. 격자 크기를 짧은 변 기준으로 둬서 미리보기와 저장본이 같은 질감
  if (u_grain > 0.0) {
    vec2 size = 1.0 / u_texel;
    vec2 p = v_uv * size * (K_grainCells / min(size.x, size.y));
    float n = valueNoise(p) * 0.7 + valueNoise(p * 2.03 + 17.0) * 0.3 - 0.5;
    float y = clamp(y601(e), 0.0, 1.0);
    e += n * u_grain * K_grainAmount * (0.35 + 2.6 * y * (1.0 - y));
  }

  gl_FragColor = vec4(clamp(e, 0.0, 1.0), 1.0);
}
`;

function glslFloat(v) {
  const s = String(v);
  return /[.e]/.test(s) ? s : s + '.0';
}

// 완성된 프래그먼트 셰이더 소스
export function buildFragmentShader() {
  const defines = Object.entries(COEF).map(([k, v]) => `#define K_${k} ${glslFloat(v)}`).join('\n');
  const uniforms = KEYS.map((k) => `uniform float u_${k};`).join('\n');
  return `precision highp float;
varying vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_blur;
uniform sampler2D u_light;
uniform float u_p3;
uniform vec2 u_texel;
uniform float u_aspect;
${uniforms}
${defines}
${FRAGMENT_BODY}`;
}
