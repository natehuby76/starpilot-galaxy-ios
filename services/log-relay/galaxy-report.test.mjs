import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker from './worker.mjs';
import {diagnosticZip} from './diagnostic-zip.mjs';

const base = 'https://starpilot-log-relay.nathan-g-hubbard.workers.dev';
const web = '/report/galaxy';
const reference = '9a000000-0000-4000-8000-000000000001';
const env = {DISCORD_CLIENT_ID:'123', DISCORD_CLIENT_SECRET:'test-secret'};

test('Galaxy browser OAuth returns to a private report form and submits only the selected ZIP', async () => {
  const originalFetch = globalThis.fetch, discordCalls = [], sends = [];
  globalThis.fetch = async (url, options) => {
    discordCalls.push(url);
    if (url.endsWith('/oauth2/token')) {
      assert.equal(options.body.get('redirect_uri'), base + '/auth/discord/callback');
      const verifier = options.body.get('code_verifier');
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      assert.equal(Buffer.from(hash).toString('base64url'), challenge);
      return Response.json({access_token:'secret-token',refresh_token:'secret-refresh'});
    }
    assert.ok(url.endsWith('/oauth2/@me'));
    assert.equal(options.headers.Authorization, 'Bearer secret-token');
    return Response.json({application:{id:'123'},scopes:['identify'],user:{id:'555',username:'test',global_name:'<Sample>'}});
  };
  const runtime = {...env,REPORTS:{
    idFromName(id) { assert.equal(id,'555'); return id; },
    get() { return {async fetch(path, options) {
      assert.equal(path,'https://reports/submit');
      sends.push(JSON.parse(options.body));
      return Response.json({sent:true,threadURL:'https://discord.com/channels/1/2/3'});
    }}; },
  }};
  const open = (path, options) => worker.fetch(new Request(base+path,options),runtime);
  let challenge;
  try {
    assert.match(await (await open(web)).text(), /Sign in with Discord/);
    const start = await open(web+'/sign-in');
    assert.equal(start.status,303);
    const authorize = new URL(start.headers.get('Location'));
    assert.equal(authorize.origin,'https://discord.com');
    assert.equal(authorize.searchParams.get('scope'),'identify');
    challenge = authorize.searchParams.get('code_challenge');
    const transaction = start.headers.getSetCookie()[0].split(';')[0];
    assert.match(start.headers.getSetCookie()[0], /Secure; HttpOnly; SameSite=Lax/);
    const callback = new URLSearchParams({state:authorize.searchParams.get('state'),code:'valid',iss:'https://discord.com'});
    assert.equal((await open('/auth/discord/callback?'+callback)).status,400);
    assert.equal(discordCalls.length,0);
    const result = await open('/auth/discord/callback?'+callback,{headers:{Cookie:transaction}});
    assert.equal(result.status,303);
    assert.equal(result.headers.get('Location'),web);
    assert.doesNotMatch(result.headers.getSetCookie().join(' '), /secret-token|secret-refresh/);
    const session = result.headers.getSetCookie()[1].split(';')[0];
    const html = await (await open(web,{headers:{Cookie:session}})).text();
    assert.match(html, /&lt;Sample&gt;/);
    assert.match(html, /Diagnostic ZIP/);
    const form = new FormData();
    form.append('description','Local Wi-Fi dropped');
    form.append('reference',reference);
    form.append('attachment',await diagnosticZip('Synthetic Galaxy diagnostics\n'.repeat(100)), 'report.zip');
    assert.equal((await open(web,{method:'POST',body:form,headers:{Origin:'https://other.example',Cookie:session}})).status,403);
    assert.equal((await open(web,{method:'POST',body:form,headers:{Origin:base}})).status,401);
    assert.equal(sends.length,0);
    const sent = await open(web,{method:'POST',body:form,headers:{Origin:base,Cookie:session}});
    assert.equal(sent.status,200);
    assert.match(await sent.text(), /Report sent/);
    assert.deepEqual(sends,[{user:{id:'555',username:'test',global_name:'<Sample>'},reference,
      description:'Local Wi-Fi dropped',logs:'Synthetic Galaxy diagnostics\n'.repeat(100),platform:'ios',source:'galaxy'}]);
    const controllerLog = '{"externalInputInterfaces":[]}';
    form.set('attachment',await diagnosticZip(controllerLog, 'bluetooth-log.json'), 'controller.zip');
    const controllerResult = await open(web,{method:'POST',body:form,headers:{Origin:base,Cookie:session}});
    assert.equal(controllerResult.status,200);
    assert.equal(sends[1].logs,controllerLog);
    assert.equal(sends[1].controllerLog,true);
  } finally { globalThis.fetch = originalFetch; }
});

