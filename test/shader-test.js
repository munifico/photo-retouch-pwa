// 데스크톱 브라우저용 셰이더 검사. 자동 검사는 방향성(밝아지나/어두워지나)과 항등성만 본다 — 아이폰과 같은지는 눈으로.
import { ADJUSTMENTS, KEYS, emptyValues } from '../adjustments.js';
import { Renderer } from '../renderer.js';
import { decodeImage, releaseSource } from '../imageio.js';

// ── 테스트 이미지 ─────────────────────────────────────────
const W = 512;
const H = 384;
const R = { // 영역 (x, y, w, h)
  ramp: [0, 0, 512, 96],
  patches: [0, 96, 512, 96],
  stripes: [16, 208, 224, 64],
  noise: [272, 208, 224, 64],
  dark: [16, 300, 224, 68],
  bright: [272, 300, 224, 68],
};
const PATCHES = [[220, 40, 40], [40, 200, 60], [40, 60, 220], [60, 200, 210], [210, 60, 200], [230, 210, 50], [224, 172, 140], [140, 130, 120]];
const patch = (i) => [i * 64 + 8, 104, 48, 80];

function makeChart() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const inR = (x, y, [rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = [128, 128, 128];
      if (y < 96) { const g = Math.round(x / (W - 1) * 255); v = [g, g, g]; }
      else if (y < 192) v = PATCHES[Math.floor(x / 64)];
      else if (inR(x, y, R.stripes)) { const g = x % 2 ? 100 : 160; v = [g, g, g]; }
      else if (inR(x, y, R.noise)) { const g = Math.round(128 + (rnd() - 0.5) * 24); v = [g, g, g]; }
      else if (inR(x, y, R.dark)) v = [30, 30, 30];
      else if (inR(x, y, R.bright)) v = [225, 225, 225];
      const i = (y * W + x) * 4;
      d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function makeFlat() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, 256, 256);
  return c;
}

// ── 측정 도우미 ───────────────────────────────────────────
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function stats(px, w, [rx, ry, rw, rh]) {
  let n = 0, sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0, sat = 0, maxChroma = 0;
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const i = (y * w + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const l = luma(r, g, b);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      n++; sr += r; sg += g; sb += b; sl += l; sl2 += l * l;
      sat += mx ? (mx - mn) / mx : 0;
      maxChroma = Math.max(maxChroma, mx - mn);
    }
  }
  const mean = sl / n;
  return { r: sr / n, g: sg / n, b: sb / n, l: mean, sd: Math.sqrt(Math.max(0, sl2 / n - mean * mean)), sat: sat / n, maxChroma };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const tr = document.createElement('tr');
  tr.innerHTML = `<td class="${ok ? 'PASS' : 'FAIL'}">${ok ? 'PASS' : 'FAIL'}</td><td></td><td></td>`;
  tr.children[1].textContent = name;
  tr.children[2].textContent = detail;
  document.getElementById('results').append(tr);
}
const f = (n) => n.toFixed(1);

function runAuto() {
  const chart = makeChart();
  const flat = makeFlat();
  const canvas = document.createElement('canvas');
  const r = new Renderer(canvas, { preserveDrawingBuffer: true, p3: false });
  const render = (src, vals) => {
    if (r._cur !== src) { r.setSource(src); r._cur = src; }
    r.render({ ...emptyValues(), ...vals });
    return r.readPixels();
  };
  const src = chart.getContext('2d').getImageData(0, 0, W, H).data;
  const S = (px, region, w = W) => stats(px, w, region);

  // 항등성
  const id = render(chart, {});
  let maxDiff = 0;
  for (let i = 0; i < src.length; i++) if (i % 4 !== 3) maxDiff = Math.max(maxDiff, Math.abs(src[i] - id[i]));
  check('전부 0 이면 원본과 같다 (sRGB↔선형 왕복 포함)', maxDiff <= 1, `최대 차이 ${maxDiff}`);

  const base = S(id, R.ramp);
  for (const [v, dir] of [[50, 1], [-50, -1]]) {
    const s = S(render(chart, { exposure: v }), R.ramp);
    check(`노출 ${v > 0 ? '+' : ''}${v} → ${dir > 0 ? '밝아짐' : '어두워짐'}`, (s.l - base.l) * dir > 5, `램프 평균 ${f(base.l)} → ${f(s.l)}`);
  }
  {
    const lin = S(render(chart, { exposure: 100 / 1.5 }), [200, 0, 16, 96]); // 1스톱: 선형 2배
    const b0 = S(id, [200, 0, 16, 96]);
    const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const ratio = toLin(lin.l) / toLin(b0.l);
    check('노출 1스톱 = 선형 공간 2배', Math.abs(ratio - 2) < 0.15, `비율 ${ratio.toFixed(2)}`);
  }

  {
    const d0 = S(id, R.dark), b0 = S(id, R.bright);
    const hi = render(chart, { highlights: -100 });
    const dh = S(hi, R.dark), bh = S(hi, R.bright);
    check('하이라이트 -100 → 밝은 영역만 내려감', b0.l - bh.l > 10 && Math.abs(dh.l - d0.l) < 2, `밝은 ${f(b0.l)}→${f(bh.l)} / 어두운 ${f(d0.l)}→${f(dh.l)}`);
    const sh = render(chart, { shadows: 100 });
    const ds = S(sh, R.dark), bs = S(sh, R.bright);
    check('그림자 +100 → 어두운 영역만 올라감', ds.l - d0.l > 10 && Math.abs(bs.l - b0.l) < 2, `어두운 ${f(d0.l)}→${f(ds.l)} / 밝은 ${f(b0.l)}→${f(bs.l)}`);
    const br = render(chart, { brilliance: 100 });
    const db = S(br, R.dark), bb = S(br, R.bright);
    check('휘도 +100 → 어두운 곳↑ 밝은 곳↓', db.l > d0.l + 3 && bb.l < b0.l - 3, `어두운 ${f(d0.l)}→${f(db.l)} / 밝은 ${f(b0.l)}→${f(bb.l)}`);
  }

  for (const [v, dir] of [[60, 1], [-60, -1]]) {
    const s = S(render(chart, { contrast: v }), R.ramp);
    check(`대비 ${v > 0 ? '+' : ''}${v} → 표준편차 ${dir > 0 ? '증가' : '감소'}`, (s.sd - base.sd) * dir > 3, `표준편차 ${f(base.sd)} → ${f(s.sd)}`);
  }
  {
    const mid = [240, 0, 32, 96];
    const m0 = S(id, mid).l;
    const m1 = S(render(chart, { brightness: 50 }), mid).l;
    const blk = S(render(chart, { brightness: 50 }), [0, 0, 2, 96]).l;
    check('밝기 +50 → 중간톤↑, 순수 블랙 유지', m1 - m0 > 5 && blk < 2, `중간 ${f(m0)}→${f(m1)} / 블랙 ${f(blk)}`);
  }
  {
    const d0 = S(id, R.dark).l;
    const dp = S(render(chart, { blackPoint: 100 }), R.dark).l;
    const blk = S(render(chart, { blackPoint: -100 }), [0, 0, 2, 96]).l;
    check('블랙 포인트 +100 → 블랙이 더 깊어짐 (아이폰 방향)', dp < d0 - 5, `어두운 영역 ${f(d0)}→${f(dp)}`);
    check('블랙 포인트 -100 → 블랙이 뜸', blk > 10, `순수 블랙 → ${f(blk)}`);
  }
  {
    const s = S(render(chart, { saturation: -100 }), R.patches);
    check('채도 -100 → 무채색', s.maxChroma <= 2, `최대 채도차 ${s.maxChroma}`);
    const p0 = S(id, R.patches).sat, p1 = S(render(chart, { saturation: 50 }), R.patches).sat;
    check('채도 +50 → 채도 증가', p1 > p0 + 0.03, `평균 채도 ${p0.toFixed(3)} → ${p1.toFixed(3)}`);
  }
  {
    const vib = render(chart, { vibrance: 100 });
    const gain = (i) => S(vib, patch(i)).sat - S(id, patch(i)).sat;
    const low = gain(7), high = gain(0), skin = gain(6);
    check('색 선명도 → 저채도에 더 강하게', low > high, `저채도 +${low.toFixed(3)} / 고채도 +${high.toFixed(3)}`);
    const satOnly = S(render(chart, { saturation: 100 * 0.9 }), patch(6)).sat - S(id, patch(6)).sat;
    check('색 선명도 → 피부톤 보호 (같은 채도 변화보다 작게)', skin < satOnly * 0.6, `피부 +${skin.toFixed(3)} / 채도만 +${satOnly.toFixed(3)}`);
  }
  {
    const f0 = S(render(flat, {}), [0, 0, 256, 256], 256);
    const w = S(render(flat, { warmth: 100 }), [0, 0, 256, 256], 256);
    check('따뜻함 +100 → R↑ B↓, 휘도 유지', w.r > f0.r + 5 && w.b < f0.b - 5 && Math.abs(w.l - f0.l) < 2, `R ${f(w.r)} B ${f(w.b)} L ${f(w.l)}`);
    const t = S(render(flat, { tint: 100 }), [0, 0, 256, 256], 256);
    check('색조 +100 → 마젠타 (G↓)', t.g < f0.g - 3 && t.r > t.g && t.b > t.g, `R ${f(t.r)} G ${f(t.g)} B ${f(t.b)}`);
    const v = render(flat, { vignette: 100 });
    const corner = S(v, [0, 0, 8, 8], 256).l, center = S(v, [124, 124, 8, 8], 256).l;
    check('비네트 +100 → 모서리 어둡고 중앙 유지', corner < center - 30 && Math.abs(center - f0.l) < 2, `모서리 ${f(corner)} / 중앙 ${f(center)}`);
    const vn = S(render(flat, { vignette: -100 }), [0, 0, 8, 8], 256).l;
    check('비네트 -100 → 모서리 밝아짐', vn > f0.l + 20, `모서리 ${f(vn)}`);
  }
  {
    const s0 = S(id, R.stripes).sd;
    const sp = S(render(chart, { sharpness: 100 }), R.stripes).sd;
    const sm = S(render(chart, { sharpness: -100 }), R.stripes).sd;
    check('선명도 ± → 미세 디테일 증가/감소', sp > s0 + 5 && sm < s0 - 5, `표준편차 ${f(s0)} → +${f(sp)} / -${f(sm)}`);
    const n0 = S(id, R.noise).sd;
    const nr = S(render(chart, { noiseReduction: 100 }), R.noise).sd;
    check('노이즈 감소 +100 → 평탄 영역 노이즈 감소', nr < n0 * 0.7, `표준편차 ${f(n0)} → ${f(nr)}`);
    // 명료도: 큰 경계(어두운/밝은 영역 사이)의 국소 대비가 커진다
    const edge = [200, 300, 112, 68];
    const e0 = S(id, edge).sd, e1 = S(render(chart, { definition: 100 }), edge).sd;
    check('명료도 +100 → 큰 경계의 국소 대비 증가', e1 > e0 + 2, `표준편차 ${f(e0)} → ${f(e1)}`);
  }
  {
    // 해상도 독립성: 2배 크기에서도 큰 블러 기반 효과(휘도)가 비슷해야 미리보기 = 저장 결과
    const big = document.createElement('canvas');
    big.width = W * 2; big.height = H * 2;
    const bctx = big.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(chart, 0, 0, W * 2, H * 2);
    const vals = { brilliance: 100, definition: 60 };
    const a = S(render(chart, vals), R.dark).l;
    const b = S(render(big, vals), R.dark.map((n) => n * 2), W * 2).l;
    check('미리보기(1x)와 풀해상도(2x) 결과가 비슷하다', Math.abs(a - b) < 3, `1x ${f(a)} / 2x ${f(b)}`);
  }

  r.dispose();
  const pass = results.filter((x) => x.ok).length;
  const text = `${pass === results.length ? 'PASS' : 'FAIL'} ${pass}/${results.length}`;
  document.getElementById('summary').textContent = text;
  document.title = text;
}

// ── 수동 확인 UI ──────────────────────────────────────────
function setupManual() {
  const values = emptyValues();
  const origC = document.getElementById('orig');
  const outC = document.getElementById('out');
  const r = new Renderer(outC, { p3: true });
  let source = null;
  let comparing = false;

  const show = (src) => {
    if (source && source !== src) releaseSource(source);
    source = src;
    origC.width = src.width; origC.height = src.height;
    origC.getContext('2d').drawImage(src, 0, 0);
    r.setSource(src, { keep: true });
    draw();
  };
  const draw = () => {
    r.render(comparing ? emptyValues() : values);
    document.getElementById('info').textContent =
      `${r.width}x${r.height} · ${r.gl instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1'} · 색공간 ${r.colorSpace} · 최대 변 ${r.maxSide}\n` +
      JSON.stringify(Object.fromEntries(Object.entries(values).filter(([, v]) => v)));
  };

  const box = document.getElementById('sliders');
  const inputs = {};
  for (const a of ADJUSTMENTS) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label>${a.label}</label><input type="range" min="-100" max="100" step="1" value="0"><output>0</output>`;
    const input = row.querySelector('input');
    input.addEventListener('input', () => {
      values[a.key] = Number(input.value);
      row.querySelector('output').textContent = input.value;
      row.classList.toggle('nz', values[a.key] !== 0);
      draw();
    });
    input.addEventListener('dblclick', () => { input.value = 0; input.dispatchEvent(new Event('input')); });
    inputs[a.key] = input;
    box.append(row);
  }
  const setAll = (vals) => {
    for (const k of KEYS) { inputs[k].value = vals[k] || 0; inputs[k].dispatchEvent(new Event('input')); }
  };
  document.getElementById('reset').onclick = () => setAll({});
  document.getElementById('vintage').onclick = () => setAll({
    exposure: -35, highlights: -70, shadows: -30, contrast: 35, brightness: 10, blackPoint: 5, saturation: 25, vibrance: 20,
  });
  document.getElementById('sample').onchange = (e) => show(e.target.value === 'flat' ? makeFlat() : makeChart());
  document.getElementById('file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dec = await decodeImage(file, { maxPixels: 4_000_000, maxSide: Math.min(r.maxSide, 2048) });
      show(dec.source);
    } catch (err) {
      alert(err.message);
    }
  };
  const hold = (on) => { comparing = on; draw(); };
  outC.addEventListener('pointerdown', () => hold(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) outC.addEventListener(ev, () => comparing && hold(false));
  show(makeChart());
}

try {
  runAuto();
} catch (e) {
  document.getElementById('summary').textContent = 'ERROR ' + e.message;
  document.title = 'ERROR';
  console.error(e);
}
setupManual();
