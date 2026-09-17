/* Report CSS classes the JS uses that app.css never styles.
   Run: node tools/cssaudit.mjs */
import { readFileSync } from 'node:fs';

const css = readFileSync('public/css/app.css', 'utf8');
const files = ['public/js/app.js', 'public/js/ui/panels.js'];
const js = files.map(f => readFileSync(f, 'utf8')).join('\n');

const used = new Set();
const addTokens = (s) => String(s).split(/\s+/).forEach(t => {
  // only plausible class names: letters/digits/-/_ and not code fragments
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(t)) used.add(t);
});
for (const m of js.matchAll(/class:\s*'([^']+)'/g)) addTokens(m[1]);
for (const m of js.matchAll(/class:\s*`([^`$]*)`/g)) addTokens(m[1]);
for (const m of js.matchAll(/class:\s*"([^"]+)"/g)) addTokens(m[1]);
for (const m of js.matchAll(/classList\.(?:add|toggle|remove)\('([A-Za-z0-9_-]+)'/g)) used.add(m[1]);

const missing = [...used].filter(c => !css.includes('.' + c));
console.log(`classes referenced in JS: ${used.size}`);
console.log(`missing from app.css:     ${missing.length}`);
if (missing.length) console.log(missing.sort().join('\n'));
