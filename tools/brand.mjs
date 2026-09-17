/* Key the near-black studio background out of the chosen logo so the mark sits
   cleanly on ANY surface (topbar, boot, README on white). Done in a real browser
   canvas: no image deps, and the alpha ramp keeps anti-aliased edges soft. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
mkdirSync('/home/user/app/public/brand', { recursive: true });
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage();
await p.goto('http://127.0.0.1:4173/index.html');
const out = await p.evaluate(async () => {
  const load = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const img = await load('/logos/candidate-1.png');
  const S = 512;
  const c = new OffscreenCanvas(S, S);
  const g = c.getContext('2d', { willReadFrequently: true });
  // centre-crop the mark: the source has generous padding
  g.drawImage(img, 0, 0, img.width, img.height, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S);
  const px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    // background is ~#0d0f14 (lum ≈ 14); the mark is mint (lum ≈ 190).
    // ramp alpha between them so edge pixels keep their softness
    const a = lum < 40 ? 0 : lum > 90 ? 255 : Math.round(((lum - 40) / 50) * 255);
    px[i + 3] = Math.min(px[i + 3], a);
    // recolour to the exact product accent (#00E5A0) so the mark always reads
    // as part of the theme; keep a little luminance for depth on the strokes
    if (px[i + 3] > 0) {
      const t = 0.8 + 0.2 * Math.min(1, Math.max(0, (lum - 40) / 150));
      px[i] = Math.round(0 * (1 - t) + 0 * t);       // R stays 0
      px[i + 1] = Math.round(229 * t + 40 * (1 - t)); // G
      px[i + 2] = Math.round(160 * t + 30 * (1 - t)); // B
    }
  }
  g.putImageData(d, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
  const sizes = {};
  for (const s of [512, 180, 32]) {
    const t = new OffscreenCanvas(s, s); const tg = t.getContext('2d');
    tg.drawImage(c, 0, 0, S, S, 0, 0, s, s);
    const tb = await t.convertToBlob({ type: 'image/png' });
    const tb8 = new Uint8Array(await tb.arrayBuffer());
    let b2 = ''; for (let i = 0; i < tb8.length; i += 8192) b2 += String.fromCharCode(...tb8.subarray(i, i + 8192));
    sizes[s] = btoa(b2);
  }
  return { full: btoa(bin), sizes };
});
await writeFile('public/brand/logo.png', Buffer.from(out.full, 'base64'));
await writeFile('public/brand/logo-180.png', Buffer.from(out.sizes[180], 'base64'));
// The photographic mark loses its hairline strokes below ~40px, so the favicon
// is a hand-drawn vector of the same silhouette at optical stroke weights.
const FAV_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<g fill="none" stroke="#00e5a0" stroke-linecap="round">
<path stroke-width="3" d="M5 13V9Q5 5 9 5H13M19 5H23Q27 5 27 9V13M5 19V23Q5 27 9 27H13M19 27H23Q27 27 27 23V19"/>
<path stroke-width="2.6" d="M16 5V12M16 20V27"/>
<ellipse cx="16" cy="16" rx="2.3" ry="3.3" stroke-width="2.4"/>
</g></svg>`;
const fav = await p.evaluate(async (svg) => {
  const url = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const t = new OffscreenCanvas(32, 32); const g = t.getContext('2d');
  g.drawImage(img, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  let opaque = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 128) opaque++;
  const blob = await t.convertToBlob({ type: 'image/png' });
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192));
  return { b64: btoa(bin), coverage: +(100 * opaque / 1024).toFixed(1) };
}, FAV_SVG);
await writeFile('public/brand/favicon.png', Buffer.from(fav.b64, 'base64'));
console.log('favicon vector coverage %', fav.coverage);
console.log('brand written: logo.png(512) logo-180.png favicon.png(32)');
const probe = await p.evaluate(async () => {
  const load = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url + '?v=' + Date.now(); });
  const img = await load('/brand/logo.png');
  const c = new OffscreenCanvas(img.width, img.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  const at = (x, y) => { const i = (y * img.width + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
  let opaque = 0, first = null;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 200) { opaque++; if (!first) first = [d[i - 3], d[i - 2], d[i - 1], d[i]]; }
  return { corner: at(2, 2), stroke: first, opaquePct: +(100 * opaque / (img.width * img.height)).toFixed(1) };
});
console.log('probe', JSON.stringify(probe));
await b.close();
