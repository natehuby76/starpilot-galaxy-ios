import {botPost} from './bot-delivery.mjs';
import {discordTags, getReportThread, supportTags} from './thread-tags.mjs';
import {issueDriveLink, sendDriveInvite} from './drive-logs.mjs';

const titles = {
  note:'Additional Report', assign:'Assign', priority:'Set Priority', status:'Change Status',
  testing:'Request User Testing', rename:'Rename Thread', duplicate:'Link Duplicate',
  connection:'Request Network Logs', controller:'Request Bluetooth Logs'
};
const row = component => ({type:1,components:[component]});
const ephemeral = content => Response.json({type:4,data:{flags:64,content,allowed_mentions:{parse:[]}}});
const idPattern = /^\d{1,20}$/;

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
  if(action==='note' ? actor!==user&&!sage : !sage) return ephemeral(action==='note'?'Only the reporter or StarPilot Sage can add details.':'Staff Actions requires the StarPilot Sage role.');
  if(i.type===3 && command==='menu'){
    const options=Object.entries(titles).filter(([k])=>k!=='note').map(([value,label])=>({label,value}));
    return Response.json({type:4,data:{flags:64,components:[row({type:3,custom_id:base+'pick:'+channel,placeholder:'Choose a staff action',options})]}});
  }
  if(!Object.hasOwn(titles,action))return ephemeral('Unknown support action.');
  const choices={priority:['0','1','2','3','4','5','Clear'],status:['Open','In Progress','Closed'],assign:['Me','Other maintainer','Unassigned']};
  if(i.type===3 && command==='pick' && choices[action]){
    return Response.json({type:4,data:{flags:64,components:[row({type:3,custom_id:base+action+':'+channel,placeholder:titles[action],options:choices[action].map(value=>({label:value,value}))})]}});
  }
  const prompts={note:'What happened?',testing:'Build and steps to test',rename:'New thread title',duplicate:'Original support thread ID'};
  if(i.type===3 && prompts[action]){
    return Response.json({type:9,data:{title:titles[action],custom_id:base+action+':'+channel,components:[row({type:4,custom_id:'value',label:prompts[action],style:['note','testing'].includes(action)?2:1,required:true,max_length:action==='rename'?100:action==='duplicate'?20:1500})]}});
  }
  const value=i.type===5?i.data.components?.[0]?.components?.[0]?.value?.trim():i.data.values?.[0];
  if(prompts[action] && (!value||i.type!==5) || choices[action]&&!choices[action].includes(value))return ephemeral('Choose a valid value.');
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

export async function caseAction(storage,env,b){
  const result=message=>Response.json({message});
  const {channel,platform,user,action,actor,value}=b;
  const key='thread:'+channel;
  const record=await storage.get(key);
  if(!record||record.platform!==platform)return result('This ticket could not be verified.');
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
  }else if(action==='assign'){
    const id=value==='Me'?actor:[env.REPORT_MAINTAINER_ID,env.ANDROID_REPORT_MAINTAINER_ID].find(id=>id&&id!==actor);
    if(!id&&value!=='Unassigned')return result('No other maintainer is configured.');
    patch.assignee=value==='Unassigned'?null:id;
    message=patch.assignee?'Assigned to <@'+id+'>.':'Assignment cleared.';
  }else if(action==='priority'){
    patch.priority=value==='Clear'?null:value;
    message=patch.priority===null?'Priority cleared.':'Priority '+value+' (0 is highest).';
  }else if(action==='status'){
    const statuses=['Open','In Progress','Closed'].map(name=>supportTags[name]);
    const tags=[...thread.applied_tags.filter(id=>!statuses.includes(id)),supportTags[value]];
    if(tags.length>5)return result('Remove a forum tag to make room for the status.');
    await discordTags(env,'/channels/'+channel,{applied_tags:tags});
    message='Status changed to '+value+'.';
  }else if(action==='testing')message='Testing requested from <@'+user+'>\n'+value;
  else if(action==='note')message='Additional report from <@'+actor+'>\n'+value;
  else return result('Unknown action.');
  if(Object.keys(patch).length)await storage.transaction(async tx=>tx.put(key,{...await tx.get(key),...patch}));
  const post=await botPost(env,channel,{content:message,nonce:b.interaction,enforce_nonce:true,allowed_mentions:{parse:[],users:action==='testing'?[user]:[]}});
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
