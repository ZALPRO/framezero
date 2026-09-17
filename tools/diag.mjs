import { chromium } from 'playwright';
const b=await chromium.launch({args:['--enable-unsafe-swiftshader','--no-sandbox']});
const pg=await b.newPage({viewport:{width:1000,height:800}});
pg.on('pageerror',e=>console.log('[pageerror]',e.message));
pg.on('console',m=>{ if(m.type()==='error') console.log('[console.error]',m.text().slice(0,200)); });
await pg.goto('http://127.0.0.1:4173/tests/diag.html',{waitUntil:'load'});
// poll the checkpoint marker so we can see WHERE it stops
let last='';
for(let i=0;i<45;i++){
  await pg.waitForTimeout(2000);
  const t=await pg.title();
  const cur=await pg.evaluate(()=>window.__DIAG__||'boot').catch(()=>'<gone>');
  if(cur!==last){console.log(`  …at ${((i+1)*2)}s → ${cur}`);last=cur;}
  if(t.startsWith('DIAG-'))break;
}
console.log('\n'+await pg.evaluate(()=>window.__DIAGLOG__?window.__DIAGLOG__():'<no log>').catch(e=>'eval failed: '+e.message));
console.log('title:',await pg.title());
await b.close();
