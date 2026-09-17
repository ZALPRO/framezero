/* ═══════════════════════════════════════════════════════════════
   core/base.js — utilities, easing library, keyframe tracks
   ═══════════════════════════════════════════════════════════════ */

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const inv = (a, b, v) => (b === a) ? 0 : (v - a) / (b - a);
export const uid = (p = 'n') => p + Math.random().toString(36).slice(2, 9);
export const round = (v, d = 3) => { const m = 10 ** d; return Math.round(v * m) / m; };

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

export function debounce(fn, ms = 120) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function throttle(fn, ms = 16) {
  let last = 0, timer = null, lastArgs = null;
  return (...a) => {
    const now = performance.now(); lastArgs = a;
    if (now - last >= ms) { last = now; fn(...a); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = performance.now(); fn(...lastArgs); }, ms - (now - last));
  };
}

/* colour helpers ------------------------------------------------ */
export function hex2rgb(h) {
  h = String(h).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function rgb2css({ r, g, b, a = 1 }) {
  return a >= 1 ? `rgb(${r | 0},${g | 0},${b | 0})` : `rgba(${r | 0},${g | 0},${b | 0},${round(a, 3)})`;
}
export function hex2css(h, a = 1) { return rgb2css({ ...hex2rgb(h), a }); }
/** parse #rgb/#rrggbb or rgb()/rgba() or named -> {r,g,b,a} */
export function parseColor(s) {
  if (!s) return { r: 255, g: 255, b: 255, a: 1 };
  if (typeof s === 'object' && 'r' in s) return { a: 1, ...s };
  s = String(s).trim();
  if (s.startsWith('#')) return { ...hex2rgb(s), a: 1 };
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p.length > 3 ? p[3] : 1 };
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ═══════════ EASING ═══════════
   Everything an animator needs, closed-form, allocation-free.
   `spring` and `overshoot` are the two AE users write expressions for. */

/** Cubic bezier solver (same curve model as CSS / AE's graph editor). */
export function cubicBezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a;
  const B = (a, b) => 3 * b - 6 * a;
  const C = a => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);
  return function (x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {          // Newton-Raphson
      const s = slope(t, x1, x2);
      if (Math.abs(s) < 1e-6) break;
      t -= (calc(t, x1, x2) - x) / s;
    }
    t = clamp(t, 0, 1);
    return calc(t, y1, y2);
  };
}

export const EASINGS = {
  linear: t => t,
  'ease-in-quad': t => t * t,
  'ease-out-quad': t => 1 - (1 - t) * (1 - t),
  'ease-in-out-quad': t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  'ease-in-cubic': t => t * t * t,
  'ease-out-cubic': t => 1 - Math.pow(1 - t, 3),
  'ease-in-out-cubic': t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  'ease-in-quart': t => t * t * t * t,
  'ease-out-quart': t => 1 - Math.pow(1 - t, 4),
  'ease-in-out-quart': t => t < .5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2,
  'ease-in-expo': t => t === 0 ? 0 : Math.pow(2, 10 * t - 10),
  'ease-out-expo': t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
  'ease-in-out-expo': t => t === 0 ? 0 : t === 1 ? 1 : t < .5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  'ease-in-sine': t => 1 - Math.cos(t * Math.PI / 2),
  'ease-out-sine': t => Math.sin(t * Math.PI / 2),
  'ease-in-out-sine': t => -(Math.cos(Math.PI * t) - 1) / 2,
  'ease-in-circ': t => 1 - Math.sqrt(1 - t * t),
  'ease-out-circ': t => Math.sqrt(1 - (t - 1) * (t - 1)),
  'ease-out-back': t => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  'ease-in-back': t => 2.70158 * t * t * t - 1.70158 * t * t,
  'ease-in-out-back': t => t < .5
    ? (Math.pow(2 * t, 2) * ((2.5949 + 1) * 2 * t - 2.5949)) / 2
    : (Math.pow(2 * t - 2, 2) * ((2.5949 + 1) * (t * 2 - 2) + 2.5949) + 2) / 2,
  'ease-out-elastic': t => t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - .75) * (2 * Math.PI / 3)) + 1,
  'ease-in-elastic': t => t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * (2 * Math.PI / 3)),
  'ease-out-bounce': t => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + .75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + .9375;
    return n * (t -= 2.625 / d) * t + .984375;
  },
  // parametric — see below
  spring: null,
  overshoot: null,
};

/** Damped spring, closed-form-ish via fixed-step integration (stable at any dt). */
export function springValue(t, { stiffness = 180, damping = 14, mass = 1 } = {}) {
  if (t <= 0) return 0;
  const steps = 90;
  const dt = clamp(t, 0.0001, 4) / steps;
  let x = 0, v = 0;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  for (let i = 0; i < steps; i++) {
    const a = -w0 * w0 * (x - 1) - 2 * zeta * w0 * v;
    v += a * dt; x += v * dt;
  }
  return x;
}

/** Overshoot: go past 1 by `amount` then settle. amount 0..1 */
export function overshootValue(t, amount = 0.28) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const s = 1 + amount * 3.2;
  return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
}

export function getEasing(name) {
  if (typeof name === 'function') return name;
  if (Array.isArray(name) && name.length === 4) return cubicBezier(...name);
  return EASINGS[name] || EASINGS.linear;
}

export const EASING_NAMES = Object.keys(EASINGS);

/* ═══════════ KEYFRAME TRACKS ═══════════
   A track is { keys:[{t, v, ease?, easeIn?}], mode:'hold'|'auto' }
   Values may be numbers, arrays (vectors/colours) or strings (discrete). */

export function evalTrack(track, time) {
  if (!track || !Array.isArray(track.keys) || track.keys.length === 0) return track?.value;
  const keys = track.keys;
  if (time <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (time >= last.t) return last.v;

  // binary search for the surrounding pair
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= time) lo = mid; else hi = mid;
  }
  const a = keys[lo], b = keys[hi];
  const span = b.t - a.t;
  if (span <= 0) return a.v;
  let u = (time - a.t) / span;

  const easeName = a.ease || 'ease-out-cubic';
  if (easeName === 'hold') return a.v;

  let e;
  if (easeName === 'spring') e = springValue(u, a.spring);
  else if (easeName === 'overshoot') e = overshootValue(u, a.amount ?? 0.28);
  else if (easeName === 'bezier' && Array.isArray(a.bezier)) e = cubicBezier(...a.bezier)(u);
  else e = getEasing(easeName)(u);

  return mixValue(a.v, b.v, e);
}

export function mixValue(a, b, t) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length), out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = typeof a[i] === 'number' ? a[i] + (b[i] - a[i]) * t : (t < .5 ? a[i] : b[i]);
    return out;
  }
  if (a && b && typeof a === 'object' && 'r' in a && 'r' in b) {
    return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t), a: lerp(a.a ?? 1, b.a ?? 1, t) };
  }
  return t < .5 ? a : b;   // discrete: strings, enums
}

export function setKey(track, t, v, opts = {}) {
  track.keys = track.keys || [];
  const i = track.keys.findIndex(k => Math.abs(k.t - t) < 1e-6);
  if (i >= 0) Object.assign(track.keys[i], { v }, opts);
  else track.keys.push({ t, v, ...opts });
  track.keys.sort((a, b) => a.t - b.t);
  return track;
}
export function removeKey(track, t) {
  if (!track.keys) return;
  track.keys = track.keys.filter(k => Math.abs(k.t - t) >= 1e-6);
}
export function hasKeyAt(track, t) { return !!(track?.keys || []).some(k => Math.abs(k.t - t) < 1e-6); }
export function nearestKey(track, t, dir) {
  const ks = track?.keys || [];
  if (!ks.length) return null;
  if (dir > 0) return ks.find(k => k.t > t + 1e-6) || null;
  for (let i = ks.length - 1; i >= 0; i--) if (ks[i].t < t - 1e-6) return ks[i];
  return null;
}

/** A property is either a plain value or {keys:[...]}. Normalise both. */
export function propValue(prop, time) {
  if (prop === null || prop === undefined) return prop;
  if (typeof prop === 'object' && Array.isArray(prop.keys)) return evalTrack(prop, time);
  return prop;
}
export function isAnimated(prop) { return !!(prop && typeof prop === 'object' && Array.isArray(prop.keys) && prop.keys.length); }
export function staticOf(prop) {
  if (prop && typeof prop === 'object' && Array.isArray(prop.keys)) return prop.keys.length ? prop.keys[0].v : 0;
  return prop;
}

/* ═══════════ TIMECODE ═══════════ */
export function tc(sec, fps = 30) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ff = Math.floor((s - Math.floor(s)) * fps + 1e-6) % fps;
  const p = n => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(ss)}:${p(ff)}`;
}
export function snapToFrame(t, fps) { return Math.round(t * fps) / fps; }

/* ═══════════ MATRIX (2D affine, column-vector convention) ═══════════ */
export const M = {
  ident: () => [1, 0, 0, 1, 0, 0],
  mul: (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ],
  trs: (tx, ty, rot, sx, sy, ax = 0, ay = 0) => {
    const c = Math.cos(rot), s = Math.sin(rot);
    return [c * sx, s * sx, -s * sy, c * sy, tx - (c * sx * ax - s * sy * ay), ty - (s * sx * ax + c * sy * ay)];
  },
  apply: (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]],
  invert: (m) => {
    const d = m[0] * m[3] - m[1] * m[2];
    if (!d) return null;
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
  },
};
