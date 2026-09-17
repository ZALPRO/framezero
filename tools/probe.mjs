import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-sandbox','--disable-gpu-sandbox'] });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
await p.goto('http://127.0.0.1:4173/index.html');
await p.waitForFunction(() => !!window.__FZ__?.state.renderer, null, { timeout: 60000 });
await p.waitForTimeout(600);
const out = await p.evaluate(() => {
  const FZ = window.__FZ__;
  const c = document.querySelector('#viewport'); const g = c.getContext('2d', {willReadFrequently:true});
  const ink = (name, t) => {
    FZ.setTime(t);
    const L = FZ.state.project.layers.find(l => l.name === name);
    FZ.state.renderer.renderFrame(FZ.resolveScene(), t, FZ.state.registry);
    const a = g.getImageData(0,0,c.width,c.height).data;
    const v = L.visible; L.visible = false;
    FZ.state.renderer.renderFrame(FZ.resolveScene(), t, FZ.state.registry);
    const b2 = g.getImageData(0,0,c.width,c.height).data;
    L.visible = v;
    let d = 0; for (let i=0;i<a.length;i+=4) if (Math.abs(a[i]-b2[i])+Math.abs(a[i+1]-b2[i+1])+Math.abs(a[i+2]-b2[i+2])>24) d++;
    return d;
  };
  const times = [0, 0.2, 0.6, 1.0, 1.5, 2.5, 3.9];
  return {
    title: times.map(t => `${t}s:${ink('Title', t)}`),
    persian: times.map(t => `${t}s:${ink('Persian line', t)}`),
  };
});
console.log('Title      ', out.title.join('  '));
console.log('Persian    ', out.persian.join('  '));
await b.close();
