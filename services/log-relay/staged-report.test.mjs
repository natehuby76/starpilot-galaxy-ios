import assert from 'node:assert/strict';
import test from 'node:test';
import worker,{Reports} from './worker.mjs';
import {claimPage} from './staged-report.mjs';
import {diagnosticZip} from './diagnostic-zip.mjs';

const base='https://starpilot-log-relay.nathan-g-hubbard.workers.dev';
const user={id:'42',username:'reporter'};
function setup(){
  const stores=new Map(), uploads=[];
  const env={DISCORD_CLIENT_ID:'1',DISCORD_CLIENT_SECRET:'test',REPORTS:{
    idFromName:name=>name,
    get(name){
      if(name==='42')return {async fetch(path,opts){
        if(path.endsWith('/list'))return Response.json({reports:JSON.parse(opts.body).kind==='connection' && JSON.parse(opts.body).platform==='ios'?[{id:'123',title:'Lost nav'}]:[]});
        assert.ok(path.endsWith('/submit-stage'));
        uploads.push({meta:JSON.parse(opts.body.get('metadata')),zip:Buffer.from(await opts.body.get('archive').arrayBuffer())});
        return Response.json({sent:true,threadURL:'https://discord.com/channels/1/123/246'});
      }};
      if(!stores.has(name)){
        const rows=new Map();
        const storage={rows,get:k=>rows.get(k),put:(k,v)=>rows.set(k,v),delete(keys){for(const k of [].concat(keys))rows.delete(k);},
          deleteAll:()=>rows.clear(),setAlarm(){},transaction:f=>f(storage)};
        const obj=new Reports({storage},env);
        stores.set(name,{storage,obj,fetch:(url,init)=>obj.fetch(new Request(url,init))});
      }
      return stores.get(name);
    }
  }};
  async function stage(kind,filename,note='Screen stayed black'){
    const zip=Buffer.from(await (await diagnosticZip('Synthetic diagnostic data',filename)).arrayBuffer());
    const response=await worker.fetch(new Request(base+'/report/galaxy/stage',{method:'POST',headers:{
      'Content-Type':'application/zip','X-Galaxy-Report':encodeURIComponent(JSON.stringify({kind,note,car:'Test car',branch:'Nate-testing',commit:'abcdef'}))
    },body:zip}),env);
    return {response,zip};
  }
  return {env,stores,uploads,stage};
}
for(const [kind,file,target] of [['starport','session.txt','new'],['connection','connection-logs.txt','ios:123'],['controller','bluetooth-log.json','new']]){
  test(kind+' stages original ZIP, confirms destination, deletes ZIP and receipts retries',async()=>{
    const {env,stores,uploads,stage}=setup();
    const {response,zip}=await stage(kind,file);
    assert.equal(response.status,200);
    const {claimUrl}=await response.json();
    const token=claimUrl.split('/').pop();
    const {storage}=stores.get('staged-report:'+token);
    const open=(who,method='GET',destination=target,origin=base)=>claimPage(new Request(claimUrl,{method,...(method==='POST'?{
      headers:{Origin:origin},body:new URLSearchParams({destination})}:{})}),env,{base,token,user:who,escape:s=>String(s)});
    assert.equal((await open(null)).status,303);
    const confirmationPage=await (await open(user)).text();
    assert.equal(confirmationPage.includes('Lost nav'),kind==='connection');
    if(kind!=='connection')assert.doesNotMatch(confirmationPage,/new (iOS|Android) support thread/);
    else assert.match(confirmationPage,/selected disabled>Choose a phone platform/);
    assert.equal((await open(user,'POST',target,'https://other.example')).headers.get('Location'), new URL(claimUrl).pathname+'?notice=review');
    assert.equal((await open(user,'POST','ios:999')).headers.get('Location'),new URL(claimUrl).pathname+'?notice=destination');
    assert.equal(uploads.length,0);
    assert.equal((await open(user,'POST')).status,303);
    assert.match(await (await open(user)).text(),/Open your Discord thread/);
    assert.deepEqual(uploads[0].zip,zip);
    assert.equal(uploads[0].meta.threadID,target==='new'?undefined:'123');
    assert.equal(uploads[0].meta.controllerLog,kind==='controller');
    assert.match(uploads[0].meta.deviceSummary,/Test car/);
    assert.deepEqual([...storage.rows.keys()].sort(),['stage','stageCleanup']);
    assert.equal((await open({id:'99'})).status,403);
    assert.equal((await open(user,'POST')).status,303);
    assert.match(await (await open(user)).text(),/Open your Discord thread/);
    assert.equal(uploads.length,1);
  });
}
test('wrong archive type, staging limit and expiry',async()=>{
  const {env,stores,stage}=setup();
  assert.equal((await stage('controller','connection-logs.txt')).response.status,400);
  const {response}=await stage('connection','connection-logs.txt');
  const {claimUrl}=await response.json(),token=claimUrl.split('/').pop();
  const {storage,obj}=stores.get('staged-report:'+token);
  storage.rows.get('stage').expires=Date.now()-1;
  assert.equal((await claimPage(new Request(claimUrl),env,{base,token,user,escape:String})).status,410);
  await obj.alarm();assert.equal(storage.rows.size,0);
  for(let i=0;i<6;i++)assert.equal((await stage('connection','connection-logs.txt')).response.status,200);
  assert.equal((await stage('connection','connection-logs.txt')).response.status,429);
});

test('Nate-testing separate headers preserve the chosen Android app and decode the note',async()=>{
  const {env,uploads}=setup();
  const zip=await diagnosticZip('Synthetic diagnostic data','connection-logs.txt');
  const response=await worker.fetch(new Request(base+'/report/galaxy/stage',{method:'POST',headers:{
    'Content-Type':'application/zip','X-Galaxy-Kind':'connection','X-Galaxy-Platform':'android',
    'X-Galaxy-Note':encodeURIComponent('[Android] Bluetooth café')
  },body:zip}),env);
  assert.equal(response.status,200);
  const {claimUrl}=await response.json(),token=claimUrl.split('/').pop();
  const posted=await claimPage(new Request(claimUrl,{method:'POST',headers:{Origin:base},
    body:new URLSearchParams({destination:'new'})}),env,{base,token,user,escape:String});
  assert.equal(posted.status,303);
  assert.equal(uploads[0].meta.platform,'android');
  assert.equal(uploads[0].meta.description,'[Android] Bluetooth café');
});

test('Safari confirmation remains tied to the signed-in user and staged report', async()=>{
  const {env,uploads,stage}=setup();
  for(const origin of [null,'null']){
    const {claimUrl}=await (await stage('starport','session.txt')).response.json();
    const options={base,token:claimUrl.split('/').pop(),user,escape:String};
    const html=await (await claimPage(new Request(claimUrl),env,options)).text();
    const confirmation=html.match(/name="confirmation" value="([a-f0-9]+)"/)[1];
    const post=(who,proof,source)=>claimPage(new Request(claimUrl,{method:'POST',
      headers:source===null?{}:{Origin:source},body:new URLSearchParams({destination:'new',confirmation:proof})}),env,{...options,user:who});
    assert.equal((await post(user,'',origin)).headers.get('Location'),new URL(claimUrl).pathname+'?notice=review');
    assert.equal((await post({...user,id:'89'},confirmation,origin)).headers.get('Location'),new URL(claimUrl).pathname+'?notice=review');
    assert.equal((await post(user,confirmation,'https://other.example')).headers.get('Location'),new URL(claimUrl).pathname+'?notice=review');
    assert.equal((await post(user,confirmation,origin)).headers.get('Location'),new URL(claimUrl).pathname);
    for(let i=0;i<2;i++)assert.match(await (await claimPage(new Request(claimUrl),env,options)).text(),/Your report was posted/);
  }
  assert.equal(uploads.length,2);
});

test('hardware reports ignore the comma phone label, including existing staged captures',async()=>{
 for(const [kind,phone,file,category] of [['starport','android','session.txt','StarPort'],['controller','ios','bluetooth-log.json','Bluetooth controller'],['connection','android','connection-logs.txt','Android'],['connection','ios','connection-logs.txt','iOS']]){
   const {env}=setup();
   const response=await worker.fetch(new Request(base+'/report/galaxy/stage',{method:'POST',headers:{
     'Content-Type':'application/zip','X-Galaxy-Kind':kind,'X-Galaxy-Platform':phone,'X-Galaxy-Note':'test'
   },body:await diagnosticZip('test',file)}),env);
   const {claimUrl}=await response.json();
   const html=await (await claimPage(new Request(claimUrl),env,{base,user,token:claimUrl.split('/').pop(),escape:String})).text();
   assert.ok(html.includes('Create a new '+category+' support thread'));
   assert.equal(html.includes('Create a new iOS support thread'),category==='iOS');
 }
});
