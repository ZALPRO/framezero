/* Regenerates the README hero shot: the shipped demo piece at its title beat,
   chrome visible, HUD off. Usage: node tools/hero.mjs */
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
await p.goto('http://127.0.0.1:4173/index.html');
await p.waitForTimeout(1600);
await p.evaluate(() => window.__FZ__.api.loadDemo());
await p.waitForFunction(() => window.__FZ__.state.project.name === 'persian-epic', null, { timeout: 20000 });
await p.waitForTimeout(900);
await p.evaluate(() => { window.__FZ__.play(true); window.__FZ__.api.seek(9.2); });
await p.waitForTimeout(600);
await p.screenshot({ path: 'docs/hero.png' });
await b.close();
console.log('docs/hero.png written');
