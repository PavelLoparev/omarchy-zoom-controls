import {strict as assert} from 'node:assert';
import {mkdtemp,writeFile,mkdir,rm,readFile} from 'node:fs/promises';
import {spawn,execFile as execCb} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {CDP} from '../backend/cdp.mjs';
const exec=promisify(execCb);
const tmp=await mkdtemp('/tmp/zoom-join-test-');
const profile=tmp+'/profile';
const cli=fileURLToPath(new URL('../backend/zoom-controls.mjs',import.meta.url));
const config=tmp+'/config.json';
const env={...process.env,ZOOM_CONTROLS_CONFIG:config};
const run=async(...args)=>JSON.parse((await exec(process.execPath,[cli,...args],{env,timeout:60000})).stdout);
const browser=spawn(process.env.ZOOM_TEST_BROWSER||'/usr/lib/chromium/chromium',['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
let c;
try {
  for(let n=0;n<100;n++){try{await readFile(profile+'/DevToolsActivePort');break}catch{await new Promise(r=>setTimeout(r,50))}}
  const bin=tmp+'/bin';await mkdir(bin);
  const launcher=bin+'/noop';await writeFile(launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});
  await writeFile(config,JSON.stringify({profile,launcher:[launcher],autoJoin:true,displayName:'Ada'}));
  const port=(await readFile(profile+'/DevToolsActivePort','utf8')).split('\n')[0];
  const endpoint='http://127.0.0.1:'+port;
  const ts=await(await fetch(endpoint+'/json/list')).json();
  c=await CDP.connect(ts.find(t=>t.type==='page').webSocketDebuggerUrl,endpoint);
  const frameHtml=`<!doctype html><title>Zoom prejoin</title><body><input id="input-for-name" placeholder="Your Name"><button id="join">Join</button><video></video><script>document.querySelector('#join').onclick=()=>{const d=document.createElement('div');d.className='join-dialog';d.innerHTML='<button id="audio">Join with Computer Audio</button>';d.querySelector('#audio').onclick=()=>{document.body.innerHTML='<footer id="wc-footer"><button id="meeting-info-indication">Test meeting</button></footer>'};document.body.appendChild(d)};</script></body>`;
  const topHtml=`<!doctype html><title>Join</title><body><iframe id="webclient" src="https://app.zoom.us/wc/123456789/join" style="width:500px;height:500px"></iframe></body>`;
  const homeHtml=`<!doctype html><title>Zoom home</title><body><button aria-label="New meeting">New meeting</button><input placeholder="Meeting ID or Personal Link Name"><button>Join</button></body>`;
  const pages=new Map([['https://app.zoom.us/wc/home',homeHtml],['https://app.zoom.us/wc/join/123456789?prefer=1&un=QWRh',topHtml],['https://app.zoom.us/wc/123456789/join',frameHtml]]);
  const intercepted=[];
  c.ws.on('message',data=>{
    const event=JSON.parse(data);
    if(event.method!=='Fetch.requestPaused')return;
    const body=pages.get(event.params.request.url)||'<!doctype html><title>blocked</title>';
    intercepted.push(c.call('Fetch.fulfillRequest',{requestId:event.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from(body).toString('base64')}));
  });
  await c.call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  await c.call('Page.navigate',{url:'https://app.zoom.us/wc/home'});
  await Promise.all(intercepted);
  for(let n=0;n<60;n++){
    if(await c.evaluate(`document.readyState==='complete'&&!!document.querySelector('button[aria-label="New meeting"]')`))break;
    await new Promise(r=>setTimeout(r,50));
  }
  const result=await run('join','','123456789');
  assert.equal(result.ok,true);
  assert.equal(result.message,'Meeting joined');
  const state=await run('status');
  assert.equal(state.state,'meeting');
  console.log('PASS: CLI join navigates, auto-fills the prejoin, clicks Join, handles audio, and reports the meeting');
} finally {c?.close();const exited=once(browser,'exit');browser.kill();await exited;await rm(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
