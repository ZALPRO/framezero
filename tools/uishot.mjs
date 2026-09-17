/* Hi-DPI crops of the chrome for visual review + a favicon legibility montage. */
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 3 });
await p.goto('http://127.0.0.1:4173/index.html');
await p.locator('#boot').screenshot({ path: 'test-results/ui-boot.png' }).catch(() => {});
await p.waitForTimeout(1500);
await p.locator('#topbar').screenshot({ path: 'test-results/ui-topbar.png' });
await p.locator('#right').screenshot({ path: 'test-results/ui-right.png' });
await p.locator('#timeline').screenshot({ path: 'test-results/ui-timeline.png' });
// favicon montage: 16/32/48 px on both dark and light surfaces
await p.evaluate(async () => {
  const load = (u) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = u; });
  const fav = await load('/brand/favicon.png');
  const logo = await load('/brand/logo.png');
  const host = document.createElement('div');
  host.id = 'fav-montage';
  host.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;gap:26px;align-items:center;justify-content:center;background:#0b0d10';
  const cell = (bg, label) => {
    const d = document.createElement('div');
    d.style.cssText = `background:${bg};padding:22px 26px;border-radius:10px;display:flex;gap:18px;align-items:center`;
    for (const s of [16, 32, 48]) {
      const c = document.createElement('canvas'); c.width = s; c.height = s;
      c.style.cssText = `width:${s}px;height:${s}px;image-rendering:auto`;
      c.getContext('2d').drawImage(s <= 32 ? fav : logo, 0, 0, s, s);
      d.append(c);
    }
    return d;
  };
  host.append(cell('#0b0d10', 'dark'), cell('#ffffff', 'light'), cell('#00e5a0', 'accent'));
  document.body.append(host);
});
await p.waitForTimeout(200);
await p.locator('#fav-montage').screenshot({ path: 'test-results/ui-favicon.png' });
await b.close();
console.log('uishot ok');
