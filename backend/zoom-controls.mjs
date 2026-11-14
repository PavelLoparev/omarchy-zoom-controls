#!/usr/bin/env node
import {readFile,readlink,mkdir} from 'node:fs/promises';
import {exec,launchBrowser} from './execution.mjs';
import {targetsAt,pageState} from './protocol.mjs';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {loadConfig} from './config.mjs';
import {CDP} from './cdp.mjs';
import {zoomPage} from './page.mjs';
import {inviteLink, meetingLink, meetingDestination, autoJoinLink, zoomHome, zoomPrejoin} from './home.mjs';
import {activeWorkspaceName, focusWorkspaceDispatch} from './workspace.mjs';
let config, configError;
try {config=await loadConfig();} catch(e) {configError=e;config={};}
const profile=config.profile;
const action=process.argv[2]||'status';
const expected=process.argv[3]||'';
async function endpoints(){
  const pids=new Set();
  // Read argv exactly: profile paths can contain spaces and regex characters.
  const {readdir}=await import('node:fs/promises');
  for(const pid of await readdir('/proc')) {
    if(!/^\d+$/.test(pid))continue;
    try {
      const raw=await readFile('/proc/'+pid+'/cmdline','utf8');
      const args=raw.split('\0').filter(Boolean);
      const exact=args.includes('--user-data-dir='+profile)||args.some((a,i)=>a==='--user-data-dir'&&args[i+1]===profile);
      // Some Chromium launchers flatten argv after startup. Only allow exact
      // whitespace-delimited fallback for profiles without whitespace.
      const flat=!/\s/.test(profile)&&raw.split(/[\0\s]+/).includes('--user-data-dir='+profile);
      if((exact||flat)&&!args.some(a=>a.startsWith('--type='))&&!/--type=/.test(raw))pids.add(pid);
    }catch{}
  }
  // Chromium rewrites /proc argv into a flat title on some builds. Its
  // per-profile singleton lock identifies the owner even for paths with spaces.
  try {
    const pid=(await readlink(profile+'/SingletonLock')).match(/-(\d+)$/)?.[1];
    const raw=pid?await readFile('/proc/'+pid+'/cmdline','utf8'):'';
    if(raw.includes('--user-data-dir='+profile)&&!raw.includes('--type='))pids.add(pid);
  }catch{}
  if(!pids.size)return [];
  const {stdout}=await exec('/usr/bin/ss',['-ltnp'],{timeout:1500});
  const result=[];
  for(const line of stdout.split('\n')) {
    if(![...line.matchAll(/pid=(\d+)/g)].some(m=>pids.has(m[1])))continue;
    const address=line.trim().split(/\s+/)[3];
    if(/^(127\.0\.0\.1|\[::1\]):\d+$/.test(address))result.push('http://'+address);
  }
  return [...new Set(result)];
}
export async function discover(){
  const urls=await endpoints();
  if(urls.length>8)throw new Error('Too many browser debugging endpoints.');
  if(!urls.length)return {state:'offline', title:'Zoom is not connected', capabilities:{}};
  const found=[];
  let failed=false;
  for(const url of urls){
    try {
      const targets=await targetsAt(url);
      for(const t of targets){
        if(t.type!=='page')continue;
        const u=new URL(t.url);
        if(u.protocol!=='https:'||!/(^|\.)zoom\.us$/.test(u.hostname))continue;
        const c=await CDP.connect(t.webSocketDebuggerUrl,url);
        try{const state=pageState(await c.evaluate('('+zoomPage.toString()+')()'));found.push({...state,target:t.id,ws:t.webSocketDebuggerUrl,endpoint:url})}finally{c.close()}
      }
    }catch{failed=true}
  }
  const meetings=found.filter(s=>s.state==='meeting');
  if(meetings.length>1)return {state:'unknown',title:'Multiple Zoom meetings — open Zoom',capabilities:{}};
  if(failed)return {state:'unknown',title:'Unable to read Zoom controls',capabilities:{}};
  if(meetings.length===1)return meetings[0];
  return found[0]||{state:'idle',title:'No active meeting',capabilities:{}};
}
async function clipboardMeeting() {
  try {
    const {stdout}=await exec('/usr/bin/wl-paste',['--no-newline'],{timeout:1000,maxBuffer:8192});
    return meetingLink(stdout);
  } catch { return null; }
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function currentWorkspace(run=exec) {
  let activeWindow=null;
  try {activeWindow=JSON.parse((await run('/usr/bin/hyprctl',['activewindow','-j'],{timeout:2000})).stdout);} catch {}
  const windowName=activeWorkspaceName(activeWindow,null);
  if(windowName)return windowName;
  try {
    const monitors=JSON.parse((await run('/usr/bin/hyprctl',['monitors','-j'],{timeout:2000})).stdout);
    return activeWorkspaceName(null,monitors);
  } catch {return '';}
}
export async function focusWorkspace(name,run=exec) {
  const dispatch=focusWorkspaceDispatch(name);
  if(!dispatch)throw new Error('Invalid workspace to return to.');
  await run('/usr/bin/hyprctl',['dispatch',dispatch],{timeout:2000});
}
async function joinPrejoin(c,link,config,fallback='Opening meeting') {
  const name=config.displayName||process.env.USER||'';
  let passcode='';
  try { passcode=new URL(link).searchParams.get('pwd')||''; } catch {}
  let attempted=false, clicked=false, sawPrejoin=false, sawAudioPrompt=false, audio='';
  const deadline=Date.now()+20000;
  while(Date.now()<deadline) {
    let result;
    try {
      result=await c.evaluate('('+zoomPrejoin.toString()+')('+JSON.stringify(name)+','+JSON.stringify(!!config.displayName)+','+JSON.stringify(passcode)+','+JSON.stringify(attempted)+')',true);
    } catch(e) {
      if(c.ws.closed) {
        const after=await discover().catch(()=>null);
        if(after?.state==='meeting')return {ok:true,message:'Meeting joined'};
        throw new Error('The Zoom window closed while joining.');
      }
      if(!/context.*destroyed|target navigated|Cannot find context|connection closed|Zoom did not respond/i.test(e.message))throw e;
      await sleep(300);
      continue;
    }
    if(!result||typeof result!=='object')throw new Error('Zoom did not respond to the join flow.');
    if(result.audio)audio=result.audio;
    if(result.state==='meeting')return {ok:true,message:audio==='none'?'Joined without audio':'Meeting joined'};
    if(result.state==='waiting')return {ok:true,message:'Waiting for the host'};
    if(result.state==='signin')throw new Error('Sign in to Zoom in the Zoom window, then try again.');
    if(result.state==='passcode')throw new Error('This meeting needs a passcode. Use a full Zoom invite link.');
    if(result.state==='name')throw new Error('Zoom needs a display name. Add displayName to the Zoom controls config or enter it in Zoom.');
    if(result.state==='error')throw new Error(result.message||'Zoom could not join this meeting.');
    if(result.state==='audio'){attempted=true;await sleep(250);continue;}
    if(result.state==='joining'){attempted=true;clicked=true;sawPrejoin=true;await sleep(250);continue;}
    if(result.state==='prejoin'){sawPrejoin=true;await sleep(250);continue;}
    if(result.state==='audio-prompt'){attempted=true;sawAudioPrompt=true;await sleep(250);continue;}
    if(result.state==='loading'||result.state==='idle'){await sleep(250);continue;}
    throw new Error('Zoom returned an unexpected join state.');
  }
  if(clicked)return {ok:true,message:'Joining meeting'};
  if(sawAudioPrompt)return {ok:true,message:'Choose an audio option in Zoom'};
  if(sawPrejoin)return {ok:true,message:'Open Zoom to finish joining'};
  return {ok:true,message:fallback};
}
async function homeAction(action) {
  let state=await discover();
  if(state.state==='meeting'||state.state==='unknown')throw new Error('A meeting is active or Zoom is still loading. Reopen the menu.');
  // Validate again at click time; clipboard contents never enter status output.
  let link=action==='join-clipboard'?await clipboardMeeting():action==='join'?meetingDestination(process.argv[4] || ''):null;
  if(action==='join'&&!link)throw new Error('Enter a Zoom meeting link or a 9–11 digit meeting ID.');
  if(action==='join-clipboard'&&!link)throw new Error('The clipboard no longer contains a Zoom meeting link.');
  const autoJoin=config.autoJoin!==false;
  if(autoJoin)link=autoJoinLink(link,config.displayName||'');
  await showZoom();
  for(let n=0;n<30;n++) {
    state=await discover();
    if(state.ws)break;
    await new Promise(r=>setTimeout(r,200));
  }
  if(state.state!=='idle'||!state.ws)throw new Error('Zoom is not ready. Open Zoom and sign in first.');
  const c=await CDP.connect(state.ws,state.endpoint);
  try {
    // A second check catches a meeting that started while the window opened.
    const current=await c.evaluate('('+zoomPage.toString()+')()');
    if(current.state!=='idle')throw new Error('The meeting changed. Reopen the Zoom menu.');
    if(action==='join-clipboard'||action==='join') {
      await c.call('Page.enable').catch(()=>{});
      let navigated=false, loaded=false;
      const onMessage=data=>{
        try {
          const event=JSON.parse(data);
          if(event.method==='Page.frameNavigated'&&event.params.frame.parentId===undefined)navigated=true;
          if(event.method==='Page.loadEventFired')loaded=true;
        } catch {}
      };
      c.ws.on('message',onMessage);
      try {
        const result=await c.call('Page.navigate',{url:link});
        if(result.errorText)throw new Error(action==='join-clipboard'?'Zoom could not open the copied meeting link.':'Zoom could not open the meeting link.');
        for(let n=0;n<80&&!loaded;n++)await sleep(100);
      } finally {c.ws.off('message',onMessage);}
      if(!navigated) {
        let href='';
        try { href=await c.evaluate('location.href'); } catch {}
        let current=null;
        try { current=new URL(href); } catch {}
        const target=new URL(link);
        if(!current||current.origin!==target.origin||current.pathname!==target.pathname)
          return {ok:true,message:action==='join-clipboard'?'Opening copied meeting':'Opening meeting'};
      }
      if(autoJoin)return await joinPrejoin(c,link,config,action==='join-clipboard'?'Opening copied meeting':'Opening meeting');
      return {ok:true,message:action==='join-clipboard'?'Opening copied meeting':'Opening meeting'};
    }
    // Join error/prejoin pages may remain after an attempt. Start always returns
    // to the signed-in home screen before invoking New meeting.
    if (!await c.evaluate("location.hostname==='app.zoom.us' && location.pathname==='/wc/home'")) {
      await c.call('Page.navigate',{url:'https://app.zoom.us/wc/home'});
      for(let n=0;n<40;n++) {
        await new Promise(r=>setTimeout(r,150));
        try {if(await c.evaluate("!!document.querySelector('button[aria-label=\"New meeting\"]')"))break;}catch{}
      }
    }
    let result;
    try {result=await c.evaluate('('+zoomHome.toString()+')('+JSON.stringify(action)+')',true);}
    catch(e) {
      if(action!=='start'||!/context.*destroyed|target navigated or closed/i.test(e.message))throw e;
      result={ok:true,verifyStarted:true};
    }
    if(result.verifyStarted) {
      for(let n=0;n<50;n++) {
        const after=await discover();
        if(after.state==='meeting')return {ok:true,message:'Meeting started'};
        await new Promise(r=>setTimeout(r,200));
      }
      throw new Error('Zoom has not started the meeting yet. Check the Zoom window for a sign-in or setup prompt.');
    }
    return result;
  } finally {c.close();}
}
async function zoomWindowAddress(){
  const {stdout}=await exec('/usr/bin/hyprctl',['clients','-j'],{timeout:2000});
  const lockPid=(await readlink(profile+'/SingletonLock').catch(()=>'' )).match(/-(\d+)$/)?.[1];
  for(const client of JSON.parse(stdout)) {
    try {
      const argv=(await readFile('/proc/'+client.pid+'/cmdline','utf8')).split('\0');
      if(!/^0x[0-9a-f]+$/i.test(client.address))continue;
      if(!argv.includes('--user-data-dir='+profile)&&!(String(client.pid)===lockPid&&argv.join(' ').includes('--user-data-dir='+profile)))continue;
      return client.address;
    }catch{}
  }
  return null;
}
async function focusZoomWindow(){
  const address=await zoomWindowAddress();
  if(!address)return false;
  await exec('/usr/bin/hyprctl',['dispatch','hl.dsp.focus({ window = "address:'+address+'" })'],{timeout:2000});
  return true;
}
async function closeZoomWindow(){
  const address=await zoomWindowAddress();
  if(!address)return false;
  await exec('/usr/bin/hyprctl',['dispatch','hl.dsp.window.close({ window = "address:'+address+'" })'],{timeout:2000});
  return true;
}
async function showZoom(){
  if(config.launcher) {
    await exec(config.launcher[0],config.launcher.slice(1),{timeout:40000,custom:true});
    return;
  }
  const state=await discover();
  if(state.ws) {
    const c=await CDP.connect(state.ws,state.endpoint);
    try {await c.call('Page.bringToFront');}finally{c.close();}
    await focusZoomWindow();
    return;
  }
  await mkdir(profile,{recursive:true,mode:0o700});
  // A dedicated profile avoids enabling remote control on ordinary browsing.
  const args=['--ozone-platform=wayland','--no-first-run','--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
    '--user-data-dir='+profile,'--class=zoom-controls-chromium','--new-window','https://app.zoom.us/wc/home'];
  await launchBrowser(config.browser,args);
  for(let n=0;n<50;n++) {
    try {if(await focusZoomWindow())break;}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
}
async function main(){
  if(configError)throw configError;
  if(action==='focus-workspace'){await focusWorkspace(process.argv[4]||'');return {ok:true}}
  if(action==='show'){await showZoom();return {ok:true}}
  if(['start','join','join-clipboard'].includes(action))return homeAction(action);
  const state=await discover();
  const token=state.target&&state.meeting?JSON.stringify([state.target,state.meeting]):'';
  if(action==='status') {const {ws,endpoint,meeting,target,...publicState}=state;return {...publicState,clipboardMeeting:['idle','offline'].includes(state.state)?!!await clipboardMeeting():false,token,checkedAt:Date.now()}}
  if(state.state!=='meeting'||!token||token!==expected)throw new Error('The meeting changed or is unavailable. Reopen the Zoom menu.');
  let returnWorkspace='';
  if(['share','chat','participants'].includes(action)) {
    if(action==='share')returnWorkspace=await currentWorkspace();
    await showZoom();
  }
  const c=await CDP.connect(state.ws,state.endpoint);
  try{
    let result;
    try { result=await c.evaluate('('+zoomPage.toString()+')('+JSON.stringify(action)+','+JSON.stringify(state.meeting)+')',true); }
    catch(e) {
      if(action !== 'leave' || !/context.*destroyed|connection closed|Cannot find context|target navigated or closed/i.test(e.message)) throw e;
      result = {ok:true,verifyLeft:true};
    }
    if(result.verifyLeft) {
      for(let n=0;n<40;n++) {
        const after=await discover();
        if(after.state==='idle'||after.state==='offline'||(after.state==='meeting'&&after.meeting!==state.meeting)) {
          await closeZoomWindow().catch(()=>{});
          return {ok:true,message:'Left the meeting'};
        }
        await new Promise(r=>setTimeout(r,150));
      }
      throw new Error('Zoom has not left the meeting. It may require a host transfer; open Zoom to finish.');
    }
    if(!result.ok) throw new Error('Zoom is no longer in that meeting. Reopen the menu.');
    if(action==='leave') await closeZoomWindow().catch(()=>{});
    if(result.link){
      const link=inviteLink(result.link);
      if(!link||link.length>8192)throw new Error('Zoom did not provide a valid invite link.');
      const cmd=config.clipboardCommand||[fileURLToPath(new URL('../bin/copy-link',import.meta.url))];
      await exec(cmd[0],cmd.slice(1),{timeout:10000,maxBuffer:8192,custom:true,input:link});
      return {ok:true,message:'Invite link copied'};
    }
    return {...result,workspace:action==='share'?returnWorkspace:'',message:action==='share'?'Choose what to share in Zoom':''};
  }finally{c.close()}
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  try{console.log(JSON.stringify(await main()))}catch(e){console.log(JSON.stringify({ok:false,state:'unknown',capabilities:{},error:e.message}));process.exitCode=1}
}
