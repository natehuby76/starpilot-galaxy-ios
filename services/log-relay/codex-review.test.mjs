import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareReview,claimReview,reviewStorage} from './codex-review.mjs';

const record={title:'lost nav',reference:'BC67EAFB-EDB5-4F15-BD20-C1F54B8A62EA',threadURL:'https://discord.com/channels/1/2/3'};
test('handoff uses the specified chat and can be claimed only once',async t=>{
  const stores=new Map();
  const env={DISCORD_WEBHOOK_URL:'https://discord.com/api/webhooks/111/public',
    DISCORD_PRIVATE_WEBHOOK_URL:'https://discord.com/api/webhooks/222/private',
    REPORTS:{idFromName:n=>n,get:n=>({fetch:(url,options)=>{
      if(!stores.has(n))stores.set(n,new Map());
      const rows=stores.get(n);
      const storage={get:k=>rows.get(k),put:(k,v)=>rows.set(k,v),delete:k=>rows.delete(k),setAlarm:()=>{},transaction:cb=>cb(storage)};
      return reviewStorage(storage,new URL(url).pathname.split('/').pop(),JSON.parse(options.body));
    }})}};
  t.mock.method(globalThis,'fetch',async url=>{
    const pub=String(url).includes('/public/');
    return Response.json(pub?{id:'3',channel_id:'2',content:'Lost nav\nPrivate diagnostics: https://discord.com/channels/1/4/5'}:
      {id:'5',channel_id:'4',content:'Private report',attachments:[{filename:'report.txt',url:'https://cdn.discordapp.com/attachments/4/report.txt',size:12}]});
  });
  assert.equal((await prepareReview(env,record,'arbitrary')).status,400);
  for(const chat of ['',crypto.randomUUID()]){
    const {ticket}=await (await prepareReview(env,record,chat)).json();
    const result=await (await claimReview(env,ticket)).json();
    assert.equal(result.chat,chat);
    assert.equal(result.entries[0].attachments[0].name,'report.txt');
    assert.equal((await claimReview(env,ticket)).status,410);
  }
});
