/* ═══════════════════════════════════════════════════════════════
   render/backend.js — capability detection + the compositor contract

   Backend order is dictated by measurement, not preference:
     WebGPU  — requested first, but `requestAdapter()` returned null in
               headless CI, so it can only ever be an opportunistic upgrade.
     WebGL2  — fully available with EXT_color_buffer_float + EXT_float_blend
               + OES_texture_float_linear ⇒ real HDR float targets. PRIMARY.
     Canvas2D— always present. A complete implementation, not a stub, because
               CI and low-end machines run on it.

   All three implement the same `Compositor` interface so the rest of the app
   never branches on backend.
   ═══════════════════════════════════════════════════════════════ */

export const BACKENDS = { webgpu: 'WebGPU', webgl2: 'WebGL2', canvas2d: 'Canvas 2D' };

export async function detectCapabilities(probeCanvas) {
  const caps = {
    webgpu: false, webgpuAdapter: null, webgl2: false, canvas2d: false,
    floatTargets: false, floatLinear: false, maxTexture: 0, renderer: '', vendor: '',
    dpr: typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1,
    offscreen: typeof OffscreenCanvas !== 'undefined',
    workers: typeof Worker !== 'undefined',
  };

  // Canvas2D is the guaranteed floor
  try {
    const c = probeCanvas || document.createElement('canvas');
    caps.canvas2d = !!c.getContext('2d');
  } catch { caps.canvas2d = false; }

  // WebGPU — opportunistic only
  try {
    if (navigator.gpu) {
      const adapter = await Promise.race([
        navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
        new Promise(r => setTimeout(() => r(null), 2500)),
      ]);
      caps.webgpuAdapter = adapter ? {
        isFallbackAdapter: !!adapter.isFallbackAdapter,
        vendor: adapter.info?.vendor || '', architecture: adapter.info?.architecture || '',
      } : null;
      caps.webgpu = !!adapter && !adapter.isFallbackAdapter;
      if (adapter) {
        try {
          const dev = await adapter.requestDevice();
          caps.webgpuDevice = true;
          caps.webgpuLimits = { maxTextureDimension2D: dev.limits.maxTextureDimension2D, maxBufferSize: dev.limits.maxBufferSize };
          dev.destroy?.();
        } catch { caps.webgpuDevice = false; }
      }
    }
  } catch { caps.webgpu = false; }

  // WebGL2 — the workhorse
  try {
    const c = probeCanvas || document.createElement('canvas');
    const gl = c.getContext('webgl2', { antialias: false, failIfMajorPerformanceCaveat: false });
    if (gl) {
      caps.webgl2 = true;
      caps.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      caps.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
      caps.floatLinear = !!gl.getExtension('OES_texture_float_linear');
      caps.floatBlend = !!gl.getExtension('EXT_float_blend');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      caps.renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
      caps.vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR));
      caps.software = /swiftshader|software|llvmpipe|basic render/i.test(caps.renderer);
      const lose = gl.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    }
  } catch { caps.webgl2 = false; }

  /* ── Recommendation ───────────────────────────────────────────────
     This rule has now been wrong twice, for opposite reasons, and both errors
     came from MEASUREMENT METHODOLOGY rather than from the code:

     1. First it demoted software GL to Canvas2D based on 156 ms/frame. That was
        real but misattributed: a shader was failing to compile and silently
        falling back to a CPU readPixels path.
     2. It was then changed to "always WebGL2" based on 3.19 ms/frame for GL vs
        6.72 for Canvas2D. THAT NUMBER WAS ALSO WRONG — WebGL commands are
        asynchronous, so timing a short burst measures command SUBMISSION, not
        execution. Measured at steady state (240 frames, backends interleaved so
        JIT warm-up cannot flatter whichever runs second), the same SwiftShader
        scene costs WebGL2 ~85 ms/frame against Canvas2D ~2.4 ms — a ~35x gap,
        because a per-pixel Gaussian in a fragment shader is enormously more
        expensive in software than Skia's optimised ctx.filter blur.

     So: on a REAL GPU, WebGL2 wins and is preferred. On a SOFTWARE rasteriser
     there is no GPU to win with, and Canvas2D's native Skia path is far ahead.
     Any future change here must be justified by a steady-state, interleaved
     measurement — never by a short burst. */
  if (caps.webgpu) {
    caps.recommended = 'webgpu';
    caps.recommendReason = 'hardware WebGPU adapter';
  } else if (caps.webgl2 && !caps.software) {
    caps.recommended = 'webgl2';
    caps.recommendReason = 'WebGL2 (hardware accelerated)';
  } else if (caps.canvas2d) {
    caps.recommended = 'canvas2d';
    caps.recommendReason = caps.software && caps.webgl2
      ? 'Canvas2D — GL is a software rasteriser, where Skia\u2019s native blur beats a fragment shader by ~35x'
      : 'Canvas2D — no GL available';
  } else if (caps.webgl2) {
    caps.recommended = 'webgl2';
    caps.recommendReason = 'WebGL2 (software rasteriser — no Canvas2D fallback)';
  } else {
    caps.recommended = 'none';
    caps.recommendReason = 'no backend available';
  }
  return caps;
}

/**
 * The contract every backend implements. Keeping it explicit means the
 * viewport, the effects and the exporter are all backend-agnostic.
 */
export class Compositor {
  constructor(kind) {
    this.kind = kind;                    // 'webgpu' | 'webgl2' | 'canvas2d'
    this.label = BACKENDS[kind] || kind;
    this.ready = false;
    this.width = 0; this.height = 0; this.dpr = 1;
    this.stats = { frames: 0, draws: 0, effectPasses: 0, uploads: 0, lastFrameMs: 0, gpuMs: 0, readbacks: 0 };
    this.supportedEffects = new Set();
    this.capabilities = {};
  }
  async init(canvas, opts) { throw new Error('not implemented'); }
  resize(w, h, dpr) { throw new Error('not implemented'); }
  /** Upload/refresh a layer's rasterised source (an OffscreenCanvas or canvas). */
  updateLayerSource(id, source) { throw new Error('not implemented'); }
  /** Run an effect over a layer source, returning a handle to the result. */
  applyEffect(sourceHandle, effect, params, time) { throw new Error('not implemented'); }
  beginFrame(time) { throw new Error('not implemented'); }
  /** Composite one already-processed layer into the frame. */
  drawLayer(handle, { matrix, opacity, blend, crop }) { throw new Error('not implemented'); }
  endFrame() { throw new Error('not implemented'); }
  readback() { throw new Error('not implemented'); }
  destroy() {}
}

export const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
  'add', 'linear-burn', 'vivid-light', 'pin-light', 'hard-mix',
];

/** CSS globalCompositeOperation equivalents — used by the Canvas2D backend. */
export const BLEND_TO_GCO = {
  'normal': 'source-over', 'multiply': 'multiply', 'screen': 'screen', 'overlay': 'overlay',
  'darken': 'darken', 'lighten': 'lighten', 'color-dodge': 'color-dodge', 'color-burn': 'color-burn',
  'hard-light': 'hard-light', 'soft-light': 'soft-light', 'difference': 'difference',
  'exclusion': 'exclusion', 'hue': 'hue', 'saturation': 'saturation', 'color': 'color',
  'luminosity': 'luminosity', 'add': 'lighter', 'linear-burn': 'multiply',
  'vivid-light': 'color-dodge', 'pin-light': 'lighten', 'hard-mix': 'difference',
};

/**
 * GL blend function pairs. Only the modes GL can express natively are true GPU
 * blends; the rest are resolved by a shader pass (see gl2.js `blendPass`).
 */
export const BLEND_TO_GL = {
  'normal':   ['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA'],
  'add':      ['SRC_ALPHA', 'ONE'],
  'screen':   ['ONE', 'ONE_MINUS_SRC_COLOR'],
  'multiply': ['DST_COLOR', 'ONE_MINUS_SRC_ALPHA'],
  'lighten':  ['SRC_ALPHA', 'ONE'],       // resolved properly in-shader
  'darken':   ['SRC_ALPHA', 'ONE'],       // resolved properly in-shader
};

export function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
