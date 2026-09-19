/* Records the shipped demo piece through the PRODUCT's own exporter
   (MediaRecorder on the viewport stream + master audio) and saves the WebM. */
import { chromium } from 'playwright';
import { statSync } from 'node:fs';
const b = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 860 } });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:4173/index.html');
await p.waitForTimeout(1500);
await p.evaluate(() => window.__FZ__.api.loadDemo());
await p.waitForFunction(() => window.__FZ__.state.project.name === 'persian-epic', null, { timeout: 20000 });
await p.waitForTimeout(1200);
await p.click('#viewport');                      // user gesture → AudioContext runs
await p.waitForTimeout(300);
const dl = p.waitForEvent('download', { timeout: 120000 });
await p.evaluate(() => window.__FZ__.exportVideo());
const download = await dl;
const dest = 'exports/persian-epic.webm';
await download.saveAs(dest);
const st = statSync(dest);
console.log('saved', dest, (st.size / 1048576).toFixed(2), 'MB');
await b.close();
