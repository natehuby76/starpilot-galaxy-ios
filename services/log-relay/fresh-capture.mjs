// A Discord request carries only its ticket identifier into the local Galaxy page.
export async function freshCapturePage({request, user, ticket, token, base, diagnosticText, bounded, submit, escape}) {
  const path = '/report/galaxy/fresh/' + token;
  const label = ticket.kind === 'controller' ? 'controller' : 'connection';
  const nonce = crypto.randomUUID().replaceAll('-', '');
  function screen(content, status = 200) {
    return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Send fresh logs</title><style>body{font:1rem/1.55 system-ui;max-width:32rem;margin:8vh auto;padding:1rem}input,button{font:inherit;padding:.5rem}label{display:block}</style><main><h1>Send fresh '+label+' logs</h1>'+content+'</main></html>', {
      status, headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}
    });
  }
  const signIn = '<a href="/report/galaxy/sign-in?return='+encodeURIComponent(path)+'">Sign in with Discord</a>';
  if (request.method === 'GET') {
    if (!user) return screen(signIn);
    if (user.id !== ticket.userID) return screen('Open this request with the Discord account that filed the report.',403);
    return screen('<p>'+escape(ticket.title || 'New Galaxy support report')+'</p><form id="launch"><label>Local Galaxy address from your comma<input id="address" required placeholder="192.168.1.17:8082"></label><button>Open Galaxy</button></form><p><button id="on-comma" type="button">I’m on the comma screen</button></p><p id="status" role="status"></p><script nonce="'+nonce+'">'+
      `const field=document.getElementById('address');
      try {field.value=localStorage.getItem('galaxy-local-address')||'';} catch {}
      const openGalaxy=url=>{
        url.pathname='/';url.search='';url.hash='/logs/help/fresh/${ticket.kind}/${token}';location.assign(url.href);
      };
      document.getElementById('on-comma').onclick=()=>openGalaxy(new URL('http://127.0.0.1:8082'));
      document.getElementById('launch').onsubmit=e=>{
        e.preventDefault();
        try {
          const raw=field.value.trim(), url=new URL(raw.includes('://')?raw:'http://'+raw);
          const ip=url.hostname.split('.').map(Number);
          if(!['http:','https:'].includes(url.protocol)||url.username||url.password||ip.length!==4||!ip.every(Number.isInteger)||!(ip[0]===10||ip[0]===192&&ip[1]===168||ip[0]===172&&ip[1]>=16&&ip[1]<=31))throw Error();
          if(!url.port && !raw.includes('://'))url.port='8082';
          try {localStorage.setItem('galaxy-local-address',url.origin);} catch {}
          openGalaxy(url);
        } catch {document.getElementById('status').textContent='Enter the local IPv4 address shown on your comma.';}
      };</script>`);
  }
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

