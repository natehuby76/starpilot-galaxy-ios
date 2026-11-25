import {galaxyLogSteps} from './galaxy-log-request.mjs';
// A Discord request carries only its ticket identifier into the local Galaxy page.
export async function freshCapturePage({request, user, ticket, token, base, diagnosticText, bounded, submit, escape, issueCode}) {
  const path = '/report/galaxy/fresh/' + token;
  const starport=ticket.kind==='starport';
  const label = starport?'StarPort':ticket.kind === 'controller' ? 'controller' : 'connection';
  const nonce = crypto.randomUUID().replaceAll('-', '');
  function screen(content, status = 200) {
    return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Send fresh logs</title><style>:root{color-scheme:dark;font:16px/1.55 system-ui;background:#100e18;color:#f4efff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#312348,transparent 70%);min-height:100vh;padding:clamp(1rem,5vw,3rem)}main{margin:auto;max-width:34rem;background:#201b30;border:1px solid #493d60;border-radius:1.25rem;padding:clamp(1rem,4vw,2rem)}h1{font-size:1.6rem;line-height:1.2;margin:.3rem 0 1rem}p{color:#ddd4ec}a,summary{color:#d9bfff}button{background:#c9a6ff;color:#20122f;border:0;border-radius:1rem;padding:.65rem 1.1rem;font:inherit;font-weight:650;cursor:pointer}input{font:inherit;max-width:100%}details{margin-top:1.25rem;border-top:1px solid #493d60;padding-top:1rem}summary{cursor:pointer}.code{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.8rem;padding:1rem;border:1px solid #715291;background:#181322;border-radius:1rem}.code strong{font:600 clamp(1rem,5vw,1.5rem) ui-monospace,monospace;user-select:all}.brand{color:#d1affb;font-weight:650}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #efe4ff;outline-offset:3px}</style><main><div class="brand">✦ StarPilot Support</div><h1>Send fresh '+label+' logs</h1>'+content+'</main></html>', {
      status, headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}
    });
  }
  const signIn = '<a href="/report/galaxy/sign-in?return='+encodeURIComponent(path)+'">Sign in with Discord</a>';
  if (request.method === 'GET') {
    if (!user) return screen(signIn);
    if (user.id !== ticket.userID) return screen('Open this request with the Discord account that filed the report.',403);
    const guide=ticket.threadID?'<ol>'+galaxyLogSteps(ticket).map(step=>'<li>'+escape(step)+'</li>').join('')+'</ol>':'';
    let deviceInstructions = "";
    if (ticket.threadID || starport) {
      const code=await issueCode();
      const codeCard='<div class="code"><strong>'+code.match(/.{4}/g).join(' ')+'</strong><button id="copy-code" type="button">Copy code</button></div><p id="copy-status" role="status"></p>';
      const copyScript='<script nonce="'+nonce+'">const copy=document.getElementById("copy-code");copy.onclick=async()=>{const el=copy.previousElementSibling;try{await navigator.clipboard.writeText(el.textContent.replaceAll(" ",""));copy.textContent="Copied";document.getElementById("copy-status").textContent="Ready to paste into Galaxy."}catch{const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.getElementById("copy-status").textContent="Code selected. Use Copy on your device."}};</script>';
      if(starport)return screen(guide+(guide?'<details><summary>Earlier Galaxy versions</summary>':'')+'<p>'+escape(ticket.title||'New StarPort report')+'</p>'+codeCard+'<p>This private code expires in 10 minutes.</p><p>In <strong>Galaxy → Logs &amp; Diagnostics → StarPort Logs</strong>, paste the code, check the report title, describe what happened and press <strong>Send StarPort logs</strong>.</p><p>Your description goes to the support thread. Only staff receive the session ZIP.</p>'+copyScript+(guide?'</details>':''));
      const panel=ticket.kind==='controller'?'Bluetooth':'Networks';
      deviceInstructions = '<p>'+escape(ticket.title)+'</p><p>Your private code expires in 10 minutes.</p>'+codeCard+'<p>If the phone app cannot reach Galaxy, use the comma screen or open Galaxy in a browser. For browser access, connect to the same Wi-Fi as the comma or join its hotspot, then open the <strong>Local Galaxy address</strong> shown on the comma.</p><p>In <strong>Galaxy → Galaxy Access &amp; Connections → '+panel+'</strong>. Scroll to <strong>Connection logs</strong> and choose <strong>Send to existing Discord thread</strong>.</p><p>The comma needs internet to find the report and send logs. If it is offline, connect it to Wi-Fi with internet or to your phone’s hotspot.</p><p>Enter the code, tap <strong>Find report</strong>, check the title, then tap <strong>Capture and send</strong>. Only support staff receive the logs.</p>';
      deviceInstructions=guide+'<details><summary>Earlier Galaxy versions</summary>'+deviceInstructions+'</details>';
      deviceInstructions += '<details><summary>Comma offline? Save a ZIP and send it later</summary><ol><li>On your phone, join the comma’s hotspot or the same Wi-Fi. Open the Local Galaxy address shown on the comma in your browser. Stay on that Wi-Fi even if it has no internet.</li><li>Open the same topic under <strong>Logs &amp; Diagnostics → Get help</strong> and choose <strong>Download ZIP instead</strong>. Save the file on your phone.</li><li>Once your phone has internet, reopen <strong>Offline ZIP help</strong> in the original Discord thread, expand this section, and select the saved ZIP. The comma can stay offline. If the request link expired, ask support for a fresh link in that thread.</li></ol><form id="offline-upload" method="post"><label>Diagnostic ZIP <input id="offline-file" type="file" accept=".zip,application/zip" required></label><input type="hidden" name="archive"><button>Review ZIP for this report</button><p role="status" id="offline-status"></p></form></details>';

      deviceInstructions+=copyScript;
    }
    return screen(deviceInstructions+(deviceInstructions?'<details><summary>Use Galaxy in a web browser</summary>':'')+'<p>'+escape(ticket.title || 'New Galaxy support report')+'</p><button id="open-galaxy" type="button" hidden>Open Galaxy</button><p id="missing-address">This browser did not receive your Galaxy address. If Galaxy is already open in your browser, go back to that tab and start from <strong>Send to Discord support</strong>. You can also use the local Galaxy address shown on your comma.</p><details><summary>Use a different Galaxy address</summary><form id="launch"><label>Galaxy address<input id="address" required placeholder="192.168.1.17:8082"></label><button>Open address</button><p id="status" role="status"></p></form></details><script nonce="'+nonce+'">'+
      `const field=document.getElementById('address');
      const upload=document.getElementById('offline-upload');
      if(upload)upload.onsubmit=async event=>{
        event.preventDefault();
        const file=document.getElementById('offline-file').files[0];
        const status=document.getElementById('offline-status');
        if(!file||!file.size||file.size>98304){status.textContent='Choose a Galaxy diagnostic ZIP up to 96 KiB.';return;}
        try{
          const bytes=new Uint8Array(await file.arrayBuffer());
          upload.elements.archive.value=btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join(''));
          upload.submit();
        }catch{status.textContent='Could not read the ZIP. Select the downloaded file again.';}
      };
      const primary=document.getElementById('open-galaxy');
      const localAddress=raw=>{
        const url=new URL(raw.includes('://')?raw:'http://'+raw);
        const ip=url.hostname.split('.').map(Number);
        if(!['http:','https:'].includes(url.protocol)||url.username||url.password||ip.length!==4||!ip.every(Number.isInteger)||!(ip[0]===10||ip[0]===192&&ip[1]===168||ip[0]===172&&ip[1]>=16&&ip[1]<=31))throw Error();
        if(!url.port && !raw.includes('://'))url.port='8082';
        return url;
      };
      let destination;
      try {
        const saved=localStorage.getItem('galaxy-local-address');
        if(saved){
          destination=localAddress(saved);
          primary.hidden=false;
          document.getElementById('missing-address').hidden=true;
          field.value=destination.origin;
        }
      } catch {try {localStorage.removeItem('galaxy-local-address');} catch {}}
      const openGalaxy=url=>{
        url.pathname='/';url.search='';url.hash='/logs/help/fresh/${ticket.kind}/${token}';location.assign(url.href);
      };
      primary.onclick=()=>{if(destination)openGalaxy(destination);};
      document.getElementById('launch').onsubmit=e=>{
        e.preventDefault();
        try {
          const url=localAddress(field.value.trim());
          try {localStorage.setItem('galaxy-local-address',url.origin);} catch {}
          openGalaxy(url);
        } catch {document.getElementById('status').textContent='Enter the local IPv4 address shown on your comma.';}
      };</script>`+(deviceInstructions?'</details>':''));
  }
  if(starport)return screen('Send the StarPort bundle from Galaxy.',405);
  if(request.method !== 'POST') return screen('Open the request link to continue.',405);
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return screen('Unsupported capture format.',415);
  let form;
  try {form=new URLSearchParams(new TextDecoder().decode(await bounded(request.body,450000)));} catch {return screen('Capture exceeds the size limit.',413);}
  const archive=form.get('archive') || '';
  if (archive.length>131072 || !/^[A-Za-z0-9+/]+={0,2}$/.test(archive)) return screen('Invalid capture. Open Galaxy and try again.',400);
  if (form.get('confirm') !== 'yes') {
    const prompt=ticket.threadID ? 'Send fresh logs to your existing report?' : 'Send a new support report?';
    const description=ticket.threadID ? '' : '<label>What happened?<textarea name="description" maxlength="1000" required></textarea></label>';
    return screen('<h2>'+prompt+'</h2><p>Only support staff receive the capture.</p><form method="post">'+description+'<input type="hidden" name="confirm" value="yes"><input type="hidden" name="archive" value="'+archive+'"><button>Send to this report</button></form>');
  }
  if(request.headers.get('Origin')!==base || !user || user.id!==ticket.userID) return screen('Reopen the request in the browser where you signed in. '+signIn,403);
  let diagnostic;
  try {
    const file=new Blob([Uint8Array.from(atob(archive),c=>c.charCodeAt(0))]);
    diagnostic=await diagnosticText(file);
    if(Boolean(diagnostic.controllerLog)!==(ticket.kind==='controller')) throw Error();
  } catch {return screen('Galaxy returned an unexpected capture. Open the request and capture again.',400);}
  const description=ticket.threadID ? 'Fresh '+label+' logs requested by support.' : (form.get('description')||'').trim().slice(0,1000);
  if(!description) return screen('Describe what happened before sending.',400);
  const response=await submit({user, platform:ticket.platform,threadID:ticket.threadID,reference:ticket.reference,description,...diagnostic});
  const result=await response.json();
  if(!response.ok||!result.sent)return screen(escape(result.error || 'Delivery could not be confirmed.'),response.ok?502:response.status);
  const receipt = /^https:\/\/discord\.com\/channels\/\d+\/(\d+)\/\d+$/.exec(result.threadURL || '');
  if (!receipt || (ticket.threadID && receipt[1] !== ticket.threadID)) return screen('Check your support thread for the receipt.',502);
  return screen('<p>Support received your logs.</p><a href="'+escape(result.threadURL)+'">Return to your report</a>');
}

