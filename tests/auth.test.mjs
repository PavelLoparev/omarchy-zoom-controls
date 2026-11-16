import {strict as assert} from 'node:assert';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {CDP} from '../backend/cdp.mjs';
import {zoomAuth} from '../backend/home.mjs';
const tmp=await mkdtemp('/tmp/zoom-auth-test-');
const browser=spawn(process.env.ZOOM_TEST_BROWSER||'/usr/lib/chromium/chromium',['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+tmp,'about:blank'],{stdio:'ignore'});
let c;
try {
  let port;
  for(let i=0;i<100;i++){try{port=(await readFile(tmp+'/DevToolsActivePort','utf8')).split('\n')[0];break}catch{await new Promise(r=>setTimeout(r,50))}}
  assert.ok(port,'Test browser started');
  const endpoint='http://127.0.0.1:'+port;
  const ts=await(await fetch(endpoint+'/json/list')).json();
  c=await CDP.connect(ts.find(t=>t.type==='page').webSocketDebuggerUrl,endpoint);
  const run=html=>c.evaluate(`(() => { document.body.innerHTML=${JSON.stringify(html)}; return (${zoomAuth.toString()})(); })()`);
  assert.deepEqual(await run(''),{state:'loading'});
  assert.deepEqual(await run('<button aria-label="Sign In">Sign In</button>'),{state:'signed-out'});
  assert.deepEqual(await run('<button aria-label="New meeting">New meeting</button>'),{state:'signed-in'});
  assert.deepEqual(await run('<a href="#">Sign In</a><button aria-label="New meeting">New meeting</button>'),{state:'signed-out'});
  assert.deepEqual(await run('<button aria-label="New meeting" style="display:none">New meeting</button>'),{state:'loading'});
  assert.deepEqual(await run('<button aria-label="Sign In" style="display:none">Sign In</button>'),{state:'loading'});
  console.log('PASS: zoomAuth distinguishes signed-in, signed-out, loading and ignores hidden controls');
} finally {c?.close();const exited=once(browser,'exit');browser.kill();await exited;await rm(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
