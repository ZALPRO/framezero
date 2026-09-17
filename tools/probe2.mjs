import { chromium } from 'playwright';
const b = await chromium.launch({ args:['--enable-unsafe-swiftshader','--no-sandbox'] });
const pg = await b.newPage({ viewport:{width:960,height:700} });
const errs=[]; pg.on('pageerror',e=>errs.push(e.message)); pg.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await pg.goto('http://127.0.0.1:4173/probe2.html',{waitUntil:'load'});
await pg.waitForFunction(()=>document.title==='P2-DONE',null,{timeout:120000});
console.log(await pg.evaluate(()=>document.getElementById('out').textContent));
if(errs.length)console.log('--- ERRORS ---\n'+errs.join('\n'));
await b.close();
