import { chromium } from 'playwright';
const b=await chromium.launch({args:['--enable-unsafe-swiftshader','--no-sandbox']});
const pg=await b.newPage();
pg.on('pageerror', e=>console.log('[PAGEERROR]', (e.stack||e.message).slice(0,800)));
pg.on('console', m=>{ if(m.type()==='error') console.log('[err]', m.text().slice(0,300)); });
await pg.goto('http://127.0.0.1:4173/tests/typography.html',{waitUntil:'load'});
await pg.waitForTimeout(12000);
console.log('title  :', JSON.stringify(await pg.title()));
console.log('__CK__ :', await pg.evaluate(()=>window.__CK__??'<unset>'));
const t = await pg.evaluate(()=>window.__TESTS__ ? {p:window.__TESTS__.passed,f:window.__TESTS__.failed,s:window.__TESTS__.skipped,n:window.__TESTS__.results.length} : null);
console.log('__TESTS__:', JSON.stringify(t));
if(t){ const fails = await pg.evaluate(()=>window.__TESTS__.results.filter(r=>r.ok===false).map(r=>({g:r.group,n:r.name,d:r.detail})));
  console.log('\nFAILURES ('+fails.length+'):'); for(const f of fails) console.log('  ✗ ['+f.g+'] '+f.n+'\n      '+String(f.d).slice(0,240)); }
await b.close();
