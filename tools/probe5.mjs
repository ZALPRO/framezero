import { chromium } from 'playwright';
const b=await chromium.launch({args:['--enable-unsafe-swiftshader','--no-sandbox']});
const pg=await b.newPage();const errs=[];
pg.on('pageerror',e=>errs.push(e.message));
await pg.goto('http://127.0.0.1:4173/probe5.html',{waitUntil:'load'});
await pg.waitForFunction(()=>document.title.startsWith('P5-'),null,{timeout:90000});
console.log(await pg.evaluate(()=>document.getElementById('o').textContent));
if(errs.length)console.log('ERRORS:',errs.join('\n'));
await b.close();
