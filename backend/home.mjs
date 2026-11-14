// Validate shareable invites without changing Zoom's host, route, or query.
export function inviteLink(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'https:' || !/(^|\.)zoom\.us$/i.test(u.hostname) || u.username || u.password || u.port) return null;
    const match = u.pathname.match(/^\/(?:j|wc\/join)\/(\d{9,11})\/?$/);
    const personal = u.pathname.match(/^\/my\/([a-zA-Z0-9._-]+)\/?$/);
    if (!match && !personal) return null;
    return u.href;
  } catch { return null; }
}

// The local plugin joins in the web app. Never use this conversion for sharing.
export function meetingLink(value) {
  const invite = inviteLink(value);
  if (!invite) return null;
  const u = new URL(invite);
  const match = u.pathname.match(/^\/(?:j|wc\/join)\/(\d{9,11})\/?$/);
  const out = new URL(match ? '/wc/join/' + match[1] : u.pathname.replace(/\/$/, ''), match ? 'https://app.zoom.us' : u.origin);
  if (u.searchParams.has('pwd')) out.searchParams.set('pwd', u.searchParams.get('pwd'));
  return out.href;
}

export function meetingDestination(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().replace(/[\s-]/g, '');
  return /^\d{9,11}$/.test(id) ? 'https://app.zoom.us/wc/join/' + id : meetingLink(value);
}

// Zoom's web client still shows a prejoin page unless prefer=1 is set. Only
// add un when the user explicitly chose a display name; otherwise keep the
// signed-in account name.
export function autoJoinLink(link, displayName = '') {
  if (!link) return link;
  const u = new URL(link);
  u.searchParams.set('prefer', '1');
  if (displayName) u.searchParams.set('un', Buffer.from(displayName).toString('base64'));
  return u.href;
}

// Runs only in the selected Zoom page. Fill the prejoin fields and click Join;
// the caller polls because Join can replace the document and its context.
export async function zoomPrejoin(name = '', overrideName = false, passcode = '', attempted = false) {
  const docs = [];
  function visit(d) {
    if (!d || docs.includes(d)) return;
    docs.push(d);
    for (const frame of d.querySelectorAll('iframe')) {
      try { if (frame.contentDocument && /(^|\.)zoom\.us$/.test(new URL(frame.src, d.URL).hostname)) visit(frame.contentDocument); } catch {}
    }
  }
  visit(document);
  const visible = e => !!e && e.getClientRects().length > 0 && e.checkVisibility();
  const enabled = e => !!e && !e.disabled && e.getAttribute('aria-disabled') !== 'true';
  const text = e => (e?.getAttribute('aria-label') || e?.value || e?.innerText || '').trim();
  const buttons = d => [...d.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]')].filter(visible);
  const findButton = (d, re) => buttons(d).find(e => re.test(text(e)));
  const click = e => { if (!visible(e) || !enabled(e)) return false; e.click(); return true; };
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  };
  const shownText = (e, re) => { const t = text(e); return visible(e) && t.length > 0 && t.length < 300 && re.test(t); };
  const shown = (d, re) => [...d.querySelectorAll('div,span,p,section,label,h1,h2,h3,li')].some(e => shownText(e, re));
  const audioButton = d => findButton(d, /join with computer audio|join audio by computer|use computer audio/i);
  const noAudioButton = d => findButton(d, /join without (computer )?audio/i);

  const audioDoc = docs.find(d => visible(d.querySelector('.join-dialog')) || audioButton(d) || noAudioButton(d));
  if (audioDoc) {
    const withAudio = audioButton(audioDoc);
    if (withAudio && enabled(withAudio)) { click(withAudio); return {state:'audio', audio:'computer'}; }
    const withoutAudio = noAudioButton(audioDoc);
    if (withoutAudio && enabled(withoutAudio)) { click(withoutAudio); return {state:'audio', audio:'none'}; }
    return {state:'audio-prompt'};
  }

  const meeting = docs.find(d => visible(d.querySelector('#wc-footer')) && d.querySelector('#meeting-info-indication'));
  if (meeting) {
    const joinAudio = findButton(meeting, /^join audio$/i);
    if (joinAudio && enabled(joinAudio)) { click(joinAudio); return {state:'audio', audio:'prompt'}; }
    return {state:'meeting'};
  }

  const waiting = docs.find(d => shown(d, /waiting for (the )?host|host will let you in|please wait.*host|the host will let you in soon/i));
  if (waiting) return {state:'waiting'};
  const signIn = docs.find(d => visible(d.querySelector('input[type="password"]')) && shown(d, /sign in to join|sign in to continue/i));
  if (signIn) return {state:'signin'};
  if (attempted) {
    const failure = docs.map(d => [...d.querySelectorAll('div,span,p,section,label,h1,h2,h3,li')].find(e => shownText(e, /invalid meeting|meeting id is invalid|meeting has not started|meeting is over|this meeting has been ended|unable to join|incorrect passcode|invalid passcode|meeting password is incorrect/i))).find(Boolean);
    if (failure) {
      const message = text(failure);
      const reason = /not started|hasn't started/i.test(message) ? 'The meeting has not started yet.' : /passcode|password/i.test(message) ? 'The meeting passcode is incorrect.' : /ended|is over/i.test(message) ? 'This meeting has ended.' : /invalid meeting|meeting id/i.test(message) ? 'Zoom could not find this meeting. Check the meeting ID.' : 'Zoom could not join this meeting.';
      return {state:'error', message:reason};
    }
  }

  const webclient = docs.map(d => { try { return d.querySelector('#webclient')?.contentDocument; } catch { return null; } }).find(Boolean);
  const candidates = [...new Set([webclient, ...docs])].filter(Boolean);
  const field = (d, re) => [...d.querySelectorAll('input')].find(e => visible(e) && re.test([e.id, e.name, e.placeholder, e.getAttribute('aria-label')].filter(Boolean).join(' ')));
  const nameField = d => d.querySelector('#input-for-name') || [...d.querySelectorAll('input')].find(e => visible(e) && !/meeting id|personal link/i.test([e.id, e.name, e.placeholder, e.getAttribute('aria-label')].filter(Boolean).join(' ')) && /\b(your name|display name|screen name|participant name|name)\b/i.test([e.id, e.name, e.placeholder, e.getAttribute('aria-label')].filter(Boolean).join(' ')));
  const passField = d => d.querySelector('#input-for-pwd') || field(d, /passcode|meeting password|password/i);
  const joinButton = d => {
    const direct = d.querySelector('#joinBtn, .btn-join');
    return direct && visible(direct) ? direct : findButton(d, /^(join|join meeting)$/i);
  };
  let prejoin = null, nameInput = null, passInput = null, join = null;
  for (const d of candidates) {
    const n = nameField(d), p = passField(d);
    const j = joinButton(d);
    if (n || p || d.querySelector('video') || visible(d.querySelector('.join-dialog')) || (d === webclient && j)) {
      prejoin = d; nameInput = n; passInput = p; join = j;
      break;
    }
  }
  if (!prejoin) {
    if (document.querySelector('[title="In a Zoom meeting"]')) return {state:'loading'};
    if (location.pathname.replace(/\/+$/,'') === '/wc/join' && docs.some(d => [...d.querySelectorAll('input')].some(e => visible(e) && /meeting id/i.test(e.placeholder)))) return {state:'error', message:'Zoom could not open this meeting. Check the meeting ID.'};
    if (docs.some(d => [...d.querySelectorAll('button,[role="button"]')].some(e => visible(e) && /^sign in$/i.test(text(e))))) return {state:'signin'};
    return {state:'idle'};
  }

  const reject = prejoin.querySelector('#onetrust-reject-all-handler');
  if (visible(reject)) { click(reject); return {state:'loading'}; }
  const agree = prejoin.querySelector('#wc_agree1');
  if (visible(agree)) { click(agree); return {state:'loading'}; }

  if (passInput && !passInput.value.trim()) {
    if (!passcode) return {state:'passcode'};
    setValue(passInput, passcode);
  }
  if (nameInput && (overrideName || !nameInput.value.trim())) {
    if (!name) return {state:'name'};
    setValue(nameInput, name);
  }
  if (!join || !visible(join) || !enabled(join)) return {state:'prejoin'};
  if (prejoin.documentElement.dataset.zoomControlsJoinAttempted === '1') return {state:'joining'};
  prejoin.documentElement.dataset.zoomControlsJoinAttempted = '1';
  if (!click(join)) {
    delete prejoin.documentElement.dataset.zoomControlsJoinAttempted;
    return {state:'prejoin'};
  }
  return {state:'joining'};
}

// Serialized into the already-selected Zoom page; only visible home controls.
export async function zoomHome(action) {
  const visible = e => !!e && e.checkVisibility() && e.getClientRects().length > 0;
  const find = label => [...document.querySelectorAll('button')].find(e => visible(e) && (e.getAttribute('aria-label') || e.innerText).trim().toLowerCase() === label);
  const joinInput = () => [...document.querySelectorAll('input')].find(e => visible(e) && /meeting id/i.test(e.placeholder));
  const click = e => { if (!e || e.disabled || e.getAttribute('aria-disabled') === 'true') throw new Error('Open Zoom and sign in to use this action.'); e.click(); };
  const waitFor = async fn => { for (let n=0;n<60;n++) {if(fn()) return; await new Promise(r=>setTimeout(r,50));} throw new Error('Zoom did not open the requested screen.'); };
  if (action === 'join' && joinInput()) return {ok:true};
  if (joinInput()) {click(find('cancel'));await waitFor(()=>!joinInput());}
  if (action === 'start') {
    await waitFor(() => find('new meeting'));
    click(find('new meeting'));
    return {ok:true, verifyStarted:true};
  }
  if (action === 'join') {
    click(find('join'));
    await waitFor(joinInput);
    return {ok:true};
  }
  throw new Error('Unknown Zoom home action.');
}
