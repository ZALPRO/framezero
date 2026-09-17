/* ═══════════════════════════════════════════════════════════════
   render/gl2.js — the WebGL2 compositor (primary GPU path)

   Measured prerequisites (probe 2): EXT_color_buffer_float, EXT_float_blend
   and OES_texture_float_linear are present ⇒ HDR float render targets,
   MAX_TEXTURE_SIZE 8192.

   Frame pipeline
     1. Layer sources are rasterised on the CPU (text engine, shapes, media)
        and uploaded as textures. `createImageBitmap` is deliberately unused —
        it measured 110 ms for a 900×600 canvas (probe 2).
     2. Each layer's effect chain runs as ping-pong fragment passes against a
        scratch target sized to that layer, so blur radii are in layer pixels.
     3. The processed layer is composited with its affine matrix, opacity and
        blend mode.

   Alpha convention: STRAIGHT (non-premultiplied) end to end. The context is
   created with premultipliedAlpha:false and every shader outputs straight
   alpha, so opacity scales the alpha channel only — never the colour.

   Blend modes: `normal` and `add` are native GL blend funcs. The other 19
   need the destination, so the frame is snapshotted to a texture and resolved
   per-pixel with the W3C Compositing & Blending formulas.
   ═══════════════════════════════════════════════════════════════ */

import { Compositor } from './backend.js';
import { EFFECTS, GLSL_PRELUDE, clampParams, defaultParams } from '../effects/registry.js';
import { parseColor } from '../core/base.js';

/* One vertex shader for every program. It carries two varyings:
   vUv      — layer-local 0..1, used to sample the layer source
   vFrameUv — comp-space 0..1, used to sample the frame snapshot
   Sampling both from the same UV was the bug this design avoids. */
/**
 * With premultipliedAlpha:true the source factor MUST be ONE.
 * Using SRC_ALPHA multiplies alpha in twice (shader already premultiplied) and
 * darkens every semi-transparent edge — exactly the anti-aliased glyph case.
 */
const SRC_OVER = (gl) => gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
const SRC_ADD  = (gl) => gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);

const QUAD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
uniform mat3 uXform;
uniform vec2 uRes;
out vec2 vUv;
out vec2 vFrameUv;
void main(){
  vec3 p = uXform * vec3(aPos, 1.0);
  gl_Position = vec4((p.xy / uRes) * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  vUv = aPos;
  vFrameUv = clamp(p.xy / uRes, vec2(0.0), vec2(1.0));
}`;

/* ── W3C Compositing & Blending Level 1, all 21 modes ── */
const BLEND_FS = `#version 300 es
precision highp float;
in vec2 vUv; in vec2 vFrameUv; out vec4 fragColor;
uniform sampler2D uSrc, uDst; uniform int uMode; uniform float uOpacity;

float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 clipColor(vec3 c){
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * (l / max(1e-6, l - n));
  if (x > 1.0) c = l + (c - l) * ((1.0 - l) / max(1e-6, x - l));
  return clamp(c, 0.0, 1.0);
}
vec3 setLum(vec3 c, float l){ return clipColor(c + (l - lum(c))); }
vec3 setSat(vec3 c, float s){
  float mn = min(min(c.r, c.g), c.b), mx = max(max(c.r, c.g), c.b);
  return (mx - mn) < 1e-6 ? vec3(0.0) : (c - mn) * (s / (mx - mn));
}
float satOf(vec3 c){ return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }

vec3 multiply (vec3 b, vec3 s){ return b * s; }
vec3 screen   (vec3 b, vec3 s){ return b + s - b * s; }
vec3 hardlight(vec3 b, vec3 s){ return mix(screen(b, 2.0*s - 1.0), multiply(b, 2.0*s), step(s, vec3(0.5))); }
vec3 overlay  (vec3 b, vec3 s){ return hardlight(s, b); }
vec3 dodge    (vec3 b, vec3 s){ return min(vec3(1.0), b / max(vec3(1e-6), 1.0 - s)); }
vec3 burn     (vec3 b, vec3 s){ return 1.0 - min(vec3(1.0), (1.0 - b) / max(vec3(1e-6), s)); }
vec3 softlight(vec3 b, vec3 s){
  // step(0.25, b) == 1 when b >= 0.25 ⇒ selects sqrt; else the polynomial.
  vec3 d = mix(((16.0*b - 12.0)*b + 4.0)*b, sqrt(max(b, 0.0)), step(vec3(0.25), b));
  // step(0.5, s) == 0 when s < 0.5 ⇒ selects the FIRST argument, which must be
  // the s<=0.5 branch. Both orders were backwards; probe5 measured Δ168 on red.
  return mix(b + (2.0*s - 1.0)*b*(1.0 - b), b + (2.0*s - 1.0)*(d - b), step(vec3(0.5), s));
}
vec3 vividlight(vec3 b, vec3 s){ return mix(burn(b, 2.0*s), dodge(b, 2.0*s - 1.0), step(vec3(0.5), s)); }
vec3 pinlight (vec3 b, vec3 s){ return mix(min(b, 2.0*s), max(b, 2.0*s - 1.0), step(vec3(0.5), s)); }

vec3 blendMode(int m, vec3 b, vec3 s){
  if (m ==  0) return s;                                     // normal
  if (m ==  1) return multiply(b, s);
  if (m ==  2) return screen(b, s);
  if (m ==  3) return overlay(b, s);
  if (m ==  4) return min(b, s);                             // darken
  if (m ==  5) return max(b, s);                             // lighten
  if (m ==  6) return dodge(b, s);
  if (m ==  7) return burn(b, s);
  if (m ==  8) return hardlight(b, s);
  if (m ==  9) return softlight(b, s);
  if (m == 10) return abs(b - s);                            // difference
  if (m == 11) return b + s - 2.0*b*s;                       // exclusion
  // was transposed: hue must SetSat(Cs, Sat(Cb)), saturation SetSat(Cb, Sat(Cs))
  if (m == 12) return setLum(setSat(s, satOf(b)), lum(b));   // hue
  if (m == 13) return setLum(setSat(b, satOf(s)), lum(b));   // saturation
  if (m == 14) return setLum(s, lum(b));                     // color
  if (m == 15) return setLum(b, lum(s));                     // luminosity
  if (m == 16) return b + s;                                 // add / linear dodge
  if (m == 17) return max(vec3(0.0), b + s - 1.0);           // linear burn
  if (m == 18) return vividlight(b, s);
  if (m == 19) return pinlight(b, s);
  if (m == 20) return step(vec3(0.5), vividlight(b, s));     // hard mix
  return s;
}

void main(){
  vec4 s = texture(uSrc, vUv) ;         // premultiplied
  s *= uOpacity;
  vec4 d = texture(uDst, vFrameUv);     // premultiplied
  if (s.a <= 0.0015){ fragColor = d; return; }

  // W3C blending is defined on STRAIGHT colour, so un-premultiply both sides…
  vec3 cs = clamp(s.rgb / max(s.a, 1e-4), 0.0, 1.0);
  vec3 cb = clamp(d.rgb / max(d.a, 1e-4), 0.0, 1.0);
  vec3 bl = blendMode(uMode, cb, cs);
  // …and emit the PREMULTIPLIED source-over result (no division by ao).
  vec3 co = (1.0 - d.a) * s.a * cs + d.a * ((1.0 - s.a) * cb + s.a * bl);
  float ao = s.a + d.a * (1.0 - s.a);
  fragColor = vec4(clamp(co, 0.0, 1.0), clamp(ao, 0.0, 1.0));
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uSrc; uniform float uOpacity;
void main(){
  vec4 c = texture(uSrc, vUv);          // premultiplied
  fragColor = vec4(c.rgb * uOpacity, c.a * uOpacity);
}`;

const BLEND_INDEX = {
  'normal': 0, 'multiply': 1, 'screen': 2, 'overlay': 3, 'darken': 4, 'lighten': 5,
  'color-dodge': 6, 'color-burn': 7, 'hard-light': 8, 'soft-light': 9, 'difference': 10,
  'exclusion': 11, 'hue': 12, 'saturation': 13, 'color': 14, 'luminosity': 15,
  'add': 16, 'linear-burn': 17, 'vivid-light': 18, 'pin-light': 19, 'hard-mix': 20,
};
const NATIVE = new Set(['normal', 'add']);

export class GL2Compositor extends Compositor {
  constructor() {
    super('webgl2');
    this.gl = null;
    this.programs = new Map();
    this.layerTex = new Map();
    this.scratch = new Map();
    this.frameTarget = null;
    this.floatTargets = false;
    this.clearColor = [0, 0, 0, 0];
  }

  async init(canvas, opts = {}) {
    const gl = canvas.getContext('webgl2', {
      // PREMULTIPLIED end to end. GL blend funcs are defined in premultiplied
      // space, and blurring premultiplied colour is what avoids dark halos on
      // anti-aliased text edges — the exact case this product lives on.
      alpha: true, antialias: false, premultipliedAlpha: true,
      preserveDrawingBuffer: true,          // readback() must work after the frame
      powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false,
    });
    if (!gl) throw new Error('WebGL2 context unavailable');
    this.gl = gl;
    this.canvas = canvas;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    gl.getExtension('EXT_float_blend');

    this.capabilities = {
      floatTargets: this.floatTargets,
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      internalFormat: this.floatTargets ? 'RGBA16F' : 'RGBA8',
      renderer: String(gl.getParameter(gl.RENDERER)),
    };
    this.supportedEffects = new Set(Object.keys(EFFECTS));

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.quad = { buf, vao };

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);

    this.blitProg = this._program('blit', QUAD_VS, BLIT_FS);
    this.blendProg = this._program('blend', QUAD_VS, BLEND_FS);
    this.ready = true;
    if (opts.width && opts.height) this.resize(opts.width, opts.height, opts.dpr || 1);
    return this;
  }

  /* ── shaders ── */
  _compile(type, src, name) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}: ${l}`).join('\n');
      throw new Error(`shader compile failed (${name}): ${log}\n${numbered}`);
    }
    return sh;
  }

  _program(name, vs, fs) {
    const cached = this.programs.get(name);
    if (cached) return cached;
    const gl = this.gl;
    const p = gl.createProgram();
    const v = this._compile(gl.VERTEX_SHADER, vs, `${name}.vert`);
    const f = this._compile(gl.FRAGMENT_SHADER, fs, `${name}.frag`);
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`program link failed (${name}): ${log}`);
    }
    gl.deleteShader(v); gl.deleteShader(f);
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    const rec = { program: p, uniforms, name };
    this.programs.set(name, rec);
    return rec;
  }

  /**
   * Compile (once) the program for an effect.
   *
   * Each effect's own uniforms must be DECLARED in the shader, not just set —
   * that omission was a real bug: gaussianBlur referenced uRadius/uTaps which
   * the fixed header never declared, so the program failed to compile and every
   * blur silently dropped to a slow CPU path.
   *
   * Rather than making each effect repeat a type table, the declarations are
   * derived by probing `uniforms()` once with default params: a number becomes
   * float, a 2/3/4-length array becomes vec2/vec3/vec4.
   */
  effectProgram(id, defines) {
    const e = EFFECTS[id];
    if (!e) throw new Error(`unknown effect "${id}"`);
    // Compile-time specialisation: effects may declare `defines(params, env)`
    // to bake a loop bound or kernel size into the shader. Each distinct set of
    // values gets its own cached program.
    const dkeys = defines ? Object.keys(defines).sort() : [];
    const dpart = dkeys.map(k => `${k}=${defines[k]}`).join(',');
    const key = `fx:${id}${dpart ? ':' + dpart : ''}`;
    const cached = this.programs.get(key);
    if (cached) return cached;
    const defs = dkeys.map(k => `#define ${k} ${defines[k]}`).join('\n');

    // Builtins an effect must NOT redeclare. uAmount/uPass were here and
    // collided with six effects that define their own uAmount — one of them a
    // vec2, which failed to compile against the builtin float.
    const BUILTIN = new Set(['uSrc', 'uTexel', 'uRes', 'uTime', 'uXform']);
    let decls = '';
    if (e.uniforms) {
      const env = {
        width: 256, height: 256, time: 0, pass: 0, parseColor,
        setAlpha: (c, a) => `rgba(0,0,0,${a})`,
        scratch: () => null, scratch2: () => null, noiseTile: () => null,
      };
      const sample = e.uniforms(clampParams(e, defaultParams(e)), env) || {};
      for (const [k, v] of Object.entries(sample)) {
        const t = typeof v === 'number' ? 'float' : v?.length === 2 ? 'vec2' : v?.length === 3 ? 'vec3' : v?.length === 4 ? 'vec4' : null;
        if (BUILTIN.has(k)) throw new Error(`effect "${id}" redeclares builtin uniform ${k}`);
        if (t) decls += `uniform ${t} ${k};\n`;
      }
    }

    /* Alpha convention per effect:
       • premultiplied (the blur family) reads and writes premultiplied colour.
         Blurring premultiplied data is what prevents dark halos around
         anti-aliased glyph edges.
       • everything else works on STRAIGHT colour via texS(), and main()
         re-premultiplies so the pipeline stays uniformly premultiplied. */
    const straight = !e.premultiplied;
    const body = straight ? e.glsl.split('texture(uSrc,').join('texS(') : e.glsl;
    const helper = straight
      ? `vec4 texS(vec2 uv){ vec4 c = texture(uSrc, uv);
           return vec4(c.a > 1e-4 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0), c.a); }\n`
      : '';
    const main = straight
      ? `void main(){ vec4 r = effect(vUv); float a = clamp(r.a, 0.0, 1.0);
           fragColor = vec4(clamp(r.rgb, 0.0, 1.0) * a, a); }`
      : `void main(){ fragColor = clamp(effect(vUv), vec4(0.0), vec4(8.0)); }`;

    const fs = `#version 300 es
precision highp float;
in vec2 vUv; in vec2 vFrameUv; out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel; uniform vec2 uRes;
uniform float uTime;
${defs}
${decls}${GLSL_PRELUDE}
${helper}${body}
${main}`;
    return this._program(key, QUAD_VS, fs);
  }

  /* ── GL resources ── */
  _tex(w, h, float) {
    const gl = this.gl;
    const useFloat = float && this.floatTargets;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0,
      useFloat ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA,
      useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  _target(w, h, float) {
    const gl = this.gl;
    const tex = this._tex(w, h, float);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h, ok };
  }

  _deleteTarget(t) {
    if (!t || !this.gl) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  resize(w, h, dpr = 1) {
    const gl = this.gl;
    if (!gl) return;
    this.width = Math.max(1, Math.round(w));
    this.height = Math.max(1, Math.round(h));
    this.dpr = dpr || 1;
    const pw = Math.max(1, Math.round(this.width * this.dpr));
    const ph = Math.max(1, Math.round(this.height * this.dpr));
    const changed = pw !== this.pixelWidth || ph !== this.pixelHeight;
    this.pixelWidth = pw; this.pixelHeight = ph;
    this.canvas.width = pw; this.canvas.height = ph;
    gl.viewport(0, 0, pw, ph);
    if (changed) {
      this._deleteTarget(this.frameTarget);
      this.frameTarget = this._target(pw, ph, false);
      for (const pool of this.scratch.values()) for (const t of pool) this._deleteTarget(t);
      this.scratch.clear();
    }
  }

  /** Upload a rasterised layer source (canvas / OffscreenCanvas). */
  updateLayerSource(id, source) {
    const gl = this.gl;
    const w = Math.max(1, source.width), h = Math.max(1, source.height);
    let rec = this.layerTex.get(id);
    if (!rec || rec.w !== w || rec.h !== h) {
      if (rec) gl.deleteTexture(rec.tex);
      rec = { tex: this._tex(w, h, false), w, h };
      this.layerTex.set(id, rec);
    }
    gl.bindTexture(gl.TEXTURE_2D, rec.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);   // canvas sources are premultiplied
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.stats.uploads++;
    return { tex: rec.tex, w, h, kind: 'layer', id };
  }

  /** Scratch ping-pong pair for a given size; guarantees dst ≠ src. */
  _pingPong(w, h) {
    const key = `${w}x${h}`;
    let pair = this.scratch.get(key);
    if (!pair) { pair = [this._target(w, h, true), this._target(w, h, true)]; this.scratch.set(key, pair); }
    return pair;
  }

  _identityXform(w, h) { return new Float32Array([w, 0, 0, 0, h, 0, 0, 0, 1]); }
  _layerXform(matrix, w, h) {
    const [a, b, c, d, e, f] = matrix || [1, 0, 0, 1, 0, 0];
    // maps layer-local uv (0..1) through the layer's pixel size, then the affine
    return new Float32Array([a * w, c * h, 0, b * w, d * h, 0, e, f, 1]);
  }

  /* ── effects ── */
  applyEffect(handle, effect, params, time) {
    const gl = this.gl;
    const id = effect.id || effect;
    const e = EFFECTS[id];
    if (!e || !handle) return handle;
    const p = clampParams(e, params || effect.params);
    const passes = Math.max(1, e.passes || 1);
    const env = {
      width: handle.w, height: handle.h, time: time || 0, pass: 0,
      parseColor,
      setAlpha: (col, a) => { const k = parseColor(col); return `rgba(${k.r},${k.g},${k.b},${a})`; },
      scratch: () => this._cpuScratch(handle.w, handle.h),
      scratch2: () => this._cpuScratch2(handle.w, handle.h),
      noiseTile: (size, frame) => this._noiseTile(size, frame),
    };

    // A canvas2d-only effect (or a GPU effect we cannot compile) falls back.
    let prog;
    const defines = e.defines ? e.defines(p, env) : null;
    try { prog = this.effectProgram(id, defines); }
    catch (err) { this._shaderErrors ||= []; this._shaderErrors.push(`${id}: ${err.message}`); prog = null; }

    if (!prog) { this._cpuEffect(handle, e, p, env); return handle; }

    const [ta, tb] = this._pingPong(handle.w, handle.h);
    let src = handle;
    for (let pass = 0; pass < passes; pass++) {
      // src alternates layer→ta→tb→ta…; dst is always the other one
      const dst = pass % 2 === 0 ? ta : tb;
      env.pass = pass;
      const uni = e.uniforms ? e.uniforms(p, env) : {};
      gl.useProgram(prog.program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, handle.w, handle.h);
      gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      const u = prog.uniforms;
      gl.uniform1i(u.uSrc, 0);
      if (u.uTexel) gl.uniform2f(u.uTexel, 1 / handle.w, 1 / handle.h);
      if (u.uRes) gl.uniform2f(u.uRes, handle.w, handle.h);
      if (u.uTime) gl.uniform1f(u.uTime, env.time);
      if (u.uXform) gl.uniformMatrix3fv(u.uXform, false, this._identityXform(handle.w, handle.h));
      for (const [k, v] of Object.entries(uni)) {
        const loc = u[k];
        if (!loc) continue;
        if (typeof v === 'number') gl.uniform1f(loc, v);
        else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
        else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
        else if (v.length === 4) gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
      }
      gl.bindVertexArray(this.quad.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.enable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.pixelWidth, this.pixelHeight);   // never leak scratch viewport
      this.stats.effectPasses++;
      src = { tex: dst.tex, w: handle.w, h: handle.h, kind: 'scratch' };
    }
    return src;
  }

  /** Run an effect on the CPU into a texture — used when GLSL is unavailable. */
  _cpuEffect(handle, e, p, env) {
    if (!e.canvas2d) return;
    const srcCanvas = this._textureToCanvas(handle);
    const tmp = this._cpuScratch(handle.w, handle.h);
    const g = tmp.getContext('2d');
    g.clearRect(0, 0, handle.w, handle.h);
    e.canvas2d(g, srcCanvas, p, env);
    // tmp is straight-alpha (putImageData/getImageData space); the pipeline is
    // premultiplied, so premultiply on the way back in.
    const tg = tmp.getContext('2d');
    const im = tg.getImageData(0, 0, handle.w, handle.h);
    for (let i = 0; i < im.data.length; i += 4) {
      const a = im.data[i + 3] / 255;
      im.data[i] *= a; im.data[i + 1] *= a; im.data[i + 2] *= a;
    }
    tg.putImageData(im, 0, 0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, handle.tex);
    this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, tmp);
    this.stats.effectPasses++;
  }

  _readbackTarget(w, h) {
    const key = `rb:${w}x${h}`;
    let t = this.scratch.get(key);
    if (!t || !t.ok) { t = this._target(w, h, false); this.scratch.set(key, t); }
    return t;
  }

  _textureToCanvas(handle) {
    const gl = this.gl;
    const w = handle.w, h = handle.h;
    const c = this._cpuScratch(w, h);

    // Scratch targets are RGBA16F. readPixels from a float attachment is not
    // reliably supported — on SwiftShader even the IMPLEMENTATION_COLOR_READ_*
    // pair it reports raises INVALID_OPERATION (0x502) and leaves the buffer
    // zeroed, which silently blanked any layer whose CPU-only effect followed a
    // GPU one. So blit through the existing shader into an RGBA8 target first;
    // the float→8-bit conversion then happens in GLSL where it is well defined.
    const dst = this._readbackTarget(w, h);
    const px = new Uint8Array(w * h * 4);
    if (dst && dst.ok) {
      const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
      gl.useProgram(this.blitProg.program);
      SRC_OVER(gl);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, handle.tex);
      gl.uniform1i(this.blitProg.uniforms.uSrc, 0);
      gl.uniform1f(this.blitProg.uniforms.uOpacity, 1);
      if (this.blitProg.uniforms.uXform) gl.uniformMatrix3fv(this.blitProg.uniforms.uXform, false, this._identityXform(w, h));
      if (this.blitProg.uniforms.uRes) gl.uniform2f(this.blitProg.uniforms.uRes, w, h);
      gl.bindVertexArray(this.quad.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.pixelWidth, this.pixelHeight);
      if (prevProg) gl.useProgram(prevProg);
    } else {
      // last resort: direct read of an 8-bit texture
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, handle.tex, 0);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
    }

    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    // GL is bottom-up → flip rows. Bytes are premultiplied; putImageData wants
    // straight alpha, so un-premultiply on the way in.
    for (let y = 0; y < h; y++) {
      const so = (h - 1 - y) * w * 4, d = y * w * 4;
      for (let x = 0; x < w; x++) {
        const i = so + x * 4, j = d + x * 4;
        const a = px[i + 3];
        img.data[j + 3] = a;
        if (a > 0) {
          const k = 255 / a;
          img.data[j] = px[i] * k > 255 ? 255 : (px[i] * k + 0.5) | 0;
          img.data[j + 1] = px[i + 1] * k > 255 ? 255 : (px[i + 1] * k + 0.5) | 0;
          img.data[j + 2] = px[i + 2] * k > 255 ? 255 : (px[i + 2] * k + 0.5) | 0;
        }
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  _cpuScratch(w, h) {
    if (!this._s1 || this._s1.width < w || this._s1.height < h) {
      this._s1 = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
    }
    if (this._s1.width !== w || this._s1.height !== h) { this._s1.width = w; this._s1.height = h; }
    return this._s1;
  }
  _cpuScratch2(w, h) {
    if (!this._s2 || this._s2.width !== w || this._s2.height !== h) {
      this._s2 = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
    }
    return this._s2;
  }
  _noiseTile(size, frame) {
    const S = 128;
    if (!this._noise || this._noise.frame !== frame || this._noise.size !== size) {
      this._noise = { canvas: this._makeCanvas(S, S), frame, size };
      const g = this._noise.canvas.getContext('2d');
      const img = g.createImageData(S, S);
      const cell = Math.max(1, Math.round(size));
      let seed = (frame * 2654435761) >>> 0;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      for (let y = 0; y < S; y += cell) for (let x = 0; x < S; x += cell) {
        const v = Math.round(rnd() * 255);
        for (let dy = 0; dy < cell && y + dy < S; dy++) for (let dx = 0; dx < cell && x + dx < S; dx++) {
          const i = ((y + dy) * S + (x + dx)) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
    }
    return this._noise.canvas;
  }
  _makeCanvas(w, h) {
    return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  }

  /* ── frame ── */
  beginFrame(time) {
    const gl = this.gl;
    if (!gl) return;
    this.stats.frames++;
    this._time = time || 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.pixelWidth, this.pixelHeight);
    gl.clearColor(...this.clearColor);
    gl.clear(gl.COLOR_BUFFER_BIT);
    SRC_OVER(gl);
  }

  /** Fill the frame with a solid colour (comp background). */
  fillBackground(css) {
    const gl = this.gl;
    const c = parseColor(css);
    const a = c.a ?? 1;
    gl.disable(gl.BLEND);
    // clear colour is premultiplied like everything else in this pipeline
    gl.clearColor(c.r / 255 * a, c.g / 255 * a, c.b / 255 * a, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    SRC_OVER(gl);
  }

  /**
   * @param handle texture handle
   * @param matrix affine [a,b,c,d,e,f]: layer-space px → comp px
   */
  drawLayer(handle, { matrix, opacity = 1, blend = 'normal' } = {}) {
    const gl = this.gl;
    if (!gl || !handle || opacity <= 0.0015) return;
    const xform = this._layerXform(matrix, handle.w, handle.h);
    const mode = BLEND_INDEX[blend] ?? 0;

    if (NATIVE.has(blend)) {
      const add = blend === 'add';
      (add ? SRC_ADD : SRC_OVER)(gl);
      gl.useProgram(this.blitProg.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, handle.tex);
      gl.uniform1i(this.blitProg.uniforms.uSrc, 0);
      gl.uniform1f(this.blitProg.uniforms.uOpacity, opacity);
      gl.uniformMatrix3fv(this.blitProg.uniforms.uXform, false, xform);
      gl.uniform2f(this.blitProg.uniforms.uRes, this.pixelWidth, this.pixelHeight);
      gl.bindVertexArray(this.quad.vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.pixelWidth, this.pixelHeight);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.stats.draws++;
      return;
    }

    // Non-native blend: snapshot the framebuffer, then resolve per-pixel.
    const ft = this.frameTarget;
    if (!ft || !ft.ok) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, ft.tex);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, this.pixelWidth, this.pixelHeight);

    gl.useProgram(this.blendProg.program);
    gl.blendFuncSeparate(gl.ONE, gl.ZERO, gl.ONE, gl.ZERO);   // shader already composited
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, handle.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ft.tex);
    const u = this.blendProg.uniforms;
    gl.uniform1i(u.uSrc, 0);
    gl.uniform1i(u.uDst, 1);
    gl.uniform1i(u.uMode, mode);
    gl.uniform1f(u.uOpacity, opacity);
    gl.uniformMatrix3fv(u.uXform, false, xform);
    gl.uniform2f(u.uRes, this.pixelWidth, this.pixelHeight);
    gl.bindVertexArray(this.quad.vao);
    // CRITICAL: applyEffect leaves the viewport at the scratch target's size
    // (e.g. 220x220 for this layer). Without restoring it the quad is drawn
    // into a stale, mis-scaled viewport and the layer lands in the wrong place
    // or not at all. The NATIVE branch above already did this; the non-native
    // branch did not, so every effect + non-native blend (screen, multiply,
    // overlay, …18 modes) was broken while normal/add looked fine.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.pixelWidth, this.pixelHeight);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    SRC_OVER(gl);
    this.stats.draws++;
  }

  endFrame() {
    const gl = this.gl;
    if (gl) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.flush(); }
    return { ...this.stats };
  }

  /** Forced readback — tests and export only, never the interactive path. */
  readback(x = 0, y = 0, w = this.pixelWidth, h = this.pixelHeight) {
    const gl = this.gl;
    if (!gl) return null;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.stats.readbacks++;
    const c = this._makeCanvas(w, h);
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    for (let row = 0; row < h; row++) {
      const srcOff = (h - 1 - row) * w * 4, dstOff = row * w * 4;
      // GL is bottom-up AND premultiplied; putImageData wants top-down straight
      for (let x = 0; x < w; x++) {
        const i = srcOff + x * 4, j = dstOff + x * 4;
        const a = px[i + 3];
        img.data[j + 3] = a;
        if (a > 0) {
          const k = 255 / a;
          img.data[j] = Math.min(255, Math.round(px[i] * k));
          img.data[j + 1] = Math.min(255, Math.round(px[i + 1] * k));
          img.data[j + 2] = Math.min(255, Math.round(px[i + 2] * k));
        }
      }
    }
    g.putImageData(img, 0, 0);
    return { canvas: c, data: img.data, width: w, height: h };
  }

  shaderErrors() { return this._shaderErrors || []; }

  destroy() {
    const gl = this.gl;
    if (!gl) return;
    for (const rec of this.layerTex.values()) gl.deleteTexture(rec.tex);
    for (const pool of this.scratch.values()) for (const t of pool) this._deleteTarget(t);
    this._deleteTarget(this.frameTarget);
    for (const p of this.programs.values()) gl.deleteProgram(p.program);
    if (this.quad) { gl.deleteBuffer(this.quad.buf); gl.deleteVertexArray(this.quad.vao); }
    this.layerTex.clear(); this.scratch.clear(); this.programs.clear();
    this.frameTarget = null; this.gl = null; this.ready = false;
  }
}
