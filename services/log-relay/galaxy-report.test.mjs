import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
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
    idFromName(id) { assert.ok(id==='555' || id.startsWith('drive-log:')); return id; },
    get(id) { return {async fetch(path, options) {
      if(path==='https://reports/drive/issue'){newRequest=JSON.parse(options.body);return Response.json({created:true});}
      if(path==='https://reports/drive/fresh')return Response.json(newRequest || {kind:'controller',platform:'android',threadID:'2',reference,userID:owner,title:'Controller report'});
      assert.equal(path,'https://reports/submit');
      sends.push(JSON.parse(options.body));
      return Response.json({sent:true,threadURL:'https://discord.com/channels/1/2/3'});
    }}; },
  }};
  const open = (path, options) => worker.fetch(new Request(base+path,options),runtime);
  let challenge, newRequest, owner='555';
  try {
    const landing=await (await open(web)).text();
    assert.match(landing,/\/new\/connection/);
    assert.match(landing,/\/new\/controller/);
    assert.doesNotMatch(landing,/type="file"/);
    assert.match(await (await open(web+'/manual')).text(), /Sign in with Discord/);
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
    const html = await (await open(web+'/manual',{headers:{Cookie:session}})).text();
    assert.match(html, /&lt;Sample&gt;/);
    assert.match(html, /Diagnostic ZIP/);
    assert.match(html, /<details class="manual"><summary>Manual ZIP upload<\/summary>[\s\S]*type="file"/);
    assert.ok(html.indexOf('Capture logs in Galaxy') < html.indexOf('<details'));
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
    const ticket=web+'/fresh/'+'b'.repeat(64);
    assert.match(await (await open(ticket)).text(),/Sign in with Discord/);
    const launch = await (await open(ticket,{headers:{Cookie:session}})).text();
    assert.doesNotMatch(launch,/Copy code|Find report|Earlier Galaxy versions/);
    assert.ok(launch.includes('Logs &amp; Diagnostics → Get help → Controller'));
    assert.ok(launch.includes('Download ZIP instead'));
    assert.ok(launch.includes('Review ZIP for this report'));
    for(const [saved,expected] of [['http://127.0.0.1:8082',undefined],['http://192.168.1.9:8082','http://192.168.1.9:8082']]){
      const controls={'open-galaxy':{hidden:true},'missing-address':{},address:{},launch:{}};
      let target;
      runInNewContext([...launch.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1],{URL,document:{getElementById:id=>controls[id]},localStorage:{getItem:()=>saved},location:{assign:url=>{target=url;}}});
      controls['open-galaxy'].onclick();
      assert.equal(target,expected && expected+'/#/logs/help/controller');
    }
    for(const path of ['/device','/starport-claim','/starport/upload']){
      assert.equal((await open(web+path,{method:'POST',headers:{Cookie:session,Origin:base}})).status,404);
    }
    const archive=Buffer.from(await (await diagnosticZip(controllerLog,'bluetooth-log.json')).arrayBuffer()).toString('base64');
    const capture=new URLSearchParams({archive});
    const post=origin=>open(ticket,{method:'POST',body:capture,headers:{Origin:origin,Cookie:session}});
    const confirmation = await post('http://192.168.1.2:8082');
    assert.equal(confirmation.headers.get('Referrer-Policy'),'same-origin');
    assert.match(await confirmation.text(),/Send to this report/);
    assert.equal(sends.length,2);
    capture.set('confirm','yes');
    assert.equal((await post('http://192.168.1.2:8082')).status,403);
    owner='888';
    assert.equal((await post(base)).status,403);
    owner='555';
    capture.set('archive', Buffer.from(await (await diagnosticZip('wrong kind')).arrayBuffer()).toString('base64'));
    assert.equal((await post(base)).status,400);
    capture.set('archive',archive);
    assert.match(await (await post(base)).text(),/Return to your report/);
    assert.equal(sends.length,3);
    assert.deepEqual([sends[2].threadID,sends[2].reference,sends[2].platform,sends[2].controllerLog],['2',reference,'android',true]);
    const newPath=web+'/new/connection';
    assert.match(await (await open(newPath)).text(),/Sign in with Discord/);
    const captureStart = await open(newPath,{headers:{Cookie:session}});
    assert.equal(captureStart.headers.get('Referrer-Policy'),'same-origin');
    const wrongOrigin = await open(newPath,{method:'POST',headers:{Origin:'null',Cookie:session}});
    assert.equal(wrongOrigin.status,303);
    assert.equal(wrongOrigin.headers.get('Location'),newPath);
    assert.equal(newRequest,undefined);
    const created=await open(newPath,{method:'POST',headers:{Origin:base,Cookie:session}});
    assert.equal(created.status,303);
    const reportPath=created.headers.get('Location');
    assert.match(reportPath,/^\/report\/galaxy\/fresh\/[a-f0-9]{64}$/);
    const newBody=new URLSearchParams({confirm:'yes',description:'Wi-Fi drops', archive:Buffer.from(await (await diagnosticZip('local access diagnostics','connection-logs.txt')).arrayBuffer()).toString('base64')});
    const delivered=await open(reportPath,{method:'POST',headers:{Origin:base,Cookie:session},body:newBody});
    assert.equal(delivered.status,200);
    assert.equal(sends[3].threadID,undefined);
    assert.equal(sends[3].description,'Wi-Fi drops');
    assert.equal(sends[3].logs,'local access diagnostics');
    const next=await open(web+'/new/starport',{method:'POST',headers:{Origin:base,Cookie:session}});
    const codePage=await (await open(next.headers.get('Location'),{headers:{Cookie:session}})).text();
    assert.doesNotMatch(codePage,/Copy code|paste the code/i);
    assert.match(codePage,/Sign in with Discord/i);
  } finally { globalThis.fetch = originalFetch; }
});

