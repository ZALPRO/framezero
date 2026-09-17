/**
 * app.js — the FrameZero editor controller.
 *
 * One owner of state. Panels are pure views (ui/panels.js) that read `state`
 * and mutate only through the `api` object built here; the renderer never sees
 * the document, only the flat scene that core/document.js resolves per frame.
 *
 * Layers of the stack, and who is allowed to touch what:
 *   index.html/css   shell
 *   ui/panels.js     views        → read state, call api
 *   app.js           controller   → owns state, drives everything below
 *   core/document.js model         → project/comp/layers + resolver
 *   render/*         engine        → tested independently (62 assertions)
 */
import { $, $$, el, clamp, round, tc, uid, throttle, debounce } from './core/base.js';
import { propValue, setKey, removeKey, hasKeyAt, nearestKey, isAnimated } from './core/base.js';
import {
  createProject, createLayer, resolveScene, addEffect, removeEffect,
  serialize, deserialize, UndoStack, snapshot, restore,
  projectDuration, layerKeyTimes, COMP_PRESETS, resetLayerCounters,
} from './core/document.js';
import { FontRegistry } from './core/fonts.js';
import { detectCapabilities, BACKENDS } from './render/backend.js';
import { Renderer } from './render/compositor.js';
import { EFFECT_LIST } from './effects/registry.js';
import { cacheStats } from './render/typography.js';
import {
  renderLayerList, renderAssets, renderEffectsList, renderFonts,
  renderInspector, renderTypePanel, renderAxesPanel, renderFxPanel,
} from './ui/panels.js';
import { setIcon, iconSVG } from './ui/icons.js';

/* ══════════════════════════════ state ══════════════════════════════ */

const state = {
  project: createProject({ name: 'untitled' }),
  registry: null,
  caps: null,
  renderer: null,
  backendKind: null,

  time: 0,
  duration: 4,
  playing: false,
  loop: true,
  snap: true,
  autoKey: false,
  quality: 'draft',        // 'draft' = proxy resolution, 'exact' = full
  selected: null,
  openFx: null,
  fxQuery: '',
  dirty: false,
  hudOn: false,
  lensOpen: false,

  // viewport / render bookkeeping
  renderScale: 1,
  frameMs: 0,
  fps: 0,
  history: [],             // sparkline of recent frame times
  latency: 0,
};

const undo = new UndoStack(80);
let rafId = 0, lastTick = 0, needsRender = true, fpsClock = { n: 0, t0: 0 };
let attachToken = 0;   // guards overlapping renderer hand-offs (see attachRenderer)

/* ══════════════════════════════ boot ══════════════════════════════ */

const bootLog = (msg) => { const b = $('#boot-log'); if (b) b.textContent = msg; console.info('[boot] ' + msg); };
const bootBar = (pct) => { const i = $('#boot-bar i') || $('.boot-bar i'); if (i) i.style.width = `${clamp(pct, 0, 100)}%`; };

async function boot() {
  try {
    bootLog('detecting GPU capabilities…'); bootBar(8);
    state.caps = await detectCapabilities();
    setBackendBadge();

    bootLog(`loading fonts (${state.caps.fontFace ? 'FontFace API' : 'no FontFace'})…`); bootBar(22);
    state.registry = new FontRegistry();
    await state.registry.loadStock((done, total) => bootBar(22 + 40 * (done / Math.max(1, total))));
    bootLog('fetching font axis metadata…'); bootBar(68);
    try { await state.registry.loadMeta(); } catch (e) { console.warn('font meta unavailable', e); }

    bootLog(`attaching ${BACKENDS[state.caps.recommended] || state.caps.recommended} renderer…`); bootBar(82);
    resetLayerCounters();
    seedDemoProject();
    await attachRenderer();

    bootLog('wiring interface…'); bootBar(94);
    wireShell();
    wireTransport();
    wireTimeline();
    wirePanels();
    wirePalette();
    wireIO();
    wireShortcuts();
    wireDragDrop();
    redraw();

    bootBar(100); bootLog('ready');
    await new Promise(r => setTimeout(r, 220));
    $('#boot')?.classList.add('gone');
    setTimeout(() => $('#boot')?.remove(), 420);
    startLoop();
    toast(`${BACKENDS[state.backendKind] || state.backendKind} · ${state.registry.families().length} fonts · ${EFFECT_LIST.length} effects`, 'ok');
  } catch (err) {
    console.error(err);
    bootLog(`boot failed: ${err.message}`);
    const b = $('#boot'); if (b) b.classList.add('failed');
  }
}

function setBackendBadge() {
  const c = state.caps;
  const name = $('#backend-name'), badge = $('#backend-badge');
  const label = BACKENDS[c.recommended] || c.recommended;
  if (name) name.textContent = label + (c.software ? ' · software' : '');
  if (badge) {
    badge.dataset.kind = c.recommended;
    badge.title = `${c.recommendReason}\nrenderer: ${c.renderer || 'unknown'}`;
    badge.classList.toggle('sw', !!c.software);
  }
}

/** A project that shows the engine off, and gives the tests something to look at. */
function seedDemoProject() {
  const p = state.project;
  p.name = 'kinetic-type-demo';
  p.comp = { width: 1280, height: 720, fps: 30, duration: 4, background: '#0d0f14' };

  const bg = createLayer('shape', {
    name: 'BG gradient', shapeType: 'gradient', width: 1280, height: 720,
    shape: { type: 'gradient', from: '#16203a', to: '#0d0f14', angle: 135 },
  });
  bg.transform.position = [640, 360];

  const orb = createLayer('shape', { name: 'Orb', shapeType: 'ellipse', width: 320, height: 320 });
  orb.transform.position = { keys: [{ t: 0, v: [300, 420], ease: 'ease-in-out-cubic' }, { t: 4, v: [1000, 260], ease: 'ease-in-out-cubic' }] };
  orb.blend = 'screen'; orb.opacity = 0.9;
  orb.shape = { type: 'ellipse', inset: 0 };
  orb.style = { ...orb.style, fill: '#00e5a0' };
  addEffect(orb, 'gaussianBlur', { radius: 18, quality: 9 });
  addEffect(orb, 'bloom', { threshold: 0.35, intensity: 0.9, radius: 24 });

  const title = createLayer('text', { name: 'Title' });
  title.text = { ...title.text, text: 'FrameZero', family: 'Inter', size: 150, weight: 800, tracking: -3, color: '#ffffff', axes: { GRAD: 60 } };
  title.transform.position = [640, 330];
  title.animators = [{
    id: uid('an'), enabled: true, unit: 'glyph', order: 'auto', mode: 'from',
    range: { start: 0, end: 100, offset: 0, softness: 0 },
    delay: 0.05, duration: 0.7, ease: 'ease-out-cubic',
    props: { y: -70, opacity: 0, scale: 0.9 },
  }];

  const fa = createLayer('text', { name: 'Persian line' });
  fa.text = { ...fa.text, text: 'پیش‌نمایش همان رندر است', family: 'Vazirmatn', size: 64, weight: 600, leading: 1.4, direction: 'rtl', color: '#ffc46b' };
  fa.transform.position = [640, 470];
  fa.animators = [{
    id: uid('an'), enabled: true, unit: 'glyph', order: 'auto', mode: 'from',
    range: { start: 0, end: 100, offset: 0, softness: 0 },
    delay: 0.04, duration: 0.6, ease: 'ease-out-cubic',
    props: { y: -40, opacity: 0 },
  }];

  p.layers.push(bg, orb, title, fa);
  state.selected = title.id;
  state.duration = projectDuration(p);
}

/* ══════════════════════════ renderer / viewport ══════════════════════════ */

async function attachRenderer() {
  const comp = state.project.comp;
  // Draft renders at proxy resolution; exact renders every pixel of the comp.
  const MAX_DRAFT = 900;
  let scale = 1;
  if (state.quality === 'draft') {
    const long = Math.max(comp.width, comp.height);
    scale = long > MAX_DRAFT ? MAX_DRAFT / long : 1;
  }
  state.renderScale = scale;
  const w = Math.max(2, Math.round(comp.width * scale));
  const h = Math.max(2, Math.round(comp.height * scale));

  const canvas = $('#viewport');
  if (!canvas) throw new Error('#viewport missing');
  canvas.width = w; canvas.height = h;
  fitViewportCSS(canvas, comp.width, comp.height);

  // Hand-off must be atomic from the render loop's point of view. If we point
  // `state.renderer` at a Renderer that has not finished attaching, a rAF tick
  // landing inside the await calls renderFrame on a renderer with no compositor
  // and throws. Detach first, publish only after attach resolves, and let a
  // newer request win if two overlap (rapid quality/comp-size clicks).
  const token = ++attachToken;
  const old = state.renderer;
  state.renderer = null;
  if (old) { try { old.destroy(); } catch (e) { console.warn('renderer teardown failed', e); } }

  const next = new Renderer();
  // comp dims travel with the device dims so the renderer knows its present
  // scale; without them a proxy preview composites comp-space geometry 1:1.
  const init = await next.attach(canvas, {
    preferred: state.caps.recommended, width: w, height: h, dpr: 1,
    comp: { width: comp.width, height: comp.height },
  });
  if (token !== attachToken) { try { next.destroy(); } catch { } return init; }   // superseded
  state.renderer = next;
  state.backendKind = init.chosen;
  if (init.chosen !== state.caps.recommended) {
    toast(`Requested ${state.caps.recommended}, running ${init.chosen}`, 'warn');
    const badge = $('#backend-badge'); if (badge) badge.dataset.kind = init.chosen;
    const nm = $('#backend-name'); if (nm) nm.textContent = BACKENDS[init.chosen] || init.chosen;
  }
  needsRender = true;
}

/** CSS-fit the render surface into its wrapper, preserving the comp aspect. */
function fitViewportCSS(canvas, compW, compH) {
  const wrap = $('#viewport-wrap');
  if (!wrap) return;
  const avail = { w: wrap.clientWidth - 24, h: wrap.clientHeight - 24 };
  const k = Math.min(avail.w / compW, avail.h / compH, 1);
  canvas.style.width = `${Math.max(16, Math.round(compW * k))}px`;
  canvas.style.height = `${Math.max(16, Math.round(compH * k))}px`;
}

/* ══════════════════════════════ render loop ══════════════════════════════ */

function startLoop() {
  lastTick = performance.now();
  const tick = (now) => {
    rafId = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;

    if (state.playing) {
      let t = state.time + dt;
      let wrapped = false;
      if (t >= state.duration) {
        if (state.loop) { t = 0; wrapped = true; } else { state.playing = false; t = state.duration; }
      }
      setTime(t, { fromPlayback: true });
      if (wrapped) startAudioVoices();        // the loop point is a new take
      if (!state.playing) stopAudioVoices();
    }
    if (needsRender) { needsRender = false; renderOnce(now); }
    fpsClock.n++;
    if (now - fpsClock.t0 >= 500) {
      state.fps = Math.round(fpsClock.n * 1000 / (now - fpsClock.t0));
      fpsClock = { n: 0, t0: now };
      updateHUD();
    }
  };
  rafId = requestAnimationFrame(tick);
}

function renderOnce(now) {
  const r = state.renderer;
  if (!r || !r.compositor) return;          // mid hand-off: skip, don't throw
  const t0 = performance.now();
  const scene = resolveScene(state.project, state.time);
  syncMediaToTransport();
  for (const L of scene.layers) if (L.resolved?.media) L.resolved.media.frame = Math.round((state.project.layers.find(x => x.id === L.id)?.mediaFrame ?? 0) * 1000);
  r.renderFrame(scene, state.time, state.registry, { assets: assetMap() });
  const ms = performance.now() - t0;

  state.frameMs = ms;
  state.latency = r.frameAvg?.totalMs ?? ms;
  state.history.push(ms);
  if (state.history.length > 110) state.history.shift();
  $('#vp-empty')?.classList.toggle('hidden', scene.layers.length > 0);
  if (state.hudOn) { updateHUD(); drawSpark(); }
}

const requestRender = () => { needsRender = true; };

/* ══════════════════════════════ HUD ══════════════════════════════ */

function updateHUD() {
  const r = state.renderer;
  const fs = r?.frameStats || {};
  const set = (id, v) => { const n = $(id); if (n) n.textContent = v; };
  set('#hud-backend', `${BACKENDS[state.backendKind] || state.backendKind}${state.caps?.software ? ' (software)' : ''}`);
  set('#hud-fps', `${state.fps}`);
  set('#hud-frametime', `${(r?.frameAvg?.totalMs ?? state.frameMs).toFixed(2)} ms`);
  set('#hud-latency', `${state.latency.toFixed(2)} ms`);
  set('#hud-eval', `${fs.layers ?? 0} layers · ${fs.passes ?? 0} passes`);
  const cs = cacheStats();
  set('#hud-cache', `layout ${cs.layouts} · buffer ${cs.buffers} · raster ${fs.rasterCacheHits ?? 0}`);
  set('#hud-surfaces', `${fs.uploads ?? 0} uploads/frame`);
  set('#hud-mem', estMemory());
  set('#hud-mode', `${state.quality} · ${state.renderScale < 1 ? Math.round(state.renderScale * 100) + '% proxy' : 'full res'}`);
}

function estMemory() {
  const c = state.project.comp;
  const bytes = c.width * c.height * 4 * state.renderScale ** 2;
  const layers = Math.max(1, state.project.layers.length);
  const mb = (bytes * (1 + layers * 1.5)) / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function drawSpark() {
  const cv = $('#hud-spark');
  if (!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const budget = 1000 / (state.project.comp.fps || 30);
  const maxMs = Math.max(budget * 2, ...state.history, 1);
  const y = v => H - 3 - (v / maxMs) * (H - 8);

  g.strokeStyle = 'rgba(255,92,122,.55)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, y(budget)); g.lineTo(W, y(budget)); g.stroke();

  if (state.history.length > 1) {
    g.beginPath();
    state.history.forEach((v, i) => {
      const x = (i / 109) * W;
      i ? g.lineTo(x, y(v)) : g.moveTo(x, y(v));
    });
    g.strokeStyle = '#00e5a0'; g.lineWidth = 1.4; g.stroke();
  }
  g.fillStyle = 'rgba(138,147,166,.9)'; g.font = '9px ui-monospace,monospace';
  g.fillText(`${maxMs.toFixed(0)}ms`, 3, 10);
  g.fillText(`${budget.toFixed(1)}ms budget`, 3, y(budget) - 3);
}

/* ══════════════════════════════ transport ══════════════════════════════ */

function setTime(t, { fromPlayback = false, redrawPanels = false } = {}) {
  const fps = state.project.comp.fps || 30;
  let v = clamp(t, 0, state.duration);
  if (state.snap && !fromPlayback) v = Math.round(v * fps) / fps;
  state.time = v;
  syncMediaToTransport();
  // A running AudioBufferSource cannot move, so a SCRUB while playing re-bases
  // the voices. Playback ticks must not: restarting them 60×/s is a stutter.
  if (state.playing && !fromPlayback) startAudioVoices();
  const tcEl = $('#tl-tc'); if (tcEl) tcEl.textContent = tc(v, fps);
  positionPlayhead();
  needsRender = true;
  if (redrawPanels) redraw();
}

function play(pause) {
  state.playing = pause ? false : !state.playing;
  $('#btn-play')?.classList.toggle('playing', state.playing);
  setIcon($('#btn-play'), state.playing ? 'pause' : 'play', 15);
  if (state.playing && state.time >= state.duration - 1e-6) setTime(0);
  // audio follows the transport: voices restart from the new playhead on play,
  // and every seek while playing re-bases them (a running source cannot move)
  if (state.playing) startAudioVoices(); else stopAudioVoices();
  for (const L of state.project.layers) if (L.type === 'media') { const a = assetById(L.assetId); if (a?.video && !state.playing) a.video.pause(); }
}

function gotoKey(dir) {
  const L = sel();
  const times = L ? layerKeyTimes(L) : [];
  const all = times.length ? times : [0, state.duration];
  const eps = 1 / (state.project.comp.fps || 30) / 4;
  let target = dir > 0 ? all.find(t => t > state.time + eps) : [...all].reverse().find(t => t < state.time - eps);
  if (target === undefined) target = dir > 0 ? all[all.length - 1] : all[0];
  setTime(target);
}

function wireTransport() {
  setIcon($('#btn-start'), 'start', 15); setIcon($('#btn-prev'), 'prevKey', 15);
  setIcon($('#btn-play'), 'play', 15); setIcon($('#btn-next'), 'nextKey', 15);
  setIcon($('#btn-end'), 'end', 15); setIcon($('#btn-loop'), 'loop', 15);
  setIcon($('#tl-autokey'), 'key', 14);
  const on = (id, fn) => $(id)?.addEventListener('click', fn);
  on('#btn-play', () => play());
  on('#btn-start', () => { play(true); setTime(0); });
  on('#btn-end', () => { play(true); setTime(state.duration); });
  on('#btn-prev', () => { play(true); gotoKey(-1); });
  on('#btn-next', () => { play(true); gotoKey(1); });
  on('#btn-loop', e => { state.loop = !state.loop; e.currentTarget.classList.toggle('on', state.loop); });
  on('#btn-hud', e => { state.hudOn = !state.hudOn; e.currentTarget.classList.toggle('on', state.hudOn); $('#hud')?.classList.toggle('on', state.hudOn); if (state.hudOn) { updateHUD(); drawSpark(); } });
  on('#btn-bench', runBenchmark);

  $$('#quality-seg button').forEach(b => b.addEventListener('click', async () => {
    $$('#quality-seg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    state.quality = b.dataset.q;
    await attachRenderer();
    toast(`${state.quality === 'draft' ? 'Draft proxy' : 'Exact full-resolution'} · ${Math.round(state.renderScale * 100)}%`, 'ok');
  }));

  $('#comp-size')?.addEventListener('change', async e => {
    const [w, h] = e.target.value.split('x').map(Number);
    pushUndo();
    state.project.comp.width = w; state.project.comp.height = h;
    await attachRenderer(); syncCompUI(); redraw();
  });
  $('#comp-dur')?.addEventListener('change', e => {
    pushUndo();
    state.project.comp.duration = clamp(parseFloat(e.target.value) || 4, 0.5, 120);
    state.duration = projectDuration(state.project); syncCompUI(); redraw();
  });
  $('#comp-fps')?.addEventListener('change', e => {
    pushUndo();
    state.project.comp.fps = clamp(Math.round(parseFloat(e.target.value) || 30), 1, 240);
    syncCompUI(); setTime(state.time); redraw();
  });
  $('#tl-snap')?.addEventListener('click', e => { state.snap = !state.snap; e.currentTarget.classList.toggle('on', state.snap); });
  $('#tl-autokey')?.addEventListener('click', e => { state.autoKey = !state.autoKey; e.currentTarget.classList.toggle('on', state.autoKey); toast(`Auto-key ${state.autoKey ? 'ON — every property change writes a keyframe' : 'off'}`, 'ok'); });
}

function syncCompUI() {
  const c = state.project.comp;
  syncNameUI();
  const dur = $('#comp-dur'); if (dur) dur.value = String(c.duration);
  const fps = $('#comp-fps'); if (fps) fps.value = String(c.fps);
  const size = $('#comp-size'); if (size) size.value = `${c.width}x${c.height}`;
  const l = $('#tl-dur'); if (l) l.textContent = `${round(state.duration, 2)} s`;
  const f = $('#tl-fps'); if (f) f.textContent = `${c.fps} fps`;
}

/** The Benchmark button: honest steady-state numbers, not a 30-frame burst. */
async function runBenchmark() {
  const r = state.renderer;
  if (!r) return;
  toast('Benchmark: reaching steady state…', 'info');
  const scene = resolveScene(state.project, state.time);
  const ropts = { assets: assetMap() };
  let prev = Infinity, stable = 0, per = 0, f = 0;
  const t0 = performance.now();
  while (f < 300 && stable < 2) {
    const a = performance.now();
    for (let k = 0; k < 15; k++, f++) r.renderFrame(scene, state.time, state.registry, ropts);
    const w = (performance.now() - a) / 15;
    if (Math.abs(w - prev) / Math.max(prev, w, 1e-6) < 0.12) stable++; else stable = 0;
    prev = w; per = w;
  }
  const secs = (performance.now() - t0) / 1000;
  showBenchmark({ backend: state.backendKind, per, frames: f, secs, software: !!state.caps?.software, caps: state.caps });
}

function showBenchmark(res) {
  const box = $('#modal-box');
  const root = $('#modal-root');
  if (!box || !root) return;
  box.textContent = '';
  box.append(
    el('h3', {}, 'Benchmark — steady state'),
    el('p', { class: 'note' }, 'Warmed until two consecutive 15-frame windows agreed within 12%. WebGL commands are asynchronous, so a short burst measures command submission rather than execution and lies badly.'),
    el('div', { class: 'bm' },
      el('div', {}, el('span', {}, 'backend'), el('b', {}, BACKENDS[res.backend] || res.backend)),
      el('div', {}, el('span', {}, 'rasteriser'), el('b', {}, res.software ? 'software' : 'hardware')),
      el('div', {}, el('span', {}, 'renderer'), el('b', {}, (res.caps?.renderer || '?').slice(0, 48))),
      el('div', {}, el('span', {}, 'frame'), el('b', {}, `${res.per.toFixed(2)} ms`)),
      el('div', {}, el('span', {}, 'throughput'), el('b', {}, `${(1000 / res.per).toFixed(0)} fps`)),
      el('div', {}, el('span', {}, 'measured'), el('b', {}, `${res.frames} frames in ${res.secs.toFixed(1)}s`)),
    ),
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn-sm', onclick: () => root.classList.add('hidden') }, 'Close')),
  );
  root.classList.remove('hidden');
}

/* ══════════════════════════════ timeline ══════════════════════════════ */

let tl = { pxPerSec: 120, dragging: false };

function wireTimeline() {
  const zoom = $('#tl-zoom');
  const apply = () => { tl.pxPerSec = clamp(Number(zoom?.value || 120), 20, 600); drawTimeline(); };
  zoom?.addEventListener('input', apply);
  $('#tl-zoom-in')?.addEventListener('click', () => { if (zoom) { zoom.value = String(clamp(Number(zoom.value) * 1.3, 20, 600)); apply(); } });
  $('#tl-zoom-out')?.addEventListener('click', () => { if (zoom) { zoom.value = String(clamp(Number(zoom.value) / 1.3, 20, 600)); apply(); } });

  for (const id of ['#tl-ruler', '#tl-tracks']) {
    const cv = $(id);
    if (!cv) continue;
    cv.addEventListener('pointerdown', e => {
      tl.dragging = true; cv.setPointerCapture(e.pointerId);
      play(true); scrubFromEvent(e, cv);
    });
    cv.addEventListener('pointermove', e => { if (tl.dragging) scrubFromEvent(e, cv); });
    cv.addEventListener('pointerup', e => { tl.dragging = false; try { cv.releasePointerCapture(e.pointerId); } catch { } });
  }
  $('#tl-scroll')?.addEventListener('scroll', () => drawTimeline());
  new ResizeObserver(() => { sizeTimelineCanvases(); drawTimeline(); }).observe($('#timeline') || document.body);
  sizeTimelineCanvases();
}

function scrubFromEvent(e, cv) {
  const rect = cv.getBoundingClientRect();
  const x = e.clientX - rect.left + (($('#tl-scroll')?.scrollLeft) || 0) - (cv === $('#tl-tracks') ? 0 : 0);
  setTime(Math.max(0, x / tl.pxPerSec));
}

function sizeTimelineCanvases() {
  const scroll = $('#tl-scroll');
  if (!scroll) return;
  const dpr = 1;
  const w = Math.max(scroll.clientWidth, Math.ceil(state.duration * tl.pxPerSec) + 40);
  for (const [id, h] of [['#tl-ruler', 26], ['#tl-tracks', Math.max(60, state.project.layers.length * 26 + 12)]]) {
    const cv = $(id);
    if (!cv) continue;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
  }
  const labels = $('#tl-labels');
  if (labels) {
    labels.textContent = '';
    for (const l of [...state.project.layers].reverse()) {
      labels.append(el('div', { class: 'tl-lab' + (state.selected === l.id ? ' sel' : ''), onclick: () => api.select(l.id) },
        el('span', { class: 'tl-lab-n' }, l.name),
        el('span', { class: 'tl-lab-t' }, tc(l.inPoint ?? 0, state.project.comp.fps))));
    }
  }
}

function drawTimeline() {
  const p = state.project, fps = p.comp.fps || 30;
  const ruler = $('#tl-ruler'), tracks = $('#tl-tracks');
  if (ruler) {
    const g = ruler.getContext('2d');
    const W = ruler.width, H = ruler.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#141922'; g.fillRect(0, 0, W, H);
    // choose a tick step that stays readable at any zoom
    const target = 78;
    const steps = [1 / fps, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find(s => s * tl.pxPerSec >= target) || 600;
    g.strokeStyle = '#2b3444'; g.fillStyle = '#8a93a6'; g.font = '10px ui-monospace,monospace'; g.lineWidth = 1;
    for (let t = 0; t * tl.pxPerSec < W; t += step) {
      const x = Math.round(t * tl.pxPerSec) + 0.5;
      g.beginPath(); g.moveTo(x, H - 9); g.lineTo(x, H); g.stroke();
      g.fillText(tc(t, fps), x + 3, 11);
      // sub-ticks
      for (let k = 1; k < 5; k++) {
        const sx = Math.round((t + step * k / 5) * tl.pxPerSec) + 0.5;
        if (sx > W) break;
        g.beginPath(); g.moveTo(sx, H - 4); g.lineTo(sx, H); g.stroke();
      }
    }
    g.strokeStyle = '#232a38'; g.beginPath(); g.moveTo(0, H - 0.5); g.lineTo(W, H - 0.5); g.stroke();
  }
  if (tracks) {
    const g = tracks.getContext('2d');
    const W = tracks.width, H = tracks.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#10141c'; g.fillRect(0, 0, W, H);
    const rowH = 26;
    [...p.layers].reverse().forEach((l, i) => {
      const y = 6 + i * rowH;
      if (y > H) return;
      if (state.selected === l.id) { g.fillStyle = 'rgba(0,229,160,.07)'; g.fillRect(0, y - 3, W, rowH); }
      const a = (l.inPoint ?? 0) * tl.pxPerSec;
      const b = (l.outPoint ?? p.comp.duration) * tl.pxPerSec;
      g.fillStyle = l.visible === false ? '#2a3140' : (l.type === 'text' ? '#3b4a6b' : '#2f5c4c');
      roundRect(g, a, y, Math.max(3, b - a), rowH - 8, 3); g.fill();
      g.strokeStyle = state.selected === l.id ? '#00e5a0' : 'rgba(255,255,255,.08)';
      g.lineWidth = 1; roundRect(g, a + .5, y + .5, Math.max(3, b - a) - 1, rowH - 9, 3); g.stroke();
      // keyframe diamonds
      g.fillStyle = '#ffc46b';
      for (const t of layerKeyTimes(l)) {
        const x = t * tl.pxPerSec;
        if (x < -6 || x > W + 6) continue;
        g.beginPath(); g.moveTo(x, y + 4); g.lineTo(x + 4, y + 8); g.lineTo(x, y + 12); g.lineTo(x - 4, y + 8); g.closePath(); g.fill();
      }
      if (l.effects?.length) { g.fillStyle = '#8a93a6'; g.font = '9px ui-monospace,monospace'; g.fillText(`fx${l.effects.length}`, a + 5, y + rowH - 11); }
      // waveform: the asset's min/max envelope stretched over the layer's span
      const asset = l.type === 'media' ? (state.project.assets || []).find(x => x.id === l.assetId) : null;
      if (asset?.peaks) {
        const span = Math.max(0.001, (l.outPoint ?? p.comp.duration) - (l.inPoint ?? 0));
        const x0 = (l.inPoint ?? 0) * tl.pxPerSec, x1 = x0 + span * tl.pxPerSec;
        const mid = y + (rowH - 8) / 2, amp = (rowH - 10) / 2;
        g.strokeStyle = 'rgba(0,229,160,.75)'; g.lineWidth = 1;
        g.beginPath();
        const n = asset.peaks.length;
        for (let px = Math.floor(x0); px < x1; px += 1) {
          const idx = clamp(Math.floor(((px - x0) / (x1 - x0)) * n), 0, n - 1);
          const v = asset.peaks[idx] * amp;
          g.moveTo(px + .5, mid - v); g.lineTo(px + .5, mid + v);
        }
        g.stroke();
      }
    });
  }
  positionPlayhead();
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function positionPlayhead() {
  const ph = $('#tl-playhead');
  if (!ph) return;
  ph.style.left = `${round(state.time * tl.pxPerSec, 2)}px`;
  ph.style.height = `${($('#tl-tracks')?.clientHeight || 80) + 26}px`;
}

/* ══════════════════════════ property access + keys ══════════════════════════ */

const sel = () => state.project.layers.find(l => l.id === state.selected) || null;

/** Walk a dot path, resolving any track encountered on the way. */
function resolveAtPath(layer, path, time) {
  let cur = layer;
  for (const k of path.split('.')) {
    if (cur && typeof cur === 'object' && Array.isArray(cur.keys)) cur = propValue(cur, time);
    if (cur == null) return undefined;
    cur = cur[k];
  }
  if (cur && typeof cur === 'object' && Array.isArray(cur.keys)) return propValue(cur, time);
  return cur;
}
function rawAtPath(layer, path) {
  let cur = layer;
  for (const k of path.split('.')) { if (cur == null) return undefined; cur = cur[k]; }
  return cur;
}
function snapTime(t) {
  const fps = state.project.comp.fps || 30;
  return state.snap ? Math.round(t * fps) / fps : round(t, 4);
}

const api = {
  /* ── selection ── */
  select(id) { state.selected = id; state.openFx = null; redraw(); },
  /* ── property read ── */
  getProp(path) { const L = sel(); return L ? resolveAtPath(L, path, state.time) : undefined; },
  isKeyed(path) {
    const L = sel(); if (!L) return false;
    const segs = path.split('.');
    for (let n = segs.length; n > 0; n--) {
      const v = rawAtPath(L, segs.slice(0, n).join('.'));
      if (v && typeof v === 'object' && Array.isArray(v.keys)) return hasKeyAt(v, snapTime(state.time));
    }
    return false;
  },
  /* ── property write (auto-key aware) ── */
  setProp(path, value) {
    const L = sel(); if (!L || L.locked) return;
    const segs = path.split('.');
    const compIdx = /^\d+$/.test(segs[segs.length - 1]) ? Number(segs.pop()) : null;
    const leafKey = segs.pop();
    let container = L;
    for (const k of segs) { container = container?.[k]; if (container == null) return; }
    const existing = container[leafKey];
    const isTrack = existing && typeof existing === 'object' && Array.isArray(existing.keys);
    const cur = isTrack ? propValue(existing, state.time) : existing;

    let next;
    if (compIdx === null) next = value;
    else { const arr = Array.isArray(cur) ? cur.slice() : [cur ?? 0, cur ?? 0]; arr[compIdx] = value; next = arr; }

    if (isTrack || state.autoKey) {
      const tr = isTrack ? existing : { keys: [] };
      if (!isTrack) setKey(tr, 0, Array.isArray(next) ? next.slice() : next);   // give the motion a start
      setKey(tr, snapTime(state.time), Array.isArray(next) ? next.slice() : next);
      container[leafKey] = tr;
    } else {
      container[leafKey] = next;
    }
    commit();
  },
  toggleKey(path) {
    const L = sel(); if (!L || L.locked) return;
    const segs = path.split('.');
    const compIdx = /^\d+$/.test(segs[segs.length - 1]) ? Number(segs[segs.length - 1]) : null;
    const propPath = compIdx === null ? path : segs.slice(0, -1).join('.');
    const t = snapTime(state.time);
    // find the nearest track ancestor (a component path keys the whole vector)
    const ps = propPath.split('.');
    for (let n = ps.length; n > 0; n--) {
      const pp = ps.slice(0, n).join('.');
      const keys = pp.split('.'); const leaf = keys.pop();
      let cont = L; for (const k of keys) cont = cont?.[k];
      if (cont == null) continue;
      const v = cont[leaf];
      if (v && typeof v === 'object' && Array.isArray(v.keys)) {
        if (hasKeyAt(v, t)) { removeKey(v, t); toast(`Removed key at ${tc(t, state.project.comp.fps)}`, 'info'); }
        else {
          const cur = propValue(v, t);
          setKey(v, t, Array.isArray(cur) ? cur.slice() : cur);
          toast(`Key at ${tc(t, state.project.comp.fps)}`, 'ok');
        }
        commit(); return;
      }
      if (n === ps.length) {
        // nothing animated yet → create a track seeded with the current value
        const cur = resolveAtPath(L, pp, state.time);
        const tr = { keys: [] };
        setKey(tr, 0, Array.isArray(cur) ? cur.slice() : cur);
        if (Math.abs(t) > 1e-9) setKey(tr, t, Array.isArray(cur) ? cur.slice() : cur);
        cont[leaf] = tr;
        toast(`Keyframed ${pp} at ${tc(t, state.project.comp.fps)}`, 'ok');
        commit(); return;
      }
    }
  },
  /* ── layer-level writes ── */
  setLayer(k, v) { const L = sel(); if (!L || L.locked) return; pushUndo(); L[k] = v; commit(); },
  setText(k, v) { const L = sel(); if (!L || L.locked) return; L.text = L.text || {}; L.text[k] = v; commit(); },
  setShape(k, v) { const L = sel(); if (!L || L.locked) return; L.shape = L.shape || {}; L.shape[k] = v; commit(); },
  setStyle(k, v) { const L = sel(); if (!L || L.locked) return; L.style = L.style || {}; L.style[k] = v; commit(); },
  setTextAxis(tag, v) {
    const L = sel(); if (!L || L.locked) return;
    L.text = L.text || {}; L.text.axes = { ...(L.text.axes || {}), [tag]: v };
    if (tag === 'wght') L.text.weight = Math.round(v);
    commit();
  },
  resetAxes() {
    const L = sel(); if (!L) return;
    pushUndo(); L.text.axes = {}; commit(); toast('Axes reset', 'ok');
  },
  setShapeType(type) {
    const L = sel(); if (!L) return;
    pushUndo();
    const defaults = createLayer('shape', { shapeType: type }).shape;
    L.shape = { ...defaults, type };
    commit();
  },
  setFont(family) {
    const L = sel(); if (!L || L.type !== 'text') return;
    pushUndo(); L.text.family = family;
    const spec = state.registry?.spec(family);
    if (spec?.defaultAxes) L.text.axes = { ...spec.defaultAxes };
    commit(); toast(`Typeface → ${family}`, 'ok');
  },
  /* ── layer ops ── */
  toggleVisible(id) { const L = byId(id); if (L) { L.visible = L.visible === false; commit(); } },
  toggleSolo(id) { const L = byId(id); if (L) { L.solo = !L.solo; commit(); } },
  toggleLock(id) { const L = byId(id); if (L) { L.locked = !L.locked; commit(); } },
  rename(id, name) { const L = byId(id); if (L) { pushUndo(); L.name = name; commit(); } },
  addLayer(type, over) {
    pushUndo();
    const c = state.project.comp;
    const L = createLayer(type, {
      width: Math.round(c.width * 0.5), height: Math.round(c.height * 0.5),
      ...(over || {}),
    });
    if (!over?.transform) L.transform.position = [Math.round(c.width / 2), Math.round(c.height / 2)];
    L.inPoint = 0; L.outPoint = c.duration;
    state.project.layers.push(L);
    state.selected = L.id;
    state.duration = projectDuration(state.project);
    commit(); toast(`Added ${L.name}`, 'ok');
    return L;
  },
  deleteSelected() {
    const L = sel(); if (!L) return;
    if (L.locked) { toast('Layer is locked', 'warn'); return; }
    pushUndo();
    const i = state.project.layers.indexOf(L);
    state.project.layers.splice(i, 1);
    state.selected = state.project.layers[Math.min(i, state.project.layers.length - 1)]?.id || null;
    state.duration = projectDuration(state.project);
    commit(); toast(`Deleted ${L.name}`, 'ok');
  },
  duplicateSelected() {
    const L = sel(); if (!L) return;
    pushUndo();
    const copy = JSON.parse(JSON.stringify(L));
    copy.id = uid('L'); copy.name = L.name + ' copy';
    copy.transform = { ...copy.transform, position: (copy.transform.position || [0, 0]) };
    const pos = copy.transform.position;
    const shift = (v) => Array.isArray(v) ? [v[0] + 24, v[1] + 24] : v;
    if (Array.isArray(pos.keys)) pos.keys.forEach(k => { k.v = shift(k.v); }); else copy.transform.position = shift(pos);
    state.project.layers.splice(state.project.layers.indexOf(L) + 1, 0, copy);
    state.selected = copy.id; commit(); toast(`Duplicated → ${copy.name}`, 'ok');
  },
  reorder(dir) {
    const L = sel(); if (!L) return;
    const arr = state.project.layers, i = arr.indexOf(L), j = i + dir;
    if (j < 0 || j >= arr.length) return;
    pushUndo(); [arr[i], arr[j]] = [arr[j], arr[i]]; commit();
  },
  /* ── effects ── */
  addEffect(id) {
    const L = sel(); if (!L) { toast('Select a layer first', 'warn'); return; }
    pushUndo();
    if (!addEffect(L, id)) { toast(`Unknown effect ${id}`, 'warn'); return; }
    state.openFx = L.effects.length - 1;
    commit(); toast(`Added ${EFFECT_LIST.find(e => e.id === id)?.name || id}`, 'ok');
  },
  removeEffectAt(i) { const L = sel(); if (!L) return; pushUndo(); removeEffect(L, i); state.openFx = null; commit(); },
  toggleEffect(i) { const L = sel(); if (!L) return; const fx = L.effects[i]; if (fx) { fx.enabled = fx.enabled === false; commit(); } },
  selectEffect(i) { state.openFx = i; redraw(); },
  setEffectParam(i, key, v) {
    const L = sel(); if (!L) return;
    const fx = L.effects[i]; if (!fx) return;
    fx.params = { ...(fx.params || {}), [key]: v };
    needsRender = true; markDirty();
    // avoid a full panel rebuild per slider tick — only the value changes
  },
  /* ── masks & track mattes ── */
  addMask(shape) {
    const L = sel(); if (!L || L.locked) return;
    pushUndo();
    L.masks = L.masks || { enabled: true, items: [] };
    const w = Math.round((L.width || state.project.comp.width * 0.5) * 0.6);
    const h = Math.round((L.height || state.project.comp.height * 0.5) * 0.6);
    L.masks.items.push({ id: uid('mk'), shape: shape === 'rect' ? 'rect' : 'ellipse', cx: 0, cy: 0, w: Math.max(8, w), h: Math.max(8, h), rot: 0, feather: 0, opacity: 1, invert: false, mode: 'add' });
    commit(); toast(`Mask ${L.masks.items.length} added`, 'ok');
  },
  setMask(i, patch) {
    const L = sel(); if (!L || L.locked) return;
    const it = L.masks?.items?.[i]; if (!it) return;
    Object.assign(it, patch);
    // per-tick writes must not rebuild the inspector (focus loss), same rule
    // as effect params: mark dirty and re-render, redraw on structural change
    markDirty(); requestRender();
  },
  removeMask(i) {
    const L = sel(); if (!L || L.locked) return;
    pushUndo(); L.masks?.items?.splice(i, 1); commit(); toast('Mask removed', 'info');
  },
  setMasksEnabled(v) {
    const L = sel(); if (!L || L.locked) return;
    pushUndo(); L.masks = L.masks || { enabled: true, items: [] }; L.masks.enabled = v; commit();
  },
  setMatte(matte) {
    const L = sel(); if (!L || L.locked) return;
    pushUndo();
    L.matte = matte && matte.source ? { source: matte.source, mode: matte.mode === 'luma' ? 'luma' : 'alpha', invert: !!matte.invert } : null;
    commit();
    const src = L.matte && state.project.layers.find(x => x.id === L.matte.source);
    toast(L.matte ? `Track matte ← ${src?.name || '?'}` : 'Track matte cleared', 'ok');
  },
  /* ── animators ── */
  addAnimator() {
    const L = sel(); if (!L || L.type !== 'text') return;
    pushUndo();
    L.animators = L.animators || [];
    L.animators.push(defaultAnimator({ id: uid('an') }));
    commit(); toast('Animator added', 'ok');
  },
  removeAnimator(i) { const L = sel(); if (!L) return; pushUndo(); L.animators.splice(i, 1); commit(); },
  updateAnimator(i, patch) {
    const L = sel(); if (!L) return;
    const an = L.animators?.[i]; if (!an) return;
    Object.assign(an, patch);
    needsRender = true; markDirty();
  },
  /* ── assets ── */
  addAssetToComp(a) {
    pushUndo();
    const c = state.project.comp;
    const L = createLayer('media', {
      name: a.name,
      width: a.kind === 'audio' ? 64 : (a.width || 640),
      height: a.kind === 'audio' ? 64 : (a.height || 360),
    });
    L.assetId = a.id;
    L.mediaKind = a.kind;
    if (a.kind === 'image') L.bitmap = a.bitmap;
    if (a.kind === 'video' || a.kind === 'audio') L.outPoint = Math.min(c.duration, a.duration || c.duration);
    state.project.layers.push(L); state.selected = L.id;
    state.duration = projectDuration(state.project);
    commit(); toast(`Placed ${a.name}`, 'ok');
  },
  setMedia(k, v) {
    const L = sel(); if (!L || L.type !== 'media' || L.locked) return;
    if (k === 'volume') L.volume = clamp(Number(v) || 0, 0, 4);
    else if (k === 'mute') L.mute = !!v;
    else if (k === 'mediaOffset') L.mediaOffset = Number(v) || 0;
    markDirty(); requestRender();
    if (state.playing) startAudioVoices();
  },
  removeAsset(id) { pushUndo(); state.project.assets = (state.project.assets || []).filter(a => a.id !== id); commit(); },
};
const byId = (id) => state.project.layers.find(l => l.id === id) || null;

/* ══════════════════════════ commit / undo / redraw ══════════════════════════ */

function pushUndo() { undo.push(snapshot(state.project)); }
function markDirty() {
  state.dirty = true;
  const d = $('#proj-dirty'); if (d) d.style.opacity = '1';
}
/** Model → DOM. The document owns the project name; the header field is a view
 *  of it. Reading the field back into the model on every dirty mark let the
 *  shell's placeholder silently rename a project as soon as anything was edited
 *  — so saving produced "name.fz.fz.json". Only the field's own change event
 *  writes the model. */
function syncNameUI() {
  const n = $('#project-name');
  if (n && n.value !== (state.project.name || '')) n.value = state.project.name || '';
}
const redraw = throttle(() => {
  renderLayerList(state, api);
  renderAssets(state, api);
  renderEffectsList(state, api);
  renderFonts(state, api);
  renderInspector(state, api);
  renderTypePanel(state, api);
  renderAxesPanel(state, api);
  renderFxPanel(state, api);
  sizeTimelineCanvases();
  drawTimeline();
  syncCompUI();
  fitAll();                 // panel content can change column widths → re-fit comp
  needsRender = true;
}, 40);

/** Structural change: undo point + full redraw + re-render. */
function commit() { markDirty(); redraw(); requestRender(); }

/* ══════════════════════════════ shell wiring ══════════════════════════════ */

function wireShell() {
  const tabify = (navSel, paneSel) => {
    $$(navSel + ' button').forEach(b => b.addEventListener('click', () => {
      $$(navSel + ' button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      $$(paneSel).forEach(p => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
      redraw();
    }));
  };
  tabify('#left-tabs', '#left .tabpane');
  tabify('#right-tabs', '#right .tabpane');

  setIcon($('#btn-add-text'), 'text', 15); setIcon($('#btn-add-shape'), 'shape', 15);
  setIcon($('#btn-add-solid'), 'solid', 13); setIcon($('#btn-del'), 'trash', 15);
  setIcon($('#btn-import-media'), 'plus', 15); setIcon($('#btn-font-audit'), 'refresh', 15);
  const ghost = (id, name) => { const b = $(id); if (b) b.innerHTML = iconSVG(name, 14) + b.textContent; };
  ghost('#btn-hud', 'gauge'); ghost('#btn-bench', 'bolt'); ghost('#btn-clearance', 'file');
  ghost('#btn-palette', 'command');
  $$('#io-seg button').forEach(b => {
    const n = b.dataset.io === 'open' ? 'folder' : b.dataset.io === 'save' ? 'save' : 'exportImg';
    b.innerHTML = iconSVG(n, 14) + b.textContent;
  });
  $('#btn-add-text')?.addEventListener('click', () => api.addLayer('text'));
  $('#btn-add-shape')?.addEventListener('click', () => api.addLayer('shape', { shapeType: 'rect' }));
  $('#btn-add-solid')?.addEventListener('click', () => api.addLayer('shape', {
    name: undefined, shapeType: 'solid',
    width: state.project.comp.width, height: state.project.comp.height,
  }));
  $('#btn-del')?.addEventListener('click', () => api.deleteSelected());
  $('#fx-search')?.addEventListener('input', e => { state.fxQuery = e.target.value; renderEffectsList(state, api); });
  $('#btn-font-audit')?.addEventListener('click', () => { renderFonts(state, api); toast('Font coverage re-audited', 'ok'); });
  $('#project-name')?.addEventListener('change', e => { state.project.name = e.target.value; markDirty(); });

  $$('#tl-view-seg button').forEach(b => b.addEventListener('click', () => {
    $$('#tl-view-seg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    const v = b.dataset.tlv;
    $('#timeline')?.classList.toggle('hidden', v !== 'layers');
    state.lensOpen = v !== 'layers';
    $('#lens-wrap')?.classList.toggle('hidden', !state.lensOpen);
    if (state.lensOpen) drawLens(v);
    fitAll();
  }));
  $$('#lens-seg button').forEach(b => b.addEventListener('click', () => {
    $$('#lens-seg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); drawLens(b.dataset.lens);
  }));

  $('#modal-root')?.addEventListener('click', e => { if (e.target.id === 'modal-root') e.currentTarget.classList.add('hidden'); });
  /* Observe the element whose box actually decides the fit: the viewport wrap.
     Watching #center missed the case where the side panels change width after
     their content arrives (fonts, inspector fields), leaving the canvas fitted
     to a stale, wider column and clipped by the right panel. */
  new ResizeObserver(() => fitAll()).observe($('#viewport-wrap') || $('#center') || document.body);
  new ResizeObserver(() => fitAll()).observe($('#center') || document.body);
  window.addEventListener('resize', () => fitAll());
  // Webfonts landing can reflow the panels; re-fit once they are in.
  document.fonts?.ready?.then(() => fitAll())?.catch?.(() => { });
  window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  syncCompUI();
  fitAll();
}

function fitAll() {
  const canvas = $('#viewport');
  if (canvas) fitViewportCSS(canvas, state.project.comp.width, state.project.comp.height);
  positionPlayhead();
}

/** Node-graph / curves lens: a read-only view of the SAME scene graph. */
function drawLens(which) {
  const cv = $('#nodeview');
  if (!cv || !state.lensOpen) return;
  const wrap = $('#lens-wrap');
  cv.width = Math.max(200, wrap.clientWidth - 20); cv.height = Math.max(120, wrap.clientHeight - 60);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#0b0e13'; g.fillRect(0, 0, cv.width, cv.height);
  const L = sel();
  g.font = '11px ui-monospace,monospace';
  if (which === 'nodes') {
    const layers = state.project.layers;
    const bw = 132, bh = 30, gap = 16;
    const x0 = 24, y0 = 24;
    layers.forEach((l, i) => {
      const x = x0 + (i % 4) * (bw + gap), y = y0 + Math.floor(i / 4) * (bh + gap + 26);
      g.fillStyle = state.selected === l.id ? '#1d3a30' : '#161c26';
      roundRect(g, x, y, bw, bh, 5); g.fill();
      g.strokeStyle = state.selected === l.id ? '#00e5a0' : '#2b3444'; roundRect(g, x + .5, y + .5, bw - 1, bh - 1, 5); g.stroke();
      g.fillStyle = '#e6e9f0'; g.fillText(l.name.slice(0, 16), x + 8, y + 19);
      // chain: source → effects → transform → comp
      g.fillStyle = '#5b6478';
      g.fillText(`src → ${(l.effects || []).map(e => e.id).join(' → ') || '—'} → xform`, x, y + bh + 14);
    });
    g.fillStyle = '#8a93a6';
    g.fillText(L ? `selected: ${L.name}` : 'nothing selected', x0, cv.height - 12);
  } else {
    // value curves for the selected layer's animated properties
    const tracks = [];
    const walk = (obj, path) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj.keys)) { tracks.push({ path, keys: obj.keys }); return; }
      for (const [k, v] of Object.entries(obj)) walk(v, path ? `${path}.${k}` : k);
    };
    if (L) { walk(L.transform, 'transform'); walk({ opacity: L.opacity }, ''); walk(L.text, 'text'); }
    if (!tracks.length) { g.fillStyle = '#8a93a6'; g.fillText('No animated properties on this layer.', 20, 30); return; }
    const pad = 30, W = cv.width - pad * 2, H = cv.height - pad * 2;
    const tMax = Math.max(state.duration, ...tracks.flatMap(t => t.keys.map(k => k.t)), 0.001);
    g.strokeStyle = '#232a38';
    for (let i = 0; i <= 4; i++) { const y = pad + H * i / 4; g.beginPath(); g.moveTo(pad, y); g.lineTo(pad + W, y); g.stroke(); }
    const colors = ['#00e5a0', '#ffc46b', '#ff5ea8', '#6bb7ff', '#b48cff'];
    tracks.forEach((tr, ti) => {
      const flat = tr.keys.map(k => ({ t: k.t, v: Array.isArray(k.v) ? k.v[0] : Number(k.v) || 0 }));
      const vMin = Math.min(...flat.map(f => f.v)), vMax = Math.max(...flat.map(f => f.v));
      const span = (vMax - vMin) || 1;
      g.strokeStyle = colors[ti % colors.length]; g.lineWidth = 1.6; g.beginPath();
      for (let px = 0; px <= W; px++) {
        const t = px / W * tMax;
        const v = propValue({ keys: tr.keys.map((k, i) => ({ ...k, v: Array.isArray(k.v) ? k.v[0] : k.v })) }, t);
        const y = pad + H - ((v - vMin) / span) * H;
        px ? g.lineTo(pad + px, y) : g.moveTo(pad + px, y);
      }
      g.stroke();
      g.fillStyle = colors[ti % colors.length];
      g.fillText(`${tr.path || 'opacity'}  [${round(vMin, 2)} … ${round(vMax, 2)}]`, pad, 16 + ti * 13);
      for (const f of flat) {
        const x = pad + f.t / tMax * W, y = pad + H - ((f.v - vMin) / span) * H;
        g.beginPath(); g.moveTo(x, y - 3); g.lineTo(x + 3, y); g.lineTo(x, y + 3); g.lineTo(x - 3, y); g.closePath(); g.fill();
      }
    });
    g.strokeStyle = 'rgba(255,255,255,.35)';
    const px = pad + state.time / tMax * W;
    g.beginPath(); g.moveTo(px, pad); g.lineTo(px, pad + H); g.stroke();
  }
}

/* ══════════════════════════════ panels ══════════════════════════════ */

function wirePanels() {
  // panels are re-rendered wholesale by redraw(); nothing to attach globally
  renderLayerList(state, api);
}

/* ══════════════════════════ command palette ══════════════════════════ */

let palItems = [], palVisible = [], palIdx = 0;

function paletteCommands() {
  const cmds = [
    { label: 'Add text layer', hint: 'T', run: () => api.addLayer('text') },
    { label: 'Add shape layer', hint: 'S', run: () => api.addLayer('shape', { shapeType: 'rect' }) },
    { label: 'Add solid', hint: 'D', run: () => api.addLayer('shape', { shapeType: 'solid', width: state.project.comp.width, height: state.project.comp.height }) },
    { label: 'Duplicate selected', run: () => api.duplicateSelected() },
    { label: 'Delete selected', hint: 'Del', run: () => api.deleteSelected() },
    { label: 'Play / pause', hint: 'Space', run: () => play() },
    { label: 'Go to start', hint: 'Home', run: () => { play(true); setTime(0); } },
    { label: 'Go to end', hint: 'End', run: () => { play(true); setTime(state.duration); } },
    { label: 'Toggle HUD', hint: 'H', run: () => $('#btn-hud')?.click() },
    { label: 'Run benchmark (steady state)', run: () => runBenchmark() },
    { label: 'Toggle auto-key', hint: 'K', run: () => $('#tl-autokey')?.click() },
    { label: 'Quality: draft proxy', run: () => $$('#quality-seg button')[0]?.click() },
    { label: 'Quality: exact full res', run: () => $$('#quality-seg button')[1]?.click() },
    { label: 'Save project (.fz.json)', hint: '⌘S', run: () => saveProject() },
    { label: 'Open project…', run: () => $('#file-input')?.click() },
    { label: 'Export current frame (PNG)', hint: '⌘E', run: () => exportFrame() },
    { label: 'Export video (WebM, realtime capture)', run: () => exportVideo() },
    { label: 'Undo', hint: '⌘Z', run: () => doUndo() },
    { label: 'Redo', hint: '⌘⇧Z', run: () => doRedo() },
    ...COMP_PRESETS.map(c => ({ label: `Comp size → ${c.label}`, run: async () => { pushUndo(); state.project.comp.width = c.w; state.project.comp.height = c.h; await attachRenderer(); redraw(); } })),
  ];
  for (const fx of EFFECT_LIST) cmds.push({ label: `Add effect: ${fx.name}`, hint: fx.category, run: () => api.addEffect(fx.id) });
  for (const f of state.registry?.families() || []) cmds.push({ label: `Typeface → ${f}`, run: () => api.setFont(f) });
  for (const l of state.project.layers) cmds.push({ label: `Select layer: ${l.name}`, run: () => api.select(l.id) });
  return cmds;
}

function wirePalette() {
  const root = $('#palette'), input = $('#pal-input'), out = $('#pal-results');
  const open = () => { root?.classList.remove('hidden'); palItems = paletteCommands(); palIdx = 0; if (input) { input.value = ''; input.focus(); } drawPal(''); };
  const close = () => root?.classList.add('hidden');
  $('#btn-palette')?.addEventListener('click', open);
  input?.addEventListener('input', () => { palIdx = 0; drawPal(input.value); });
  input?.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); palIdx = Math.min(palVisible.length - 1, palIdx + 1); drawPal(input.value); }
    if (e.key === 'ArrowUp') { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); drawPal(input.value); }
    if (e.key === 'Enter') { e.preventDefault(); runPal(palIdx); close(); }
  });
  root?.addEventListener('click', e => { if (e.target === root) close(); });
  window.__openPalette = open;

  function drawPal(q) {
    if (!out) return;
    const query = (q || '').trim().toLowerCase();
    // `palVisible` is the list the user actually sees, and it is the list every
    // index refers to. Indexing the unfiltered `palItems` with a visible-list
    // index runs the wrong command as soon as the user types a query.
    const list = query ? palItems.filter(c => c.label.toLowerCase().includes(query)) : palItems;
    palVisible = list.slice(0, 60);
    palIdx = clamp(palIdx, 0, Math.max(0, palVisible.length - 1));
    out.textContent = '';
    if (!palVisible.length) { out.append(el('div', { class: 'pal-empty' }, 'No matching command.')); return; }
    palVisible.forEach((c, i) => {
      const row = el('div', { class: 'pal-row' + (i === palIdx ? ' sel' : '') });
      row.append(el('span', { class: 'pal-l' }, c.label));
      if (c.hint) row.append(el('span', { class: 'pal-h' }, c.hint));
      row.addEventListener('mouseenter', () => { palIdx = i; drawPal(q); });
      row.addEventListener('click', () => { runPal(i); close(); });
      out.append(row);
    });
    out.dataset.q = q;
    out.scrollTop = 0;
  }
  function runPal(i) {
    const c = palVisible[i];
    if (!c) return;
    try { c.run(); } catch (e) { toast(`Command failed: ${e.message}`, 'err'); }
  }
}

/* ══════════════════════════════ media: video & audio ══════════════════════════════
   Decoding happens at IMPORT time (file pick / drop = a user gesture, so the
   AudioContext is allowed to start). The render loop only ever drawImage()s an
   already-decoded surface and never waits on a decoder mid-frame. */

const media = { ctx: null, master: null, voices: [], streamDest: null };

function actx() {
  if (!media.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    media.ctx = new AC();
    media.master = media.ctx.createGain();
    media.master.gain.value = 1;
    media.master.connect(media.ctx.destination);
    if (media.streamDest) media.master.connect(media.streamDest);
  }
  if (media.ctx.state === 'suspended') media.ctx.resume().catch(() => { });
  return media.ctx;
}
const assetById = (id) => (state.project.assets || []).find(a => a.id === id) || null;
const assetMap = () => new Map((state.project.assets || []).map(a => [a.id, a]));

/** Min/max envelope per bucket — what a timeline waveform actually shows. */
function computePeaks(buffer, buckets = 900) {
  const ch = buffer.getChannelData(0);
  const per = Math.max(1, Math.floor(ch.length / buckets));
  const peaks = new Array(buckets);
  for (let b = 0; b < buckets; b++) {
    let mx = 0;
    const start = b * per, end = Math.min(ch.length, start + per);
    for (let i = start; i < end; i += 4) { const v = Math.abs(ch[i]); if (v > mx) mx = v; }
    peaks[b] = mx;
  }
  return peaks;
}

/** Keep every video element and audio voice locked to the transport clock. */
function syncMediaToTransport() {
  const t = state.time;
  for (const L of state.project.layers) {
    if (L.type !== 'media') continue;
    const a = assetById(L.assetId);
    if (!a || a.kind !== 'video' || !a.video) continue;
    const want = clamp(t - (L.inPoint || 0) + (L.mediaOffset || 0), 0, Math.max(0, (a.duration || 0) - 0.001));
    const v = a.video;
    if (state.playing) {
      if (v.paused) v.play().catch(() => { });
      // drift correction: small errors ride out, big ones (seek, stall) snap
      if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
    } else if (Math.abs(v.currentTime - want) > 0.02) {
      v.currentTime = want;
    }
    L.mediaFrame = v.currentTime;
  }
}

function startAudioVoices() {
  stopAudioVoices();
  const ctx = actx(); if (!ctx) return;
  for (const L of state.project.layers) {
    if (L.type !== 'media' || L.mute) continue;
    const a = assetById(L.assetId);
    if (!a || a.kind !== 'audio' || !a.buffer) continue;
    const off = state.time - (L.inPoint || 0) + (L.mediaOffset || 0);
    if (off < 0 || off >= a.duration) continue;
    const src = ctx.createBufferSource();
    src.buffer = a.buffer;
    const g = ctx.createGain();
    g.gain.value = clamp(L.volume ?? 1, 0, 4);
    src.connect(g); g.connect(media.master);
    src.start(0, off);
    media.voices.push(src);
  }
  state.audioVoices = media.voices.length;
}
function stopAudioVoices() {
  for (const v of media.voices) { try { v.stop(); } catch { } }
  media.voices = [];
  state.audioVoices = 0;
}

/* ══════════════════════════════ IO ══════════════════════════════ */

function wireIO() {
  $$('#io-seg button').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.io;
    if (k === 'save') saveProject();
    else if (k === 'open') $('#file-input')?.click();
    else if (k === 'export') exportFrame();
  }));
  $('#file-input')?.addEventListener('change', async e => {
    for (const f of e.target.files || []) await ingestFile(f);
    e.target.value = '';
  });
  $('#btn-clearance')?.addEventListener('click', showClearance);
}

function saveProject() {
  const text = serialize(state.project);
  const blob = new Blob([text], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${state.project.name || 'project'}.fz.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  state.dirty = false; const d = $('#proj-dirty'); if (d) d.style.opacity = '.25';
  toast(`Saved ${state.project.name}.fz.json (${(text.length / 1024).toFixed(1)} KB)`, 'ok');
}

async function ingestFile(file) {
  if (/\.(json|fz)$/i.test(file.name)) {
    const text = await file.text();
    const { project, error } = deserialize(text);
    if (error) { toast(`Cannot open: ${error}`, 'err'); return; }
    pushUndo();
    state.project = project;
    state.selected = project.layers[0]?.id || null;
    state.duration = projectDuration(project);
    state.time = 0;
    await attachRenderer();
    setTime(0); redraw();
    toast(`Opened ${project.name} — ${project.layers.length} layers`, 'ok');
    return;
  }
  if (/^video\//.test(file.type)) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url; video.muted = true; video.preload = 'auto'; video.playsInline = true;
    await new Promise((res, rej) => {
      video.onloadedmetadata = () => res();
      video.onerror = () => rej(new Error('cannot decode this video'));
      setTimeout(() => rej(new Error('video metadata timeout')), 15000);
    });
    const asset = { id: uid('a'), name: file.name, kind: 'video', url, video, duration: video.duration || 0, width: video.videoWidth || 640, height: video.videoHeight || 360, meta: `${video.videoWidth}×${video.videoHeight} · ${(video.duration || 0).toFixed(1)}s` };
    state.project.assets = state.project.assets || [];
    state.project.assets.push(asset);
    redraw(); toast(`Imported ${file.name} (${asset.meta})`, 'ok');
    return;
  }
  if (/^audio\//.test(file.type)) {
    const ctx = actx();
    if (!ctx) { toast('This browser has no Web Audio — audio import unavailable', 'err'); return; }
    const buf = await file.arrayBuffer();
    let audio;
    try { audio = await ctx.decodeAudioData(buf); }
    catch (e) { toast(`Cannot decode ${file.name}`, 'err'); return; }
    const asset = { id: uid('a'), name: file.name, kind: 'audio', buffer: audio, duration: audio.duration, peaks: computePeaks(audio), meta: `${audio.duration.toFixed(1)}s · ${audio.sampleRate}Hz` };
    state.project.assets = state.project.assets || [];
    state.project.assets.push(asset);
    redraw(); toast(`Imported ${file.name} (${asset.meta})`, 'ok');
    return;
  }
  if (/^image\//.test(file.type)) {
    const bitmap = await createImageBitmap(file);   // import only — NOT in the render loop
    const asset = { id: uid('a'), name: file.name, kind: 'image', bitmap, width: bitmap.width, height: bitmap.height, meta: `${bitmap.width}×${bitmap.height}` };
    state.project.assets = state.project.assets || [];
    state.project.assets.push(asset);
    redraw(); toast(`Imported ${file.name}`, 'ok');
    $$('#left-tabs button')[1]?.click();
    return;
  }
  toast(`${file.type || file.name}: video/audio import is a later stage — decoding is not wired yet`, 'warn');
}

async function exportFrame() {
  // Export always runs at full comp resolution, whatever the preview proxy is.
  const prevQ = state.quality;
  if (prevQ !== 'exact') { state.quality = 'exact'; await attachRenderer(); }
  // Take the renderer AFTER any hand-off: attachRenderer destroys the old one,
  // and reading back from a destroyed renderer yields nothing.
  const r = state.renderer;
  if (!r || !r.compositor) { if (prevQ !== 'exact') state.quality = prevQ; toast('Export failed — renderer unavailable', 'err'); return; }
  renderOnce(performance.now());                    // guarantee the frame matches state.time
  const url = await r.toDataURL('image/png');
  if (prevQ !== 'exact') { state.quality = prevQ; await attachRenderer(); }
  if (!url) { toast('Export failed — no readback', 'err'); return; }
  const frame = Math.round(state.time * (state.project.comp.fps || 30));
  const a = el('a', { href: url, download: `${state.project.name || 'frame'}-f${frame}.png` });
  document.body.append(a); a.click(); a.remove();
  toast(`Exported frame ${tc(state.time, state.project.comp.fps)} at ${state.project.comp.width}×${state.project.comp.height}`, 'ok');
}

/**
 * Record the comp to WebM in real time: the viewport canvas as a stream plus
 * the audio master bus. Honest about what it is — a realtime capture, not an
 * offline encoder — and labelled as such in the UI.
 */
async function exportVideo() {
  const canvas = $('#viewport');
  if (!canvas || !canvas.captureStream) { toast('This browser cannot capture a canvas stream', 'err'); return; }
  const fps = state.project.comp.fps || 30;
  const stream = canvas.captureStream(fps);
  const ctx = actx();
  if (ctx) {
    media.streamDest = ctx.createMediaStreamDestination();
    media.master.connect(media.streamDest);
    for (const tr of media.streamDest.stream.getAudioTracks()) stream.addTrack(tr);
  }
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  if (!mime) { toast('MediaRecorder/WebM unavailable here', 'err'); return; }
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(res => { rec.onstop = res; });

  toast(`Recording ${state.duration}s in real time…`, 'info');
  play(true); setTime(0);
  await new Promise(r => setTimeout(r, 120));
  rec.start(250);
  play();                                   // start the transport
  const t0 = performance.now();
  await new Promise(res => {
    const wait = () => {
      if (state.time >= state.duration - 1e-6 || performance.now() - t0 > (state.duration + 2) * 1000) return res();
      requestAnimationFrame(wait);
    };
    wait();
  });
  play(true);
  rec.stop();
  await done;
  if (media.streamDest) { try { media.master.disconnect(media.streamDest); } catch { } media.streamDest = null; }
  const blob = new Blob(chunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `${state.project.name || 'export'}-${state.project.comp.width}x${state.project.comp.height}.webm` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  toast(`Exported ${(blob.size / 1048576).toFixed(1)} MB WebM · ${state.duration}s @ ${fps}fps`, 'ok');
}

function showClearance() {
  const reg = state.registry;
  const box = $('#modal-box'), root = $('#modal-root');
  if (!box || !root) return;
  box.textContent = '';
  const rows = [];
  for (const family of reg.families()) {
    const spec = reg.spec(family) || {};
    for (const script of ['latin', 'arabic', 'persian']) {
      const cov = reg.coverage?.(family, script);
      if (cov == null) continue;
      rows.push({ family, script, cov });
    }
  }
  box.append(
    el('h3', {}, 'Font clearance report'),
    el('p', { class: 'note' }, 'Every bundled face is SIL OFL 1.1 — cleared for video, broadcast and embedding. Coverage below is measured from the actual font tables, not from metadata guesses.'),
    el('div', { class: 'clr' },
      el('div', { class: 'clr-h' }, el('span', {}, 'family'), el('span', {}, 'script'), el('span', {}, 'coverage')),
      ...rows.map(r => el('div', { class: 'clr-r' },
        el('span', {}, r.family), el('span', {}, r.script),
        el('span', { class: r.cov > 0.98 ? 'good' : r.cov > 0.5 ? 'warn' : 'bad' }, `${(r.cov * 100).toFixed(0)}%`))),
    ),
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn-sm', onclick: () => root.classList.add('hidden') }, 'Close')),
  );
  root.classList.remove('hidden');
}

/* ══════════════════════════════ undo ══════════════════════════════ */

function doUndo() {
  const s = undo.undo(snapshot(state.project));
  if (!s) { toast('Nothing to undo', 'info'); return; }
  restore(state.project, s);
  state.duration = projectDuration(state.project);
  if (!byId(state.selected)) state.selected = state.project.layers.at(-1)?.id || null;
  redraw(); toast('Undo', 'info');
}
function doRedo() {
  const s = undo.redo(snapshot(state.project));
  if (!s) { toast('Nothing to redo', 'info'); return; }
  restore(state.project, s);
  state.duration = projectDuration(state.project);
  redraw(); toast('Redo', 'info');
}

/* ══════════════════════════════ shortcuts ══════════════════════════════ */

function wireShortcuts() {
  window.addEventListener('keydown', e => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); window.__openPalette?.(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); exportFrame(); return; }
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && e.key === '1') { e.preventDefault(); $$('#quality-seg button')[0]?.click(); return; }
    if (mod && e.key === '2') { e.preventDefault(); $$('#quality-seg button')[1]?.click(); return; }
    if (typing || mod) return;

    switch (e.key) {
      case ' ': e.preventDefault(); play(); break;
      case 'Home': play(true); setTime(0); break;
      case 'End': play(true); setTime(state.duration); break;
      case 'ArrowLeft': play(true); setTime(state.time - (e.shiftKey ? 1 : 1 / (state.project.comp.fps || 30))); break;
      case 'ArrowRight': play(true); setTime(state.time + (e.shiftKey ? 1 : 1 / (state.project.comp.fps || 30))); break;
      case 'PageUp': api.reorder(1); break;
      case 'PageDown': api.reorder(-1); break;
      case 'Delete': case 'Backspace': api.deleteSelected(); break;
      case 't': case 'T': api.addLayer('text'); break;
      case 's': case 'S': api.addLayer('shape', { shapeType: 'rect' }); break;
      case 'd': case 'D': api.addLayer('shape', { shapeType: 'solid', width: state.project.comp.width, height: state.project.comp.height }); break;
      case 'h': case 'H': $('#btn-hud')?.click(); break;
      case 'l': case 'L': $('#btn-loop')?.click(); break;
      case 'k': case 'K': $('#tl-autokey')?.click(); break;
      case 'j': case 'J': play(true); gotoKey(-1); break;
      case ';': play(true); gotoKey(1); break;
      case 'v': case 'V': $('#viewport')?.focus(); break;
      case 'Escape': $('#modal-root')?.classList.add('hidden'); break;
    }
  });
}

/* ══════════════════════════════ drag & drop ══════════════════════════════ */

function wireDragDrop() {
  const hint = $('#drop-hint');
  let depth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); depth++; hint?.classList.remove('hidden'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('dragleave', e => { e.preventDefault(); if (--depth <= 0) { depth = 0; hint?.classList.add('hidden'); } });
  window.addEventListener('drop', async e => {
    e.preventDefault(); depth = 0; hint?.classList.add('hidden');
    for (const f of e.dataTransfer?.files || []) await ingestFile(f);
  });
}

/* ══════════════════════════════ toasts ══════════════════════════════ */

function toast(msg, kind = 'info') {
  const host = $('#toasts');
  if (!host) { console.info(`[${kind}] ${msg}`); return; }
  const n = el('div', { class: `toast ${kind}` }, msg);
  host.append(n);
  requestAnimationFrame(() => n.classList.add('in'));
  setTimeout(() => { n.classList.remove('in'); setTimeout(() => n.remove(), 320); }, kind === 'err' ? 6000 : 3200);
}

/* ══════════════════════════════ go ══════════════════════════════ */

// Exposed for the smoke test and for debugging from the console.
window.__FZ__ = {
  state, api, undo, setTime, play, redraw, toast,
  resolveScene: () => resolveScene(state.project, state.time),
  importFile: ingestFile, exportVideo, exportFrame,
};

boot();
