/**
 * panels.js — every docked panel in the shell.
 *
 * Pure view layer: each function reads `state` and writes DOM, and calls back
 * through `api` for every mutation. Nothing here owns state or talks to the
 * renderer, which keeps the panels testable and means there is exactly one
 * place where the document can change.
 */
import { iconEl, iconSVG } from './icons.js';
import { $, $$, el, clamp, round } from '../core/base.js';
import { EFFECT_LIST, CATEGORIES, defaultParams } from '../effects/registry.js';
import { SHAPE_TYPES } from '../render/shapes.js';
import { BLEND_MODES } from '../render/backend.js';
import { ANIMATOR_PROPS, defaultAnimator } from '../render/typography.js';
import { EASING_NAMES, isAnimated, staticOf } from '../core/base.js';

/* ══════════════════════════ small widgets ══════════════════════════ */

/**
 * A numeric row with an optional keyframe diamond.
 * `path` is a dot path into the selected layer ('transform.position.0').
 */
function numField(label, value, api, opts = {}) {
  const { path, min = -1e6, max = 1e6, step = 1, keyed = false, onInput } = opts;
  const row = el('div', { class: 'f-row' });
  row.append(el('label', { class: 'f-lbl' }, label));

  if (path && api) {
    const diamond = el('button', {
      class: 'kf' + (keyed ? ' on' : ''),
      title: keyed ? 'Remove keyframe at playhead' : 'Add keyframe at playhead',
    });
    diamond.innerHTML = iconSVG('key', 10);
    diamond.addEventListener('click', () => api.toggleKey(path));
    row.append(diamond);
  }

  const input = el('input', {
    type: 'number', class: 'f-num', value: String(round(Number(value) || 0, 3)),
    min: String(min), max: String(max), step: String(step),
  });
  input.addEventListener('change', () => {
    const v = clamp(parseFloat(input.value) || 0, min, max);
    input.value = String(round(v, 3));
    if (onInput) onInput(v);
    else if (path && api) api.setProp(path, v);
  });
  row.append(input);
  return row;
}

function vec2Field(label, vec, api, basePath, keyed = [false, false]) {
  const row = el('div', { class: 'f-row' });
  row.append(el('label', { class: 'f-lbl' }, label));
  ['X', 'Y'].forEach((axis, i) => {
    const p = `${basePath}.${i}`;
    const d = el('button', { class: 'kf' + (keyed[i] ? ' on' : ''), title: `${axis} keyframe` }, '◆');
    d.addEventListener('click', () => api.toggleKey(p));
    const input = el('input', { type: 'number', class: 'f-num', value: String(round(Number(vec?.[i]) || 0, 2)), step: '1' });
    input.addEventListener('change', () => api.setProp(p, parseFloat(input.value) || 0));
    row.append(d, input);
  });
  return row;
}

function selectField(label, value, options, onChange) {
  const row = el('div', { class: 'f-row' });
  row.append(el('label', { class: 'f-lbl' }, label));
  const sel = el('select', { class: 'f-sel' });
  for (const o of options) {
    const opt = el('option', { value: o.value }, o.label);
    if (String(o.value) === String(value)) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  row.append(sel);
  return row;
}

function textField(label, value, onChange, opts = {}) {
  const row = el('div', { class: 'f-row' + (opts.tall ? ' tall' : '') });
  row.append(el('label', { class: 'f-lbl' }, label));
  const input = opts.tall
    ? el('textarea', { class: 'f-txt', rows: '3' })
    : el('input', { type: 'text', class: 'f-txt', spellcheck: 'false' });
  input.value = value ?? '';
  input.addEventListener('change', () => onChange(input.value));
  row.append(input);
  return row;
}

function colorField(label, value, onChange) {
  const row = el('div', { class: 'f-row' });
  row.append(el('label', { class: 'f-lbl' }, label));
  const c = el('input', { type: 'color', class: 'f-col', value: toHex(value) });
  const t = el('input', { type: 'text', class: 'f-num wide', value: value || '', spellcheck: 'false' });
  c.addEventListener('input', () => { t.value = c.value; onChange(c.value); });
  t.addEventListener('change', () => { onChange(t.value); c.value = toHex(t.value); });
  row.append(c, t);
  return row;
}
function toHex(v) {
  if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) return v;
  if (typeof v === 'string' && /^#[0-9a-f]{3}$/i.test(v)) return '#' + v.slice(1).split('').map(c => c + c).join('');
  return '#ffffff';
}

function sliderField(label, value, api, path, min, max, step) {
  const row = el('div', { class: 'f-row' });
  row.append(el('label', { class: 'f-lbl' }, label));
  const d = el('button', { class: 'kf' + (api.isKeyed(path) ? ' on' : ''), title: 'Keyframe' }, '◆');
  d.addEventListener('click', () => api.toggleKey(path));
  const range = el('input', { type: 'range', class: 'f-range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = el('span', { class: 'f-val' }, String(round(value, 2)));
  range.addEventListener('input', () => {
    const v = parseFloat(range.value);
    out.textContent = String(round(v, 2));
    api.setProp(path, v);
  });
  row.append(d, range, out);
  return row;
}

const TRANS_TYPES = [
  { value: '', label: 'none' }, { value: 'cross', label: 'cross dissolve' },
  { value: 'wipeL', label: 'wipe left-to-right' }, { value: 'wipeR', label: 'wipe right-to-left' },
  { value: 'slideL', label: 'slide from left' }, { value: 'slideR', label: 'slide from right' },
];

/** Icon-grid picker for the shape kind — every cell is one SVG from icons.js. */
function shapeGrid(L, api) {
  const cur = L.shape?.type || 'rect';
  const grid = el('div', { class: 'shape-grid' });
  for (const t of SHAPE_TYPES) {
    const b = el('button', { class: 'sg-cell' + (t.id === cur ? ' on' : ''), title: t.name });
    b.innerHTML = iconSVG(t.icon, 17);
    b.addEventListener('click', () => api.setShapeType(t.id));
    grid.append(b);
  }
  return grid;
}

function section(title, ...kids) {
  return el('div', { class: 'f-sec' }, el('div', { class: 'f-sec-h' }, title), ...kids);
}

/* ══════════════════════════ LEFT: layer list ══════════════════════════ */

export function renderLayerList(state, api) {
  const host = $('#layer-list');
  host.textContent = '';
  if (!state.project.layers.length) {
    host.append(el('div', { class: 'empty' }, 'No layers yet.', el('br'), 'Press T for text, S for shape.'));
  }
  // top of the list = top of the stack, like every compositor
  for (const layer of [...state.project.layers].reverse()) {
    const row = el('div', { class: 'l-row' + (state.selected === layer.id ? ' sel' : '') });
    row.dataset.id = layer.id;

    const vis = el('button', { class: 'l-ic' + (layer.visible ? ' on' : ''), title: 'Visibility' }, iconEl(layer.visible ? 'eye' : 'eyeOff', '', 13));
    vis.addEventListener('click', e => { e.stopPropagation(); api.toggleVisible(layer.id); });

    const solo = el('button', { class: 'l-ic solo' + (layer.solo ? ' on' : ''), title: 'Solo' }, iconEl('solo', '', 13));
    solo.addEventListener('click', e => { e.stopPropagation(); api.toggleSolo(layer.id); });

    const lock = el('button', { class: 'l-ic' + (layer.locked ? ' on' : ''), title: 'Lock' }, iconEl(layer.locked ? 'lock' : 'unlock', '', 13));
    lock.addEventListener('click', e => { e.stopPropagation(); api.toggleLock(layer.id); });

    const kindIcon = layer.type === 'text' ? 'text'
      : layer.type === 'media' ? ({ video: 'video', audio: 'audio', image: 'image' }[(state.project.assets || []).find(x => x.id === layer.assetId)?.kind] || 'file')
      : layer.shape?.type === 'solid' ? 'solid' : 'shape';
    const icon = iconEl(kindIcon, '', 13);
    const name = el('span', { class: 'l-name', title: layer.name }, layer.name);
    name.addEventListener('dblclick', e => {
      e.stopPropagation();
      const input = el('input', { class: 'l-rename', value: layer.name });
      name.replaceWith(input); input.focus(); input.select();
      const commit = () => { api.rename(layer.id, input.value || layer.name); };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', ev => { if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = layer.name; input.blur(); } });
    });

    const badges = el('span', { class: 'l-badges' });
    if (layer.effects?.length) badges.append(el('span', { class: 'b', title: `${layer.effects.length} effect(s)` }, `fx${layer.effects.length}`));
    if (layer.animators?.length) badges.append(el('span', { class: 'b', title: 'Has text animators' }, 'anim'));
    if (layer.type === 'media') {
      const a = (state.project.assets || []).find(x => x.id === layer.assetId);
      badges.append(el('span', { class: 'b', title: a?.meta || 'media' }, a?.kind === 'audio' ? 'aud' : a?.kind === 'video' ? 'vid' : 'img'));
    }
    if (layer.masks?.items?.length) badges.append(el('span', { class: 'b', title: `${layer.masks.items.length} mask(s)` }, `mk${layer.masks.items.length}`));
    if (layer.matte?.source) badges.append(el('span', { class: 'b', title: 'Track matte' }, 'matte'));
    if (hasAnyKey(layer)) badges.append(el('span', { class: 'b kf', title: 'Has keyframes' }, '◆'));
    if (layer.blend && layer.blend !== 'normal') badges.append(el('span', { class: 'b', title: 'Blend mode' }, layer.blend));

    row.append(vis, solo, lock, el('span', { class: 'l-type' }, icon), name, badges);
    row.addEventListener('click', () => api.select(layer.id));
    host.append(row);
  }
  const st = $('#scene-stats');
  if (st) {
    const c = state.project.comp;
    st.textContent = `${state.project.layers.length} layers · ${c.width}×${c.height} · ${c.fps}fps · ${round(state.duration, 2)}s`;
  }
}
function hasAnyKey(layer) {
  const walk = v => {
    if (!v || typeof v !== 'object') return false;
    if (Array.isArray(v.keys)) return v.keys.length > 0;
    return Object.values(v).some(walk);
  };
  return walk(layer.transform) || walk(layer.opacity) || walk(layer.text) || walk(layer.shape) || walk(layer.style);
}

/* ══════════════════════════ LEFT: assets ══════════════════════════ */

export function renderAssets(state, api) {
  const host = $('#asset-list');
  host.textContent = '';
  const assets = state.project.assets || [];
  if (!assets.length) {
    host.append(el('div', { class: 'empty' }, 'No assets.', el('br'), 'Drop an image, video or audio file anywhere.'));
    return;
  }
  for (const a of assets) {
    const row = el('div', { class: 'a-row' });
    row.append(el('span', { class: 'a-ic' }, iconEl(a.kind === 'image' ? 'image' : a.kind === 'video' ? 'video' : a.kind === 'audio' ? 'audio' : 'file', '', 15)));
    row.append(el('span', { class: 'a-name', title: a.name }, a.name));
    row.append(el('span', { class: 'a-meta' }, a.meta || ''));
    const use = el('button', { class: 'l-ic', title: 'Add to comp' }, iconEl('plus', '', 13));
    use.addEventListener('click', () => api.addAssetToComp(a));
    const del = el('button', { class: 'l-ic', title: 'Remove' }, iconEl('x', '', 13));
    del.addEventListener('click', () => api.removeAsset(a.id));
    row.append(use, del);
    host.append(row);
  }
}

/* ══════════════════════════ LEFT: effects browser ══════════════════════════ */

export function renderEffectsList(state, api) {
  const host = $('#fx-list');
  host.textContent = '';
  const q = (state.fxQuery || '').trim().toLowerCase();
  const byCat = new Map();
  for (const fx of EFFECT_LIST) {
    if (q && !(fx.name.toLowerCase().includes(q) || fx.id.toLowerCase().includes(q) || (fx.category || '').includes(q))) continue;
    if (!byCat.has(fx.category)) byCat.set(fx.category, []);
    byCat.get(fx.category).push(fx);
  }
  if (!byCat.size) { host.append(el('div', { class: 'empty' }, `No effect matches “${state.fxQuery}”.`)); return; }
  for (const [catId, list] of byCat) {
    const cat = CATEGORIES[catId] || { name: catId, icon: 'catStylize' };
    const head = el('div', { class: 'fx-cat' }, iconEl(cat.icon, '', 12), el('span', {}, cat.name), el('span', { class: 'fx-count' }, String(list.length)));
    host.append(head);
    for (const fx of list) {
      const row = el('div', { class: 'fx-row', title: `${fx.id} · cost ${fx.cost || 'low'}${fx.glsl ? '' : ' · CPU path'}` });
      row.append(el('span', { class: 'fx-name' }, fx.name));
      row.append(el('span', { class: 'fx-cost' + (fx.cost === 'high' ? ' hi' : '') }, fx.cost || 'low'));
      const add = el('button', { class: 'l-ic', title: state.selected ? `Add to ${selectedName(state)}` : 'Select a layer first' }, iconEl('plus', '', 13));
      add.disabled = !state.selected;
      add.addEventListener('click', e => { e.stopPropagation(); api.addEffect(fx.id); });
      row.append(add);
      row.addEventListener('dblclick', () => api.addEffect(fx.id));
      host.append(row);
    }
  }
}
const selectedName = (state) => state.project.layers.find(l => l.id === state.selected)?.name || 'layer';

/* ══════════════════════════ LEFT: fonts ══════════════════════════ */

export function renderFonts(state, api) {
  const host = $('#font-list');
  host.textContent = '';
  const reg = state.registry;
  if (!reg) { host.append(el('div', { class: 'empty' }, 'Font registry not ready.')); return; }
  for (const family of reg.families()) {
    const spec = reg.spec(family) || {};
    const row = el('div', { class: 'fo-row' });
    const sample = el('div', { class: 'fo-sample' }, spec.sample || 'Handgloves 123');
    sample.style.fontFamily = `"${family}", sans-serif`;
    if (spec.defaultAxes) sample.style.fontVariationSettings = Object.entries(spec.defaultAxes).map(([k, v]) => `'${k}' ${v}`).join(', ');
    const meta = el('div', { class: 'fo-meta' });
    meta.append(el('span', { class: 'fo-name' }, family));
    const axes = spec.axes || [];
    meta.append(el('span', { class: 'fo-axes' }, axes.length ? `${axes.length} axes` : 'static'));
    if (spec.scripts?.length) meta.append(el('span', { class: 'fo-scr' }, spec.scripts.join(' · ')));
    const use = el('button', { class: 'l-ic', title: 'Use on the selected text layer' }, '✓');
    use.disabled = !(state.selected && selectedLayer(state)?.type === 'text');
    use.addEventListener('click', () => api.setFont(family));
    row.append(sample, meta, use);
    host.append(row);
  }
  const foot = $('#font-foot');
  if (foot) {
    const s = reg.stats?.() || {};
    foot.textContent = `${reg.families().length} families loaded · ${s.instances ?? 0} cached instances · all SIL OFL 1.1`;
  }
}
const selectedLayer = (state) => state.project.layers.find(l => l.id === state.selected) || null;

/* ══════════════════════════ RIGHT: inspector ══════════════════════════ */

export function renderInspector(state, api) {
  const host = $('#inspector');
  host.textContent = '';
  const L = selectedLayer(state);
  const mk = (state.project.markers || []).find(m => m.id === state.markerSel);
  if (mk) {
    host.append(section('Marker',
      row2(
        el('input', { class: 'f-txt', value: mk.label || '', placeholder: 'label', oninput: e => api.setMarker(mk.id, { label: e.target.value }) }),
        el('input', { type: 'color', class: 'f-col', value: mk.color || '#00e5a0', oninput: e => api.setMarker(mk.id, { color: e.target.value }) }),
      ),
      numField('Time (s)', mk.t, null, { step: 0.1, min: 0, onInput: v => api.setMarker(mk.id, { t: v }) }),
      row2(
        el('button', { class: 'btn-sm', onclick: () => api.seek(mk.t) }, iconEl('markerNext', '', 12), ' Go'),
        el('button', { class: 'btn-sm danger', onclick: () => api.deleteMarker(mk.id) }, iconEl('markerDel', '', 12), ' Delete'),
      ),
    ));
  }
  if (!L) { host.append(el('div', { class: 'empty' }, 'Select a layer to inspect it.')); return; }

  host.append(el('div', { class: 'ins-head' },
    el('span', { class: 'ins-type' }, L.type),
    el('span', { class: 'ins-name' }, L.name)));

  const t = L.transform || {};
  const pos = api.getProp('transform.position') || [0, 0];
  const scl = api.getProp('transform.scale') || [1, 1];
  const rot = api.getProp('transform.rotation') ?? 0;
  const op = api.getProp('opacity') ?? 1;

  host.append(section('Transform',
    vec2Field('Position', pos, api, 'transform.position', [api.isKeyed('transform.position.0'), api.isKeyed('transform.position.1')]),
    vec2Field('Scale', scl, api, 'transform.scale', [api.isKeyed('transform.scale.0'), api.isKeyed('transform.scale.1')]),
    numField('Rotation °', rot, api, { path: 'transform.rotation', step: 1, keyed: api.isKeyed('transform.rotation') }),
    sliderField('Opacity', op, api, 'opacity', 0, 1, 0.01),
    selectField('Blend', L.blend || 'normal', BLEND_MODES.map(m => ({ value: m, label: m })), v => api.setLayer('blend', v)),
  ));

  host.append(section('Timing',
    numField('In point (s)', L.inPoint ?? 0, null, { step: 0.1, min: 0, onInput: v => api.setLayer('inPoint', v) }),
    numField('Out point (s)', L.outPoint ?? state.duration, null, { step: 0.1, min: 0, onInput: v => api.setLayer('outPoint', v === 0 ? null : v) }),
    row2(
      el('button', { class: 'btn-sm', onclick: () => api.setLayer('inPoint', state.time) }, iconEl('key', '', 11), ' In at playhead'),
      el('button', { class: 'btn-sm', onclick: () => api.setLayer('outPoint', state.time) }, iconEl('key', '', 11), ' Out at playhead'),
    ),
  ));

  host.append(section('Time & Compositing',
    row2(
      el('button', { class: 'btn-sm' + (L.adjustment ? ' on' : ''), onclick: () => api.toggleAdjustment() }, iconEl('adjustment', '', 12), ' Adjustment'),
      el('button', { class: 'btn-sm', onclick: () => api.setSpeed(-(L.speed ?? 1)) }, iconEl('reverse', '', 12), ' Reverse'),
    ),
    numField('Speed ×', L.speed ?? 1, null, { step: 0.05, min: -8, max: 8, onInput: v => api.setSpeed(v) }),
    el('div', { class: 'note dim' }, 'Content clock: media frames, noise fields and text animators. Keys stay on comp time.'),
    selectField('In transition', L.transition?.in?.type || '', TRANS_TYPES, v => api.setTransition('in', v, L.transition?.in?.duration ?? 0.5)),
    numField('In duration (s)', L.transition?.in?.duration ?? 0.5, null, { step: 0.05, min: 0.04, max: 5, onInput: v => L.transition?.in && api.setTransition('in', L.transition.in.type, v) }),
    selectField('Out transition', L.transition?.out?.type || '', TRANS_TYPES, v => api.setTransition('out', v, L.transition?.out?.duration ?? 0.5)),
    numField('Out duration (s)', L.transition?.out?.duration ?? 0.5, null, { step: 0.05, min: 0.04, max: 5, onInput: v => L.transition?.out && api.setTransition('out', L.transition.out.type, v) }),
  ));

  if (L.type === 'shape') {
    host.append(section('Shape',
      shapeGrid(L, api),
      numField('Width', L.width, null, { step: 1, min: 1, onInput: v => api.setLayer('width', Math.round(v)) }),
      numField('Height', L.height, null, { step: 1, min: 1, onInput: v => api.setLayer('height', Math.round(v)) }),
      colorField('Fill', L.style?.fill, v => api.setStyle('fill', v)),
      sliderField('Fill opacity', L.style?.fillOpacity ?? 1, { ...api, setProp: (p, v) => api.setStyle(p.split('.').pop(), v), isKeyed: () => false }, 'style.fillOpacity', 0, 1, 0.01),
      colorField('Stroke', L.style?.stroke, v => api.setStyle('stroke', v)),
      numField('Stroke width', L.style?.strokeWidth ?? 0, null, { step: 1, min: 0, onInput: v => api.setStyle('strokeWidth', v) }),
      ...shapeParams(L, api),
    ));
  }

  if (L.type === 'text') {
    host.append(section('Text',
      textField('Content', L.text?.text || '', v => api.setText('text', v), { tall: true }),
      selectField('Family', L.text?.family, state.registry?.families().map(f => ({ value: f, label: f })) || [], v => api.setFont(v)),
      numField('Size', L.text?.size ?? 64, null, { step: 1, min: 1, onInput: v => api.setText('size', v) }),
      numField('Weight', L.text?.weight ?? 400, null, { step: 1, min: 1, max: 1000, onInput: v => api.setText('weight', v) }),
      numField('Tracking', L.text?.tracking ?? 0, null, { step: 0.1, onInput: v => api.setText('tracking', v) }),
      numField('Leading', L.text?.leading ?? 1.2, null, { step: 0.05, min: 0.5, onInput: v => api.setText('leading', v) }),
      colorField('Colour', L.text?.color, v => api.setText('color', v)),
      selectField('Align', L.text?.align || 'left', ['left', 'center', 'right'].map(v => ({ value: v, label: v })), v => api.setText('align', v)),
      selectField('Direction', L.text?.direction || 'auto', ['auto', 'ltr', 'rtl'].map(v => ({ value: v, label: v })), v => api.setText('direction', v)),
      selectField('Case', L.text?.case || 'none', ['none', 'upper', 'lower', 'small'].map(v => ({ value: v, label: v })), v => api.setText('case', v === 'none' ? undefined : v)),
      numField('Max width (0 = off)', L.text?.maxWidth ?? 0, null, { step: 10, min: 0, onInput: v => api.setText('maxWidth', v) }),
    ));
    const cov = coverageNote(state, L);
    if (cov) host.append(el('div', { class: 'note' + (cov.bad ? ' warn' : '') }, cov.text));
    host.append(section('Animators', ...animatorUI(state, api, L)));
  }

  if (L.type === 'media') {
    const a = (state.project.assets || []).find(x => x.id === L.assetId);
    host.append(section('Media',
      el('div', { class: 'note' }, `${a ? `${a.kind} · ${a.name} · ${a.meta || ''}` : 'missing asset'}`),
      numField('Source offset (s)', L.mediaOffset ?? 0, null, { step: 0.05, onInput: v => api.setMedia('mediaOffset', v) }),
      numField('Volume', L.volume ?? 1, null, { step: 0.05, min: 0, max: 4, onInput: v => api.setMedia('volume', v) }),
      boolField('Mute', !!L.mute, v => api.setMedia('mute', v)),
      el('div', { class: 'note' }, a?.kind === 'audio' ? 'Audio renders no pixels; it plays against the transport and shows its waveform in the timeline.' : ''),
    ));
  }
  host.append(section('Masks', ...masksUI(state, api, L)));
  host.append(section('Track matte', ...matteUI(state, api, L)));
  host.append(section('Effects', ...fxSummary(state, api, L)));
}

function boolField(label, value, onChange) {
  const row = el('div', { class: 'f-row' });
  row.append(el('label', { class: 'f-lbl' }, label));
  const b = el('button', { class: 'btn-sm tog' + (value ? ' on' : ''), onclick: () => onChange(!value) }, value ? 'on' : 'off');
  row.append(b);
  return row;
}

function row2(a, b) { const r = el('div', { class: 'f-row' }); r.append(a, b); return r; }

function shapeParams(L, api) {
  const s = L.shape || {};
  const out = [];
  const num = (k, label, step = 1, min = -1e6) => {
    if (s[k] === undefined) return;
    out.push(numField(label, s[k], null, { step, min, onInput: v => api.setShape(k, v) }));
  };
  num('rx', 'Corner X'); num('ry', 'Corner Y'); num('inset', 'Inset');
  num('sides', 'Sides', 1, 3); num('points', 'Points', 1, 3);
  if (s.innerRatio !== undefined) out.push(sliderField('Inner ratio', s.innerRatio, { ...api, setProp: (p, v) => api.setShape('innerRatio', v), isKeyed: () => false }, 'shape.innerRatio', 0.05, 0.95, 0.01));
  num('thickness', 'Thickness'); num('angle', 'Angle');
  num('cell', 'Cell'); num('phase', 'Phase', 0.1);
  num('scale', 'Scale', 1, 1); num('octaves', 'Octaves', 1, 1); num('seed', 'Seed', 1);
  if (s.speed !== undefined) out.push(sliderField('Speed', s.speed, { ...api, setProp: (p, v) => api.setShape('speed', v), isKeyed: () => false }, 'shape.speed', 0, 4, 0.05));
  num('contrast', 'Contrast', 0.05, 0);
  if (s.from !== undefined) out.push(colorField('From', s.from, v => api.setShape('from', v)));
  if (s.to !== undefined) out.push(colorField('To', s.to, v => api.setShape('to', v)));
  if (s.color !== undefined) out.push(colorField('Colour', s.color, v => api.setShape('color', v)));
  if (s.colorA !== undefined) out.push(colorField('Colour A', s.colorA, v => api.setShape('colorA', v)));
  if (s.colorB !== undefined) out.push(colorField('Colour B', s.colorB, v => api.setShape('colorB', v)));
  return out;
}

function coverageNote(state, L) {
  const reg = state.registry;
  if (!reg?.detectSilentFallback) return null;
  const text = String(L.text?.text || '');
  if (!text) return null;
  const hit = reg.detectSilentFallback(L.text?.family || 'Inter', text);
  if (!hit) return { bad: false, text: `“${L.text.family}” covers every glyph in this string.` };
  return { bad: true, text: `Silent fallback: “${hit.family}” has no glyph for ${hit.sample || 'some characters'} → routed to ${hit.route || 'a fallback'}. After Effects would do this silently; FrameZero tells you.` };
}

function animatorUI(state, api, L) {
  const out = [];
  if (!L.animators?.length) {
    out.push(el('div', { class: 'empty sm' }, 'No animators.'));
  }
  (L.animators || []).forEach((an, i) => {
    const box = el('div', { class: 'an-box' });
    box.append(el('div', { class: 'an-head' },
      el('span', {}, `Animator ${i + 1}`),
      el('button', { class: 'l-ic', title: 'Remove', onclick: () => api.removeAnimator(i) }, iconEl('x', '', 12))));
    box.append(selectField('Unit', an.unit || 'glyph', Object.keys(ANIMATOR_PROPS || { glyph: 1, word: 1, line: 1, char: 1 }).map(v => ({ value: v, label: v })), v => api.updateAnimator(i, { unit: v })));
    box.append(selectField('Order', an.order || 'auto', ['auto', 'reverse', 'random'].map(v => ({ value: v, label: v })), v => api.updateAnimator(i, { order: v })));
    box.append(numField('Delay (s/unit)', an.delay ?? 0, null, { step: 0.01, onInput: v => api.updateAnimator(i, { delay: v }) }));
    box.append(numField('Duration (s)', an.duration ?? 0.6, null, { step: 0.05, min: 0.01, onInput: v => api.updateAnimator(i, { duration: v }) }));
    box.append(selectField('Easing', an.ease || 'ease-out-cubic', EASING_NAMES.map(v => ({ value: v, label: v })), v => api.updateAnimator(i, { ease: v })));
    box.append(selectField('Direction', an.mode || 'from', [
      { value: 'from', label: 'from — settle in (reveal)' },
      { value: 'to', label: 'to — travel to props' },
    ], v => api.updateAnimator(i, { mode: v })));
    box.append(sliderField('Range start %', an.range?.start ?? 0, { setProp: (p, v) => api.updateAnimator(i, { range: { ...(an.range || {}), start: v } }), isKeyed: () => false }, 'r0', 0, 100, 1));
    box.append(sliderField('Range end %', an.range?.end ?? 100, { setProp: (p, v) => api.updateAnimator(i, { range: { ...(an.range || {}), end: v } }), isKeyed: () => false }, 'r1', 0, 100, 1));
    for (const prop of ['y', 'x', 'opacity', 'scale', 'rotation']) {
      const v = an.props?.[prop];
      box.append(numField(`Δ ${prop}`, v ?? 0, null, { step: prop === 'opacity' || prop === 'scale' ? 0.05 : 1, onInput: nv => api.updateAnimator(i, { props: { ...(an.props || {}), [prop]: nv } }) }));
    }
    out.push(box);
  });
  out.push(el('button', { class: 'btn-sm wide', onclick: () => api.addAnimator() }, iconEl('plus', '', 11), ' Add animator'));
  return out;
}

/* ── masks & track mattes ── */
function masksUI(state, api, L) {
  const out = [];
  const m = L.masks || { enabled: true, items: [] };
  out.push(row2(
    boolField('Enabled', m.enabled !== false, v => api.setMasksEnabled(v)),
    el('div', { class: 'f-row' },
      el('button', { class: 'btn-sm', onclick: () => api.addMask('ellipse') }, iconEl('plus', '', 11), ' ellipse'),
      el('button', { class: 'btn-sm', onclick: () => api.addMask('rect') }, iconEl('plus', '', 11), ' rect'))));
  (m.items || []).forEach((it, i) => {
    const box = el('div', { class: 'fx-item' });
    box.append(el('div', { class: 'fx-head' },
      el('span', { class: 'fx-name' }, `${it.shape} ${i + 1}`),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn-sm ic-btn', title: 'Remove mask', onclick: () => api.removeMask(i) }, iconEl('x', '', 12))));
    box.append(selectField('Mode', it.mode || 'add',
      ['add', 'subtract', 'intersect'].map(v => ({ value: v, label: v })), v => api.setMask(i, { mode: v })));
    box.append(row2(
      numField('Centre X', it.cx ?? 0, null, { step: 1, onInput: v => api.setMask(i, { cx: v }) }),
      numField('Centre Y', it.cy ?? 0, null, { step: 1, onInput: v => api.setMask(i, { cy: v }) })));
    box.append(row2(
      numField('Width', it.w ?? 100, null, { step: 1, min: 0, onInput: v => api.setMask(i, { w: v }) }),
      numField('Height', it.h ?? 100, null, { step: 1, min: 0, onInput: v => api.setMask(i, { h: v }) })));
    box.append(row2(
      numField('Rotation °', it.rot ?? 0, null, { step: 1, onInput: v => api.setMask(i, { rot: v }) }),
      numField('Feather px', it.feather ?? 0, null, { step: 1, min: 0, onInput: v => api.setMask(i, { feather: v }) })));
    box.append(row2(
      numField('Opacity', it.opacity ?? 1, null, { step: 0.05, min: 0, max: 1, onInput: v => api.setMask(i, { opacity: v }) }),
      boolField('Invert', !!it.invert, v => api.setMask(i, { invert: v }))));
    box.append(boolField('Enabled', it.enabled !== false, v => api.setMask(i, { enabled: v })));
    out.push(box);
  });
  if (!(m.items || []).length) out.push(el('div', { class: 'empty sm' }, 'No masks — the layer is unmasked.'));
  return out;
}

function matteUI(state, api, L) {
  const others = state.project.layers.filter(x => x.id !== L.id);
  const cur = L.matte?.source || '';
  return [
    selectField('Source', cur, [{ value: '', label: '— none —' }, ...others.map(o => ({ value: o.id, label: o.name }))],
      v => api.setMatte(v ? { source: v, mode: L.matte?.mode || 'alpha', invert: !!L.matte?.invert } : null)),
    selectField('Use', L.matte?.mode || 'alpha', ['alpha', 'luma'].map(v => ({ value: v, label: v })), v => api.setMatte({ source: cur, mode: v, invert: !!L.matte?.invert })),
    boolField('Invert', !!L.matte?.invert, v => api.setMatte({ source: cur, mode: L.matte?.mode || 'alpha', invert: v })),
    el('div', { class: 'note' }, cur ? 'The source layer is hidden from the comp and feeds this layer instead.' : ''),
  ];
}

function fxSummary(state, api, L) {
  if (!L.effects?.length) return [el('div', { class: 'empty sm' }, 'No effects. Add one from the Effects tab.')];
  return L.effects.map((fx, i) => {
    const def = EFFECT_LIST.find(e => e.id === fx.id);
    const row = el('div', { class: 'fx-chip' + (fx.enabled === false ? ' off' : '') });
    row.append(el('button', { class: 'l-ic' + (fx.enabled !== false ? ' on' : ''), title: 'Enable/disable', onclick: () => api.toggleEffect(i) }, iconEl(fx.enabled !== false ? 'eye' : 'eyeOff', '', 13)));
    row.append(el('span', { class: 'fx-chip-name', onclick: () => api.selectEffect(i) }, def?.name || fx.id));
    row.append(el('button', { class: 'l-ic', title: 'Remove', onclick: () => api.removeEffectAt(i) }, iconEl('x', '', 12)));
    return row;
  });
}

/* ══════════════════════════ RIGHT: type panel ══════════════════════════ */

export function renderTypePanel(state, api) {
  const host = $('#type-panel');
  host.textContent = '';
  const L = selectedLayer(state);
  if (!L || L.type !== 'text') { host.append(el('div', { class: 'empty' }, 'Select a text layer for typography controls.')); return; }
  const reg = state.registry;
  const t = L.text || {};
  const spec = reg?.spec(t.family) || {};

  host.append(section('Content',
    textField('Text', t.text || '', v => api.setText('text', v), { tall: true }),
    selectField('Family', t.family, reg?.families().map(f => ({ value: f, label: f })) || [], v => api.setFont(v)),
    selectField('Direction', t.direction || 'auto', ['auto', 'ltr', 'rtl'].map(v => ({ value: v, label: v })), v => api.setText('direction', v)),
    selectField('Align', t.align || 'left', ['left', 'center', 'right'].map(v => ({ value: v, label: v })), v => api.setText('align', v)),
  ));

  host.append(section('Metric',
    numField('Size', t.size ?? 64, null, { step: 1, min: 1, onInput: v => api.setText('size', v) }),
    numField('Weight', t.weight ?? 400, null, { step: 1, min: 1, max: 1000, onInput: v => api.setText('weight', v) }),
    numField('Tracking', t.tracking ?? 0, null, { step: 0.1, onInput: v => api.setText('tracking', v) }),
    numField('Leading', t.leading ?? 1.2, null, { step: 0.05, min: 0.4, onInput: v => api.setText('leading', v) }),
    colorField('Colour', t.color, v => api.setText('color', v)),
  ));

  // Display styles: the kinetic-type looks the reference pieces need
  // (3D extrude like broadcast titles, marker-pen highlight like docs zooms).
  host.append(section('Display',
    numField('Extrude depth', t.extrude?.depth ?? 0, null, { step: 1, min: 0, max: 60, onInput: v => api.setText('extrude', { ...t.extrude, depth: v }) }),
    numField('Extrude angle', t.extrude?.angle ?? 90, null, { step: 1, min: -180, max: 180, onInput: v => api.setText('extrude', { ...t.extrude, angle: v }) }),
    colorField('Extrude colour', t.extrude?.color || '#000000', v => api.setText('extrude', { ...t.extrude, color: v })),
    textField('Highlight phrase', t.highlight?.phrase || '', v => api.setText('highlight', { ...t.highlight, phrase: v })),
    colorField('Highlight colour', t.highlight?.color || '#ffe14d', v => api.setText('highlight', { ...t.highlight, color: v })),
  ));

  // Coverage report — the thing After Effects never tells you.
  const text = String(t.text || '');
  if (reg && text) {
    const missing = reg.missingGlyphs?.(t.family, text) || [];
    const rows = [
      el('div', { class: 'cov-row' }, el('span', {}, 'characters'), el('b', {}, String([...text].length))),
      el('div', { class: 'cov-row' }, el('span', {}, 'missing in ' + t.family), el('b', { class: missing.length ? 'bad' : 'good' }, String(missing.length))),
    ];
    if (missing.length) rows.push(el('div', { class: 'note warn' }, `Missing: ${missing.slice(0, 12).map(m => `“${m.char || m}”`).join(' ')}${missing.length > 12 ? ' …' : ''}`));
    const route = reg.routeForScript?.('arabic', t.family);
    if (route) rows.push(el('div', { class: 'note' }, `Arabic-script route: ${Array.isArray(route) ? route.join(' → ') : route}`));
    host.append(section('Coverage', ...rows));
  }
  if (spec.axes?.length) host.append(el('div', { class: 'note' }, `${spec.axes.length} variable axes — see the Axes tab.`));
}

/* ══════════════════════════ RIGHT: axes panel ══════════════════════════ */

export function renderAxesPanel(state, api) {
  const host = $('#axes-panel');
  host.textContent = '';
  const L = selectedLayer(state);
  if (!L || L.type !== 'text') { host.append(el('div', { class: 'empty' }, 'Select a text layer to drive its variable-font axes.')); return; }
  const reg = state.registry;
  const spec = reg?.spec(L.text?.family) || {};
  const axes = spec.axes || [];
  if (!axes.length) { host.append(el('div', { class: 'empty' }, `“${L.text?.family}” is not a variable font — no axes to drive.`)); return; }

  host.append(el('div', { class: 'note' }, `${axes.length} axes on ${L.text.family}. Moving a slider re-instantiates the face — no server round-trip, because FontFace(variationSettings) works client-side.`));
  const live = { ...(L.text?.axes || {}) };
  for (const ax of axes) {
    const tag = ax.tag || ax.name;
    const min = ax.min ?? 0, max = ax.max ?? 1000, dflt = ax.default ?? min;
    const cur = live[tag] ?? (L.text?.weight != null && tag === 'wght' ? L.text.weight : dflt);
    const row = el('div', { class: 'f-row' });
    row.append(el('label', { class: 'f-lbl', title: ax.name || tag }, `${tag}`));
    const range = el('input', { type: 'range', class: 'f-range', min: String(min), max: String(max), step: String(ax.step || ((max - min) / 200)), value: String(cur) });
    const out = el('span', { class: 'f-val' }, String(round(cur, 1)));
    range.addEventListener('input', () => {
      const v = parseFloat(range.value);
      out.textContent = String(round(v, 1));
      api.setTextAxis(tag, v);
    });
    const rst = el('button', { class: 'l-ic', title: `Reset to ${dflt}`, onclick: () => { range.value = String(dflt); out.textContent = String(dflt); api.setTextAxis(tag, dflt); } }, iconEl('reset', '', 12));
    row.append(range, out, rst);
    host.append(row);
  }
  host.append(el('div', { class: 'f-row' },
    el('button', { class: 'btn-sm wide', onclick: () => api.resetAxes() }, 'Reset all axes to defaults')));
}

/* ══════════════════════════ RIGHT: effect params ══════════════════════════ */

export function renderFxPanel(state, api) {
  const host = $('#fx-panel');
  host.textContent = '';
  const L = selectedLayer(state);
  if (!L) { host.append(el('div', { class: 'empty' }, 'Select a layer.')); return; }
  if (!L.effects?.length) { host.append(el('div', { class: 'empty' }, 'No effects on this layer. Add one from the Effects tab.')); return; }

  L.effects.forEach((fx, i) => {
    const def = EFFECT_LIST.find(e => e.id === fx.id);
    if (!def) return;
    const open = state.openFx === i;
    const head = el('div', { class: 'fx-head' + (open ? ' open' : '') });
    head.append(el('button', { class: 'l-ic' + (fx.enabled !== false ? ' on' : ''), onclick: e => { e.stopPropagation(); api.toggleEffect(i); } }, iconEl(fx.enabled !== false ? 'eye' : 'eyeOff', '', 13)));
    head.append(el('span', { class: 'fx-title' }, def.name));
    head.append(el('span', { class: 'fx-cost' + (def.cost === 'high' ? ' hi' : '') }, def.cost || 'low'));
    head.append(el('button', { class: 'l-ic', onclick: e => { e.stopPropagation(); api.removeEffectAt(i); } }, iconEl('x', '', 12)));
    head.addEventListener('click', () => api.selectEffect(open ? null : i));
    host.append(head);

    if (!open) return;
    const box = el('div', { class: 'fx-body' });
    const params = def.params || {};
    for (const [key, p] of Object.entries(params)) {
      const v = fx.params?.[key] ?? p?.def ?? p?.default ?? 0;
      const min = p?.min ?? 0, max = p?.max ?? 1, step = p?.step ?? ((max - min) / 100);
      const label = p?.label || key;
      const row = el('div', { class: 'f-row' });
      row.append(el('label', { class: 'f-lbl', title: p?.unit || '' }, label));
      const isInt = Number.isInteger(min) && Number.isInteger(max) && step >= 1;
      const range = el('input', { type: 'range', class: 'f-range', min: String(min), max: String(max), step: String(step), value: String(v) });
      const num = el('input', { type: 'number', class: 'f-num sm', min: String(min), max: String(max), step: String(step), value: String(round(v, 3)) });
      const apply = (nv) => { const val = clamp(parseFloat(nv), min, max); range.value = String(val); num.value = String(round(val, 3)); api.setEffectParam(i, key, isInt ? Math.round(val) : val); };
      range.addEventListener('input', () => apply(range.value));
      num.addEventListener('change', () => apply(num.value));
      const rst = el('button', { class: 'l-ic', title: `Reset to ${p?.def ?? 'default'}`, onclick: () => apply(p?.def ?? v) }, iconEl('reset', '', 12));
      row.append(range, num, rst);
      box.append(row);
    }
    if (def.note) box.append(el('div', { class: 'note' }, def.note));
    box.append(el('div', { class: 'note dim' }, `${def.glsl ? 'GPU shader' : 'CPU path'} · ${def.passes || 1} pass(es)${def.premultiplied ? ' · premultiplied' : ' · straight alpha'}`));
    host.append(box);
  });
}
