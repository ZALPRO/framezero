import { chromium } from 'playwright';
const b=await chromium.launch({args:['--enable-unsafe-swiftshader','--no-sandbox']});
const pg=await b.newPage();const errs=[];
pg.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
await pg.goto('http://127.0.0.1:4173/probe-perf2.html',{waitUntil:'load'});
let done=true;
try{ await pg.waitForFunction(()=>document.title.startsWith('PERF2-'),null,{timeout:240000}); }catch(e){ done=false; }
console.log(await pg.evaluate(()=>document.getElementById('o').textContent));
console.log(done?'[completed]':'[TIMED OUT — partial above]');
if(errs.length)console.log('ERRORS:\n'+errs.join('\n'));
await b.close();
