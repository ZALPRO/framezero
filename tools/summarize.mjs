/* prints pass/fail lines from test-results/*.json */
import { readFileSync, existsSync } from 'node:fs';
for (const n of ['app', 'render', 'document', 'typography']) {
  const f = `test-results/${n}.json`;
  if (!existsSync(f)) { console.log(n.padEnd(11), 'missing'); continue; }
  const d = JSON.parse(readFileSync(f));
  const list = d.results || d.asserts || d.tests || [];
  const fail = list.filter(a => a.ok === false || a.status === 'fail');
  console.log(n.padEnd(11), `pass ${list.length - fail.length} fail ${fail.length}`);
  for (const a of fail.slice(0, 8)) console.log('   FAIL:', a.name || a.label || a.section, '|', a.detail || a.got || '');
}
