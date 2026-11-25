import {stageUpload,claimPage} from './staged-report.mjs';
import {freshRequest,startGalaxyCapture,issueCaptureCode,resolveCaptureCode} from './drive-logs.mjs';
import {freshCapturePage} from './fresh-capture.mjs';
const PAGE = '/report/galaxy';
const MANUAL = PAGE + '/manual';
const OAUTH_COOKIE = '__Host-galaxy-discord-oauth';
const SESSION_COOKIE = '__Host-galaxy-discord-report';
const STATE_PREFIX = 'galaxy_web_';
const MAX_ARCHIVE = 8 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const encode = value => new TextEncoder().encode(value);
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const unb64 = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), ch => ch.charCodeAt(0));
const nonce = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const cookie = (name, value, age) => name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + age;

async function cookieKey(secret, name) {
  const key = await crypto.subtle.digest('SHA-256', encode(name + '\0' + secret));
  return crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt','decrypt']);
}

async function seal(secret, name, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv}, await cookieKey(secret,name), encode(JSON.stringify(payload))));
  return b64(iv) + '.' + b64(data);
}

async function openCookie(request, secret, name) {
  try {
    const value = request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length+1);
    if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/.test(value)) return null;
    const [iv, data] = value.split('.').map(unb64);
    const decoded = await crypto.subtle.decrypt({name:'AES-GCM',iv}, await cookieKey(secret,name), data);
    const payload = JSON.parse(new TextDecoder().decode(decoded));
    return payload.expires > Date.now() ? payload : null;
  } catch { return null; }
}

function redirect(url, cookies = []) {
  const headers = new Headers({'Location':url, 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer'});
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, {status:303, headers});
}

function page({user, error = '', reference = crypto.randomUUID(), description = '', thread, status = 200, cookies = []} = {}) {
  const headers = new Headers({
    'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'same-origin',
    'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  for (const value of cookies) headers.append('Set-Cookie', value);
  const message = error ? '<p role="alert" class="error">'+escape(error)+'</p>' : '';
  let content;
  if (thread) {
    content = '<h2>Report sent</h2><p>Reference <code>'+escape(reference)+'</code></p><a class="button" href="'+escape(thread)+'">Open support thread</a>';
  } else if (!user) {
    content = '<p>Sign in with Discord to send a report and follow support replies.</p><a class="button" href="'+PAGE+'/sign-in?return='+encodeURIComponent(MANUAL)+'">Sign in with Discord</a>';
  } else {
    content = '<p>Signed in as <strong>'+escape(user.global_name || user.username)+'</strong></p>'
      + '<p>Your description goes to the StarPilot support forum. Your diagnostic ZIP goes to the private support forum.</p>'
      + '<form method="post" enctype="multipart/form-data"><input type="hidden" name="reference" value="'+escape(reference)+'">'
      + '<label for="description">What happened?</label><textarea id="description" name="description" rows="5" maxlength="1000" required>'+escape(description)+'</textarea>'
      + '<label for="attachment">Diagnostic ZIP</label><input type="file" id="attachment" name="attachment" accept=".zip,application/zip" required>'
      + '<p>Choose the ZIP from Galaxy’s Download ZIP button or StarPilot’s Export logs.</p><button>Send report</button></form>'
      + '<form method="post" action="'+PAGE+'/sign-out"><button class="secondary">Sign out</button></form>';
  }
  const capture = thread ? '' : '<a class="button" href="'+PAGE+'/new/connection">Capture logs in Galaxy</a>'
    + ' <a class="button secondary" href="'+PAGE+'/new/controller">Capture controller logs</a>';
  if (!thread) content = '<details class="manual"><summary>Manual ZIP upload</summary>'+content+'</details>';
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Report a Galaxy issue</title><style>'
    + ':root{color-scheme:light dark;font:16px system-ui}body{margin:0;background:#141120;color:#f5efff}main{max-width:38rem;margin:auto;padding:2rem 1.2rem 3rem}'
    + 'h1{line-height:1.15}p{line-height:1.55;color:#d4c8e5}form{display:grid;gap:.65rem;margin:1.2rem 0}label{font-weight:650}'
    + 'textarea,input{font:inherit;color:inherit}textarea{box-sizing:border-box;width:100%;padding:.75rem;border:1px solid #64557a;border-radius:.6rem;background:#201a2d}input{max-width:100%}'
    + 'button,.button{justify-self:start;display:inline-block;font:inherit;font-weight:650;padding:.7rem 1rem;border:none;border-radius:.6rem;background:#c7a5ff;color:#1b102a;text-decoration:none;cursor:pointer}'
    + '.secondary{background:#352847;color:#f5efff}.error{color:#ffb8c9}.manual{margin-top:1.25rem;font-size:.875rem;color:#d4c8e5}.manual summary{cursor:pointer}</style>'
    + '<main><h1>Galaxy support</h1>'+message+capture+content+'</main></html>', {status, headers});
}

async function bounded(body, limit) {
  if (!body) throw new Error('Missing diagnostics');
  const reader = body.getReader(), chunks = [];
  let length = 0;
  while (true) {
    const {done,value} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error('The diagnostic archive is too large');
    }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

async function diagnosticText(file) {
  if (!(file instanceof Blob) || file.size < 52 || file.size > MAX_ARCHIVE) throw new Error('Choose a diagnostic ZIP under 8 MB');
  const data = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(data.buffer);
  const end = data.length - 22;
  if (view.getUint32(0,true) !== 0x04034b50 || view.getUint32(end,true) !== 0x06054b50 ||
      view.getUint16(end+10,true) !== 1 || view.getUint16(6,true) !== 0) throw new Error('Choose a StarPilot or Galaxy diagnostic ZIP');
  const method = view.getUint16(8,true), compressed = view.getUint32(18,true), expanded = view.getUint32(22,true);
  const nameEnd = 30 + view.getUint16(26,true), start = nameEnd + view.getUint16(28,true);
  const directory = view.getUint32(end+16,true);
  const name = new TextDecoder().decode(data.subarray(30,nameEnd));
  if (!['diagnostics.txt','connection-logs.txt','bluetooth-log.json'].includes(name) || start + compressed !== directory || expanded > MAX_ARCHIVE ||
      directory > end - 46 || view.getUint32(directory,true) !== 0x02014b50 || ![0,8].includes(method)) throw new Error('Choose a StarPilot or Galaxy diagnostic ZIP');
  let bytes = data.subarray(start,directory);
  if (method === 8) bytes = await bounded(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')), expanded);
  if (bytes.length !== expanded) throw new Error('The diagnostic ZIP is incomplete');
  const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
  if (!text.trim()) throw new Error('The diagnostic ZIP is empty');
  return {logs:text, ...(name === 'bluetooth-log.json' ? {controllerLog:true} : {})};
}

export function browserDiscordCallback(url) {
  return url.pathname === '/auth/discord/callback' && /^galaxy_web_[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') || '');
}

export async function galaxyReportPage(request, env, {base, callback, discord, submit}) {
  const url = new URL(request.url);
  const secret = env.DISCORD_CLIENT_SECRET;
  if (!env.DISCORD_CLIENT_ID || !secret) return page({error:'Discord sign-in is unavailable.',status:503});
  if (request.method === 'GET' && url.pathname === PAGE + '/sign-in') {
    const state = STATE_PREFIX + nonce(), verifier = nonce();
    const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256',encode(verifier))));
    const target = new URL('https://discord.com/oauth2/authorize');
    target.search = new URLSearchParams({client_id:env.DISCORD_CLIENT_ID, redirect_uri:callback, response_type:'code', scope:'identify',
      state, code_challenge:challenge, code_challenge_method:'S256'}).toString();
    const returnPath = url.searchParams.get('return') || PAGE;
    const next = returnPath === MANUAL || /^\/report\/galaxy\/(?:(?:fresh|starport-auth|claim)\/[a-f0-9]{64}|new\/(?:connection|controller|starport))$/.test(returnPath) ? returnPath : PAGE;
    const transaction = await seal(secret,OAUTH_COOKIE,{state,verifier,next,expires:Date.now()+600000});
    return redirect(target.href,[cookie(OAUTH_COOKIE,transaction,600)]);
  }
  if (request.method === 'GET' && browserDiscordCallback(url)) {
    const transaction = await openCookie(request,secret,OAUTH_COOKIE);
    const code = url.searchParams.get('code'), cookies = [cookie(OAUTH_COOKIE,'',0)];
    if (!transaction || transaction.state !== url.searchParams.get('state') || url.searchParams.get('iss') !== 'https://discord.com' ||
        !code || code.length > 2048) return page({error:'Discord sign-in couldn’t be completed. Try again.',cookies,status:400});
    const token = await discord('/oauth2/token',{method:'POST',body:new URLSearchParams({
      client_id:env.DISCORD_CLIENT_ID, client_secret:secret, grant_type:'authorization_code', code, code_verifier:transaction.verifier, redirect_uri:callback,
    })});
    if (!token.ok) return page({error:'Discord sign-in expired or was declined. Try again.',cookies,status:401});
    const {access_token:accessToken} = await token.json();
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 2048) return page({error:'Discord returned incomplete sign-in details.',cookies,status:401});
    const identity = await discord('/oauth2/@me',{headers:{Authorization:'Bearer '+accessToken}});
    if (!identity.ok) return page({error:'Could not verify Discord sign-in. Try again.',cookies,status:401});
    const auth = await identity.json();
    if (auth.application?.id !== env.DISCORD_CLIENT_ID || !auth.scopes?.includes('identify') || !/^\d{1,20}$/.test(auth.user?.id || '') ||
        typeof auth.user.username !== 'string') return page({error:'Invalid Discord authorization.',cookies,status:403});
    const user = {id:auth.user.id, username:auth.user.username.slice(0,80),
      global_name:typeof auth.user.global_name === 'string' ? auth.user.global_name.slice(0,80) : ''};
    const session = await seal(secret,SESSION_COOKIE,{user,expires:Date.now()+3600000});
    cookies.push(cookie(SESSION_COOKIE,session,3600));
    return redirect(transaction.next || PAGE,cookies);
  }
  const {user} = await openCookie(request,secret,SESSION_COOKIE) || {};
  if(url.pathname===PAGE+'/stage')return stageUpload(request,env,{base,bounded,diagnosticText});
  const claim=/^\/report\/galaxy\/claim\/([a-f0-9]{64})$/.exec(url.pathname);
  if(claim)return claimPage(request,env,{base,user,token:claim[1],escape});
  const approvalObject=challenge=>env.REPORTS.get(env.REPORTS.idFromName('drive-log:starport-approval:'+challenge));
  const authorization=/^\/report\/galaxy\/starport-auth\/([a-f0-9]{64})$/.exec(url.pathname);
  if(authorization){
    const html=(body,status=200)=>new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>StarPort support</title><style>body{color-scheme:dark;background:#171221;color:#f7f3ff;font:1rem/1.55 system-ui;max-width:32rem;margin:8vh auto;padding:1rem}a,button{font:inherit;color:#211531;background:#d2b5ff;border:0;border-radius:.7rem;padding:.65rem 1rem;display:inline-block}</style><main><h1>StarPort support</h1>'+body+'</main>',{status,headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"}});
    if(!user)return redirect(PAGE+'/sign-in?return='+encodeURIComponent(url.pathname));
    if(request.method==='GET')return html('<p>Signed in as <strong>'+escape(user.global_name||user.username)+'</strong>.</p><p>Allow the Galaxy session you opened to submit one StarPort report with this account.</p><form method="post"><button>Allow this report</button></form>');
    if(request.method!=='POST'||request.headers.get('Origin')!==base)return html('<p>Reopen sign-in from Galaxy.</p>',403);
    const ticket=await startGalaxyCapture(env,base,user.id,'starport');
    if(ticket.status!==303)return html('<p>Could not start your report. Try again from Galaxy.</p>',503);
    const code=await issueCaptureCode(env,ticket.headers.get('Location').split('/').pop(),user);
    const stored=await approvalObject(authorization[1]).fetch('https://reports/drive/authorize-starport',{method:'POST',body:JSON.stringify({kind:'starport-approval',userID:user.id,code,expires:Date.now()+600000})});
    return stored.ok?html('<p>Return to Galaxy and press <strong>Send report</strong> within 10 minutes.</p>'):html('<p>Start another report from Galaxy.</p>',stored.status);
  }
  if(url.pathname===PAGE+'/starport-claim' && request.method==='POST'){
    const verifier=request.headers.get('X-StarPort-Verifier')||'';
    if(!/^[a-f0-9]{64}$/.test(verifier))return Response.json({error:'Invalid session'},{status:400});
    const hash=await crypto.subtle.digest('SHA-256',encode(verifier));
    const challenge=Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');
    return approvalObject(challenge).fetch('https://reports/drive/starport-approval');
  }
  if (url.pathname === PAGE+'/starport/upload') {
    const fail=(error,status)=>Response.json({error},{status});
    if(request.method!=='POST'||request.headers.get('content-type')!=='application/zip')return fail('StarPort ZIP required.',415);
    const target=await resolveCaptureCode(env,request.headers.get('X-Galaxy-Code'));
    if(target?.ticket.kind!=='starport')return fail('Open the StarPort request for a fresh code.',410);
    let note;
    try{note=decodeURIComponent(request.headers.get('X-StarPort-Note')||'').trim();}catch{return fail('Invalid report description.',400);}
    if(!note||note.length>240)return fail('Add a short description.',400);
    let bytes;
    try{bytes=await bounded(request.body,10*1024*1024-65536);}catch{return fail('StarPort ZIP exceeds the attachment limit.',413);}
    if(bytes.length<22||new DataView(bytes.buffer).getUint32(0,true)!==0x04034b50)return fail('Invalid StarPort ZIP.',400);
    const {ticket,user:reporter}=target;
    const form=new FormData();
    form.set('metadata',JSON.stringify({user:reporter,platform:ticket.platform,threadID:ticket.threadID,reference:ticket.reference,description:note,source:'starport',deviceCapture:true}));
    form.set('archive',new Blob([bytes],{type:'application/zip'}),'starport.zip');
    return env.REPORTS.get(env.REPORTS.idFromName(reporter.id)).fetch('https://reports/submit-starport',{method:'POST',body:form});
  }
  if (url.pathname === PAGE+'/device') {
    const error = (message,status) => Response.json({error:message},{status,headers:{'Cache-Control':'no-store'}});
    if (request.method !== 'POST' || request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') return error('JSON POST required',415);
    let data;
    try {data=JSON.parse(new TextDecoder().decode(await bounded(request.body,140000)));} catch {return error('Invalid request',400);}
    const target = await resolveCaptureCode(env,data?.code);
    if (!target) return error('Code expired or incorrect. Open the request in Discord for a fresh code.',410);
    const {ticket,user:reporter}=target;
    if(data.action==='check') return Response.json({title:ticket.title || 'New StarPort report',kind:ticket.kind},{headers:{'Cache-Control':'no-store'}});
    if(ticket.kind==='starport'||data.action!=='send' || typeof data.archive!=='string' || data.archive.length>131072) return error('Invalid capture',400);
    let diagnostic;
    try {
      diagnostic=await diagnosticText(new Blob([Uint8Array.from(atob(data.archive),c=>c.charCodeAt(0))]));
      if(Boolean(diagnostic.controllerLog)!==(ticket.kind==='controller')) throw Error();
    } catch {return error('Unexpected diagnostic archive',400);}
    const sent=await submit({deviceCapture:true,user:reporter,platform:ticket.platform,threadID:ticket.threadID,reference:ticket.reference,
      description:'Fresh '+ticket.kind+' logs requested by support.',...diagnostic});
    const receipt=await sent.json();
    if (!sent.ok || !receipt.sent || !new RegExp('^https://discord[.]com/channels/[0-9]+/'+ticket.threadID+'/[0-9]+$').test(receipt.threadURL))
      return error(receipt.error || 'Delivery could not be confirmed. Check your thread.',sent.ok?502:sent.status);
    return Response.json({sent:true},{headers:{'Cache-Control':'no-store'}});
  }
  const start = /^\/report\/galaxy\/new\/(connection|controller|starport)$/.exec(url.pathname);
  if (start) {
    if (request.method === 'GET') {
      const id = nonce();
      const action = user ? '<p>Signed in as '+escape(user.global_name || user.username)+'</p><form method="post"><button>Continue to capture</button></form>' :
        '<a href="'+PAGE+'/sign-in?return='+encodeURIComponent(url.pathname)+'">Sign in with Discord</a>';
      return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Galaxy support</title><style>body{font:1rem/1.55 system-ui;max-width:32rem;margin:8vh auto;padding:1rem}button{font:inherit;padding:.5rem}</style><main><h1>Send '+start[1]+' logs</h1><p>Your logs go to the private support forum.</p>'+action+'</main><script nonce="'+id+'">try {const u=new URL(decodeURIComponent(location.hash.slice(1)));if (["http:","https:"].includes(u.protocol)&&!u.username&&!u.password&&(/^(10[.]|192[.]168[.]|172[.](1[6-9]|2[0-9]|3[01])[.])/.test(u.hostname)&&/^[0-9.]+$/.test(u.hostname)))localStorage.setItem("galaxy-local-address",u.origin);else localStorage.removeItem("galaxy-local-address");} catch {} history.replaceState(null,"",location.pathname);</script>',{headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-"+id+"'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
    }
    if (!user) return page({error:'Sign in with Discord to continue.',status:401});
    if (request.method !== 'POST' || request.headers.get('Origin') !== base) return redirect(url.pathname);
    return startGalaxyCapture(env,base,user.id,start[1]);
  }
  const fresh = /^\/report\/galaxy\/fresh\/([a-f0-9]{64})$/.exec(url.pathname);
  if (fresh) {
    const ticket = await freshRequest(env, fresh[1]);
    if (!ticket) return page({error:'This request has expired. Ask support for a new link.',status:410});
    return freshCapturePage({request,user,ticket,token:fresh[1],base,diagnosticText,bounded,submit,escape,issueCode:()=>issueCaptureCode(env,fresh[1],user)});
  }
  if (request.method === 'GET' && url.pathname === PAGE) {
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Galaxy support</title>
      <style>body{font:1rem/1.55 system-ui;max-width:32rem;margin:8vh auto;padding:1rem;color-scheme:light dark}a{display:block;margin:.8rem 0}</style>
      <main><h1>Galaxy support</h1><p>Galaxy captures and attaches the diagnostics for you. Your logs go to the private support forum.</p>
      <a href="${PAGE}/new/connection">Send connection logs</a><a href="${PAGE}/new/controller">Send Bluetooth controller logs</a>
      <details><summary>Manual upload</summary><a href="${MANUAL}">Attach an existing ZIP</a></details></main></html>`,
      {headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"}});
  }
  if (request.method === 'GET' && url.pathname === MANUAL) return page({user});
  if (request.method !== 'POST' || request.headers.get('Origin') !== base) return page({user,error:'Open the report form to continue.',status:403});
  if (url.pathname === PAGE + '/sign-out') return redirect(PAGE,[cookie(SESSION_COOKIE,'',0)]);
  if (![PAGE, MANUAL].includes(url.pathname) || !user) return page({error:'Sign in with Discord before sending.',status:401});

  let description = '', reference;
  try {
    const type = request.headers.get('Content-Type');
    if (!type?.startsWith('multipart/form-data;')) throw new Error('Choose a diagnostic ZIP');
    const content = await bounded(request.body,MAX_ARCHIVE+64*1024);
    const form = await new Response(content,{headers:{'Content-Type':type}}).formData();
    description = String(form.get('description') || '').trim().slice(0,1000);
    reference = String(form.get('reference') || '');
    if (!description || !UUID.test(reference)) return page({user,description,error:'Add a short description and attach a diagnostic ZIP.',status:400});
    let diagnostic;
    try { diagnostic = await diagnosticText(form.get('attachment')); }
    catch { return page({user,reference,description,error:'Choose an intact StarPilot or Galaxy diagnostic ZIP under 8 MB.',status:400}); }
    const response = await submit({user,reference,description,...diagnostic});
    const result = await response.json();
    if (response.ok && result.sent && /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(result.threadURL || '')) {
      return page({user,reference,thread:result.threadURL});
    }
    return page({user,reference,description,error:result.error || 'Delivery wasn’t confirmed. Check your support threads before resending.',status:response.status});
  } catch { return page({user,reference,description,error:'Could not process the report. Check the ZIP and try again.',status:400}); }
}

