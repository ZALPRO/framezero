/* ═══════════════════════════════════════════════════════════════
   render/shapes.js — vector shape rasterisation

   Shapes are resolution-independent: they are re-rasterised at whatever size
   the layer currently needs, so scaling a shape layer never softens it.
   Every value may be a plain number or a keyframe track (resolved upstream),
   and `time` is threaded through so generated patterns can animate.
   ═══════════════════════════════════════════════════════════════ */

import { clamp, lerp, parseColor, rgb2css, round } from '../core/base.js';

export const SHAPE_TYPES = [
  { id: 'solid',     name: 'Solid',         icon: 'shSolid' },
  { id: 'rect',      name: 'Rectangle',     icon: 'shRect' },
  { id: 'ellipse',   name: 'Ellipse',       icon: 'shEllipse' },
  { id: 'triangle',  name: 'Triangle',      icon: 'shTriangle' },
  { id: 'polygon',   name: 'Polygon',       icon: 'shPolygon' },
  { id: 'star',      name: 'Star',          icon: 'shStar' },
  { id: 'line',      name: 'Line',          icon: 'shLine' },
  { id: 'gradient',  name: 'Gradient',      icon: 'shGradient' },
  { id: 'grid',      name: 'Grid',          icon: 'shGrid' },
  { id: 'checker',   name: 'Checkerboard',  icon: 'shChecker' },
  { id: 'noise',     name: 'Noise field',   icon: 'shNoise' },
];

export const DEFAULT_SHAPES = {
  solid:    {},
  rect:     { rx: 0, ry: 0, inset: 0 },
  ellipse:  { inset: 0 },
  triangle: {},
  polygon:  { sides: 6, rotation: 0, inset: 0 },
  star:     { points: 5, innerRatio: 0.45, rotation: 0 },
  line:     { thickness: 4, cap: 'round', angle: 0 },
  gradient: { from: '#00e5a0', to: '#1b1145', angle: 90, type: 'linear', stops: null },
  grid:     { cell: 48, thickness: 1, color: '#ffffff', phase: 0 },
  checker:  { cell: 48, colorA: '#ffffff', colorB: '#000000' },
  noise:    { scale: 24, octaves: 3, seed: 1, speed: 0.4, contrast: 1 },
};

export const DEFAULT_STYLE = {
  fill: '#00e5a0', fillOpacity: 1,
  stroke: '#ffffff', strokeWidth: 0, strokeOpacity: 1,
  shadow: 0, shadowColor: '#000000', shadowOpacity: 0.5,
};

/* ── path builders ── */
function tracePath(ctx, type, s, W, H) {
  const cx = W / 2, cy = H / 2;
  const inset = s.inset || 0;
  const rx = Math.max(0, W / 2 - inset), ry = Math.max(0, H / 2 - inset);
  ctx.beginPath();
  switch (type) {
    case 'rect': {
      const r = Math.min(s.rx || 0, rx, ry);
      if (r > 0 && ctx.roundRect) ctx.roundRect(inset, inset, rx * 2, ry * 2, r);
      else ctx.rect(inset, inset, rx * 2, ry * 2);
      break;
    }
    case 'ellipse':
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      break;
    case 'triangle': {
      ctx.moveTo(cx, inset);
      ctx.lineTo(W - inset, H - inset);
      ctx.lineTo(inset, H - inset);
      ctx.closePath();
      break;
    }
    case 'polygon': {
      const n = Math.max(3, Math.round(s.sides || 6));
      const rot = ((s.rotation || 0) - 90) * Math.PI / 180;
      for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * Math.PI * 2;
        const x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      break;
    }
    case 'star': {
      const n = Math.max(3, Math.round(s.points || 5));
      const k = clamp(s.innerRatio ?? 0.45, 0.02, 1);
      const rot = ((s.rotation || 0) - 90) * Math.PI / 180;
      for (let i = 0; i < n * 2; i++) {
        const a = rot + (i / (n * 2)) * Math.PI * 2;
        const rr = i % 2 === 0 ? 1 : k;
        const x = cx + Math.cos(a) * rx * rr, y = cy + Math.sin(a) * ry * rr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      break;
    }
    case 'line': {
      const a = (s.angle || 0) * Math.PI / 180;
      const len = Math.hypot(rx, ry);
      ctx.moveTo(cx - Math.cos(a) * len, cy - Math.sin(a) * len);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      break;
    }
    default:
      ctx.rect(0, 0, W, H);
  }
}

function fillFor(ctx, type, s, W, H, style, time) {
  if (type === 'gradient') {
    const a = (s.angle || 0) * Math.PI / 180;
    const cx = W / 2, cy = H / 2;
    const len = Math.abs(W * Math.cos(a)) + Math.abs(H * Math.sin(a));
    const g = s.type === 'radial'
      ? ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, len / 2))
      : ctx.createLinearGradient(cx - Math.cos(a) * len / 2, cy - Math.sin(a) * len / 2, cx + Math.cos(a) * len / 2, cy + Math.sin(a) * len / 2);
    const stops = s.stops && s.stops.length >= 2
      ? s.stops
      : [{ at: 0, color: s.from || '#00e5a0' }, { at: 1, color: s.to || '#1b1145' }];
    for (const st of stops) g.addColorStop(clamp(st.at, 0, 1), st.color);
    return g;
  }
  return style.fill || '#ffffff';
}

/* ── procedural patterns (drawn directly, not via a path) ── */
function drawPattern(ctx, type, s, W, H, style, time) {
  const base = parseColor(style.fill || '#ffffff');
  switch (type) {
    case 'grid': {
      const cell = Math.max(1, s.cell || 48);
      const th = Math.max(0.25, s.thickness || 1);
      const ph = (s.phase || 0) * cell;
      ctx.save();
      ctx.strokeStyle = s.color || rgb2css(base);
      ctx.globalAlpha = clamp(style.fillOpacity ?? 1, 0, 1);
      ctx.lineWidth = th;
      ctx.beginPath();
      for (let x = (ph % cell); x <= W; x += cell) { ctx.moveTo(round(x, 2), 0); ctx.lineTo(round(x, 2), H); }
      for (let y = (ph % cell); y <= H; y += cell) { ctx.moveTo(0, round(y, 2)); ctx.lineTo(W, round(y, 2)); }
      ctx.stroke();
      ctx.restore();
      return true;
    }
    case 'checker': {
      const cell = Math.max(1, s.cell || 48);
      ctx.save();
      ctx.globalAlpha = clamp(style.fillOpacity ?? 1, 0, 1);
      for (let y = 0, r = 0; y < H; y += cell, r++) {
        for (let x = 0, cIx = 0; x < W; x += cell, cIx++) {
          ctx.fillStyle = (r + cIx) % 2 ? (s.colorB || '#000000') : (s.colorA || '#ffffff');
          ctx.fillRect(x, y, Math.ceil(cell), Math.ceil(cell));
        }
      }
      ctx.restore();
      return true;
    }
    case 'noise': {
      const cell = Math.max(1, Math.round(s.scale || 24));
      const t = time * (s.speed || 0);
      let seed = ((s.seed || 1) * 2654435761 + Math.floor(t) * 40503) >>> 0;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const img = ctx.createImageData(W, H);
      const d = img.data;
      const contrast = s.contrast ?? 1;
      const oct = clamp(Math.round(s.octaves || 1), 1, 4);
      // value-noise on a coarse lattice, bilinearly interpolated, fbm-stacked
      const gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2;
      const grids = [];
      for (let o = 0; o < oct; o++) {
        const g2 = new Float32Array(gw * gh * (o + 1) * (o + 1));
        for (let i = 0; i < g2.length; i++) g2[i] = rnd();
        grids.push({ data: g2, w: gw * (o + 1), step: cell / Math.pow(2, o) });
      }
      const sample = (g2, x, y) => {
        const gx = x / g2.step, gy = y / g2.step;
        const x0 = Math.floor(gx), y0 = Math.floor(gy);
        const fx = gx - x0, fy = gy - y0;
        const at = (ix, iy) => g2.data[((iy % (g2.w >> 0)) * g2.w + (ix % g2.w)) % g2.data.length] ?? 0;
        return lerp(lerp(at(x0, y0), at(x0 + 1, y0), fx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx), fy);
      };
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let v = 0, amp = 0.5, norm = 0;
        for (const g2 of grids) { v += amp * sample(g2, x, y); norm += amp; amp *= 0.5; }
        v = clamp(((v / Math.max(1e-6, norm)) - 0.5) * contrast + 0.5, 0, 1);
        const i = (y * W + x) * 4;
        d[i] = base.r * v; d[i + 1] = base.g * v; d[i + 2] = base.b * v;
        d[i + 3] = 255 * clamp(style.fillOpacity ?? 1, 0, 1);
      }
      ctx.putImageData(img, 0, 0);
      return true;
    }
    default: return false;
  }
}

/* ══════════════ public entry ══════════════ */
/**
 * @param ctx   destination 2D context, already sized W×H and cleared
 * @param opts  { width, height, shape:{type,…}, style:{…}, time }
 */
export function rasterizeShape(ctx, opts) {
  const W = opts.width, H = opts.height;
  const shape = opts.shape || { type: 'solid' };
  const type = shape.type || 'solid';
  const s = { ...(DEFAULT_SHAPES[type] || {}), ...shape };
  const style = { ...DEFAULT_STYLE, ...(opts.style || {}) };
  const time = opts.time || 0;

  ctx.save();
  ctx.imageSmoothingQuality = 'high';

  if (style.shadow > 0) {
    ctx.shadowBlur = style.shadow;
    ctx.shadowColor = rgb2css({ ...parseColor(style.shadowColor || '#000000'), a: style.shadowOpacity ?? 0.5 });
  }

  if (type === 'solid') {
    ctx.globalAlpha = clamp(style.fillOpacity ?? 1, 0, 1);
    ctx.fillStyle = style.fill || '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    return { type, painted: true, path: false };
  }

  if (drawPattern(ctx, type, s, W, H, style, time)) { ctx.restore(); return { type, painted: true, path: false }; }

  tracePath(ctx, type, s, W, H);

  if (type === 'line') {
    ctx.lineCap = s.cap || 'round';
    ctx.lineWidth = Math.max(0.25, s.thickness || 4);
    ctx.globalAlpha = clamp(style.fillOpacity ?? 1, 0, 1);
    ctx.strokeStyle = style.fill || '#ffffff';
    ctx.stroke();
  } else {
    if ((style.fillOpacity ?? 1) > 0) {
      ctx.globalAlpha = clamp(style.fillOpacity, 0, 1);
      ctx.fillStyle = fillFor(ctx, type, s, W, H, style, time);
      ctx.fill();
    }
    if ((style.strokeWidth || 0) > 0 && (style.strokeOpacity ?? 1) > 0) {
      ctx.globalAlpha = clamp(style.strokeOpacity, 0, 1);
      ctx.lineWidth = Math.max(0.25, style.strokeWidth);
      ctx.strokeStyle = style.stroke || '#ffffff';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }
  ctx.restore();
  return { type, painted: true, path: true };
}

/** Tight bounding box for a shape, so the raster is not wastefully large. */
export function shapeBounds(shape, style) {
  const sw = (style?.strokeWidth || 0) + (shape?.inset || 0);
  return { pad: Math.ceil(sw + (style?.shadow || 0)) };
}
