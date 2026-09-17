/**
 * document.js — the project model and the per-frame resolver.
 *
 * The Renderer is deliberately dumb: `_layerMatrix` reads `resolved.position`,
 * `resolved.scale` and `resolved.rotation` as plain numbers and never looks at a
 * keyframe track (it imports `propValue` but does not call it). So *something*
 * has to turn an animated document into a flat, resolved scene every frame —
 * and it must not be the renderer, or the renderer stops being reusable and
 * testable. That something is this module.
 *
 * Property values are either static (`12`) or a track (`{keys:[{t,v,ease}]}`).
 * Everything downstream of `resolveScene()` sees only static numbers.
 */
import { propValue, setKey, removeKey, hasKeyAt, nearestKey, evalTrack, isAnimated, staticOf, clamp, uid, round } from './base.js';
import { DEFAULT_SHAPES, DEFAULT_STYLE, SHAPE_TYPES } from '../render/shapes.js';
import { defaultAnimator, ANIMATOR_PROPS } from '../render/typography.js';
import { EFFECTS, defaultParams } from '../effects/registry.js';

export { propValue, setKey, removeKey, hasKeyAt, nearestKey, evalTrack, isAnimated, staticOf };

/* ─────────────────────────── composition ─────────────────────────── */

export const COMP_PRESETS = [
  { id: '1920x1080', w: 1920, h: 1080, label: '1920×1080 · 16:9' },
  { id: '1080x1920', w: 1080, h: 1920, label: '1080×1920 · 9:16' },
  { id: '1080x1080', w: 1080, h: 1080, label: '1080×1080 · 1:1' },
  { id: '3840x2160', w: 3840, h: 2160, label: '3840×2160 · 4K' },
  { id: '1280x720',  w: 1280, h: 720,  label: '1280×720 · 720p' },
];

export function createComp(over = {}) {
  return {
    width: 1920, height: 1080, fps: 30, duration: 4,
    background: '#0d0f14',
    ...over,
  };
}

export function createProject(over = {}) {
  return {
    format: 'framezero/project',
    version: 1,
    name: 'untitled',
    comp: createComp(over.comp),
    layers: [],
    assets: [],
    ...over,
    id: over.id || uid('prj'),
  };
}

/* ───────────────────────────── layers ────────────────────────────── */

/** Text defaults that the typography engine actually reads. */
export const DEFAULT_TEXT = {
  text: 'FrameZero', family: 'Inter', size: 120, weight: 700,
  tracking: 0, leading: 1.2, align: 'left', maxWidth: 0,
  direction: 'auto', color: '#ffffff', axes: {},
  anchor: 'left', vAnchor: 'baseline',
};

/**
 * A layer stores its animatable properties as plain values OR tracks.
 * `transform` holds position/scale/rotation/anchorPoint; each may be a track.
 */
export function createLayer(type, over = {}) {
  const base = {
    id: uid('L'),
    type,                                  // 'text' | 'shape' | 'media'
    name: over.name || defaultName(type),
    visible: true, locked: false, solo: false,
    inPoint: 0, outPoint: null,            // null = until comp end
    opacity: 1,
    blend: 'normal',
    transform: { position: [0, 0], anchorPoint: null, scale: [1, 1], rotation: 0 },
    effects: [],
    animators: [],
    /* Masks live in layer-local pixels, origin at the layer's centre, and are
       combined in order AE-style: add / subtract / intersect, then feather,
       invert and opacity are applied to the combined mask. */
    masks: { enabled: true, items: [] },
    /* Track matte: consume another layer's alpha or luma as this layer's
       window. The source layer is hidden from the comp (matteOnly). */
    matte: null,
  };
  if (type === 'media') {
    // audio mix lives on the layer so it serialises with the project
    base.volume = over.volume ?? 1;
    base.mute = !!over.mute;
    base.mediaOffset = over.mediaOffset ?? 0;   // seconds into the source at layer in-point
  }
  if (type === 'text') {
    base.text = { ...DEFAULT_TEXT, ...(over.text || {}) };
  } else if (type === 'media') {
    base.width = over.width ?? 640;
    base.height = over.height ?? 360;
  } else {
    const shapeType = over.shapeType || (type === 'shape' ? 'rect' : 'solid');
    base.width = over.width ?? 640;
    base.height = over.height ?? 360;
    base.shape = { type: shapeType, ...(DEFAULT_SHAPES[shapeType] || {}), ...(over.shape || {}) };
    base.style = { ...DEFAULT_STYLE, ...(over.style || {}) };
  }
  // shallow-merge the rest so callers can seed anything
  const layer = { ...base, ...stripKeys(over, ['text', 'shape', 'style', 'transform', 'effects', 'animators']) };
  if (over.transform) layer.transform = { ...base.transform, ...over.transform };
  if (over.effects) layer.effects = over.effects.map(e => addEffectSpec(e.id, e.params, e.enabled));
  if (over.animators) layer.animators = over.animators;
  return layer;
}

function stripKeys(o, keys) {
  const out = {};
  for (const k of Object.keys(o || {})) if (!keys.includes(k)) out[k] = o[k];
  return out;
}

let _n = { text: 0, shape: 0, solid: 0, media: 0 };
function defaultName(type) {
  const k = type === 'shape' ? 'shape' : type;
  _n[k] = (_n[k] || 0) + 1;
  return `${k[0].toUpperCase()}${k.slice(1)} ${_n[k]}`;
}
export function resetLayerCounters() { _n = { text: 0, shape: 0, solid: 0, media: 0 }; }

/* ───────────────────────────── effects ───────────────────────────── */

export function addEffectSpec(id, params, enabled = true) {
  const def = EFFECTS[id];
  if (!def) return null;
  return { id, enabled, params: { ...defaultParams(def), ...(params || {}) } };
}

export function addEffect(layer, id, params) {
  const spec = addEffectSpec(id, params);
  if (!spec) return null;
  layer.effects.push(spec);
  return spec;
}

export function removeEffect(layer, index) {
  if (index < 0 || index >= layer.effects.length) return null;
  return layer.effects.splice(index, 1)[0];
}

/* ──────────────────────────── resolver ───────────────────────────── */

/** Resolve one property (static or track) at a time. */
export function resolveProp(prop, time) { return propValue(prop, time); }

function resolveVec(prop, time, fallback) {
  const v = resolveProp(prop, time);
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === 'number') return [v, v];
  return fallback;
}

/** Resolve every animatable field of a mask stack into plain numbers. */
function resolveMasks(m, time) {
  if (!m || !Array.isArray(m.items) || !m.items.length) return null;
  return {
    enabled: m.enabled !== false,
    items: m.items.map(it => ({
      id: it.id || 'mask',
      shape: it.shape === 'rect' ? 'rect' : 'ellipse',
      cx: Number(resolveProp(it.cx, time) ?? 0),
      cy: Number(resolveProp(it.cy, time) ?? 0),
      w: Math.max(0, Number(resolveProp(it.w, time) ?? 100)),
      h: Math.max(0, Number(resolveProp(it.h, time) ?? 100)),
      rot: Number(resolveProp(it.rot, time) ?? 0),
      feather: Math.max(0, Number(resolveProp(it.feather, time) ?? 0)),
      opacity: clamp(Number(resolveProp(it.opacity, time) ?? 1), 0, 1),
      invert: !!it.invert,
      enabled: it.enabled !== false,
      mode: it.mode === 'subtract' || it.mode === 'intersect' ? it.mode : 'add',
    })),
  };
}

/**
 * Flatten one animated layer into the static shape the Renderer consumes.
 *
 * Output contract (verified against compositor.js):
 *   { id, type, visible, opacity, blend, in, out, width, height,
 *     resolved:{ position, scale, rotation, anchorPoint, text|shape|style, animators },
 *     effects:[{id, enabled, params}] }
 */
export function resolveLayer(layer, time, comp) {
  const t = layer.transform || {};
  const out = {
    id: layer.id,
    type: layer.type,
    // name/locked are not needed by the renderer, but a resolved scene that
    // cannot say which layer it came from is useless in a HUD, a crash report
    // or a test failure. Cheap to carry.
    name: layer.name,
    locked: !!layer.locked,
    visible: layer.visible !== false,
    opacity: clamp(Number(resolveProp(layer.opacity, time) ?? 1), 0, 1),
    blend: layer.blend || 'normal',
    resolved: {
      position: resolveVec(t.position, time, [0, 0]),
      scale: resolveVec(t.scale, time, [1, 1]),
      rotation: Number(resolveProp(t.rotation, time) ?? 0),
      anchorPoint: t.anchorPoint ? resolveVec(t.anchorPoint, time, null) : null,
    },
    effects: (layer.effects || []).filter(e => e && EFFECTS[e.id]).map(e => ({
      id: e.id, enabled: e.enabled !== false, params: e.params || {},
    })),
    masks: resolveMasks(layer.masks, time),
  };
  if (layer.matte && layer.matte.source) {
    out.matte = {
      id: layer.matte.source,
      mode: layer.matte.mode === 'luma' ? 'luma' : 'alpha',
      invert: !!layer.matte.invert,
    };
  }
  if (layer.inPoint != null) out.in = layer.inPoint;
  const end = layer.outPoint ?? comp?.duration ?? null;
  if (end != null) out.out = end;

  if (layer.type === 'media') {
    out.resolved.media = {
      kind: layer.mediaKind || 'image',
      assetId: layer.assetId || null,
      // the app stamps the decoded frame time here each tick; it is part of the
      // raster identity so a playing video never serves a stale frame
      frame: Math.round(Number(layer.mediaFrame ?? 0)),
    };
  }
  if (layer.type === 'text') {
    const tx = layer.text || DEFAULT_TEXT;
    out.resolved.text = {
      text: String(resolveProp(tx.text, time) ?? ''),
      family: tx.family || DEFAULT_TEXT.family,
      size: Math.max(1, Number(resolveProp(tx.size, time) ?? DEFAULT_TEXT.size)),
      weight: Number(resolveProp(tx.weight, time) ?? 400),
      tracking: Number(resolveProp(tx.tracking, time) ?? 0),
      leading: Number(resolveProp(tx.leading, time) ?? 1.2),
      align: tx.align || 'left',
      maxWidth: Number(tx.maxWidth || 0),
      direction: tx.direction || 'auto',
      case: tx.case,
      color: tx.color || '#ffffff',
      axes: tx.axes || {},
      anchor: tx.anchor || 'left',
      vAnchor: tx.vAnchor || 'baseline',
    };
    out.resolved.animators = layer.animators || [];
  } else {
    out.width = Math.max(1, Math.round(resolveProp(layer.width, time) ?? 640));
    out.height = Math.max(1, Math.round(resolveProp(layer.height, time) ?? 360));
    out.resolved.width = out.width;
    out.resolved.height = out.height;
    // shape params may themselves be animated (e.g. noise speed, grid phase)
    const sh = {};
    for (const [k, v] of Object.entries(layer.shape || {})) sh[k] = resolveProp(v, time);
    out.resolved.shape = sh;
    const st = {};
    for (const [k, v] of Object.entries(layer.style || {})) st[k] = resolveProp(v, time);
    out.resolved.style = st;
  }
  return out;
}

/** Flatten the whole project into a renderable scene at `time`. */
export function resolveScene(project, time) {
  const comp = project.comp;
  const layers = [];
  const solo = project.layers.some(l => l.solo);
  // A layer consumed as a track matte feeds the layer above it instead of the
  // comp — AE hides it for the same reason. It still has to reach the renderer
  // (matteOnly) so the consumer can rasterise it.
  const matteIds = new Set(project.layers.map(l => l.matte?.source).filter(Boolean));
  for (const layer of project.layers) {
    if (layer.visible === false) continue;
    if (solo && !layer.solo) continue;
    if (layer.inPoint != null && time < layer.inPoint) continue;
    const end = layer.outPoint ?? comp.duration;
    if (end != null && time >= end) continue;
    const r = resolveLayer(layer, time, comp);
    if (matteIds.has(layer.id)) r.matteOnly = true;
    layers.push(r);
  }
  return {
    width: comp.width, height: comp.height,
    background: comp.background,
    layers,
  };
}

/* ────────────────────────── serialisation ────────────────────────── */

export function serialize(project) {
  return JSON.stringify({
    format: project.format, version: project.version, name: project.name,
    comp: project.comp, layers: project.layers, assets: project.assets || [],
    savedAt: new Date().toISOString(),
  }, null, 2);
}

/**
 * Parse and validate a project file. Returns {project} or {error} — never
 * throws, because opening a corrupt file must not take the editor down.
 */
export function deserialize(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return { error: `not valid JSON: ${e.message}` }; }
  if (!raw || typeof raw !== 'object') return { error: 'not a project object' };
  if (!Array.isArray(raw.layers)) return { error: 'project has no layers array' };
  const comp = createComp(raw.comp || {});
  // Repair rather than reject: a hand-edited or truncated file with an absurd
  // comp size should still open. Failing to open loses the user's work, which
  // is strictly worse than opening at a corrected size.
  comp.width = clamp(Math.round(Number(comp.width) || 1920), 16, 16384);
  comp.height = clamp(Math.round(Number(comp.height) || 1080), 16, 16384);
  comp.fps = clamp(Number(comp.fps) || 30, 1, 240);
  comp.duration = clamp(Number(comp.duration) || 4, 0.1, 3600);
  const layers = [];
  for (const l of raw.layers) {
    if (!l || typeof l !== 'object') continue;
    const type = l.type === 'text' ? 'text' : l.type === 'media' ? 'media' : 'shape';
    const built = createLayer(type, {
      ...l,
      text: l.text ? { ...DEFAULT_TEXT, ...l.text } : undefined,
      shape: l.shape || undefined,
      style: l.style ? { ...DEFAULT_STYLE, ...l.style } : undefined,
      transform: l.transform || undefined,
      effects: Array.isArray(l.effects) ? l.effects.filter(e => e && EFFECTS[e.id]) : [],
      animators: Array.isArray(l.animators) ? l.animators : [],
    });
    built.id = l.id || built.id;
    built.masks = normaliseMasks(l.masks);
    built.matte = normaliseMatte(l.matte, raw.layers);
    layers.push(built);
  }
  return { project: { ...createProject(), ...raw, comp, layers, assets: raw.assets || [] } };
}

/**
 * Repair, never reject: a hand-edited file may carry `masks: "nope"` or a mask
 * item whose width is a string. The renderer would throw on those frames, and
 * losing a project to a typo is worse than opening it with the bad field
 * corrected.
 */
function normaliseMasks(m) {
  const out = { enabled: true, items: [] };
  if (!m || typeof m !== 'object') return out;
  out.enabled = m.enabled !== false;
  if (!Array.isArray(m.items)) return out;
  out.items = m.items.filter(it => it && typeof it === 'object').map(it => ({
    id: String(it.id || 'mask'),
    shape: it.shape === 'rect' ? 'rect' : 'ellipse',
    cx: isTrack(it.cx) ? it.cx : Number(it.cx) || 0,
    cy: isTrack(it.cy) ? it.cy : Number(it.cy) || 0,
    w: isTrack(it.w) ? it.w : Math.max(0, Number(it.w) || 0),
    h: isTrack(it.h) ? it.h : Math.max(0, Number(it.h) || 0),
    rot: isTrack(it.rot) ? it.rot : Number(it.rot) || 0,
    feather: isTrack(it.feather) ? it.feather : Math.max(0, Number(it.feather) || 0),
    opacity: isTrack(it.opacity) ? it.opacity : clamp(Number(it.opacity ?? 1) || 0, 0, 1),
    invert: !!it.invert,
    enabled: it.enabled !== false,
    mode: it.mode === 'subtract' || it.mode === 'intersect' ? it.mode : 'add',
  }));
  return out;
}
const isTrack = v => !!v && typeof v === 'object' && Array.isArray(v.keys);

function normaliseMatte(mt, layers) {
  if (!mt || typeof mt !== 'object' || !mt.source) return null;
  const ids = new Set((layers || []).filter(l => l && typeof l === 'object').map(l => l.id));
  if (!ids.has(mt.source)) return null;      // dangling reference → no matte
  return { source: mt.source, mode: mt.mode === 'luma' ? 'luma' : 'alpha', invert: !!mt.invert };
}

/* ────────────────────────────── undo ─────────────────────────────── */

/**
 * Snapshot undo. The document is small and JSON-able, so a deep copy per edit
 * is far cheaper than the bugs an incremental/patch model would introduce.
 */
export class UndoStack {
  constructor(limit = 80) { this.limit = limit; this.past = []; this.future = []; }
  push(snapshot) {
    this.past.push(snapshot);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }
  undo(current) {
    if (!this.past.length) return null;
    this.future.push(current);
    return this.past.pop();
  }
  redo(current) {
    if (!this.future.length) return null;
    this.past.push(current);
    return this.future.pop();
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  clear() { this.past.length = 0; this.future.length = 0; }
}

export const snapshot = (project) => JSON.stringify({ comp: project.comp, layers: project.layers });
export function restore(project, snap) {
  const o = JSON.parse(snap);
  project.comp = o.comp;
  project.layers = o.layers;
  return project;
}

/* ───────────────────────────── helpers ───────────────────────────── */

export function projectDuration(project) {
  const compEnd = project.comp.duration;
  let end = compEnd;
  for (const l of project.layers) if (l.outPoint != null) end = Math.max(end, l.outPoint);
  return round(Math.max(0.1, end), 3);
}

export function layerBounds(layer) {
  return { in: layer.inPoint ?? 0, out: layer.outPoint ?? Infinity };
}

/** Every keyframe time across a layer, for the timeline + prev/nextkey. */
export function layerKeyTimes(layer) {
  const times = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v.keys)) for (const k of v.keys) times.add(round(k.t, 6));
    else for (const x of Object.values(v)) walk(x);
  };
  walk(layer.transform); walk(layer.text); walk(layer.shape); walk(layer.style);
  walk(layer.opacity);
  for (const an of layer.animators || []) times.add(round(an.delay ?? 0, 6));
  return [...times].sort((a, b) => a - b);
}

export { SHAPE_TYPES, ANIMATOR_PROPS, defaultAnimator, EFFECTS };
