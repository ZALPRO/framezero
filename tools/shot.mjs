/* Deterministic beauty-shot + a hard check that every demo layer contributes ink. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('/home/user/app/test-results', { recursive: true });
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-sandbox','--disable-gpu-sandbox'] });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto('http://127.0.0.1:4173/index.html');
await p.waitForFunction(() => !!window.__FZ__?.state.renderer, null, { timeout: 60000 });
await p.waitForTimeout(900);

const regionInk = async (layerName) => p.evaluate((name) => {
  const FZ = window.__FZ__;
  const L = FZ.state.project.layers.find(l => l.name === name);
  if (!L) return null;
  const withL = FZ.resolveScene();
  const c = document.querySelector('#viewport');
  const g = c.getContext('2d', { willReadFrequently: true });
  const snap = () => g.getImageData(0, 0, c.width, c.height).data;
  const a = snap();
  const vis0 = L.visible; L.visible = false;
  FZ.state.renderer.renderFrame(FZ.resolveScene(), FZ.state.time, FZ.state.registry);
  const bdata = snap();
  L.visible = vis0;
  FZ.state.renderer.renderFrame(withL, FZ.state.time, FZ.state.registry);
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]-bdata[i]) + Math.abs(a[i+1]-bdata[i+1]) + Math.abs(a[i+2]-bdata[i+2]) > 24) diff++;
  return diff;
}, layerName);

await p.evaluate(() => window.__FZ__.setTime(1.5));
await p.waitForTimeout(300);
for (const n of ['BG gradient','Orb','Title','Persian line']) {
  const d = await regionInk(n);
  console.log(`${n.padEnd(14)} ink-diff when hidden: ${d} px ${d > 400 ? '✓ contributes' : '✗ INVISIBLE'}`);
}
await p.evaluate(() => window.__FZ__.setTime(1.5));
await p.waitForTimeout(250);
await p.locator('#center').screenshot({ path: 'test-results/comp.png' });
await p.screenshot({ path: 'test-results/fresh.png' });
console.log('errors:', errs.length ? errs.join(' | ') : 'none');
await b.close();
