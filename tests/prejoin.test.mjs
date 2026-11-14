import {strict as assert} from 'node:assert';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {CDP} from '../backend/cdp.mjs';
import {zoomPrejoin} from '../backend/home.mjs';
const tmp=await mkdtemp('/tmp/zoom-prejoin-test-');
const browser=spawn(process.env.ZOOM_TEST_BROWSER||'/usr/lib/chromium/chromium',['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+tmp,'about:blank'],{stdio:'ignore'});
let c;
try {
  let port;
  for(let i=0;i<100;i++){try{port=(await readFile(tmp+'/DevToolsActivePort','utf8')).split('\n')[0];break}catch{await new Promise(r=>setTimeout(r,50))}}
  assert.ok(port,'Test browser started');
  const endpoint='http://127.0.0.1:'+port;
  const ts=await(await fetch(endpoint+'/json/list')).json();
  c=await CDP.connect(ts.find(t=>t.type==='page').webSocketDebuggerUrl,endpoint);
  const frameHtml=`<!doctype html><title>Zoom prejoin</title><body>
    <input id="input-for-name" placeholder="Your Name"><input id="input-for-pwd" placeholder="Passcode"><button id="join">Join</button><video></video>
    <script>
      document.querySelector('#join').onclick=()=>{
        const d=document.createElement('div');d.className='join-dialog';
        d.innerHTML='<button id="audio">Join with Computer Audio</button><button id="noaudio">Join Without Audio</button>';
        d.querySelector('#audio').onclick=()=>{document.body.innerHTML='<footer id="wc-footer"><button id="meeting-info-indication">Test meeting</button></footer>'};
        d.querySelector('#noaudio').onclick=()=>{document.body.innerHTML='<footer id="wc-footer"><button id="meeting-info-indication">Test meeting</button></footer>'};
        document.body.appendChild(d);
      };
    </script></body>`;
  const topHtml=`<!doctype html><title>Join</title><body><iframe id="webclient" src="https://app.zoom.us/wc/123456789/join" style="width:500px;height:500px"></iframe></body>`;
  const pages=new Map([['https://app.zoom.us/wc/join/123456789',topHtml],['https://app.zoom.us/wc/123456789/join',frameHtml]]);
  const intercepted=[];
  c.ws.on('message',data=>{
    const event=JSON.parse(data);
    if(event.method!=='Fetch.requestPaused')return;
    const body=pages.get(event.params.request.url)||'<!doctype html><title>blocked</title>';
    intercepted.push(c.call('Fetch.fulfillRequest',{requestId:event.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from(body).toString('base64')}));
  });
  await c.call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  await c.call('Page.navigate',{url:'https://app.zoom.us/wc/join/123456789'});
  await Promise.all(intercepted);
  for(let i=0;i<60;i++){
    if(await c.evaluate(`(() => { const f=document.querySelector('#webclient'); return !!(f && f.contentDocument && f.contentDocument.querySelector('#join')); })()`))break;
    await new Promise(r=>setTimeout(r,50));
  }
  const run=(name='',override=false,passcode='',attempted=false)=>c.evaluate('('+zoomPrejoin.toString()+')('+JSON.stringify(name)+','+JSON.stringify(override)+','+JSON.stringify(passcode)+','+JSON.stringify(attempted)+')',true);
  let r=await run('Ada Lovelace',true,'secret',false);
  assert.equal(r.state,'joining');
  let frame=await c.evaluate(`(() => { const d=document.querySelector('#webclient').contentDocument; return {name:d.querySelector('#input-for-name').value,pwd:d.querySelector('#input-for-pwd').value,clicked:d.documentElement.dataset.zoomControlsJoinAttempted}; })()`);
  assert.equal(frame.name,'Ada Lovelace');assert.equal(frame.pwd,'secret');assert.equal(frame.clicked,'1');
  r=await run('Ada Lovelace',true,'secret',true);
  assert.equal(r.state,'audio');assert.equal(r.audio,'computer');
  r=await run('Ada Lovelace',true,'secret',true);
  assert.equal(r.state,'meeting');
  await c.evaluate(`(() => { const d=document.querySelector('#webclient').contentDocument; d.body.innerHTML='<footer id="wc-footer"><button id="meeting-info-indication">Test meeting</button><button id="join-audio">Join Audio</button></footer>'; d.querySelector('#join-audio').onclick=()=>{window.zoomAudioClicked=true}; })()`);
  r=await run('Ada Lovelace',true,'secret',true);
  assert.equal(r.state,'audio');assert.equal(r.audio,'prompt');
  assert.equal(await c.evaluate(`window.zoomAudioClicked`),true);
  await c.evaluate(`(() => { const d=document.querySelector('#webclient').contentDocument; d.body.innerHTML='<input id="input-for-name" value="Ada"><input id="input-for-pwd" placeholder="Passcode"><button id="join">Join</button>'; })()`);
  r=await run('Ada',false,'',false);
  assert.equal(r.state,'passcode');
  await c.evaluate(`(() => { const d=document.querySelector('#webclient').contentDocument; d.body.innerHTML='<input id="input-for-name" placeholder="Your Name"><button id="join">Join</button>'; })()`);
  r=await run('',false,'',false);
  assert.equal(r.state,'name');
  await c.evaluate(`(() => { const d=document.querySelector('#webclient').contentDocument; d.body.innerHTML='<input id="input-for-name" value="Account Name"><button id="join">Join</button>'; })()`);
  r=await run('Ada',false,'',false);
  assert.equal(r.state,'joining');
  assert.equal(await c.evaluate(`document.querySelector('#webclient').contentDocument.querySelector('#input-for-name').value`),'Account Name');
  await c.evaluate(`(() => { const d=document.querySelector('#webclient').contentDocument; d.body.innerHTML='<div>Invalid meeting ID</div><input id="input-for-name" value="Ada"><button id="join">Join</button>'; })()`);
  r=await run('Ada',false,'',true);
  assert.equal(r.state,'error');
  await c.evaluate(`(() => { const d=document.querySelector('#webclient').contentDocument; d.body.innerHTML='<div>Waiting for the host to start this meeting</div>'; })()`);
  r=await run('Ada',false,'',true);
  assert.equal(r.state,'waiting');
  console.log('PASS: prejoin name/passcode fill, Join click, audio prompt, meeting audio, passcode/name errors, account name preserved, join error and waiting room');
} finally {c?.close();const exited=once(browser,'exit');browser.kill();await exited;await rm(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
