import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-sandbox','--disable-gpu-sandbox'] });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
await p.goto('http://127.0.0.1:4173/index.html');
await p.waitForFunction(() => !!window.__FZ__?.state.renderer, null, { timeout: 60000 });
await p.waitForTimeout(1200);
const m = await p.evaluate(() => {
  const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect();
    return { sel: s, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), cw: e.clientWidth, ch: e.clientHeight,
             styleW: e.style.width, styleH: e.style.height, backing: e.width + 'x' + e.height, overflow: getComputedStyle(e).overflow }; };
  return {
    win: [innerWidth, innerHeight],
    canvas: r('#viewport'), wrap: r('#viewport-wrap'), center: r('#center'),
    left: r('#left'), right: r('#right'), timeline: r('#timeline'),
    scale: window.__FZ__.state.renderScale,
    wrapDisplay: getComputedStyle(document.querySelector('#viewport-wrap')).display,
    wrapJustify: getComputedStyle(document.querySelector('#viewport-wrap')).justifyContent,
    wrapAlign: getComputedStyle(document.querySelector('#viewport-wrap')).alignItems,
  };
});
console.log(JSON.stringify(m, null, 1));
await b.close();
