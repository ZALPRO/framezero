/* ═══════════════════════════════════════════════════════════════
   render/compositor.js — backend selection + scene rendering

   Everything above this file is backend-agnostic: the viewport, the timeline
   and the exporter all talk to `Renderer`, never to WebGL or Canvas2D
   directly. Swapping backend is a single call and the output is required to
   match within a measured tolerance (tests/render.html asserts this).
   ═══════════════════════════════════════════════════════════════ */

import { detectCapabilities, BACKENDS } from './backend.js';
import { GL2Compositor } from './gl2.js';
import { Canvas2DCompositor } from './canvas2d.js';
import { layoutText, drawText, warmInstances, layoutReport } from './typography.js';
import { rasterizeShape } from './shapes.js';
import { propValue, M, clamp } from '../core/base.js';
import { EFFECTS } from '../effects/registry.js';
// canvas2d implementations that read the frame clock (animated output)
const FX_CLOCK = new Set(['grain', 'turbulence', 'glitch']);

/* Cache-key params: keyed effect values (a focus pull) would otherwise mint a
   fresh key per frame. Quantising to half-pixel buckets keeps hits while the
   applied pass still uses the exact value on a miss. */
function quantiseParams(fx) {
  const p = fx.params || {};
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    out[k] = typeof v === 'number'
      ? Math.round(v * (fx.id === 'gaussianBlur' && k === 'radius' ? 2 : 20)) / (fx.id === 'gaussianBlur' && k === 'radius' ? 2 : 20)
      : v;
  }
  return out;
}

export function createCompositor(kind) {
  switch (kind) {
    case 'webgl2': return new GL2Compositor();
    case 'canvas2d': return new Canvas2DCompositor();
    case 'webgpu': return null;                 // no adapter in CI; upgraded opportunistically
    default: throw new Error(`unknown backend "${kind}"`);
  }
}

/**
 * Pick and initialise a backend, falling back down the chain rather than
 * failing. `preferred` is what the user selected; `caps.recommended` is what
 * the machine can actually do.
 */
export async function initCompositor(canvas, { preferred = 'auto', width, height, dpr = 1 } = {}) {
  const caps = await detectCapabilities();
  const order = preferred === 'auto'
    ? [caps.recommended, 'webgl2', 'canvas2d']
    : [preferred, ...(preferred === 'canvas2d' ? [] : ['webgl2', 'canvas2d'])];

  const attempts = [];
  for (const kind of order) {
    if (!kind || kind === 'webgpu') { attempts.push({ kind: kind || 'webgpu', ok: false, why: 'no adapter available in this environment' }); continue; }
    const c = createCompositor(kind);
    if (!c) { attempts.push({ kind, ok: false, why: 'not implemented' }); continue; }
    try {
      await c.init(canvas, { width, height, dpr, preserveDrawingBuffer: true });
      return { compositor: c, caps, attempts, chosen: kind, fellBack: kind !== order[0] };
    } catch (err) {
      attempts.push({ kind, ok: false, why: String(err.message || err).slice(0, 200) });
      c.destroy?.();
    }
  }
  throw new Error(`no compositor backend could start: ${JSON.stringify(attempts)}`);
}

/* ═══════════════════════════════════════════════════════════════
   Renderer — turns a resolved scene into pixels
   ═══════════════════════════════════════════════════════════════ */

const RASTER_MARGIN = 96;      // room for effects/overshoot around a layer's box
const MAX_RASTER = 8192;       // WebGL2 MAX_TEXTURE_SIZE measured in probe 2
// ctx.filter is the feather path; where it is missing a mask simply has hard
// edges instead of crashing the frame.
const FILTER_OK = (() => {
  try {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : document.createElement('canvas');
    const g = c.getContext('2d'); g.filter = 'blur(1px)'; return g.filter === 'blur(1px)';
  } catch { return false; }
})();

export class Renderer {
  constructor() {
    this.compositor = null;
    this.backend = 'none';
    this.rasters = new Map();
    // Effect-chain output cache (canvas2d backend): static chains on static
    // rasters are rendered once and reused — a 2Mpx halftone must not re-run
    // per frame. Keyed on layer + raster revision + params, so any upstream
    // change (animated matte, keyed param, re-raster) invalidates it.
    this._fxCache = new Map();
    this._revSeq = 0;      // layerId -> { canvas, ctx, w, h, key }
    this.frameStats = { rasterMs: 0, effectMs: 0, compositeMs: 0, totalMs: 0, layers: 0, draws: 0, uploads: 0, passes: 0 };
    // Running average — a single frame's numbers are dominated by whatever the
    // scheduler did that millisecond, which once led us to a wrong conclusion
    // about which backend was faster.
    this.frameAvg = { totalMs: 0, rasterMs: 0, effectMs: 0, compositeMs: 0, frames: 0 };
    this.quality = 1;              // 1 = full, <1 = draft preview scale
    this.viewScale = 1;            // device px per comp px (see _setSource)
    this.sourceWidth = 0; this.sourceHeight = 0;
    this._scratch = null;
  }

  async attach(canvas, opts = {}) {
    const r = await initCompositor(canvas, opts);
    this.compositor = r.compositor;
    this.backend = r.chosen;
    this.caps = r.caps;
    this.attempts = r.attempts;
    this.fellBack = r.fellBack;
    this._setSource(opts);
    return r;
  }

  /**
   * The present scale: device pixels per comp pixel.
   *
   * Scenes are authored, resolved and rasterised in COMP space (a 150px title
   * means 150 comp px whatever the preview resolution). The composite surface
   * may be smaller — that is what draft/proxy mode is. Without this factor the
   * composite draws comp-space geometry 1:1 onto a smaller surface, so a proxy
   * preview shows an oversized, clipped comp instead of a shrunken one. Exact
   * mode hides the bug completely (scale 1), which is why it survived until a
   * draft/exact pixel comparison was written.
   */
  _setSource(opts) {
    const cw = opts.comp?.width || opts.sourceWidth || 0;
    const ch = opts.comp?.height || opts.sourceHeight || 0;
    const dw = opts.width || this.compWidth || 0;
    if (cw > 0 && dw > 0) {
      this.sourceWidth = cw; this.sourceHeight = ch;
      this.viewScale = dw / cw;
    } else {
      this.sourceWidth = 0; this.sourceHeight = 0; this.viewScale = 1;
    }
  }

  resize(w, h, dpr = 1) {
    this.compWidth = w; this.compHeight = h;
    if (this.sourceWidth) this.viewScale = w / this.sourceWidth;
    this.compositor?.resize(w, h, dpr * (this.quality || 1));
  }

  setQuality(q) {
    this.quality = clamp(q, 0.1, 1);
    if (this.compWidth) this.resize(this.compWidth, this.compHeight, this.dpr || 1);
  }

  /* ── layer rasterisation ─────────────────────────────────────── */

  /** Stable identity for a raster cache entry: everything that affects pixels. */
  _rasterKey(layer, time, registry) {
    const s = layer.resolved || layer;
    if (layer.type === 'text') {
      const t = s.text || {};
      const a = t.axes || {};
      return ['text', t.text, t.family, t.size, t.weight, t.tracking, t.leading, t.align,
        t.maxWidth || 0, t.direction || 'auto', t.case || 'none', t.color,
        (s.animators || []).map(an => JSON.stringify(an)).join(';'),
        // Static text must not re-rasterise per frame (same trap the shape
        // branch already avoids): time only matters while animators run.
        (s.animators || []).length ? Math.round(time * 1000) : 0,
        Object.keys(a).sort().map(k => `${k}:${Math.round(a[k] * 1000)}`).join(',')].join('|');
    }
    if (layer.type === 'media') {
      const m = s.media || {};
      return ['media', m.kind, m.assetId, m.frame || 0].join('|');
    }
    // Only the 'noise' pattern reads time (shapes.js: time * (speed||0)).
    // Hashing time unconditionally made EVERY static shape miss the raster cache
    // on every frame, allocating a fresh canvas each time — 8 layers × 240 frames
    // = 1920 canvases, each becoming a new GPU upload source. That is what made
    // the GL backend degrade from 2.5ms to 165ms/frame and never recover, while
    // Canvas2D (which never uploads textures) stayed flat at 4.3ms.
    const sh = s.shape || {};
    const timeDependent = sh.type === 'noise' && (sh.speed || 0) !== 0;
    return ['shape', layer.type, JSON.stringify(sh), JSON.stringify(s.style || {}),
      timeDependent ? Math.round(time * 1000) : 0].join('|');
  }

  /** Rasterise one layer into its own canvas, in layer-local space. */
  rasterizeLayer(layer, time, registry, opts = {}) {
    const t0 = performance.now();
    let key = this._rasterKey(layer, time, registry);
    // masks are baked into the raster, so they are part of its identity
    if (layer.masks && layer.masks.items && layer.masks.items.length) key += '|mk' + JSON.stringify(layer.masks);
    const cached = this.rasters.get(layer.id);
    if (cached && cached.key === key) {
      this.frameStats.rasterCacheHits++;
      cached.reused = true;
      this.frameStats.rasterMs += performance.now() - t0;
      return cached;
    }

    let rec;
    if (layer.type === 'text') rec = this._rasterizeText(layer, time, registry, opts);
    else if (layer.type === 'media') rec = this._rasterizeMedia(layer, time, opts);
    else rec = this._rasterizeShape(layer, time, opts);
    if (rec && layer.masks && layer.masks.enabled !== false && layer.masks.items && layer.masks.items.length) {
      this._applyMasks(rec, layer.masks);
    }

    if (rec) {
      rec.key = key;
      rec.reused = false;
      const prev = this.rasters.get(layer.id);
      if (prev && prev.canvas !== rec.canvas) prev.canvas.close?.();
      rec.rev = ++this._revSeq;
      this.rasters.set(layer.id, rec);
    }
    this.frameStats.rasterMs += performance.now() - t0;
    return rec;
  }

  /**
   * Reuse one canvas per layer id instead of allocating a new one per raster.
   * Even a legitimately-changing raster (animated text) must not churn canvas
   * objects: every fresh canvas becomes a new GPU-side upload source, and under
   * sustained allocation the GL backend stalls hard. Callers clearRect first,
   * so reuse is safe.
   */
  _canvasFor(id, w, h) {
    w = Math.max(1, Math.min(MAX_RASTER, Math.ceil(w)));
    h = Math.max(1, Math.min(MAX_RASTER, Math.ceil(h)));
    this._canvasPool ||= new Map();
    let c = this._canvasPool.get(id);
    if (!c || c.width !== w || c.height !== h) {
      c = this._makeCanvas(w, h);
      this._canvasPool.set(id, c);
    }
    return c;
  }

  _makeCanvas(w, h) {
    w = Math.max(1, Math.min(MAX_RASTER, Math.ceil(w)));
    h = Math.max(1, Math.min(MAX_RASTER, Math.ceil(h)));
    return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  }

  _rasterizeText(layer, time, registry, opts) {
    const s = layer.resolved || layer;
    const t = s.text || {};
    const spec = {
      text: String(t.text ?? ''), family: t.family || 'Inter', size: t.size || 64,
      weight: t.weight ?? 400, tracking: t.tracking || 0, leading: t.leading ?? 1.2,
      align: t.align || 'left', maxWidth: t.maxWidth || 0, direction: t.direction || 'auto',
      case: t.case, color: t.color || '#ffffff', axes: t.axes || {},
      anchor: t.anchor || 'center', vAnchor: t.vAnchor || 'baseline',
      extrude: t.extrude, highlight: t.highlight,
    };
    warmInstances(spec, registry);
    const layout = layoutText(spec, registry, this._measureCtx());
    if (!layout) return null;

    const margin = RASTER_MARGIN;
    const w = Math.ceil(layout.width + margin * 2);
    const h = Math.ceil(layout.height + margin * 2);
    const canvas = this._canvasFor(layer.id, w, h);
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.clearRect(0, 0, w, h);
    drawText(ctx, layout, time, {
      x: margin, y: margin,
      animators: s.animators || [],
      opacity: 1,
      registry,
    });

    // the layer matrix must compensate for the margin we added
    layer._rasterOffset = { x: -margin, y: -margin, w, h };
    return { canvas, ctx, w, h, layout, report: layoutReport(layout), kind: 'text' };
  }

  /**
   * Media layers blit an already-decoded source: an ImageBitmap for stills, a
   * <video> element for clips (the element holds whatever frame the decoder
   * has — the app owns seeking and drift-sync, exactly like a player surface).
   * Decoding never happens in the render loop; this is a drawImage.
   */
  _rasterizeMedia(layer, time, opts) {
    const s = layer.resolved || layer;
    const m = s.media || {};
    const asset0 = opts.assets?.get?.(m.assetId);
    // media size = the source's natural size unless the layer overrides it
    // (resolved.width carries the 640×360 shape default, which must NOT win here)
    const w = Math.max(1, Math.round(layer.width || asset0?.width || 640));
    const h = Math.max(1, Math.round(layer.height || asset0?.height || 360));
    const canvas = this._canvasFor(layer.id, w, h);
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.clearRect(0, 0, w, h);
    const asset = asset0;
    const src = asset && (asset.bitmap || asset.video);
    if (src) { try { ctx.drawImage(src, 0, 0, w, h); } catch { /* not decoded yet */ } }
    // a hand-authored media layer without explicit dims keeps the source's
    // natural size instead of the 640×360 default (demo projects, re-opened files)
    layer._rasterOffset = { x: 0, y: 0, w, h };
    return { canvas, ctx, w, h, kind: 'media' };
  }

  _rasterizeShape(layer, time, opts) {
    const s = layer.resolved || layer;
    const w = Math.max(1, Math.round(s.width || layer.width || 256));
    const h = Math.max(1, Math.round(s.height || layer.height || 256));
    const canvas = this._canvasFor(layer.id, w, h);
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.clearRect(0, 0, w, h);
    rasterizeShape(ctx, { width: w, height: h, shape: s.shape || { type: 'solid' }, style: s.style || {}, time });
    layer._rasterOffset = { x: 0, y: 0, w, h };
    return { canvas, ctx, w, h, kind: 'shape' };
  }

  /* ══════════════════════ masks & track mattes ══════════════════════
     Both live in the raster stage, which both backends share: a mask is drawn
     in layer-local space straight onto the layer raster, and a track matte is
     the source layer's raster mapped through the relative affine of the two
     layers' comp-space matrices. Doing it here — rather than in each backend's
     composite — is what keeps WebGL2 and Canvas2D pixel-identical by
     construction instead of by hope. */

  /** Combine a mask stack into one alpha canvas, then cut the raster with it. */
  _applyMasks(rec, masks) {
    const { w, h } = rec;
    const mc = this._canvasFor(`mask:${w}x${h}`, w, h);
    const mg = mc.getContext('2d');
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, w, h);
    const tmp = this._canvasFor(`maskTmp:${w}x${h}`, w, h);
    const tg = tmp.getContext('2d');
    const cx = w / 2, cy = h / 2;
    // a stack whose every item is switched off is not a mask at all — cutting
    // with an empty alpha canvas would erase the layer
    const active = masks.items.filter(i => i.enabled !== false);
    if (!active.length) return;

    for (const it of active) {
      tg.setTransform(1, 0, 0, 1, 0, 0);
      tg.clearRect(0, 0, w, h);
      tg.globalAlpha = 1; tg.globalCompositeOperation = 'source-over';
      tg.filter = 'none';
      tg.save();
      tg.translate(cx + it.cx, cy + it.cy);
      if (it.rot) tg.rotate(it.rot * Math.PI / 180);
      if (it.feather > 0 && FILTER_OK) tg.filter = `blur(${it.feather}px)`;
      tg.globalAlpha = it.opacity;
      tg.fillStyle = '#fff';
      tg.beginPath();
      if (it.shape === 'rect') tg.rect(-it.w / 2, -it.h / 2, it.w, it.h);
      else tg.ellipse(0, 0, Math.max(0.5, it.w / 2), Math.max(0.5, it.h / 2), 0, 0, Math.PI * 2);
      tg.fill();
      tg.restore();
      tg.filter = 'none';
      if (it.invert) {
        // 1 − α per item, so "inverted add" really is a hole-punch
        const img = tg.getImageData(0, 0, w, h), d = img.data;
        for (let i = 3; i < d.length; i += 4) d[i] = 255 - d[i];
        tg.putImageData(img, 0, 0);
      }
      mg.globalCompositeOperation =
        it.mode === 'subtract' ? 'destination-out' : it.mode === 'intersect' ? 'destination-in' : 'source-over';
      mg.drawImage(tmp, 0, 0);
    }
    mg.globalCompositeOperation = 'source-over';

    const g = rec.ctx;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(mc, 0, 0);
    g.restore();
    g.globalCompositeOperation = 'source-over';
  }

  /**
   * Cut `handle` with another layer's raster. `rel` maps the matte source's
   * local space into the target's local space, so a moved/rotated matte tracks
   * correctly instead of being pasted at the origin.
   */
  _applyMatte(handle, mrec, rel, matte) {
    const w = handle.w, h = handle.h;
    const mc = this._canvasFor(`matteSrc:${w}x${h}`, w, h);
    const mg = mc.getContext('2d');
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, w, h);
    mg.globalCompositeOperation = 'source-over';
    mg.setTransform(rel[0], rel[1], rel[2], rel[3], rel[4], rel[5]);
    mg.drawImage(mrec.canvas, 0, 0);
    mg.setTransform(1, 0, 0, 1, 0, 0);
    if (matte.mode === 'luma' || matte.invert) {
      const img = mg.getImageData(0, 0, w, h), d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        let a = d[i + 3];
        if (matte.mode === 'luma') a = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) * (a / 255);
        if (matte.invert) a = 255 - a;
        d[i + 3] = a;
      }
      mg.putImageData(img, 0, 0);
    }
    const out = this._canvasFor(`matted:${w}x${h}`, w, h);
    const og = out.getContext('2d');
    og.setTransform(1, 0, 0, 1, 0, 0);
    og.clearRect(0, 0, w, h);
    og.globalCompositeOperation = 'source-over';
    og.drawImage(handle.canvas, 0, 0);
    og.globalCompositeOperation = 'destination-in';
    og.drawImage(mc, 0, 0);
    og.globalCompositeOperation = 'source-over';
    return { canvas: out, w, h, kind: 'scratch' };
  }

  _measureCtx() {
    if (!this._mctx) {
      const c = this._makeCanvas(8, 8);
      this._mctx = c.getContext('2d');
    }
    return this._mctx;
  }

  /* ── frame ───────────────────────────────────────────────────── */

  /**
   * Render one frame.
   * @param scene  { width, height, background, layers:[resolvedLayer] }  bottom→top
   * @param time   seconds
   */
  renderFrame(scene, time, registry, opts = {}) {
    const c = this.compositor;
    if (!c) throw new Error('renderer not attached');
    const t0 = performance.now();
    this.frameStats = { rasterMs: 0, effectMs: 0, compositeMs: 0, totalMs: 0, layers: 0, draws: 0, uploads: 0, passes: 0, rasterCacheHits: 0 };

    c.beginFrame(time);
    if (scene.background && scene.background !== 'transparent') c.fillBackground(scene.background);

    const byId = new Map((scene.layers || []).map(l => [l.id, l]));
    const tc0 = performance.now();
    for (const layer of scene.layers || []) {
      if (!layer || layer.visible === false) continue;
      if (layer.matteOnly) continue;   // consumed as a track matte, not drawn
      const op = clamp(layer.opacity ?? 1, 0, 1);
      if (op <= 0.0015) continue;
      // time-window: outside [in,out] the layer contributes nothing
      if (layer.in !== undefined && time < layer.in) continue;
      if (layer.out !== undefined && time >= layer.out) continue;

      /* Adjustment layer (AE semantics): draws nothing itself — its chain runs
         on the composite accumulated so far, i.e. on everything below it. */
      if (layer.adjustment) {
        const achain = (layer.effects || []).filter(fx => fx && fx.enabled !== false && EFFECTS[fx.id]);
        if (achain.length && c.snapshotComp) {
          let h = c.snapshotComp();
          for (const fx of achain) h = c.applyEffect(h, fx, fx.params, time);
          c.presentComp(h);
          this.frameStats.passes += achain.length;
        }
        continue;
      }

      /* Time remap: the layer's CONTENT (media frames, noise fields, text
         animators) reads the remapped clock; transform and effect keys stay on
         comp time, exactly like AE's Time Remap vs property keyframes. */
      const srcTime = this._srcTime(layer, time);

      const rec = this.rasterizeLayer(layer, srcTime, registry, { ...opts, byId });
      if (!rec) continue;

      /* Track matte, Premiere-style: a link in the layer's own chain, applied
         to the raster BEFORE it becomes a backend handle. That placement is
         what keeps it backend-agnostic — a GL handle is a texture record with
         no 2D surface to cut, so cutting after upload would need a second
         two-texture GL program per matte. Effects therefore act on the matted
         raster (a blur after a matte softens its edge, exactly as it would for
         any earlier link in the chain). The matted result is a fresh canvas:
         mutating the cached raster would compound the cut on every cache hit. */
      let src = rec;
      let matteRev = 0;
      if (layer.matte) {
        const ml = byId.get(layer.matte.id);
        if (ml && ml.id !== layer.id) {
          const mrec = this.rasterizeLayer(ml, this._srcTime(ml, time), registry, opts);
          matteRev = mrec ? (mrec.rev || 0) : 0;
          if (mrec) {
            const mt = this._layerMatrix(layer, rec);
            const mm = this._layerMatrix(ml, mrec);
            const rel = M.mul(M.invert(mt) || M.ident(), mm);
            src = this._applyMatte(rec, mrec, rel, layer.matte);
          }
        }
      }

      let handle = c.updateLayerSource(layer.id, src.canvas);
      this.frameStats.uploads++;

      const te0 = performance.now();
      const chain = (layer.effects || []).filter(fx => fx && fx.enabled !== false && EFFECTS[fx.id]);
      // canvas2d effects never read the clock, so a chain on an unchanged
      // raster is pure repeat work — cache its output canvas.
      const clocked = chain.some(fx => FX_CLOCK.has(fx.id));
      const fkey = this.backend === 'canvas2d' && chain.length && !clocked
        ? `${layer.id}|${rec.rev || 0}|${matteRev || 0}|${clocked ? Math.floor(time * 24) : 0}|${JSON.stringify(chain.map(fx => [fx.id, quantiseParams(fx)]))}`
        : null;
      const cached = fkey && this._fxCache.get(fkey);
      if (cached) {
        handle = cached;
      } else {
        for (const fx of chain) {
          // Effects run on the layer-local raster, which is in COMP space, so
          // their 'px' params are already correct as authored; only the final
          // composite matrix carries the device scale.
          handle = c.applyEffect(handle, fx, fx.params, time);
          this.frameStats.passes++;
        }
        if (fkey) {
          const cv = document.createElement('canvas');
          cv.width = handle.w; cv.height = handle.h;
          cv.getContext('2d').drawImage(handle.canvas, 0, 0);
          if (this._fxCache.size > 96) this._fxCache.clear();
          this._fxCache.set(fkey, { canvas: cv, w: handle.w, h: handle.h, _flip: 0 });
        }
      }
      this.frameStats.effectMs += performance.now() - te0;


      const matrix = this._layerMatrix(layer, rec);
      // comp space → device space, once, here, for both backends
      const vs = this.viewScale || 1;
      let m = vs === 1 ? matrix : M.mul([vs, 0, 0, vs, 0, 0], matrix);
      let drawOp = op, scissor = null;

      /* Boundary transitions (Premiere): cross / wipe / slide at the edges of
         the layer's time window. Computed here so both backends get plain
         draw parameters — opacity, matrix offset, comp-space scissor. */
      const tr = layer.transition;
      if (tr) {
        const W = scene.width, H = scene.height;
        const ease = x => x * x * (3 - 2 * x);
        if (tr.in && layer.in !== undefined && time < layer.in + tr.in.duration) {
          const p = ease(clamp((time - layer.in) / tr.in.duration, 0, 1));
          if (tr.in.type === 'cross') drawOp *= p;
          else if (tr.in.type === 'wipeL') scissor = [0, 0, W * p, H];
          else if (tr.in.type === 'wipeR') scissor = [W * (1 - p), 0, W * p, H];
          else if (tr.in.type === 'slideL') { m = [...m]; m[4] -= (1 - p) * W * vs; }
          else if (tr.in.type === 'slideR') { m = [...m]; m[4] += (1 - p) * W * vs; }
        } else if (tr.out && layer.out !== undefined && time > layer.out - tr.out.duration) {
          const q = ease(clamp((layer.out - time) / tr.out.duration, 0, 1));
          if (tr.out.type === 'cross') drawOp *= q;
          else if (tr.out.type === 'wipeL') scissor = [W * (1 - q), 0, W * q, H];
          else if (tr.out.type === 'wipeR') scissor = [0, 0, W * q, H];
          else if (tr.out.type === 'slideL') { m = [...m]; m[4] -= (1 - q) * W * vs; }
          else if (tr.out.type === 'slideR') { m = [...m]; m[4] += (1 - q) * W * vs; }
        }
      }
      c.drawLayer(handle, { matrix: m, opacity: drawOp, blend: layer.blend || 'normal', scissor });
      this.frameStats.layers++;
      this.frameStats.draws++;
    }
    this.frameStats.compositeMs += performance.now() - tc0;

    c.endFrame();
    this.frameStats.totalMs = performance.now() - t0;
    // exponential moving average, α = 1/15 → settles in about a quarter second
    const a = this.frameAvg, k = a.frames ? 1 / 15 : 1;
    a.frames++;
    for (const key of ['totalMs', 'rasterMs', 'effectMs', 'compositeMs']) {
      a[key] = a[key] + (this.frameStats[key] - a[key]) * k;
    }
    const cs = c.stats || {};
    this.frameStats.gpuDraws = cs.draws;
    this.frameStats.effectPasses = cs.effectPasses;
    this.frameStats.pixelBlends = cs.pixelBlends || 0;
    return this.frameStats;
  }

  /**
   * Build the layer-space → comp-space affine.
   * The raster carries a margin (text) that must be cancelled out, then the
   * layer's own transform/anchor/position apply.
   */
  /** Remapped source clock for a layer (time-remap rate). */
  _srcTime(layer, time) {
    const spd = Number(layer?.speed);
    if (!Number.isFinite(spd) || spd === 1 || spd === 0) return time;
    const lin = layer.in || 0;
    return lin + (time - lin) * spd;
  }

  _layerMatrix(layer, rec) {
    const s = layer.resolved || layer;
    const off = layer._rasterOffset || { x: 0, y: 0 };
    const tx = s.position?.[0] ?? s.x ?? 0;
    const ty = s.position?.[1] ?? s.y ?? 0;
    const rot = (s.rotation ?? 0) * Math.PI / 180;
    const sx = s.scale?.[0] ?? 1, sy = s.scale?.[1] ?? s.scale?.[0] ?? 1;
    // anchor defaults to the raster centre, like AE's anchor point
    const ax = s.anchorPoint?.[0] ?? rec.w / 2;
    const ay = s.anchorPoint?.[1] ?? rec.h / 2;
    const m = M.trs(tx, ty, rot, sx, sy, ax, ay);
    // fold in the raster margin offset
    return M.mul(m, [1, 0, 0, 1, off.x, off.y]);
  }

  readback() { return this.compositor?.readback(); }

  /** PNG data URL of the current frame — used by the exporter + pixel diffs. */
  async toDataURL(type = 'image/png') {
    const rb = this.readback();
    if (!rb) return null;
    if (rb.canvas.convertToBlob) {
      const blob = await rb.canvas.convertToBlob({ type });
      return new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    }
    return rb.canvas.toDataURL(type);
  }

  stats() {
    return {
      backend: this.backend,
      label: BACKENDS[this.backend] || this.backend,
      capabilities: this.compositor?.capabilities || {},
      supportedEffects: this.compositor?.supportedEffects?.size ?? 0,
      degradedEffects: this.compositor?.degradedEffects || [],
      shaderErrors: this.compositor?.shaderErrors?.() || this.compositor?.effectErrors?.() || [],
      frame: this.frameStats,
      frameAvg: { ...this.frameAvg, totalMs: +this.frameAvg.totalMs.toFixed(3), rasterMs: +this.frameAvg.rasterMs.toFixed(3), effectMs: +this.frameAvg.effectMs.toFixed(3), compositeMs: +this.frameAvg.compositeMs.toFixed(3) },
      lifetime: this.compositor?.stats || {},
      fellBack: this.fellBack,
      attempts: this.attempts,
    };
  }

  destroy() {
    for (const r of this.rasters.values()) r.canvas?.close?.();
    // pooled canvases are the ones actually holding GPU-side upload resources
    this._canvasPool?.clear();
    this._canvasPool = null;
    this.rasters.clear();
    this.rasters.clear();
    this.compositor?.destroy();
    this.compositor = null;
  }
}
