// WebGL 렌더러: 원본 텍스처 + 큰 반경 블러를 만든 뒤, adjustments.js 의 셰이더 한 패스로 모든 조정을 적용.
import { KEYS, COEF, buildFragmentShader } from './adjustments.js';

// 메인 패스: 화면 위쪽 = 이미지 첫 행 (업로드 시 FLIP_Y 를 쓰지 않는다 — ImageBitmap 은 무시되므로)
const VS_MAIN = `attribute vec2 a_pos; varying vec2 v_uv;
void main() { v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5); gl_Position = vec4(a_pos, 0.0, 1.0); }`;
// 보조 패스(FBO): 텍스처 좌표를 그대로 유지 → FBO 도 원본과 같은 행 순서
const VS_PASS = `attribute vec2 a_pos; varying vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const FS_COPY = `precision highp float; varying vec2 v_uv; uniform sampler2D u_tex;
void main() { gl_FragColor = texture2D(u_tex, v_uv); }`;
// 9탭 가우시안: 탭 간격 1.5텍셀, 탭 단위 시그마 2 → 텍셀 시그마 3
const FS_BLUR = `precision highp float; varying vec2 v_uv; uniform sampler2D u_tex; uniform vec2 u_step;
void main() {
  vec4 s = vec4(0.0); float wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float f = float(i);
    float w = exp(-0.5 * (f * 0.5) * (f * 0.5));
    s += texture2D(u_tex, v_uv + u_step * f) * w; wsum += w;
  }
  gl_FragColor = s / wsum;
}`;

const BLUR_SIGMA_TEXELS = 3; // 블러 텍스처 해상도에서의 시그마 — 미리보기/풀해상도 결과가 같아지도록 해상도를 맞춘다

export function getContext(canvas, { preserveDrawingBuffer = false } = {}) {
  const opts = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer };
  return canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
}

// 기기가 처리할 수 있는 최대 변 길이
export function glMaxSide(gl) {
  const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  return Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[0], vp[1]);
}

export class CanvasTooLargeError extends Error {}

export class Renderer {
  constructor(canvas, { preserveDrawingBuffer = false, p3 = true } = {}) {
    this.canvas = canvas;
    this.opts = { preserveDrawingBuffer, p3 };
    this.source = null; // 컨텍스트 복구용 (미리보기만 유지)
    this.onRestore = null;
    this._lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this._lost = true; });
    canvas.addEventListener('webglcontextrestored', () => {
      this._lost = false;
      this._init();
      if (this.source) this.setSource(this.source);
      this.onRestore?.();
    });
    this._init();
  }

  _init() {
    const gl = getContext(this.canvas, this.opts);
    if (!gl) throw new Error('WebGL 을 사용할 수 없습니다');
    this.gl = gl;
    if (this.opts.p3) {
      // 넓은 색역: 지원하는 브라우저에서만 (Safari 16.4+ 등)
      try { if ('drawingBufferColorSpace' in gl) gl.drawingBufferColorSpace = 'display-p3'; } catch { /* 미지원 */ }
      try { if ('unpackColorSpace' in gl) gl.unpackColorSpace = 'display-p3'; } catch { /* 미지원 */ }
    }
    this.colorSpace = gl.drawingBufferColorSpace || 'srgb';
    this.maxSide = glMaxSide(gl);

    this.progMain = this._program(VS_MAIN, buildFragmentShader());
    this.progCopy = this._program(VS_PASS, FS_COPY);
    this.progBlur = this._program(VS_PASS, FS_BLUR);
    this.uMain = {};
    for (const name of ['u_src', 'u_blur', 'u_texel', 'u_aspect', ...KEYS.map((k) => `u_${k}`)]) {
      this.uMain[name] = gl.getUniformLocation(this.progMain, name);
    }

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.srcTex = null;
    this.blurTex = null;
  }

  _program(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error('셰이더 컴파일 실패: ' + gl.getShaderInfoLog(s));
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('셰이더 링크 실패: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  _texture(w, h, source) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (source) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }

  _target(w, h) {
    const gl = this.gl;
    const tex = this._texture(w, h, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  _pass(prog, srcTex, target, uniforms = {}) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    for (const [k, v] of Object.entries(uniforms)) gl.uniform2fv(gl.getUniformLocation(prog, k), v);
    this._drawQuad();
  }

  _drawQuad() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _freeTargets(list) {
    const gl = this.gl;
    for (const t of list) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
  }

  /** 원본을 올리고 큰 반경 블러를 만든다. 캔버스 크기 = 원본 크기. source 는 호출 후 해제해도 된다. */
  setSource(source, { keep = false } = {}) {
    const gl = this.gl;
    const w = source.width;
    const h = source.height;
    if (Math.max(w, h) > this.maxSide) throw new CanvasTooLargeError(`${w}x${h} > ${this.maxSide}`);
    this.canvas.width = w;
    this.canvas.height = h;
    // Safari 는 너무 큰 드로잉 버퍼를 조용히 줄인다 → 감지해서 호출자가 축소하게
    if (gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== h) {
      throw new CanvasTooLargeError(`drawing buffer ${gl.drawingBufferWidth}x${gl.drawingBufferHeight} != ${w}x${h}`);
    }
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    if (this.blurTex) this._freeTargets([this.blurTex]);
    this.srcTex = this._texture(w, h, source);
    this.width = w;
    this.height = h;
    this.source = keep ? source : null;

    // 큰 블러: 2배씩 축소 → 목표 크기 → 가로/세로 가우시안
    const sigma = Math.max(1, COEF.blurRadiusFrac * Math.min(w, h));
    const scale = Math.min(1, BLUR_SIGMA_TEXELS / sigma);
    const bw = Math.max(1, Math.round(w * scale));
    const bh = Math.max(1, Math.round(h * scale));
    const temps = [];
    let cur = { tex: this.srcTex, w, h };
    while (cur.w / 2 >= bw && cur.h / 2 >= bh) {
      const t = this._target(Math.max(1, cur.w >> 1), Math.max(1, cur.h >> 1));
      this._pass(this.progCopy, cur.tex, t);
      temps.push(t);
      cur = t;
    }
    const a = this._target(bw, bh);
    const b = this._target(bw, bh);
    this._pass(this.progCopy, cur.tex, a);
    this._pass(this.progBlur, a.tex, b, { u_step: [1.5 / bw, 0] });
    this._pass(this.progBlur, b.tex, a, { u_step: [0, 1.5 / bh] });
    this._freeTargets([...temps, b]);
    this.blurTex = a;
  }

  /** values: { key: -100~100 } */
  render(values) {
    if (!this.srcTex || this._lost) return;
    const gl = this.gl;
    const u = this.uMain;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.progMain);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(u.u_src, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blurTex.tex);
    gl.uniform1i(u.u_blur, 1);
    gl.uniform2f(u.u_texel, 1 / this.width, 1 / this.height);
    gl.uniform1f(u.u_aspect, this.width / this.height);
    for (const k of KEYS) gl.uniform1f(u[`u_${k}`], (Number(values?.[k]) || 0) / 100);
    this._drawQuad();
  }

  /** 테스트용: 현재 화면을 RGBA 로 (위쪽 행부터) */
  readPixels() {
    const gl = this.gl;
    const { width: w, height: h } = this;
    const buf = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Uint8Array(buf.length);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    if (this.blurTex) this._freeTargets([this.blurTex]);
    this.srcTex = this.blurTex = this.source = null;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
  }
}
