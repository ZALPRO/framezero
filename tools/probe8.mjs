import { chromium } from 'playwright';
const b=await chromium.launch({args:['--enable-unsafe-swiftshader','--no-sandbox']});
const pg=await b.newPage();const errs=[];
pg.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
pg.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});
await pg.goto('http://127.0.0.1:4173/probe8.html',{waitUntil:'load'});
let done=true;
try{ await pg.waitForFunction(()=>document.title.startsWith('P8-'),null,{timeout:120000}); }
catch(e){ done=false; }
// print whatever the page managed to emit, whether or not it finished
console.log(await pg.evaluate(()=>document.getElementById('o').textContent));
console.log(done?'[probe completed]':'[probe TIMED OUT — partial output above]');
if(errs.length)console.log('ERRORS:\n'+errs.join('\n'));
await b.close();
