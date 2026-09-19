/* Procedural ink brush strokes (our own asset, no licence strings): jagged
   noise-edged diagonal strokes + spatter, alpha-only artwork. */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage();
await p.goto('http://127.0.0.1:4173/index.html');
const out = await p.evaluate(async () => {
  const mk = (seed) => {
    let s = seed;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const W = 1024, H = 512;
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    // main stroke: a chain of overlapping blobs along a wobbly diagonal
    const steps = 90;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const x = 90 + t * (W - 200) + Math.sin(t * 9 + seed) * 26;
      const y = H - 90 - t * (H - 200) + Math.cos(t * 7 + seed) * 20;
      const r = 52 + Math.sin(t * 23 + seed * 2) * 16 + rnd() * 14;
      g.beginPath();
      for (let a = 0; a < Math.PI * 2; a += 0.22) {
        const rr = r * (0.82 + rnd() * 0.36);
        const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr * 0.78;
        a === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
      g.closePath(); g.fill();
    }
    // dry-brush tails + spatter
    for (let i = 0; i < 260; i++) {
      const t = rnd();
      const x = 60 + t * (W - 140) + (rnd() - 0.5) * 150;
      const y = H - 70 - t * (H - 160) + (rnd() - 0.5) * 130;
      g.beginPath(); g.arc(x, y, 1 + rnd() * 7, 0, Math.PI * 2); g.fill();
    }
    return c;
  };
  const dump = async (c) => {
    const blob = await c.convertToBlob({ type: 'image/png' });
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192));
    return btoa(bin);
  };
  return { a: await dump(mk(7)), b: await dump(mk(23)) };
});
await writeFile('public/assets/brush-1.png', Buffer.from(out.a, 'base64'));
await writeFile('public/assets/brush-2.png', Buffer.from(out.b, 'base64'));
console.log('brushes written');
await b.close();
