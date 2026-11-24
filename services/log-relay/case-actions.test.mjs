import test from 'node:test';
import assert from 'node:assert/strict';
import {caseButtons,caseInteraction,caseAction} from './case-actions.mjs';
import {supportForum} from './thread-tags.mjs';

const env={REPORTS:{idFromName:v=>v,get:()=>({fetch:()=>Response.json({id:'6'})})},REPORT_MAINTAINER_ID:'2',ANDROID_REPORT_MAINTAINER_ID:'3',DISCORD_BOT_TOKEN:'test'};
const interaction=(command,actor)=>({type:3,guild_id:'1387432184121393333',member:{user:{id:actor},roles:actor==='3'?['6']:[]},channel_id:'4',data:{custom_id:'case:1:ios:'+command}});

test('reporter can add details and staff get a private action menu',async()=>{
  assert.equal(caseButtons('1','ios')[0].components.length,2);
  assert.equal((await (await caseInteraction(interaction('note','1'),env)).json()).type,9);
  assert.equal((await (await caseInteraction(interaction('menu','1'),env)).json()).data.components,undefined);
  assert.equal((await (await caseInteraction(interaction('menu','2'),env)).json()).data.components,undefined);
  const menu=await (await caseInteraction(interaction('menu','3'),env)).json();
  assert.equal(menu.data.flags,64);
  assert.deepEqual(menu.data.components[0].components[0].options.slice(0,3).map(o=>o.value),['tags','working','assign']);
  assert.match((await (await caseInteraction(interaction('priority:5','2'),env)).json()).data.content,/original/);
});
test('priority is stored on the verified ticket and a repeated interaction posts once',async()=>{
  const data=new Map([['thread:4',{platform:'ios',title:'Original'}]]);
  const storage={get:k=>data.get(k),put:(k,v)=>data.set(k,v),transaction:fn=>fn(storage)};
  const prior=globalThis.fetch;
  const messages=[];
  globalThis.fetch=async(url,options)=>{
    if(options.method==='POST'){messages.push(JSON.parse(options.body));return Response.json({id:'8'});}
    return Response.json({id:'4',type:11,parent_id:supportForum,applied_tags:[]});
  };
  try{
    const action={action:'priority',channel:'4',platform:'ios',value:'0',actor:'2',interaction:'9'};
    await caseAction(storage,env,action);
    await caseAction(storage,env,action);
    assert.equal(data.get('thread:4').priority,'0');
    assert.equal(data.get('thread:4').title,'Original');
    assert.equal(messages.length,1);
    assert.deepEqual(messages[0].allowed_mentions.parse,[]);
  }finally{globalThis.fetch=prior;}
});

test('marking in progress preserves topics and assignment uses a Discord user picker',async()=>{
  const pick=interaction('pick:4','3');
  pick.data.values=['assign'];
  const picker=await (await caseInteraction(pick,env)).json();
  assert.equal(picker.data.flags,64);
  assert.equal(picker.data.components[0].components[0].type,5);
  const prior=globalThis.fetch, patched=[];
  globalThis.fetch=async(url,options)=>{
    if(options.method==='PATCH'){patched.push(JSON.parse(options.body));return Response.json({});}
    if(options.method==='POST')return Response.json({id:'8'});
    return Response.json({id:'4',type:11,parent_id:supportForum,applied_tags:['1565236988913913887','42']});
  };
  const data=new Map([['thread:4',{platform:'ios'}]]);
  const store={get:k=>data.get(k),put:(k,v)=>data.set(k,v),transaction:fn=>fn(store)};
  try{
    await caseAction(store,env,{channel:'4',platform:'ios',action:'working',actor:'3',interaction:'11'});
    assert.deepEqual(patched,[{applied_tags:['42','1565237023265263657']}]);
  }finally{globalThis.fetch=prior;}
});

test('only the reporter can give feedback or mark a request fulfilled',async()=>{
  const open=async(command,actor)=> (await caseInteraction(interaction(command,actor),env)).json();
  assert.equal((await open('feedback:4','1')).type,9);
  assert.equal((await open('feedback:4','2')).data.flags,64);
  assert.equal((await open('fulfilled:4','3')).data.flags,64);
  assert.equal((await open('fulfilled:5','1')).data.flags,64);
});

test('each reporter update puts working staff controls beneath the new card',async t=>{
  const data=new Map([['thread:4',{platform:'ios'}]]);
  const store={get:k=>data.get(k),put:(k,v)=>data.set(k,v),transaction:fn=>fn(store)};
  const posts=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(options.method==='POST'){posts.push(JSON.parse(options.body));return Response.json({id:'8'});}
    return Response.json({id:'4',type:11,parent_id:supportForum,applied_tags:[]});
  });
  for(const action of ['feedback','note']){
    await caseAction(store,env,{channel:'4',platform:'ios',user:'1',actor:'1',action,value:'Still happens',interaction:action});
    const post=posts.at(-1);
    assert.equal(post.flags,32768);
    assert.match(post.components[0].components[0].content,/Still happens/);
    assert.equal(post.components[1].components[1].custom_id,'case:1:ios:menu');
  }
});
