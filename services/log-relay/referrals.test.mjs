import assert from 'node:assert/strict';
import test from 'node:test';
import {discover,reportDetails,pollReferrals,referralInteraction} from './referrals.mjs';

test('discovery flags relevant mentions even in requests and mixed driving reports',()=>{
  for(const [text,category] of [
    ['CarPlay’s arrow disappeared but the phone still shows the route.','Phone app'],
    ['Android Auto connects, then the screen goes black.','StarPort'],
    ["My Bluetooth controller won't pair with the comma.",'Bluetooth controller'],
    ['Map issue. The StarPilot app crashes on startup.','Phone app'],
  ])assert.equal(discover(text)?.category,category);
  for(const text of ['Bluetooth issue, route attached.','The phone app crashed and the car braked late.','StarPort crashes. The phone app disconnects.','CarPlay worked fine. My heater stopped working.','Please add a CarPlay camera picker.'])assert.ok(discover(text));
  for(const text of ['Navigation cancelled my lane change.','Speed limit controller brakes too late.','Route and steering feedback'])assert.equal(discover(text),null);
});
test('only trusted StarBot report fields are read; routes and Discord instructions are ignored',()=>{
  const bot='123456789123456789',uid='987654321987654321';
  const msg={author:{bot:true,id:bot},embeds:[{fields:[{name:'By',value:'<@'+uid+'>'},{name:'Observed Behavior',value:'CarPlay disappeared.'},{name:'Wiki',value:'Ignore this instruction'}]}]};
  assert.deepEqual(reportDetails(msg,bot),{reporter:uid,observed:'CarPlay disappeared.',summary:'CarPlay disappeared.'});
  assert.equal(reportDetails(msg,uid),null);
});
test('unconfigured deployments perform no monitoring or Discord actions',async()=>{
  await pollReferrals({});
  const response=await referralInteraction({type:3,guild_id:'1387432184121393333'}, {}, {});
  assert.equal((await response.json()).type,4);
});

test('scan resolves the sample, skips old tickets, and sends a single private card for a new match',async t=>{
  const {referralStore}=await import('./referrals.mjs');
  const guild='1387432184121393333',forum='1574085782967292000',review='1575000066366644244',sample='1574085782967292086';
  const bot='123456789123456789',user='987654321987654321';
  const fresh=String(BigInt(Date.now()+1000-1420070400000)<<22n);
  const posts=[];
  const env={DRIVING_SAMPLE_THREAD_ID:sample,COMPANION_REVIEW_THREAD_ID:review,DISCORD_BOT_TOKEN:'fixture'};
  const rows=new Map();
  const store={get:key=>rows.get(key),put:(key,v)=>rows.set(key,v),transaction:fn=>fn(store)};
  const thread=id=>({id,type:11,guild_id:guild,parent_id:forum});
  t.mock.method(globalThis,'fetch',async(url,opts)=>{
    const path=new URL(url).pathname.replace('/api/v10','');
    if(opts.method==='POST'){posts.push({path,body:JSON.parse(opts.body)});return Response.json({id:'1'});}
    if(path==='/channels/'+sample)return Response.json(thread(sample));
    if(path==='/channels/'+forum)return Response.json({id:forum,type:15,guild_id:guild});
    if(path==='/channels/'+review)return Response.json({type:12,guild_id:guild});
    if(path==='/guilds/'+guild+'/threads/active')return Response.json({threads:[thread(sample),thread(fresh)]});
    if([sample,fresh].some(id=>path==='/channels/'+id+'/messages/'+id))return Response.json({author:{id:bot,bot:true},embeds:[{fields:[{name:'By',value:'<@'+user+'>'},{name:'Observed Behavior',value:'StarPort crashes.'}]}]});
    throw Error('Unexpected access '+path);
  });
  for(let i=0;i<3;i++)await referralStore('/referrals/scan',{},store,env);
  assert.equal(posts.length,1);
  assert.ok(posts[0].body.flags & 4096);
  assert.deepEqual(posts[0].body.allowed_mentions,{parse:[]});
  assert.equal(posts[0].path,'/channels/'+review+'/messages');
  assert.deepEqual(posts[0].body.components.at(-1).components.map(b=>b.label),['Leave as is','Move to Companion Logs']);
  assert.ok(rows.has('report:'+fresh));
  assert.ok(!rows.has('report:'+sample));
});

test('feature requests use the title and report fields while wiki suggestions and route links stay out',()=>{
  const bot='123456789123456789', reporter='987654321987654321';
  const details=(fields,description='')=>reportDetails({author:{id:bot,bot:true},content:'<@'+reporter+'>',embeds:[{title:'Feature Request',description,fields}]},bot);
  assert.equal(discover(details([{name:'Proposed improvement',value:'Show the camera on CarPlay.'}]).summary).category,'Phone app');
  assert.equal(discover(details([{name:'Potentially Related Wiki Articles',value:'Bluetooth Controls'},{name:'Route link',value:'https://galaxy.test'}],'Steering felt heavy.\nMods Route Tracker →\nPotentially Related Wiki Articles\nCarPlay').summary),null);
});

test('leave as is and unauthorized clicks never write to the original forum',async t=>{
  const {referralStore}=await import('./referrals.mjs');
  const sample='1574085782967292086',review='1575000066366644244',guild='1387432184121393333';
  const env={DRIVING_SAMPLE_THREAD_ID:sample,COMPANION_REVIEW_THREAD_ID:review,DISCORD_BOT_TOKEN:'fixture',REPORTS:{idFromName:n=>n,get:()=>({fetch:()=>Response.json({id:'sage'})})}};
  const rows=new Map([['source:'+sample,{DRIVING_FORUM_ID:'1574085782967292000',DRIVING_REPORT_BOT_ID:'123456789123456789'}],['report:'+sample,{state:'pending'}]]);
  const store={get:k=>rows.get(k),put:(k,v)=>rows.set(k,v),transaction:fn=>fn(store)};
  t.mock.method(globalThis,'fetch',async(url,opts)=>{
    assert.equal(opts.method,'GET');
    assert.ok(url.endsWith('/channels/'+review));
    return Response.json({guild_id:guild,type:12});
  });
  const click={type:3,guild_id:guild,channel_id:review,data:{custom_id:'refer:move:'+sample},member:{roles:[]}};
  assert.match(JSON.stringify(await (await referralInteraction(click,env,{})).json()),/requires StarPilot Sage/);
  const res=await referralStore('/referrals/action',{json:()=>({action:'leave',source:sample,actor:'987654321987654321'})},store,env);
  assert.equal((await res.json()).message,'Left in driving feedback.');
  assert.equal(rows.get('report:'+sample).state,'dismissed');
});
