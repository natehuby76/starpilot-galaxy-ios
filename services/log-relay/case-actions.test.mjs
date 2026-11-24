import test from 'node:test';
import assert from 'node:assert/strict';
import {caseButtons,caseInteraction,caseAction} from './case-actions.mjs';
import {supportForum} from './thread-tags.mjs';

const env={REPORT_MAINTAINER_ID:'2',ANDROID_REPORT_MAINTAINER_ID:'3',DISCORD_BOT_TOKEN:'test'};
const interaction=(command,actor)=>({type:3,member:{user:{id:actor}},channel_id:'4',data:{custom_id:'case:1:ios:'+command}});

test('reporter can add details and staff get a private action menu',async()=>{
  assert.equal(caseButtons('1','ios')[0].components.length,2);
  assert.equal((await caseInteraction(interaction('note','1'),env).json()).type,9);
  assert.equal((await caseInteraction(interaction('menu','1'),env).json()).data.components,undefined);
  const menu=await caseInteraction(interaction('menu','3'),env).json();
  assert.equal(menu.data.flags,64);
  assert.equal(menu.data.components[0].components[0].options.length,8);
  assert.match((await caseInteraction(interaction('priority:5','2'),env).json()).data.content,/original/);
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
