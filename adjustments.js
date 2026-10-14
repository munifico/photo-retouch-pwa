// 보정 항목 정의 + 근사 계수 + 셰이더 커브.
// 아이폰 알고리즘은 비공개라 전부 근사치다. 튜닝은 이 파일의 COEF / FRAGMENT_BODY 만 고치면 된다.
// 값은 UI 에서 -100~100, 셰이더에는 /100 해서 -1~1 로 들어간다 (u_<key>).

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
  { key: 'sharpness', label: '선명도', en: 'Sharpness' },
  { key: 'definition', label: '명료도', en: 'Definition' },
  { key: 'noiseReduction', label: '노이즈 감소', en: 'Noise Reduction' },
  { key: 'vignette', label: '비네트', en: 'Vignette' },
];

export const KEYS = ADJUSTMENTS.map((a) => a.key);
export const LABELS = Object.fromEntries(ADJUSTMENTS.map((a) => [a.key, a.label]));
export const MIN = -100;
export const MAX = 100;

export function emptyValues() {
  return Object.fromEntries(KEYS.map((k) => [k, 0]));
}

// 숫자 하나를 -100~100 정수로
export function clampValue(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(MIN, Math.min(MAX, n));
}

// ── 튜닝 계수 ─────────────────────────────────────────────
// 셰이더에는 `#define K_<이름> <값>` 으로 들어간다.
export const COEF = {
  exposureStops: 1.5, // 값 ±100 → ±1.5 스톱 (선형 공간 2^x 배율)

  highlightsStrength: 0.35, // 하이라이트 ±100 일 때 가장 밝은 영역의 톤 이동량
  highlightsMaskLo: 0.45, // 이 휘도부터 하이라이트 마스크 시작
  highlightsMaskHi: 1.0,
  shadowsStrength: 0.3, // 그림자 ±100 일 때 어두운 영역 톤 이동량
  shadowsMaskHi: 0.55, // 이 휘도까지 그림자 마스크
  toneMaskLocal: 0.5, // 하이라이트/그림자 마스크에 로컬(블러) 휘도를 섞는 비율

  brillianceStrength: 0.22, // 휘도: 로컬 평균이 어두우면 올리고 밝으면 내림

  contrastStrength: 0.6, // 대비 S커브 지수 = 1 + 값×이것

  brightnessGamma: 0.5, // 밝기: 감마 = 2^(-값×이것)

  blackPointStrength: 0.1, // 블랙 포인트 +100 → 0.1 이하를 0 으로 (아이폰: + 가 블랙을 더 진하게)

  saturationStrength: 1.0, // 채도 ±100 → 채도 배율 1±1
  vibranceStrength: 0.9, // 색 선명도: 채도 낮은 픽셀에 더 강하게
  vibranceSkinProtect: 0.7, // 피부톤 보호 비율 (1 = 완전 보호)

  warmthStrength: 0.15, // 따뜻함: R/B 게인 (선형 공간)
  tintStrength: 0.25, // 색조: + 마젠타 / - 그린

  sharpnessStrength: 1.5, // 선명도: 3x3 언샤프 마스크 양
  sharpnessRadiusPx: 1.0, // 선명도 블러 반경 (출력 픽셀)
  definitionStrength: 0.8, // 명료도: 큰 반경 언샤프 (휘도만, 중간톤 위주)
  blurRadiusFrac: 0.03, // 큰 블러(명료도·휘도·마스크 공용) 반경 = 짧은 변 × 이것

  noiseStrength: 1.0, // 노이즈 감소: 평탄한 영역을 3x3 블러 쪽으로
  noiseEdgeLo: 0.02, // 이 차이 이상은 엣지로 보고 덜 뭉갬
  noiseEdgeHi: 0.12,

  vignetteStrength: 0.7, // 비네트 +100 → 가장자리 30% 수준까지 어둡게
  vignetteRadius: 0.45, // 감쇠 시작 거리 (중심 0, 모서리 1)
  vignetteSoftness: 0.65,
};

// ── 프래그먼트 셰이더 ─────────────────────────────────────
// GLSL ES 1.00 (WebGL1/2 공용). 모든 조정을 한 패스에서 처리한다.
// u_src: 원본 (sRGB/P3 인코딩), u_blur: 원본의 큰 반경 블러.
export const FRAGMENT_BODY = /* glsl */ `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// 정확한 sRGB 전달 함수 (Display P3 도 같은 커브)
vec3 toLinear(vec3 c) {
  c = max(c, 0.0);
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
vec3 toEncoded(vec3 c) {
  c = max(c, 0.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

// 중간톤 기준 S커브. g>1 대비↑, g<1 대비↓, g=1 항등
float sCurve(float x, float g) {
  x = clamp(x, 0.0, 1.0);
  return x < 0.5 ? 0.5 * pow(2.0 * x, g) : 1.0 - 0.5 * pow(2.0 - 2.0 * x, g);
}

void main() {
  vec3 src = texture2D(u_src, v_uv).rgb;
  vec3 blur = texture2D(u_blur, v_uv).rgb;

  // 3x3 소반경 블러 (선명도·노이즈 감소용)
  vec2 o = u_texel * K_sharpnessRadiusPx;
  vec3 small = (
      texture2D(u_src, v_uv + vec2(-o.x, -o.y)).rgb + texture2D(u_src, v_uv + vec2(o.x, -o.y)).rgb
    + texture2D(u_src, v_uv + vec2(-o.x,  o.y)).rgb + texture2D(u_src, v_uv + vec2(o.x,  o.y)).rgb) * 0.0625
    + (texture2D(u_src, v_uv + vec2(-o.x, 0.0)).rgb + texture2D(u_src, v_uv + vec2(o.x, 0.0)).rgb
    +  texture2D(u_src, v_uv + vec2(0.0, -o.y)).rgb + texture2D(u_src, v_uv + vec2(0.0, o.y)).rgb) * 0.125
    + src * 0.25;

  // 노이즈 감소: 평탄한 곳만 소반경 블러 쪽으로 (음수는 무시)
  if (u_noiseReduction > 0.0) {
    float edge = abs(luma(src) - luma(small));
    float flatW = 1.0 - smoothstep(K_noiseEdgeLo, K_noiseEdgeHi, edge);
    src = mix(src, small, clamp(u_noiseReduction * K_noiseStrength * flatW, 0.0, 1.0));
  }

  // 1) 노출 — 선형 공간 배율
  float expMul = exp2(u_exposure * K_exposureStops);
  vec3 p = toEncoded(toLinear(src) * expMul);
  float Lb = luma(toEncoded(toLinear(blur) * expMul)); // 노출 반영한 로컬 평균 휘도

  // 2) 하이라이트 / 그림자 — 휘도 마스크
  float L = luma(p);
  float Lm = mix(L, Lb, K_toneMaskLocal);
  float hMask = smoothstep(K_highlightsMaskLo, K_highlightsMaskHi, Lm);
  float sMask = 1.0 - smoothstep(0.0, K_shadowsMaskHi, Lm);
  p += u_highlights * K_highlightsStrength * hMask;
  p += u_shadows * K_shadowsStrength * sMask * (1.0 - sMask * 0.5);

  // 3) 휘도 — 로컬 톤: 어두운 동네는 올리고 밝은 동네는 내림
  p += u_brilliance * K_brillianceStrength * (0.5 - Lb) * 2.0 * (1.0 - abs(luma(p) - 0.5));

  // 4) 대비 — S커브 (휘도에 적용 후 차이를 더함)
  L = luma(p);
  p += sCurve(L, 1.0 + u_contrast * K_contrastStrength) - clamp(L, 0.0, 1.0);

  // 5) 밝기 — 중간톤 감마
  L = clamp(luma(p), 0.0, 1.0);
  p += pow(max(L, 1e-6), exp2(-u_brightness * K_brightnessGamma)) - L;

  // 6) 블랙 포인트 — + 는 블랙을 더 깊게, - 는 블랙을 띄움
  float bp = u_blackPoint * K_blackPointStrength;
  p = bp >= 0.0 ? (p - bp) / (1.0 - bp) : -bp + p * (1.0 + bp);

  // 7) 채도 — 균일
  L = luma(p);
  p = L + (p - L) * (1.0 + u_saturation * K_saturationStrength);

  // 8) 색 선명도 — 채도 낮은 픽셀일수록, 피부톤은 덜
  if (u_vibrance != 0.0) {
    vec3 q = clamp(p, 0.0, 1.0);
    float mx = max(q.r, max(q.g, q.b));
    float mn = min(q.r, min(q.g, q.b));
    float sat = (mx - mn) / (mx + 1e-4);
    float h = (q.g - q.b) / (q.r - q.b + 1e-4); // r>g>b 일 때 0(빨강)~1(노랑)
    float skin = step(q.g, q.r) * step(q.b, q.g)
               * (1.0 - smoothstep(0.15, 0.4, abs(h - 0.4)))
               * smoothstep(0.08, 0.2, sat) * (1.0 - smoothstep(0.5, 0.75, sat));
    float amt = u_vibrance * K_vibranceStrength * (1.0 - sat) * (1.0 - skin * K_vibranceSkinProtect);
    L = luma(p);
    p = L + (p - L) * (1.0 + amt);
  }

  // 9) 따뜻함 / 색조 — 선형 공간 화이트밸런스 시프트, 휘도 유지
  if (u_warmth != 0.0 || u_tint != 0.0) {
    vec3 lin = toLinear(p);
    float before = luma(lin);
    float w = u_warmth * K_warmthStrength;
    float t = u_tint * K_tintStrength;
    lin *= vec3(1.0 + w + t * 0.5, 1.0 - t, 1.0 - w + t * 0.5);
    lin *= before / max(luma(lin), 1e-5);
    p = toEncoded(lin);
  }

  // 10) 선명도 / 명료도 — 언샤프 마스크 (명료도는 큰 반경, 휘도만, 중간톤 위주)
  p += (src - small) * u_sharpness * K_sharpnessStrength;
  float mid = 1.0 - abs(clamp(luma(p), 0.0, 1.0) - 0.5) * 2.0;
  p += (luma(src) - luma(blur)) * u_definition * K_definitionStrength * (0.3 + 0.7 * mid);

  // 11) 비네트 — 방사형 감쇠 (+ 어둡게, - 밝게)
  vec2 d = (v_uv - 0.5) * 2.0;
  d.x *= u_aspect;
  float r = length(d) / length(vec2(u_aspect, 1.0));
  float vm = smoothstep(K_vignetteRadius, K_vignetteRadius + K_vignetteSoftness, r);
  float v = u_vignette * K_vignetteStrength * vm;
  p = v >= 0.0 ? p * (1.0 - v) : p + (1.0 - p) * (-v);

  gl_FragColor = vec4(clamp(p, 0.0, 1.0), 1.0);
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
uniform vec2 u_texel;
uniform float u_aspect;
${uniforms}
${defines}
${FRAGMENT_BODY}`;
}
