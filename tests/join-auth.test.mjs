import {strict as assert} from 'node:assert';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import {spawn,execFile as execCb} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {CDP} from '../backend/cdp.mjs';
const exec=promisify(execCb);
const tmp=await mkdtemp('/tmp/zoom-join-auth-test-');
const profile=tmp+'/profile';
const cli=fileURLToPath(new URL('../backend/zoom-controls.mjs',import.meta.url));
const config=tmp+'/config.json';
const env={...process.env,ZOOM_CONTROLS_CONFIG:config};
const run=async(...args)=>{try{return JSON.parse((await exec(process.execPath,[cli,...args],{env,timeout:60000})).stdout)}catch(e){return JSON.parse(e.stdout)}};
const browser=spawn(process.env.ZOOM_TEST_BROWSER||'/usr/lib/chromium/chromium',['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
let c;
try {
  for(let n=0;n<100;n++){try{await readFile(profile+'/DevToolsActivePort');break}catch{await new Promise(r=>setTimeout(r,50))}}
  const bin=tmp+'/bin';await mkdir(bin);
  const launcher=bin+'/noop';await writeFile(launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});
  await writeFile(config,JSON.stringify({profile,launcher:[launcher],autoJoin:true}));
  const port=(await readFile(profile+'/DevToolsActivePort','utf8')).split('\n')[0];
  const endpoint='http://127.0.0.1:'+port;
  const ts=await(await fetch(endpoint+'/json/list')).json();
  c=await CDP.connect(ts.find(t=>t.type==='page').webSocketDebuggerUrl,endpoint);
  const signedOutHtml='<!doctype html><title>Zoom home</title><body><button aria-label="Sign In">Sign In</button><input placeholder="Meeting ID or Personal Link Name"><button>Join</button></body>';
  const requested=[];
  c.ws.on('message',data=>{
    const event=JSON.parse(data);
    if(event.method!=='Fetch.requestPaused')return;
    const url=event.params.request.url;
    requested.push(url);
    const body=url==='https://app.zoom.us/wc/home'?signedOutHtml:'<!doctype html><title>blocked</title>';
    c.call('Fetch.fulfillRequest',{requestId:event.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from(body).toString('base64')}).catch(()=>{});
  });
  await c.call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  await c.call('Page.navigate',{url:'https://app.zoom.us/wc/home'});
  for(let n=0;n<60;n++){
    if(await c.evaluate(`document.readyState==='complete'&&!!document.querySelector('button[aria-label="Sign In"]')`))break;
    await new Promise(r=>setTimeout(r,50));
  }
  const result=await run('join','','123456789');
  assert.equal(result.ok,false);
  assert.equal(result.state,'unknown');
  assert.deepEqual(result.capabilities,{});
  assert.equal(result.error,'Sign in to Zoom in the Zoom window, then click Join again.');
  assert.equal(requested.some(u=>u.startsWith('https://app.zoom.us/wc/join/')),false,'The join link is never requested while signed out');
  await c.evaluate(`document.body.innerHTML=''`);
  const loading=await run('join','','123456789');
  assert.equal(loading.ok,false);
  assert.equal(loading.error,'Zoom is still loading. Open Zoom, sign in, then click Join again.');
  assert.equal(requested.some(u=>u.startsWith('https://app.zoom.us/wc/join/')),false,'The join link is never requested while the home page is loading');
  await c.call('Page.navigate',{url:'https://app.zoom.us/wc/signin'});
  for(let n=0;n<60;n++){
    if(await c.evaluate(`document.readyState==='complete'`))break;
    await new Promise(r=>setTimeout(r,50));
  }
  const homeCount=requested.filter(u=>u==='https://app.zoom.us/wc/home').length;
  const offHome=await run('join','','123456789');
  assert.equal(offHome.ok,false);
  assert.equal(offHome.error,'Sign in to Zoom in the Zoom window, then click Join again.');
  assert.equal(requested.filter(u=>u==='https://app.zoom.us/wc/home').length,homeCount+1,'The signed-out path navigated to the Zoom home page exactly once');
  assert.equal(requested.some(u=>u.startsWith('https://app.zoom.us/wc/join/')),false,'The join link is never requested from a non-home page');
  console.log('PASS: CLI join refuses to guest-join a signed-out profile and never opens the join link');
} finally {c?.close();const exited=once(browser,'exit');browser.kill();await exited;await rm(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
