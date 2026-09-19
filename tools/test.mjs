/* FrameZero test runner — headless Chromium, real pixels, real assertions.
   Usage: node tools/test.mjs [suite] [--headed] [--keep] */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const suite = process.argv.slice(2).find(a => !a.startsWith('--')) || 'typography';
const headed = process.argv.includes('--headed');
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = ROOT + 'test-results';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headed,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const errors = [];
page.on('pageerror', e => { errors.push('PAGEERROR: ' + (e.stack || e.message)); console.log('\x1b[31m[pageerror]\x1b[0m ' + (e.message||'').slice(0,300)); });
page.on('console', m => {
  const t = m.text();
  if (m.type() === 'error') errors.push('CONSOLE: ' + t);
  if (t.startsWith('CK ') || t.startsWith('WINDOW-ERROR') || t.startsWith('UNHANDLED')) console.log('\x1b[36m  ' + t.slice(0, 220) + '\x1b[0m');
});
page.on('requestfailed', r => errors.push(`REQFAIL: ${r.url()} — ${r.failure()?.errorText}`));

await page.goto(`http://127.0.0.1:4173/tests/${suite}.html`, { waitUntil: 'load' });

let status;
try {
  await page.waitForFunction(() => document.title.startsWith('TEST-'), null, { timeout: 150000 });
  status = await page.title();
} catch (e) {
  status = 'TEST-TIMEOUT';
  const ck = await page.evaluate(() => window.__CK__ || '<none>').catch(() => '<page gone>');
  errors.push('Harness never finished. Last checkpoint: ' + ck);
  console.log('\x1b[31mTIMEOUT — last checkpoint: ' + ck + '\x1b[0m');
}

const data = await page.evaluate(() => window.__TESTS__ || null);
await page.screenshot({ path: `${OUT}/${suite}.png`, fullPage: true });

/* ── console report ── */
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
if (data) {
  let lastGroup = null;
  for (const r of data.results) {
    if (r.group !== lastGroup) { console.log(`\n${C.b}▌ ${r.group}${C.x}`); lastGroup = r.group; }
    const mark = r.ok === null ? `${C.d}○` : r.ok ? `${C.g}✓` : `${C.r}✗`;
    console.log(`  ${mark} ${r.name}${C.x}`);
    if (r.detail) console.log(`      ${r.ok === false ? C.r : C.d}${String(r.detail).slice(0, 300)}${C.x}`);
  }
  const line = `${data.passed} passed, ${data.failed} failed, ${data.skipped} info`;
  console.log(`\n${C.b}${data.failed ? C.r + 'FAILED' : C.g + 'ALL PASS'}${C.x} — ${line}`);
} else {
  console.log(`${C.r}No test results were produced.${C.x}`);
}

if (errors.length) {
  console.log(`\n${C.y}── page errors (${errors.length}) ──${C.x}`);
  for (const e of [...new Set(errors)].slice(0, 25)) console.log('  ' + e.slice(0, 500));
}

/* ── machine-readable artefact ── */
const fs = await import('node:fs/promises');
await fs.writeFile(`${OUT}/${suite}.json`, JSON.stringify({
  suite, status, timestamp: new Date().toISOString(),
  passed: data?.passed ?? 0, failed: data?.failed ?? 0, skipped: data?.skipped ?? 0,
  errors: [...new Set(errors)], results: data?.results ?? [],
}, null, 2));

await browser.close();
const bad = (data?.failed ?? 1) > 0 || errors.some(e => e.startsWith('PAGEERROR')) || status === 'TEST-TIMEOUT';
console.log(`\n${C.d}artefacts → ${OUT}/${suite}.{json,png}${C.x}`);
process.exit(bad ? 1 : 0);
