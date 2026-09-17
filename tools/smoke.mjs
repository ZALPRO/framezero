/* FrameZero application smoke test — drives the REAL index.html in a browser.
 *
 * The unit suites prove the engine; this proves the product boots and that a
 * user can actually do things. It asserts through window.__FZ__ and through the
 * DOM, and it fails loudly on any page error or console error.
 *
 * Usage: node tools/smoke.mjs [--headed]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';

const OUT = '/home/user/app/test-results';
mkdirSync(OUT, { recursive: true });
const headed = process.argv.includes('--headed');

const browser = await chromium.launch({
  headed,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + (e.stack || e.message)));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
page.on('requestfailed', r => {
  // a failed favicon or analytics ping must not fail the suite
  if (!/favicon|analytics/.test(r.url())) errors.push(`REQFAIL: ${r.url()} — ${r.failure()?.errorText}`);
});

const results = [];
const T = (group, name, ok, detail = '') => {
  results.push({ group, name, ok: ok === null ? null : !!ok, detail: String(detail ?? '') });
  const mark = ok === null ? '○' : ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${name}${detail ? `\n      \x1b[2m${String(detail).slice(0, 220)}\x1b[0m` : ''}`);
};

await page.goto('http://127.0.0.1:4173/index.html', { waitUntil: 'load' });

/* ── boot ── */
console.log('\n\x1b[1m▌ 1. boot\x1b[0m');
let booted = false;
try {
  await page.waitForFunction(() => !!window.__FZ__ && !!window.__FZ__.state.renderer, null, { timeout: 60000 });
  booted = true;
} catch (e) { /* reported below */ }
T('1. boot', 'the app boots and exposes its controller', booted, booted ? 'window.__FZ__ live' : 'timed out waiting for the renderer');
if (!booted) {
  const log = await page.evaluate(() => document.querySelector('#boot-log')?.textContent || '<none>');
  T('1. boot', 'boot log', false, log);
}
await page.waitForTimeout(700);
const bootGone = await page.evaluate(() => {
  const b = document.querySelector('#boot');
  return !b || b.classList.contains('gone');
});
T('1. boot', 'the boot overlay clears itself', bootGone);
T('1. boot', 'no errors during boot', errors.length === 0, errors.slice(0, 3).join(' | '));

const S = () => page.evaluate(() => window.__FZ__.state);
const A = (fn, ...args) => page.evaluate(([src, a]) => {
  const f = new Function('FZ', 'args', `return (${src})(FZ, ...args)`);
  return f(window.__FZ__, a);
}, [fn.toString(), args]);

/* ── shell is populated ── */
console.log('\n\x1b[1m▌ 2. shell\x1b[0m');
const st = await S();
T('2. shell', 'a backend was chosen and reported', !!st.backendKind, `${st.backendKind}${st.caps?.software ? ' (software rasteriser)' : ''}`);
T('2. shell', 'the backend badge names it', (await page.textContent('#backend-name') || '').length > 1, await page.textContent('#backend-name'));
T('2. shell', 'fonts are registered', await page.evaluate(() => window.__FZ__.state.registry.families().length) >= 4,
  `${await page.evaluate(() => window.__FZ__.state.registry.families().length)} families: ${await page.evaluate(() => window.__FZ__.state.registry.families().join(', '))}`);
T('2. shell', 'the demo project has layers', st.project.layers.length === 4, `${st.project.layers.length} layers`);
const rows = await page.locator('#layer-list .l-row').count();
T('2. shell', 'the layer list rendered one row per layer', rows === st.project.layers.length, `${rows} rows`);
T('2. shell', 'the inspector is populated', (await page.locator('#inspector .f-sec').count()) >= 2, `${await page.locator('#inspector .f-sec').count()} sections`);
T('2. shell', 'the effects browser lists every effect', (await page.locator('#fx-list .fx-row').count()) >= 16, `${await page.locator('#fx-list .fx-row').count()} rows`);
T('2. shell', 'the font library lists families', (await page.locator('#font-list .fo-row').count()) >= 4);
T('2. shell', 'the timeline is drawn', await page.evaluate(() => {
  const t = document.querySelector('#tl-tracks');
  return !!t && t.width > 100 && t.getContext('2d').getImageData(0, 0, t.width, t.height).data.some(v => v > 0);
}));
T('2. shell', 'timecode shows a real value', /^\d\d:\d\d:\d\d:\d\d$/.test((await page.textContent('#tl-tc') || '').trim()), await page.textContent('#tl-tc'));

/* ── the viewport actually renders ── */
console.log('\n\x1b[1m▌ 3. viewport renders\x1b[0m');
const ink = async () => page.evaluate(() => {
  const c = document.querySelector('#viewport');
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
  return { n, px: d.length / 4, w: c.width, h: c.height };
});
const hash = async () => page.evaluate(() => {
  const c = document.querySelector('#viewport');
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261; for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
});
const i0 = await ink();
T('3. viewport renders', 'the comp painted the whole frame', i0.n > i0.px * 0.5, `${i0.n}/${i0.px}px @ ${i0.w}×${i0.h}`);
T('3. viewport renders', 'draft quality renders a proxy, not full res', i0.w < st.project.comp.width || st.project.comp.width <= 900,
  `rendered ${i0.w}px wide for a ${st.project.comp.width}px comp (scale ${st.renderScale})`);

const h0 = await hash();
await page.evaluate(() => window.__FZ__.setTime(2.0));
await page.waitForTimeout(220);
const h1 = await hash();
T('3. viewport renders', 'scrubbing to t=2 changes the picture (animation is live)', h0 !== h1, `${h0} → ${h1}`);

/* ── transport ── */
console.log('\n\x1b[1m▌ 4. transport\x1b[0m');
await page.evaluate(() => window.__FZ__.setTime(0));
await page.keyboard.press('Space');
await page.waitForTimeout(450);
let s2 = await S();
T('4. transport', 'Space starts playback', s2.playing === true);
T('4. transport', 'the play button swaps to the pause icon', (await page.getAttribute('#btn-play svg', 'data-icon')) === 'pause');
const tA = s2.time;
await page.waitForTimeout(400);
s2 = await S();
T('4. transport', 'time advances while playing', s2.time > tA, `${tA.toFixed(3)} → ${s2.time.toFixed(3)}`);
await page.keyboard.press('Space');
s2 = await S();
T('4. transport', 'Space stops playback', s2.playing === false);
await page.click('#btn-start');
T('4. transport', 'go-to-start returns to 0', (await S()).time === 0);
await page.click('#btn-end');
T('4. transport', 'go-to-end reaches the duration', Math.abs((await S()).time - (await S()).duration) < 1e-6, `${(await S()).time}`);
await page.evaluate(() => window.__FZ__.setTime(0));
await page.click('#btn-loop');
T('4. transport', 'loop toggles', (await page.evaluate(() => document.querySelector('#btn-loop').classList.contains('on'))) === false);
await page.click('#btn-loop');

/* ── editing: layers, properties, keyframes ── */
console.log('\n\x1b[1m▌ 5. editing\x1b[0m');
const n0 = (await S()).project.layers.length;
await page.click('#btn-add-text');
await page.waitForTimeout(120);
let s3 = await S();
T('5. editing', 'add-text creates and selects a layer', s3.project.layers.length === n0 + 1 && !!s3.selected,
  `${n0} → ${s3.project.layers.length}; selected=${s3.selected?.slice(0, 8)}`);
T('5. editing', 'the new layer is a text layer centred in the comp',
  s3.project.layers.at(-1).type === 'text' && s3.project.layers.at(-1).transform.position[0] === Math.round(s3.project.comp.width / 2),
  JSON.stringify(s3.project.layers.at(-1).transform.position));

await page.evaluate(() => {
  const FZ = window.__FZ__;
  FZ.api.setText('text', 'Hello');
  FZ.api.setText('size', 90);
});
s3 = await S();
const L = s3.project.layers.find(l => l.id === s3.selected);
T('5. editing', 'typing into the model updates the layer', L.text.text === 'Hello' && L.text.size === 90, `${L.text.text} @ ${L.text.size}px`);

// a static property becomes a track when auto-key is on
await page.click('#tl-autokey');
await page.evaluate(() => window.__FZ__.setTime(0));
await page.evaluate(() => window.__FZ__.api.setProp('transform.position.0', 200));
await page.evaluate(() => window.__FZ__.setTime(1));
await page.evaluate(() => window.__FZ__.api.setProp('transform.position.0', 900));
s3 = await S();
const L2 = s3.project.layers.find(l => l.id === s3.selected);
const pos = L2.transform.position;
T('5. editing', 'auto-key turns a static property into a track', Array.isArray(pos.keys) && pos.keys.length === 2,
  Array.isArray(pos.keys) ? pos.keys.map(k => `${k.t}s→${JSON.stringify(k.v)}`).join(' ') : JSON.stringify(pos));
T('5. editing', 'the keyframe diamond lights up', await page.evaluate(() =>
  window.__FZ__.api.isKeyed('transform.position.0')));
await page.evaluate(() => window.__FZ__.setTime(0.5));
const mid = await page.evaluate(() => window.__FZ__.api.getProp('transform.position'));
T('5. editing', 'the track interpolates between keys', mid[0] > 200 && mid[0] < 900, `x@0.5s = ${mid[0]}`);
await page.click('#tl-autokey');

// keyframes move the picture
const hk0 = await hash();
await page.evaluate(() => window.__FZ__.setTime(1));
await page.waitForTimeout(200);
T('5. editing', 'a keyframed layer visibly moves', hk0 !== await hash());

// effects
await page.evaluate(() => window.__FZ__.api.addEffect('gaussianBlur'));
s3 = await S();
const L3 = s3.project.layers.find(l => l.id === s3.selected);
T('5. editing', 'an effect attaches to the selected layer', L3.effects.length === 1 && L3.effects[0].id === 'gaussianBlur');
await page.evaluate(() => window.__FZ__.api.setEffectParam(0, 'radius', 22));
s3 = await S();
T('5. editing', 'effect params are writable', s3.project.layers.find(l => l.id === s3.selected).effects[0].params.radius === 22);
await page.evaluate(() => window.__FZ__.api.toggleEffect(0));
T('5. editing', 'an effect can be disabled without deleting it', await page.evaluate(() => {
  const FZ = window.__FZ__;
  const L = FZ.state.project.layers.find(l => l.id === FZ.state.selected);
  return L.effects[0].enabled === false;
}));
await page.evaluate(() => window.__FZ__.api.removeEffectAt(0));
T('5. editing', 'an effect can be removed', await page.evaluate(() => {
  const FZ = window.__FZ__;
  const L = FZ.state.project.layers.find(l => l.id === FZ.state.selected);
  return L.effects.length === 0;
}));

// delete + undo + redo
const before = (await S()).project.layers.length;
await page.evaluate(() => window.__FZ__.api.deleteSelected());
T('5. editing', 'delete removes the selected layer', (await S()).project.layers.length === before - 1);
await page.keyboard.press('Control+z');
await page.waitForTimeout(120);
T('5. editing', 'undo brings it back', (await S()).project.layers.length === before);
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(120);
T('5. editing', 'redo removes it again', (await S()).project.layers.length === before - 1);
await page.keyboard.press('Control+z');
await page.waitForTimeout(120);

// masks & track mattes through the real UI api
await page.evaluate(() => window.__FZ__.setTime(1.5));
const mkBefore = await hash();
await page.evaluate(() => window.__FZ__.api.addMask('ellipse'));
await page.waitForTimeout(250);
s3 = await S();
const mkLayer = s3.project.layers.find(l => l.id === s3.selected);
T('5. editing', 'add-mask creates a mask on the selected layer', mkLayer.masks?.items?.length === 1, JSON.stringify(mkLayer.masks?.items?.[0] || null).slice(0, 90));
T('5. editing', 'the mask actually cuts the picture', mkBefore !== await hash(), `${mkBefore} → ${await hash()}`);
await page.evaluate(() => window.__FZ__.api.setMask(0, { w: 40, h: 40 }));
await page.waitForTimeout(250);
const mkAfterEdit = await hash();
const mkW = await page.evaluate(() => {
  const FZ = window.__FZ__;
  const L = FZ.state.project.layers.find(l => l.id === FZ.state.selected);
  return L.masks.items[0].w;
});
T('5. editing', 'editing a mask parameter re-renders', mkBefore !== mkAfterEdit && mkW === 40, `w=${mkW}, hash ${mkBefore} → ${mkAfterEdit}`);
// track matte: a second layer becomes the window for the first
const matteSetup = await page.evaluate(() => {
  const FZ = window.__FZ__;
  const ids = FZ.state.project.layers.map(l => l.id);
  const src = FZ.state.project.layers[FZ.state.project.layers.length - 2];
  FZ.api.setMatte({ source: src.id, mode: 'alpha', invert: false });
  const scene = FZ.resolveScene();
  const s = scene.layers.find(l => l.id === src.id);
  const c = scene.layers.find(l => l.id === FZ.state.selected);
  return { srcMatteOnly: !!s?.matteOnly, consMatte: c?.matte?.id === src.id };
});
T('5. editing', 'setting a track matte flags the source matteOnly in the resolved scene', matteSetup.srcMatteOnly && matteSetup.consMatte, JSON.stringify(matteSetup));
await page.waitForTimeout(250);
T('5. editing', 'the matte changes the picture', mkBefore !== await hash());
await page.evaluate(() => { window.__FZ__.api.setMatte(null); window.__FZ__.api.removeMask(0); });
await page.waitForTimeout(250);
T('5. editing', 'clearing matte + mask restores the layer', await page.evaluate(() => {
  const FZ = window.__FZ__;
  const L = FZ.state.project.layers.find(l => l.id === FZ.state.selected);
  return !L.matte && (L.masks?.items || []).length === 0 && FZ.resolveScene().layers.every(l => !l.matteOnly);
}));

// visibility / solo / lock
await page.evaluate(() => {
  const FZ = window.__FZ__; const id = FZ.state.project.layers[0].id;
  FZ.api.toggleVisible(id);
});
T('5. editing', 'visibility toggles', (await S()).project.layers[0].visible === false);
await page.evaluate(() => window.__FZ__.api.toggleVisible(window.__FZ__.state.project.layers[0].id));
await page.evaluate(() => { const FZ = window.__FZ__; FZ.api.toggleSolo(FZ.state.project.layers[1].id); });
const soloed = await page.evaluate(() => {
  const FZ = window.__FZ__;
  const scene = FZ.resolveScene();
  return scene.layers.map(l => l.name);
});
T('5. editing', 'solo isolates one layer in the resolved scene', soloed.length === 1, soloed.join(','));
await page.evaluate(() => window.__FZ__.api.toggleSolo(window.__FZ__.state.project.layers[1].id));

/* ── quality + comp ── */
console.log('\n\x1b[1m▌ 6. quality & comp\x1b[0m');
await page.evaluate(() => window.__FZ__.setTime(0));
await page.click('#quality-seg button[data-q="exact"]');
await page.waitForTimeout(700);
let s4 = await S();
const ex = await ink();
T('6. quality & comp', 'exact quality renders the full comp resolution', ex.w === s4.project.comp.width, `${ex.w}×${ex.h} for a ${s4.project.comp.width}×${s4.project.comp.height} comp`);
await page.click('#quality-seg button[data-q="draft"]');
await page.waitForTimeout(700);
s4 = await S();
const dr = await ink();
T('6. quality & comp', 'draft drops back to a proxy', dr.w <= ex.w && s4.quality === 'draft', `${dr.w}px @ scale ${s4.renderScale}`);

/* Proxy fidelity — the regression guard for the comp-space/device-space mixup.
   Scenes are authored in comp space; a proxy surface must show the SAME
   picture shrunken, not comp geometry drawn 1:1 onto a smaller canvas (which
   reads as an oversized, clipped comp and is invisible in exact mode, so only
   a draft↔exact comparison can catch it). */
await page.evaluate(() => {
  const c = document.querySelector('#viewport');
  window.__ex = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
});
const sim = await page.evaluate(() => {
  const c = document.querySelector('#viewport');
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  const ex = window.__ex; delete window.__ex;
  const sx = ex.width / c.width, sy = ex.height / c.height;
  let bad = 0, tot = 0;
  for (let y = 2; y < c.height - 2; y += 3) for (let x = 2; x < c.width - 2; x += 3) {
    const X = Math.min(ex.width - 1, Math.round(x * sx)), Y = Math.min(ex.height - 1, Math.round(y * sy));
    const di = (y * c.width + x) * 4, ei = (Y * ex.width + X) * 4;
    const diff = Math.abs(d.data[di] - ex.data[ei]) + Math.abs(d.data[di + 1] - ex.data[ei + 1]) + Math.abs(d.data[di + 2] - ex.data[ei + 2]);
    if (diff > 90) bad++;
    tot++;
  }
  return { bad, tot, ratio: bad / Math.max(1, tot) };
});
T('6. quality & comp', 'the draft proxy is the same picture as exact, just fewer pixels',
  sim.ratio < 0.06,
  `${(sim.ratio * 100).toFixed(1)}% of ${sim.tot} sampled pixels disagree (edge resampling only, if the proxy is faithful)`);

await page.selectOption('#comp-size', '1080x1080');
await page.waitForTimeout(700);
s4 = await S();
T('6. quality & comp', 'changing the comp size re-attaches the renderer', s4.project.comp.width === 1080 && s4.project.comp.height === 1080,
  `${s4.project.comp.width}×${s4.project.comp.height}`);
await page.selectOption('#comp-size', '1280x720');
await page.waitForTimeout(600);

/* ── HUD, palette, panels ── */
console.log('\n\x1b[1m▌ 7. HUD, palette, panels\x1b[0m');
await page.click('#btn-hud');
await page.waitForTimeout(400);
T('7. HUD, palette, panels', 'the HUD opens and reports fps', (await page.textContent('#hud-fps')) !== '—', await page.textContent('#hud-fps'));
T('7. HUD, palette, panels', 'the HUD reports a frame time', /ms/.test(await page.textContent('#hud-frametime')), await page.textContent('#hud-frametime'));
T('7. HUD, palette, panels', 'the sparkline drew something', await page.evaluate(() => {
  const c = document.querySelector('#hud-spark');
  return !!c && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some(v => v > 0);
}));
await page.click('#btn-hud');

await page.keyboard.press('Control+k');
await page.waitForTimeout(200);
T('7. HUD, palette, panels', '⌘K opens the command palette', await page.evaluate(() => !document.querySelector('#palette').classList.contains('hidden')));
await page.fill('#pal-input', 'bloom');
await page.waitForTimeout(150);
const palRows = await page.locator('#pal-results .pal-row').count();
const palFirst = (await page.locator('#pal-results .pal-row .pal-l').first().textContent() || '').trim();
T('7. HUD, palette, panels', 'the palette filters commands', palRows > 0 && palRows < 40, `${palRows} matches for “bloom” — first: “${palFirst}”`);
// Regression guard: Enter must run the row the user is LOOKING at. Indexing the
// unfiltered command list with a filtered-list index silently ran command #1.
const palBefore = await page.evaluate(() => ({
  n: window.__FZ__.state.project.layers.length,
  fx: (window.__FZ__.state.project.layers.find(l => l.id === window.__FZ__.state.selected)?.effects || []).map(e => e.id),
}));
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
const palAfter = await page.evaluate(() => ({
  hidden: document.querySelector('#palette').classList.contains('hidden'),
  n: window.__FZ__.state.project.layers.length,
  fx: (window.__FZ__.state.project.layers.find(l => l.id === window.__FZ__.state.selected)?.effects || []).map(e => e.id),
}));
T('7. HUD, palette, panels', 'Enter runs the highlighted command and closes the palette',
  palAfter.hidden && palAfter.fx.includes('bloom'), `effects ${JSON.stringify(palBefore.fx)} → ${JSON.stringify(palAfter.fx)}`);
T('7. HUD, palette, panels', 'Enter does not run some other command instead',
  palAfter.n === palBefore.n, `layer count ${palBefore.n} → ${palAfter.n} (unchanged means “Add text layer” was not mis-fired)`);

for (const [tab, pane] of [['assets', '#asset-list'], ['effects', '#fx-list'], ['fonts', '#font-list'], ['layers', '#layer-list']]) {
  await page.click(`#left-tabs button[data-tab="${tab}"]`);
  T('7. HUD, palette, panels', `left tab “${tab}” switches pane`, await page.evaluate(p => document.querySelector(p).closest('.tabpane').classList.contains('on'), pane));
}
for (const tab of ['inspect', 'type', 'axes', 'fx']) {
  await page.click(`#right-tabs button[data-tab="${tab}"]`);
  T('7. HUD, palette, panels', `right tab “${tab}” switches pane`, await page.evaluate(t =>
    document.querySelector(`.tabpane[data-pane="${t}"]`).classList.contains('on'), tab));
}
await page.click('#right-tabs button[data-tab="inspect"]');

/* ── clearance report + benchmark ── */
console.log('\n\x1b[1m▌ 8. reports\x1b[0m');
await page.click('#btn-clearance');
await page.waitForTimeout(300);
T('8. reports', 'the font clearance report opens with measured coverage', (await page.locator('#modal-box .clr-r').count()) > 0,
  `${await page.locator('#modal-box .clr-r').count()} family×script rows`);
await page.evaluate(() => document.querySelector('#modal-root').classList.add('hidden'));

await page.click('#btn-bench');
try {
  await page.waitForSelector('#modal-box .bm', { timeout: 90000 });
  const txt = await page.textContent('#modal-box .bm');
  T('8. reports', 'the benchmark reaches steady state and reports', /ms/.test(txt) && /fps/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 150));
} catch { T('8. reports', 'the benchmark reaches steady state and reports', false, 'timed out'); }
await page.evaluate(() => document.querySelector('#modal-root').classList.add('hidden'));

/* ── save / open round-trip through the real UI ── */
console.log('\n\x1b[1m▌ 9. save & reopen\x1b[0m');
const saved = await page.evaluate(() => {
  const FZ = window.__FZ__;
  return {
    json: JSON.stringify({ ...FZ.state.project, assets: [] }),
    layers: FZ.state.project.layers.length,
    name: FZ.state.project.name,
    comp: [FZ.state.project.comp.width, FZ.state.project.comp.height],
  };
});
const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
await page.evaluate(() => document.querySelector('#io-seg button[data-io="save"]').click());
const got = await dl;
T('9. save & reopen', 'Save produces a downloadable .fz.json', !!got, got ? got.suggestedFilename() : 'no download fired');
if (got) {
  T('9. save & reopen', 'the filename comes from the project name', got.suggestedFilename().startsWith(saved.name), got.suggestedFilename());
  T('9. save & reopen', 'the extension is not doubled by a stale name field', !/\.fz\.fz\./.test(got.suggestedFilename()), got.suggestedFilename());
}

const reopened = await page.evaluate(async (json) => {
  const mod = await import('/js/core/document.js');
  const r = mod.deserialize(json);
  if (r.error) return { error: r.error };
  return { layers: r.project.layers.length, comp: [r.project.comp.width, r.project.comp.height], ok: true };
}, saved.json);
T('9. save & reopen', 'the saved file reopens with the same layer count', reopened.ok && reopened.layers === saved.layers, JSON.stringify(reopened));

const exp = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
await page.evaluate(() => document.querySelector('#io-seg button[data-io="export"]').click());
const png = await exp;
T('9. save & reopen', 'Export downloads a PNG frame', !!png && /\.png$/.test(png.suggestedFilename()), png?.suggestedFilename() || 'no download');
if (png) {
  const buf = await readFile(await png.path());
  const isPng = buf.slice(1, 4).toString() === 'PNG';
  const w = isPng ? buf.readUInt32BE(16) : 0, h = isPng ? buf.readUInt32BE(20) : 0;
  T('9. save & reopen', 'the downloaded bytes are a real PNG', isPng, `${buf.length} bytes`);
  T('9. save & reopen', 'export renders the FULL comp, not the draft proxy',
    w === saved.comp[0] && h === saved.comp[1],
    `${w}×${h} exported for a ${saved.comp[0]}×${saved.comp[1]} comp (the on-screen proxy was ${dr.w}px)`);
}

/* ── shortcuts ── */
console.log('\n\x1b[1m▌ 10. keyboard\x1b[0m');
const nl = (await S()).project.layers.length;
await page.evaluate(() => document.querySelector('#viewport').focus());
await page.keyboard.press('t');
await page.waitForTimeout(150);
T('10. keyboard', 'T adds a text layer', (await S()).project.layers.length === nl + 1);
await page.keyboard.press('s');
await page.waitForTimeout(150);
T('10. keyboard', 'S adds a shape layer', (await S()).project.layers.length === nl + 2);
await page.keyboard.press('Delete');
await page.waitForTimeout(150);
T('10. keyboard', 'Delete removes the selection', (await S()).project.layers.length === nl + 1);
await page.keyboard.press('h');
await page.waitForTimeout(150);
T('10. keyboard', 'H toggles the HUD', await page.evaluate(() => document.querySelector('#hud').classList.contains('on')));
await page.keyboard.press('h');
await page.keyboard.press('Home');
T('10. keyboard', 'Home jumps to 0', (await S()).time === 0);

/* ── stability: a sustained playback session ── */
console.log('\n\x1b[1m▌ 11. stability\x1b[0m');
await page.evaluate(() => { window.__FZ__.setTime(0); window.__FZ__.state.history.length = 0; });
await page.keyboard.press('Space');
await page.waitForTimeout(3000);
await page.keyboard.press('Space');
const perf = await page.evaluate(() => {
  const h = window.__FZ__.state.history;
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] || 0; };
  const half = Math.floor(h.length / 2);
  return {
    n: h.length, median: med(h), first: med(h.slice(0, half)), second: med(h.slice(half)),
    max: h.length ? Math.max(...h) : 0, fps: window.__FZ__.state.fps,
  };
});
// "Playback produced frames" must be judged against this machine's own frame
// time, not a fixed count: 3s at 165ms/frame IS ~18 frames and is correct
// behaviour on a software rasteriser. Require at least half the frames the
// measured frame time allows (and at least a handful), which catches a stalled
// loop on any hardware without punishing slow hardware.
const allowed = 3000 / Math.max(perf.median, 1);
T('11. stability', 'a 3s playback session produced frames', perf.n >= Math.max(4, allowed * 0.5),
  `${perf.n} timed frames in 3s · ${perf.median.toFixed(0)}ms/frame allows ≈${allowed.toFixed(0)}`);
// A leak or an unbounded cache shows up as the second half getting slower than
// the first. That is a real regression signal; an absolute ms threshold is not,
// because it just measures whatever GPU the machine happens to have.
T('11. stability', 'frame time does not degrade across the session (no leak)',
  perf.second <= Math.max(perf.first * 1.6, perf.first + 25),
  `first half median ${perf.first.toFixed(1)}ms → second half ${perf.second.toFixed(1)}ms · peak ${perf.max.toFixed(1)}ms`);
T('11. stability', 'sustained playback throughput on this machine', null,
  `median ${perf.median.toFixed(1)}ms/frame ≈ ${(1000 / Math.max(perf.median, 1e-6)).toFixed(1)} fps · ${st.backendKind}${st.caps?.software ? ' (software rasteriser — no GPU in this sandbox)' : ''}`);

// idle: the rAF loop must not repaint when nothing changed
const idle0 = await page.evaluate(() => window.__FZ__.state.history.length);
await page.waitForTimeout(1200);
const idle1 = await page.evaluate(() => window.__FZ__.state.history.length);
T('11. stability', 'an idle editor renders zero extra frames', idle1 === idle0, `${idle1 - idle0} frames rendered during 1.2s idle`);
T('11. stability', 'no errors accumulated across the whole session', errors.length === 0, errors.slice(0, 3).join(' | '));

/* ── media: decode, sync, waveform, export ── */
console.log('\n\x1b[1m▌ 12. media\x1b[0m');
// a 1.0 s 440 Hz WAV, synthesised byte-by-byte and pushed through the REAL ingest path
const wavBytes = await page.evaluate(() => {
  const sr = 8000, n = sr;
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const ws = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * 440 * i / sr) * 12000, true);
  return Array.from(new Uint8Array(buf));
});
const wavInfo = await page.evaluate(async (bytes) => {
  const f = new File([new Uint8Array(bytes)], 'tone.wav', { type: 'audio/wav' });
  await window.__FZ__.importFile(f);
  const a = window.__FZ__.state.project.assets.at(-1);
  return { kind: a?.kind, duration: a?.duration, peaks: a?.peaks?.length, peakMax: Math.max(...(a?.peaks || [0])) };
}, wavBytes);
T('12. media', 'a WAV decodes at import with a measured envelope',
  wavInfo.kind === 'audio' && Math.abs(wavInfo.duration - 1) < 0.05 && wavInfo.peaks > 100 && wavInfo.peakMax > 0.2,
  JSON.stringify(wavInfo));

await page.evaluate(() => { const FZ = window.__FZ__; FZ.api.addAssetToComp(FZ.state.project.assets.at(-1)); });
const audLayer = await page.evaluate(() => { const L = window.__FZ__.state.project.layers.at(-1); return { type: L.type, kind: L.mediaKind }; });
T('12. media', 'an audio asset becomes a media layer', audLayer.type === 'media' && audLayer.kind === 'audio', JSON.stringify(audLayer));
const wave = await page.evaluate(() => {
  const c = document.querySelector('#tl-tracks');
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 120 && d[i] < 100) n++;
  return n;
});
T('12. media', 'the timeline draws the audio waveform', wave > 200, `${wave} waveform pixels`);

await page.evaluate(() => window.__FZ__.setTime(0));
await page.keyboard.press('Space'); await page.waitForTimeout(350);
const voicesOn = await page.evaluate(() => window.__FZ__.state.audioVoices);
await page.keyboard.press('Space'); await page.waitForTimeout(250);
const voicesOff = await page.evaluate(() => window.__FZ__.state.audioVoices);
T('12. media', 'playback starts an audio voice and stopping kills it', voicesOn === 1 && voicesOff === 0, `on=${voicesOn} off=${voicesOff}`);

// a REAL webm clip: recorded in-browser from an animated canvas, then imported
const vidInfo = await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 160; c.height = 90;
  const g = c.getContext('2d');
  const mime = ['video/webm;codecs=vp8', 'video/webm'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  if (!mime) return { error: 'MediaRecorder unavailable' };
  const rec = new MediaRecorder(c.captureStream(24), { mimeType: mime });
  const chunks = []; rec.ondataavailable = e => chunks.push(e.data);
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start();
  const t0 = performance.now();
  await new Promise(res => { const draw = () => {
    const t = (performance.now() - t0) / 1000;
    g.fillStyle = `hsl(${(t * 300) % 360}, 80%, 55%)`; g.fillRect(0, 0, 160, 90);
    g.fillStyle = '#fff'; g.fillRect(t * 130, 30, 20, 30);
    t < 1.2 ? requestAnimationFrame(draw) : res();
  }; draw(); });
  rec.stop(); await stopped;
  const f = new File([new Blob(chunks, { type: 'video/webm' })], 'clip.webm', { type: 'video/webm' });
  await window.__FZ__.importFile(f);
  const a = window.__FZ__.state.project.assets.at(-1);
  return { kind: a?.kind, duration: a?.duration, w: a?.width, h: a?.height };
});
T('12. media', 'a real WebM clip decodes at import (recorded in-browser)',
  vidInfo.kind === 'video' && vidInfo.duration > 0.5, JSON.stringify(vidInfo));

await page.evaluate(() => { const FZ = window.__FZ__; FZ.api.addAssetToComp(FZ.state.project.assets.at(-1)); });
await page.evaluate(() => window.__FZ__.setTime(0.1)); await page.waitForTimeout(500);
const vh0 = await hash();
await page.evaluate(() => window.__FZ__.setTime(0.9)); await page.waitForTimeout(700);
const vh1 = await hash();
T('12. media', 'scrubbing a video layer shows different decoded frames', vh0 !== vh1, `${vh0} → ${vh1}`);

// realtime WebM export of a short comp
await page.evaluate(() => { const FZ = window.__FZ__; FZ.state.project.comp.duration = 1.2; FZ.state.duration = 1.2; FZ.setTime(0); });
const vdl = page.waitForEvent('download', { timeout: 40000 }).catch(() => null);
await page.evaluate(() => window.__FZ__.exportVideo());
const vgot = await vdl;
T('12. media', 'Export video downloads a WebM', !!vgot && /\.webm$/.test(vgot.suggestedFilename()), vgot?.suggestedFilename() || 'no download');
if (vgot) {
  const b = await readFile(await vgot.path());
  T('12. media', 'the exported WebM carries real encoded bytes', b.length > 5000, `${b.length} bytes`);
}
await page.evaluate(() => { const FZ = window.__FZ__; FZ.state.project.comp.duration = 4; FZ.state.duration = 4; FZ.setTime(0); FZ.redraw(); });

// ── 16. identity: brand art + icon set (nothing emoji-shaped left in the chrome)
const ident = await page.evaluate(async () => {
  const mod = await import('./js/ui/icons.js');
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;
  const q = (sel) => [...document.querySelectorAll(sel)];
  const imgOk = (sel) => { const i = document.querySelector(sel); return !!i && i.complete && i.naturalWidth > 0; };
  return {
    iconCount: Object.keys(mod.ICONS).length,
    renders: ['play', 'pause', 'eye', 'trash', 'key', 'video'].every(n => typeof mod.iconSVG(n) === 'string' && mod.iconSVG(n).startsWith('<svg')),
    unknownIsSafe: mod.iconSVG('nope') === '',
    favicon: document.querySelector('link[rel=icon]')?.getAttribute('href') || '',
    logoLoaded: imgOk('.logo-img'),
    transportIcons: q('#transport button').filter(b => b.querySelector('svg')).length,
    transportTotal: q('#transport button').length,
    layerIcons: q('.l-row svg').length,
    chromeEmoji: q('#topbar, #left, #right, #timeline, #transport, .pane-head')
      .map(x => x.innerText).join('\n').split('\n').filter(l => emoji.test(l)),
  };
});
T('16. identity', 'the icon set ships a full range', ident.iconCount >= 30, `${ident.iconCount} icons`);
T('16. identity', 'iconSVG renders markup and fails safe on unknown names', ident.renders && ident.unknownIsSafe);
T('16. identity', 'the favicon points at the generated brand art', ident.favicon === 'brand/favicon.png', ident.favicon);
T('16. identity', 'the wordmark image is loaded', ident.logoLoaded);
T('16. identity', 'every transport button carries an icon', ident.transportIcons === ident.transportTotal, `${ident.transportIcons}/${ident.transportTotal}`);
T('16. identity', 'layer rows render svg icons', ident.layerIcons > 3, `${ident.layerIcons} svgs`);
T('16. identity', 'no emoji left anywhere in the chrome', ident.chromeEmoji.length === 0, JSON.stringify(ident.chromeEmoji.slice(0, 3)));

await page.screenshot({ path: `${OUT}/app.png`, fullPage: false });
await page.evaluate(() => { window.__FZ__.state.hudOn = true; document.querySelector('#hud')?.classList.add('on'); });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/app-hud.png` });

const passed = results.filter(r => r.ok === true).length;
const failed = results.filter(r => r.ok === false).length;
const info = results.filter(r => r.ok === null).length;
console.log(`\n\x1b[1m${failed ? '\x1b[31mFAILED' : '\x1b[32mALL PASS'}\x1b[0m — ${passed} passed, ${failed} failed, ${info} info`);
if (errors.length) { console.log(`\n\x1b[33m── errors (${errors.length}) ──\x1b[0m`); [...new Set(errors)].slice(0, 12).forEach(e => console.log('  ' + e.slice(0, 400))); }

await writeFile(`${OUT}/app.json`, JSON.stringify({
  suite: 'app', timestamp: new Date().toISOString(), passed, failed, info,
  errors: [...new Set(errors)], results,
}, null, 2));
console.log(`\n\x1b[2martefacts → ${OUT}/app.{json,png}\x1b[0m`);

await browser.close();
process.exit(failed > 0 || errors.some(e => e.startsWith('PAGEERROR')) ? 1 : 0);
