/* Release hygiene gate for the public repository.
   1. Persian (or any Arabic-script) text may only appear where it IS the
      product: the shipped demo piece, the RTL showcase layer, shaping test
      fixtures and the codepoint tables that audit font coverage. Prose,
      comments and UI copy are English-only.
   2. No one-off debug scaffolding (probe- or dbg-prefixed files) may ship. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOW = [
  'public/projects/persian-epic.fz.json',   // the reference piece itself
  'public/js/app.js',                       // default project's RTL showcase line
  'public/js/core/fonts.js',                // comment cites the codepoints it audits
  'public/js/render/typography.js',         // comment cites a measured sample
  'tools/fontinfo.py',                      // script-coverage codepoint tables
  'docs/platform-findings.md',              // measured-advance examples
  'public/tests/diag.html', 'public/tests/document.html',
  'public/tests/render.html', 'public/tests/typography.html',
];
const SKIP = new Set(['node_modules', 'test-results', '.git', 'exports', 'ref', '.fontcache']);
const FA = /[\u0600-\u06FF\u200C]/;

let fail = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (/\.(png|jpe?g|webm|ogg|ttf|woff2|ico|webp)$/i.test(name)) continue;
    if (/(^|\/)(probe|dbg-)/.test(p)) { console.log(`FAIL scaffolding ships: ${p}`); fail++; continue; }
    if (ALLOW.includes(p.replace('./', ''))) continue;
    let s; try { s = readFileSync(p, 'utf8'); } catch { continue; }
    s.split('\n').forEach((l, i) => {
      if (FA.test(l)) { console.log(`FAIL persian prose in ${p}:${i + 1}: ${l.trim().slice(0, 80)}`); fail++; }
    });
  }
};
walk('.');
console.log(fail ? `HYGIENE FAIL — ${fail} problem line(s)` : 'HYGIENE OK — prose is English; Persian only as product content');
process.exit(fail ? 1 : 0);
