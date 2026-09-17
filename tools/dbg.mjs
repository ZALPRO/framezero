import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-sandbox','--disable-gpu-sandbox'] });
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERR', e.message));
p.on('console', m => { if (m.type() !== 'log') console.log(m.type(), m.text().slice(0,200)); });
await p.goto('http://127.0.0.1:4173/tests/render.html');
await p.waitForTimeout(500);
const out = await p.evaluate(async () => {
  const mod = await import('/js/render/compositor.js');
  const { Renderer } = mod;
  const c = document.createElement('canvas'); c.width = 320; c.height = 320;
  const r = new Renderer();
  await r.attach(c, { preferred: 'canvas2d', width: 320, height: 320, dpr: 1 });
  const solid = (id, wd, ht, pos, extra = {}) => ({ id, type: 'shape', visible: true, opacity: 1, blend: 'normal', width: wd, height: ht,
    resolved: { position: pos, scale: [1,1], rotation: 0, width: wd, height: ht, shape: { type: 'solid' }, style: { fill: '#ffffff', fillOpacity: 1 } }, effects: [], ...extra });
  const layers = [
    solid('t', 300, 300, [160,160], { matte: { id: 'm', mode: 'alpha', invert: false } }),
    Object.assign(solid('m', 100, 100, [160,160], {}), { matteOnly: true, resolved: Object.assign({}, solid('m',100,100,[160,160]).resolved, { shape: { type: 'ellipse' } }) }),
  ];
  // probe what updateLayerSource returns
  const comp = r.compositor;
  const probe = comp.updateLayerSource('x', document.createElement('canvas'));
  const info = { updateReturns: Object.keys(probe), hasCanvas: 'canvas' in probe };
  try { r.renderFrame({ width: 320, height: 320, background: 'transparent', layers }, 0, null); info.render = 'ok'; }
  catch (e) { info.render = 'THREW: ' + e.message; }
  return info;
});
console.log(JSON.stringify(out));
await b.close();
