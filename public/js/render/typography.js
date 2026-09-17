/* ═══════════════════════════════════════════════════════════════════════
   render/typography.js — the typographic engine

   Every design decision here is backed by pixel measurement
   (docs/platform-findings.md, probes 1–4):

   • A line is rasterised ONCE into a buffer with full shaping context;
     per-unit animation blits slices of that buffer.
     Measured: identity blit reproduces whole-string ink EXACTLY
     (2805 == 2805 px). Drawing clusters separately inflates ink
     1639 → 2333 (+42%) because Arabic letters lose their joined forms.
     ⇒ FrameZero can animate Persian/Arabic per-glyph without breaking
       the script. After Effects cannot.

   • Animation units come from a column-ink scan with gap=0 — verified
     faithful: "0123456789" → exactly 10 units; a 25-char Latin sentence
     → 20; "سلام دنیا" → 4 cursive groups. Cost O(width): 2 ms for 2000
     characters, versus 152 ms for quadratic prefix measurement.

   • Custom variable axes are baked into FontFace.variationSettings
     (~3 ms each, pixel-verified). Registered axes stay dynamic per draw.

   • Per-unit blit animation costs ~0.8 ms/frame — inside a 60 fps budget.
   ═══════════════════════════════════════════════════════════════════════ */

import { clamp, lerp, round, getEasing, springValue, overshootValue, parseColor, rgb2css, mulberry32 } from '../core/base.js';
import { fontShorthand, scriptOf, isRTLScript } from '../core/fonts.js';

const PAD_X = 64;              // horizontal buffer padding: scaled/rotated units must not clip
const INK_THRESHOLD = 30;      // alpha above which a column counts as inked
const MAX_LAYOUT_CACHE = 64;
const MAX_BUFFER_CACHE = 48;

/* ══════════════ grapheme clustering ══════════════ */
let _segmenter;
function segmenter() {
  if (_segmenter === undefined) {
    try { _segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('und', { granularity: 'grapheme' }) : null; }
    catch { _segmenter = null; }
  }
  return _segmenter;
}
export function graphemes(s) {
  const sg = segmenter();
  if (sg) return [...sg.segment(String(s))].map(x => x.segment);
  const out = [];
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const combining = (cp >= 0x0300 && cp <= 0x036F) || (cp >= 0x0610 && cp <= 0x061A)
      || (cp >= 0x064B && cp <= 0x065F) || cp === 0x200C || cp === 0x200D || cp === 0xFE0F;
    if (out.length && combining) out[out.length - 1] += ch; else out.push(ch);
  }
  return out;
}

/* ══════════════ script runs + font routing ══════════════ */
/**
 * Split text into same-script runs and pick a family that genuinely covers
 * each one. The silent-fallback case is reported, never swallowed — that is
 * the exact failure After Effects hides.
 */
export function buildRuns(text, registry, preferred, overrides = {}) {
  const runs = [];
  const warnings = [];
  let cur = null, cursor = 0;

  for (const ch of graphemes(text)) {
    let sc = scriptOf(ch.codePointAt(0));
    // digits and punctuation inherit the neighbouring script so Persian text
    // keeps Persian digits instead of flipping to Latin mid-word
    if ((sc === 'digit' || sc === 'punct') && cur) sc = cur.script;
    if (cur && cur.script === sc) { cur.text += ch; cur.chars.push(ch); }
    else { cur = { script: sc, text: ch, chars: [ch], start: cursor }; runs.push(cur); }
    cursor++;
  }

  for (const run of runs) {
    let family = overrides.family || preferred;
    const info = registry?.meta?.[family]?.scripts?.[run.script];
    if (info && run.text.trim()) {
      const uncovered = info.pct === 0 || info.covered === false;
      if (uncovered) {
        const routed = registry.routeForScript(run.script, preferred);
        warnings.push({
          level: 'warn', code: 'silent-fallback', family, script: run.script,
          scriptName: info.name || run.script, sample: run.text.trim().slice(0, 14), routedTo: routed,
          message: `“${family}” has 0% coverage for ${info.name || run.script} (“${run.text.trim().slice(0, 14)}”). Routed to “${routed}”. After Effects would silently substitute an unrelated system font here and never tell you.`,
        });
        family = routed;
      } else if (info.pct < 100) {
        warnings.push({ level: 'info', code: 'partial-coverage', family, script: run.script, pct: info.pct, message: `“${family}” covers ${info.pct}% of ${info.name || run.script}.` });
      }
    }
    run.family = family;
    run.dir = isRTLScript(run.script) ? 'rtl' : 'ltr';
  }
  return { runs, warnings };
}

/* ══════════════ caches ══════════════ */
const layoutCache = new Map();
const bufferCache = new Map();
function touch(map, key, val, max) {
  map.delete(key); map.set(key, val);
  while (map.size > max) { const k = map.keys().next().value; const v = map.get(k); v?.canvas?.close?.(); map.delete(k); }
}
export function clearTypographyCaches() { layoutCache.clear(); for (const v of bufferCache.values()) v.canvas?.close?.(); bufferCache.clear(); }
export function cacheStats() { return { layouts: layoutCache.size, buffers: bufferCache.size }; }

/**
 * The cache key MUST include the resolved (baked) family names: a bake lands
 * asynchronously, and without this the stale un-baked buffer would be served
 * forever. This was a real bug, found by reasoning about the async path.
 */
function styleKey(spec, registry) {
  const a = spec.axes || {};
  const resolved = registry?.instanceSync(spec.family, a) || spec.family;
  return [
    resolved, spec.size, spec.weight ?? 400, spec.tracking || 0, spec.wordSpacing || 0,
    spec.leading ?? 1.2, spec.align || 'left', spec.vAlign || 'top', spec.maxWidth || 0,
    spec.direction || 'auto', spec.case || 'none', spec.kerning === false ? 'k0' : 'k1',
    spec.text, Object.keys(a).sort().map(k => `${k}:${round(a[k], 3)}`).join(','),
  ].join('|');
}

/* ══════════════ font application (verified mechanisms only) ══════════════ */
export function applyFontTo(ctx, spec, registry) {
  const family = registry?.instanceSync(spec.family, spec.axes) || spec.family;
  // NOTE: stretch is deliberately null — percentages break the shorthand parse
  // (measured) and keywords only offer 9 buckets. wdth is baked instead.
  ctx.font = fontShorthand({ size: spec.size, family, weight: spec.weight ?? 400, stretch: null });
  ctx.letterSpacing = `${spec.tracking || 0}px`;
  ctx.wordSpacing = `${spec.wordSpacing || 0}px`;
  ctx.fontKerning = spec.kerning === false ? 'none' : 'normal';
  if ('textRendering' in ctx) ctx.textRendering = spec.textRendering || 'optimizeLegibility';
  return family;
}

/** Ask the registry to start baking every axis set this spec needs. */
export function warmInstances(spec, registry) { registry?.warm(spec.family, spec.axes); }

let _scratch;
function scratchContext() {
  if (!_scratch) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8)
      : Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
    _scratch = c.getContext('2d');
  }
  return _scratch;
}
function makeCanvas(w, h, readFrequently) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

/* ══════════════ line breaking ══════════════ */
function breakLines(paragraphs, measure, maxWidth) {
  if (!maxWidth || maxWidth <= 0) return paragraphs.map(text => ({ text, hard: true }));
  const out = [];
  for (const para of paragraphs) {
    const tokens = para.split(/(\s+)/).filter(Boolean);
    let line = '';
    for (const tok of tokens) {
      const trial = line + tok;
      if (line && tok.trim() && measure(trial) > maxWidth) {
        out.push({ text: line.replace(/\s+$/, ''), hard: false });
        line = tok.replace(/^\s+/, '');
      } else line = trial;
    }
    out.push({ text: line.replace(/\s+$/, ''), hard: true });
  }
  return out;
}

function applyCase(s, mode) {
  switch (mode) {
    case 'upper': return s.toUpperCase();
    case 'lower': return s.toLowerCase();
    case 'title': return s.replace(/[^\s]+/g, w => w[0].toUpperCase() + w.slice(1));
    default: return s;
  }
}

/* ══════════════ LAYOUT ══════════════ */
export function layoutText(spec, registry, measCtx) {
  const key = styleKey(spec, registry);
  const hit = layoutCache.get(key);
  if (hit) { hit.cached = true; return hit; }

  const t0 = performance.now();
  const text = applyCase(String(spec.text ?? ''), spec.case);
  const size = Math.max(1, spec.size || 64);
  const leading = size * (spec.leading ?? 1.2);
  const mctx = measCtx || scratchContext();

  const { runs, warnings } = buildRuns(text, registry, spec.family, spec.fontOverrides);
  const measure = (s, family) => {
    mctx.save();
    applyFontTo(mctx, { ...spec, family: family || spec.family }, registry);
    const w = mctx.measureText(s).width;
    mctx.restore();
    return w;
  };

  const primary = runs.find(r => r.text.trim())?.family || spec.family;
  const rawLines = breakLines(text.split('\n'), s => measure(s, primary), spec.maxWidth);

  const lines = rawLines.map((ln, i) => {
    const lr = buildRuns(ln.text, registry, spec.family, spec.fontOverrides);
    const dir = (spec.direction === 'ltr' || spec.direction === 'rtl') ? spec.direction
      : (lr.runs.some(r => r.dir === 'rtl' && r.text.trim()) ? 'rtl' : 'ltr');
    return { index: i, text: ln.text, runs: lr.runs, warnings: lr.warnings, dir, hard: ln.hard, width: measure(ln.text, lr.runs[0]?.family || primary), y: i * leading };
  });

  const width = lines.reduce((m, l) => Math.max(m, l.width), 0);
  for (const l of lines) {
    l.x = spec.align === 'center' ? (width - l.width) / 2
      : spec.align === 'right' ? (width - l.width)
      : spec.align === 'justify' ? 0 : 0;
    if (!spec.align || spec.align === 'auto') l.x = l.dir === 'rtl' ? width - l.width : 0;
  }

  const layout = {
    key, cached: false, spec: { ...spec }, text, size, leading,
    dir: (spec.direction === 'ltr' || spec.direction === 'rtl') ? spec.direction
      : (runs.some(r => r.dir === 'rtl' && r.text.trim()) ? 'rtl' : 'ltr'),
    lines, width, height: Math.max(leading, lines.length * leading),
    runs, warnings, padX: PAD_X,
    metrics: { layoutMs: 0, scanMs: 0, units: 0, words: 0, buffers: 0 },
  };

  for (const line of layout.lines) {
    const buf = lineBuffer(layout, line, registry);
    line.buffer = buf;
    const scan = extractUnits(buf);
    line.units = scan.units;
    line.wordCount = scan.wordCount;
    layout.metrics.units += scan.units.length;
    layout.metrics.words += scan.wordCount;
    layout.metrics.buffers++;
  }

  layout.metrics.layoutMs = round(performance.now() - t0, 3);
  touch(layoutCache, key, layout, MAX_LAYOUT_CACHE);
  return layout;
}

/* ══════════════ line buffer: shape once, correctly ══════════════ */
export function lineBuffer(layout, line, registry) {
  const bkey = `${layout.key}#${line.index}`;
  const hit = bufferCache.get(bkey);
  if (hit) return hit;

  const spec = layout.spec;
  const size = layout.size;
  const leading = layout.leading;

  // real font metrics, so the baseline lands typographically instead of by guess
  const mctx = scratchContext();
  mctx.save();
  applyFontTo(mctx, { ...spec, family: line.runs[0]?.family || spec.family }, registry);
  mctx.direction = line.dir;
  const m = mctx.measureText(line.text || ' ');
  const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || size * 0.8;
  const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || size * 0.22;
  mctx.restore();

  const vPad = Math.ceil(size * 0.85);                       // room for scale/blur overshoot
  const emBox = ascent + descent;
  const halfLead = Math.max(0, (leading - emBox) / 2);
  const H = Math.max(2, Math.ceil(leading + vPad * 2));
  const W = Math.max(2, Math.ceil(line.width + PAD_X * 2));
  const baseline = Math.round(vPad + halfLead + ascent);

  const canvas = makeCanvas(W, H, true);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = '#ffffff';

  const sameFamily = line.runs.length > 0 && line.runs.every(r => r.family === line.runs[0].family);
  if (sameFamily) {
    // a single draw call lets the browser do bidi + joining perfectly
    g.direction = line.dir;
    applyFontTo(g, { ...spec, family: line.runs[0].family }, registry);
    g.fillText(line.text, PAD_X, baseline);
  } else {
    // mixed scripts: position each run; shaping inside a run stays intact
    const widths = line.runs.map(r => { applyFontTo(g, { ...spec, family: r.family }, registry); return g.measureText(r.text).width; });
    const total = widths.reduce((a, b) => a + b, 0);
    let x = line.dir === 'rtl' ? PAD_X + total : PAD_X;
    line.runs.forEach((r, i) => {
      applyFontTo(g, { ...spec, family: r.family }, registry);
      g.direction = r.dir;
      if (line.dir === 'rtl') { x -= widths[i]; g.fillText(r.text, x, baseline); }
      else { g.fillText(r.text, x, baseline); x += widths[i]; }
    });
  }

  const buf = { canvas, ctx: g, W, H, baseline, vPad, padX: PAD_X, ascent, descent, key: bkey };
  touch(bufferCache, bkey, buf, MAX_BUFFER_CACHE);
  return buf;
}

/* ══════════════ animation units via column-ink scan ══════════════ */
export function extractUnits(buf, gap = 0) {
  const { canvas, W, H } = buf;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  let data;
  try { data = g.getImageData(0, 0, W, H).data; } catch { return { units: [], wordCount: 0 }; }

  const col = new Uint32Array(W);
  const top = new Int32Array(W).fill(-1);
  const bot = new Int32Array(W).fill(-1);
  for (let y = 0; y < H; y++) {
    const row = y * W * 4 + 3;
    for (let x = 0; x < W; x++) {
      if (data[row + x * 4] > INK_THRESHOLD) { col[x]++; if (top[x] < 0) top[x] = y; bot[x] = y; }
    }
  }

  const units = [];
  let start = -1, zeros = 0;
  for (let x = 0; x <= W; x++) {
    const inked = x < W && col[x] > 0;
    if (inked) { if (start < 0) start = x; zeros = 0; continue; }
    if (start < 0) continue;
    zeros++;
    if (zeros > gap || x === W) {
      const end = x - zeros;
      let ink = 0, t = H, b = -1;
      for (let k = start; k <= end; k++) { ink += col[k]; if (top[k] >= 0 && top[k] < t) t = top[k]; if (bot[k] > b) b = bot[k]; }
      units.push({ index: units.length, x0: start, x1: end + 1, ink, top: t, bottom: b, cx: (start + end + 1) / 2, cy: (t + b) / 2, word: 0 });
      start = -1; zeros = 0;
    }
  }

  // words = units separated by an unusually large gap
  let wordCount = units.length ? 1 : 0;
  if (units.length > 1) {
    const gaps = units.slice(1).map((u, i) => u.x0 - units[i].x1);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const wordGap = Math.max(median * 2.4, buf.H * 0.06);
    units.forEach((u, i) => { u.word = wordCount - 1; if (i < gaps.length && gaps[i] > wordGap) wordCount++; });
  }
  units.forEach(u => { u.wordX0 = u.x0; });
  return { units, wordCount };
}

/** Units in animation order. RTL reads right→left; that is what 'auto' means. */
export function orderedUnits(line, order = 'auto') {
  const u = [...(line.units || [])];
  const rtl = line.dir === 'rtl';
  if (order === 'random') {
    const rnd = mulberry32(u.length * 7919 + 13);
    for (let i = u.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [u[i], u[j]] = [u[j], u[i]]; }
  } else if (order === 'center') {
    const mid = (u.length - 1) / 2;
    u.sort((a, b) => Math.abs(a.index - mid) - Math.abs(b.index - mid));
  } else if (order === 'reverse' || order === 'auto' && rtl || order === 'forward' && rtl) {
    u.reverse();
  }
  return u;
}

function groupByWord(line) {
  const groups = [];
  let cur = null;
  for (const u of line.units || []) {
    if (!cur || u.word !== cur.word) { cur = { ...u, index: groups.length, parts: [u] }; groups.push(cur); }
    else { cur.x1 = u.x1; cur.parts.push(u); cur.ink += u.ink; cur.cx = (cur.x0 + cur.x1) / 2; cur.top = Math.min(cur.top, u.top); cur.bottom = Math.max(cur.bottom, u.bottom); cur.cy = (cur.top + cur.bottom) / 2; }
  }
  return groups;
}

function wholeLineUnit(line) {
  if (!line.buffer) return [];
  return [{ index: 0, x0: line.buffer.padX, x1: line.buffer.padX + Math.max(1, line.width), ink: (line.units || []).reduce((s, u) => s + u.ink, 0), top: 0, bottom: line.buffer.H, cx: line.buffer.padX + line.width / 2, cy: line.buffer.H / 2, word: 0 }];
}

/* ══════════════ animators ══════════════ */
export const ANIMATOR_PROPS = {
  opacity:    { base: 1,  min: 0,    max: 1,   label: 'Opacity',    comp: 'mul' },
  x:          { base: 0,  min: -600, max: 600, label: 'Offset X',   unit: 'px', comp: 'add' },
  y:          { base: 0,  min: -600, max: 600, label: 'Offset Y',   unit: 'px', comp: 'add' },
  scale:      { base: 1,  min: 0,    max: 4,   label: 'Scale',      comp: 'mul' },
  scaleX:     { base: 1,  min: 0,    max: 4,   label: 'Scale X',    comp: 'mul' },
  scaleY:     { base: 1,  min: 0,    max: 4,   label: 'Scale Y',    comp: 'mul' },
  rotation:   { base: 0,  min: -360, max: 360, label: 'Rotation',   unit: '°',  comp: 'add' },
  blur:       { base: 0,  min: 0,    max: 60,  label: 'Blur',       unit: 'px', comp: 'add' },
  tracking:   { base: 0,  min: -60,  max: 240, label: 'Tracking',   unit: 'px', comp: 'add' },
  brightness: { base: 1,  min: 0,    max: 3,   label: 'Brightness', comp: 'mul' },
  hue:        { base: 0,  min: -180, max: 180, label: 'Hue shift',  unit: '°',  comp: 'add' },
};

export function defaultAnimator(over = {}) {
  return {
    id: over.id || ('anim' + Math.random().toString(36).slice(2, 8)),
    name: over.name || 'Animator',
    enabled: true,
    unit: 'glyph',                    // 'glyph' | 'word' | 'line'
    order: 'auto',                    // 'auto' | 'forward' | 'reverse' | 'random' | 'center'
    range: { start: 0, end: 100, offset: 0, softness: 0 },
    delay: 0.045,                     // stagger, seconds per unit
    duration: 0.55,                   // seconds each unit takes
    ease: 'ease-out-cubic',
    // 'from' = props are the START state: units begin offset/invisible and
    //          settle onto the base — the staggered reveal kinetic type lives on.
    // 'to'   = props are the DESTINATION: units sit at base and travel to them.
    // The engine supports both; authoring almost always wants 'from', and with
    // only 'to' a staggered reveal is inexpressible (at t=0 every unit is base,
    // i.e. already visible).
    mode: 'from',
    anchor: 'center',                 // 'left' | 'center' | 'right'
    vAnchor: 'baseline',              // 'top' | 'center' | 'baseline' | 'bottom'
    props: { y: -46, opacity: 0, scale: 0.86 },
    ...over,
  };
}

function easeOf(name, t) {
  if (name === 'spring') return springValue(t);
  if (name === 'overshoot') return overshootValue(t, 0.28);
  return getEasing(name)(t);
}

/**
 * Split an animator's influence on one unit into two factors:
 *   gate — the range selector (units outside the window never move, in either mode)
 *   p    — eased per-unit progress, 0 before its stagger, 1 after delay+duration
 * `animatorAmount` is gate*p: the tested "how far along" contract. Keeping the
 * factors separate lets mode 'from' invert ONLY the progress, never the gate.
 */
export function animatorParts(anim, pos, count, time) {
  if (!anim || anim.enabled === false || count <= 0) return { gate: 0, p: 0 };
  const r = anim.range || {};
  const start = r.start ?? 0, end = r.end ?? 100, offset = r.offset ?? 0, soft = r.softness ?? 0;
  const u = count === 1 ? 0.5 : pos / (count - 1);
  const lo = (start + offset) / 100, hi = (end + offset) / 100;

  // selector gate: units outside the window do not move
  let gate = 1;
  if (end - start < 99.999) {
    if (u < lo) gate = soft > 0 ? clamp(1 - (lo - u) / (soft / 100 || 1e-6), 0, 1) : 0;
    else if (u > hi) gate = soft > 0 ? clamp(1 - (u - hi) / (soft / 100 || 1e-6), 0, 1) : 0;
  }
  if (gate === 0) return { gate: 0, p: 0 };

  const delay = (anim.delay ?? 0) * pos;
  const dur = Math.max(0.001, anim.duration ?? 0.5);
  return { gate, p: easeOf(anim.ease, clamp((time - delay) / dur, 0, 1)) };
}

/** 0..1 contribution of one animator to one unit at `time` (gate × progress). */
export function animatorAmount(anim, pos, count, time) {
  const { gate, p } = animatorParts(anim, pos, count, time);
  return gate * p;
}

/**
 * Per-unit render state. Composition rule is explicit:
 *   additive props (x, y, rotation, blur, tracking, hue) sum their deltas
 *   multiplicative props (opacity, scale*, brightness) multiply
 */
export function computeUnitStates(line, animators, time) {
  const anims = (animators || []).filter(a => a && a.enabled !== false);
  const mode = anims[0]?.unit || 'glyph';
  const units = mode === 'word' ? groupByWord(line) : mode === 'line' ? wholeLineUnit(line) : orderedUnits(line, anims[0]?.order || 'auto');
  const n = units.length;
  const states = new Array(n);

  for (let pos = 0; pos < n; pos++) {
    const u = units[pos];
    const st = { unit: u, pos, opacity: 1, x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, blur: 0, tracking: 0, brightness: 1, hue: 0, animated: false };
    for (const anim of anims) {
      const { gate, p } = animatorParts(anim, pos, n, time);
      // mode decides which end of the timeline the authored props live at:
      //   'to'   → contribution grows with progress  (props = destination)
      //   'from' → contribution decays with progress (props = start state)
      // The gate multiplies both, so selector-excluded units stay untouched.
      const a = gate * (anim.mode === 'from' ? 1 - p : p);
      if (a === 0) continue;
      st.animated = true;
      for (const prop in anim.props) {
        const def = ANIMATOR_PROPS[prop];
        const target = anim.props[prop];
        if (!def || target === undefined || target === def.base) continue;
        if (def.comp === 'add') st[prop] += (target - def.base) * a;
        else st[prop] *= lerp(1, target / (def.base || 1), a);
      }
    }
    st.scaleX *= st.scale; st.scaleY *= st.scale;
    st.opacity = clamp(st.opacity, 0, 1);
    st.scaleX = clamp(st.scaleX, 0, 8); st.scaleY = clamp(st.scaleY, 0, 8);
    st.blur = Math.max(0, st.blur);
    states[pos] = st;
  }
  return states;
}

/* ══════════════ tinted blit ══════════════
   The shaped buffer is white-on-transparent. Tinting and per-unit effects go
   through one reusable scratch layer so the hot path allocates nothing. */
let _fx, _fxCtx;
function fxLayer(w, h) {
  if (!_fx) { _fx = makeCanvas(Math.max(1, w), Math.max(1, h)); _fxCtx = _fx.getContext('2d', { willReadFrequently: false }); }
  if (_fx.width < w || _fx.height < h) { _fx.width = Math.ceil(w); _fx.height = Math.ceil(h); }
  return _fxCtx;
}

function blitTinted(ctx, src, sx, sw, H, dx, dy, tint, blur, hue, brightness) {
  const isWhite = tint.r >= 254 && tint.g >= 254 && tint.b >= 254 && (tint.a ?? 1) >= 1;
  const needsFx = blur > 0.02 || hue !== 0 || (brightness !== 1 && brightness !== undefined);
  if (isWhite && !needsFx) { ctx.drawImage(src, sx, 0, sw, H, dx, dy, sw, H); return; }

  const g = fxLayer(sw, H);
  g.clearRect(0, 0, sw, H);
  g.globalCompositeOperation = 'source-over';
  g.filter = needsFx
    ? [blur > 0.02 ? `blur(${round(blur, 2)}px)` : null, hue ? `hue-rotate(${round(hue, 1)}deg)` : null,
       (brightness !== 1 && brightness !== undefined) ? `brightness(${round(brightness, 3)})` : null].filter(Boolean).join(' ')
    : 'none';
  g.drawImage(src, sx, 0, sw, H, 0, 0, sw, H);
  g.filter = 'none';
  if (!isWhite) {
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = rgb2css(tint);
    g.fillRect(0, 0, sw, H);
    g.globalCompositeOperation = 'source-over';
  }
  ctx.drawImage(_fx, 0, 0, sw, H, dx, dy, sw, H);
}

/* ══════════════ DRAW ══════════════ */
export function drawLine(ctx, layout, line, time, opts = {}) {
  const buf = line.buffer;
  if (!buf || !buf.W) return;
  const spec = layout.spec;
  const tint = parseColor(spec.color || '#ffffff');
  const animators = (opts.animators || []).filter(a => a && a.enabled !== false);
  const destX = (opts.originX || 0) + line.x - PAD_X;
  const destY = (opts.originY || 0) + line.y - buf.vPad;
  const gAlpha = opts.opacity ?? 1;

  if (!animators.length) {
    // fast path: one blit, no scratch layer when the colour is white
    if (gAlpha < 1) { ctx.save(); ctx.globalAlpha *= gAlpha; }
    blitTinted(ctx, buf.canvas, 0, buf.W, buf.H, destX, destY, tint, 0, 0, 1);
    if (gAlpha < 1) ctx.restore();
    return;
  }

  const states = computeUnitStates(line, animators, time);
  for (const st of states) {
    const u = st.unit;
    const w = Math.max(1, u.x1 - u.x0);
    const ax = spec.anchor === 'left' ? u.x0 : spec.anchor === 'right' ? u.x1 : u.cx;
    const ay = spec.vAnchor === 'top' ? u.top : spec.vAnchor === 'bottom' ? u.bottom
      : spec.vAnchor === 'center' ? u.cy : buf.baseline;
    if (st.opacity <= 0.002) continue;
    ctx.save();
    ctx.globalAlpha *= gAlpha * st.opacity;
    ctx.translate(destX + ax + st.x, destY + ay + st.y);
    if (st.rotation) ctx.rotate(st.rotation * Math.PI / 180);
    if (st.scaleX !== 1 || st.scaleY !== 1) ctx.scale(st.scaleX, st.scaleY);
    ctx.translate(-(destX + ax), -(destY + ay));
    blitTinted(ctx, buf.canvas, u.x0, w, buf.H, destX + u.x0, destY, tint, st.blur, st.hue, st.brightness);
    ctx.restore();
  }
}

export function drawText(ctx, layout, time, opts = {}) {
  if (!layout) return;
  ctx.save();
  if (opts.transform) { const m = opts.transform; ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]); }
  for (const line of layout.lines) drawLine(ctx, layout, line, time, { ...opts, originX: opts.x ?? 0, originY: opts.y ?? 0 });
  ctx.restore();
}

/* ══════════════ inspection (drives the UI panels) ══════════════ */
export function layoutReport(layout) {
  if (!layout) return null;
  return {
    characters: graphemes(layout.text).filter(c => c.trim()).length,
    lines: layout.lines.length,
    units: layout.metrics.units,
    words: layout.metrics.words,
    direction: layout.dir,
    layoutMs: layout.metrics.layoutMs,
    cached: !!layout.cached,
    runs: layout.runs.map(r => ({ script: r.script, family: r.family, dir: r.dir, chars: r.chars.length })),
    warnings: layout.warnings,
    unitsPerLine: layout.lines.map(l => (l.units || []).length),
    wordsPerLine: layout.lines.map(l => l.wordCount || 0),
  };
}

/** Which family actually drew each script — the Font Clearance panel. */
export function routingTable(layout) {
  const seen = new Map();
  for (const r of layout?.runs || []) {
    if (!r.text.trim() || seen.has(r.script)) continue;
    seen.set(r.script, { script: r.script, requested: layout.spec.family, used: r.family, sample: r.text.trim().slice(0, 12), substituted: r.family !== layout.spec.family });
  }
  return [...seen.values()];
}

/** Hit-test: which unit is at buffer-space x? Used by the viewport picker. */
export function unitAt(layout, lineIndex, xBuffer) {
  const line = layout?.lines?.[lineIndex];
  if (!line) return null;
  return (line.units || []).find(u => xBuffer >= u.x0 && xBuffer < u.x1) || null;
}
