import {botPost} from './bot-delivery.mjs';
import {discordTags, getReportThread, supportForum, supportTags} from './thread-tags.mjs';
import {issueDriveLink, sendDriveInvite} from './drive-logs.mjs';

const titles = {
  note:'Additional Report', tags:'Apply tags', working:'Mark in progress', assign:'Assign someone', unassign:'Clear assignment', priority:'Set Priority', status:'Change Status',
  testing:'Request User Testing', rename:'Rename Thread', duplicate:'Link Duplicate',
  connection:'Request Network Logs', controller:'Request Bluetooth Logs'
};
const row = component => ({type:1,components:[component]});
const ephemeral = content => Response.json({type:4,data:{flags:64,content,allowed_mentions:{parse:[]}}});
const idPattern = /^\d{1,20}$/;

export function reporterButtons(user,platform,channel) {
  const button=(action,label,style)=>({type:2,style,label,custom_id:['case',user,platform,action,channel].join(':')});
  return {type:1,components:[button('feedback','Give feedback',1),button('fulfilled','My request is fulfilled',3)]};
}

export function caseButtons(user, platform) {
  const button = (action,label,style) => ({type:2,style,label,custom_id:['case',user,platform,action].join(':')});
  return [{type:1,components:[button('note',titles.note,2),button('menu','Staff Actions',1)]}];
}

export async function caseInteraction(i,env,origin,ctx) {
  const [prefix,user,platform,command,bound] = (i.data?.custom_id||'').split(':');
  const channel=i.channel_id, actor=i.member?.user?.id;
  if(prefix!=='case'||!idPattern.test(user)||!idPattern.test(channel)||!idPattern.test(actor)||!['ios','android'].includes(platform)||
     (bound && bound!==channel)) return ephemeral('Open the original support thread.');
  const roles=i.guild_id==='1387432184121393333' && Array.isArray(i.member?.roles)?i.member.roles:[];
  let sage=false;
  if(roles.length){
    const settings=env.REPORTS.get(env.REPORTS.idFromName('companion-bot-setup'));
    const response=await settings.fetch('https://reports/sage-role');
    if(response.ok)sage=roles.includes((await response.json()).id);
  }
  const base=['case',user,platform].join(':')+':';
  const action=command==='pick'?i.data.values?.[0]:command;
  const reporterAction=['feedback','fulfilled'].includes(action);
  if(reporterAction && (actor!==user || bound!==channel))return ephemeral('Only the original reporter can respond to this request.');
  if(!reporterAction && (action==='note' ? actor!==user&&!sage : !sage)) return ephemeral(action==='note'?'Only the reporter or StarPilot Sage can add details.':'Staff Actions requires the StarPilot Sage role.');
  if(i.type===3 && command==='menu'){
    const options=Object.entries(titles).filter(([k])=>k!=='note').map(([value,label])=>({label,value}));
    return Response.json({type:4,data:{flags:64,components:[row({type:3,custom_id:base+'pick:'+channel,placeholder:'Choose a staff action',options})]}});
  }
  if(!reporterAction&&!Object.hasOwn(titles,action))return ephemeral('Unknown support action.');
  if(i.type===3 && command==='pick' && action==='assign'){
    return Response.json({type:4,data:{flags:64,components:[row({type:5,custom_id:base+'assign:'+channel,placeholder:'Choose a server member'})]}});
  }
  if(i.type===3 && command==='pick' && action==='tags'){
    const forum=await discordTags(env,'/channels/'+supportForum);
    const options=topicTags(forum).map(t=>({label:t.name,value:t.id}));
    if(!options.length)return ephemeral('No topic tags are configured in this forum.');
    return Response.json({type:4,data:{flags:64,components:[row({type:3,custom_id:base+'tags:'+channel,placeholder:'Choose tags to add',max_values:Math.min(5,options.length),options})]}});
  }
  const choices={priority:['0','1','2','3','4','5','Clear'],status:['Open','In Progress','Closed']};
  if(i.type===3 && command==='pick' && choices[action]){
    return Response.json({type:4,data:{flags:64,components:[row({type:3,custom_id:base+action+':'+channel,placeholder:titles[action],options:choices[action].map(value=>({label:value,value}))})]}});
  }
  const prompts={feedback:'What did you find or what do you need?',note:'What happened?',testing:'Build and steps to test',rename:'New thread title',duplicate:'Original support thread ID'};
  if(i.type===3 && prompts[action]){
    return Response.json({type:9,data:{title:titles[action]||'Give feedback',custom_id:base+action+':'+channel,components:[row({type:4,custom_id:'value',label:prompts[action],style:['note','testing','feedback'].includes(action)?2:1,required:true,max_length:action==='rename'?100:action==='duplicate'?20:1500})]}});
  }
  const value=action==='tags'?i.data.values:i.type===5?i.data.components?.[0]?.components?.[0]?.value?.trim():i.data.values?.[0];
  if(prompts[action] && (!value||i.type!==5) || choices[action]&&!choices[action].includes(value))return ephemeral('Choose a valid value.');
  if(action==='assign'&&(!idPattern.test(value)||!i.data.resolved?.members?.[value]))return ephemeral('Choose a server member.');
  const owner=env.REPORTS.get(env.REPORTS.idFromName(user));
  ctx.waitUntil((async()=>{
    let content='Could not confirm the action. Check the thread before retrying.';
    try{
      const response=await owner.fetch('https://reports/case-action',{method:'POST',body:JSON.stringify({user,platform,channel,action,actor,value,interaction:i.id,origin})});
      content=(await response.json()).message||content;
    }finally{
      await fetch('https://discord.com/api/v10/webhooks/'+i.application_id+'/'+i.token+'/messages/@original',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,allowed_mentions:{parse:[]}}),redirect:'manual'});
    }
  })());
  return Response.json({type:5,data:{flags:64}});
}

function topicTags(forum){
  const reserved=['Open','In Progress','Closed','iOS','Android'].map(name=>supportTags[name]);
  return (forum.available_tags||[]).filter(tag=>!reserved.includes(tag.id));
}

export async function caseAction(storage,env,b){
  const result=message=>Response.json({message});
  const {channel,platform,user,action,actor,value}=b;
  const key='thread:'+channel;
  const record=await storage.get(key);
  if(!record||record.platform!==platform)return result('This ticket could not be verified.');
  if(['feedback','fulfilled'].includes(action)&&actor!==user)return result('Only the reporter can respond.');
  const thread=await getReportThread(env,channel);
  const fresh=await storage.transaction(async tx=>{
    const recent=await tx.get('case-interactions')||[];
    if(recent.includes(b.interaction))return false;
    await tx.put('case-interactions',[...recent.slice(-99),b.interaction]);return true;
  });
  if(!fresh)return result('This action was already received.');
  if(['connection','controller'].includes(action)){
    const link=await issueDriveLink(env,channel,b.origin,{userID:user,platform},action);
    const data=await link.json();
    if(!link.ok)return result(data.error||'Could not create the request.');
    const sent=await sendDriveInvite(env,channel,new URL(data.url).pathname.split('/').pop());
    return result(sent.ok?'Log instructions sent to this thread.':'Could not confirm delivery of the instructions.');
  }
  let message;
  const patch={};
  if(action==='duplicate'){
    if(!idPattern.test(value)||channel===value)return result('Choose a different support thread.');
    await getReportThread(env,value);
    patch.duplicate=value;
    message='Duplicate of <#'+value+'>.';
  }else if(action==='rename'){
    await discordTags(env,'/channels/'+channel,{name:value});
    patch.title=value;message='Renamed this report to '+value+'.';
  }else if(action==='assign'||action==='unassign'){
    patch.assignee=action==='assign'?value:null;
    message=patch.assignee?'Assigned to <@'+value+'>.':'Assignment cleared.';
  }else if(action==='tags'){
    const allowed=topicTags(await discordTags(env,'/channels/'+supportForum));
    if(!Array.isArray(value)||!value.length||value.some(id=>!allowed.some(t=>t.id===id)))return result('Reopen Apply tags to see the current choices.');
    const tags=[...new Set([...thread.applied_tags,...value])];
    if(tags.length>5)return result('Discord allows five tags. Remove a tag or choose fewer.');
    await discordTags(env,'/channels/'+channel,{applied_tags:tags});
    message='Applied tags: '+allowed.filter(t=>value.includes(t.id)).map(t=>t.name).join(', ')+'.';
  }else if(action==='priority'){
    patch.priority=value==='Clear'?null:value;
    message=patch.priority===null?'Priority cleared.':'Priority '+value+' (0 is highest).';
  }else if(action==='status'||action==='working'||action==='fulfilled'){
    const status=action==='fulfilled'?'Closed':action==='working'?'In Progress':value;
    const statuses=['Open','In Progress','Closed'].map(name=>supportTags[name]);
    const tags=[...thread.applied_tags.filter(id=>!statuses.includes(id)),supportTags[status]];
    if(tags.length>5)return result('Remove a forum tag to make room for the status.');
    await discordTags(env,'/channels/'+channel,{applied_tags:tags});
    message=action==='fulfilled'?'The reporter marked this request fulfilled.':action==='working'?'<@'+actor+'> is working on this report.':'Status changed to '+status+'.';
  }else if(action==='testing')message='<@'+user+'>';
  else if(action==='feedback')message='Feedback from <@'+actor+'>\n'+value;
  else if(action==='note')message='Additional report from <@'+actor+'>\n'+value;
  else return result('Unknown action.');
  if(Object.keys(patch).length)await storage.transaction(async tx=>tx.put(key,{...await tx.get(key),...patch}));
  const payload={content:message,nonce:b.interaction,enforce_nonce:true,
    allowed_mentions:{parse:[],users:action==='testing'?[user]:action==='assign'?[value]:[]}};
  if(action==='testing'){
    payload.embeds=[{title:'🧪 Waiting for user testing',description:value,color:0xf2b134,
      footer:{text:'Share your results below or mark the request fulfilled.'}}];
    payload.components=[reporterButtons(user,platform,channel)];
  }
  const post=await botPost(env,channel,payload);
  return result(post.ok?'Updated this report.':'Could not confirm the update message. Refresh the thread.');
}


export async function enableCaseControls(env) {
  const endpoint='https://starpilot-log-relay.nathan-g-hubbard.workers.dev/drive-interactions';
  const path='/applications/@me';
  let app=await discordTags(env,path);
  if(app.id!=='1574857862872703088'||app.verify_key!==env.DISCORD_PUBLIC_KEY)throw Error('Check the Companion-Bot application and verification key.');
  if(app.interactions_endpoint_url===endpoint)return;
  if(app.interactions_endpoint_url)throw Error('Companion-Bot already uses another interactions endpoint.');
  app=await discordTags(env,path,{interactions_endpoint_url:endpoint});
  if(app.interactions_endpoint_url!==endpoint)throw Error('Discord has not confirmed the support controls endpoint.');
}
