const reviewReply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const reviewUUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function reviewObject(env,name){
  return env.REPORTS.get(env.REPORTS.idFromName('codex-review:'+name));
}
function reviewCall(env,name,action,data){
  return reviewObject(env,name).fetch('https://reports/review/'+action,{method:'POST',body:JSON.stringify(data)});
}
export async function rememberDriveMessage(env,record,message){
  return reviewCall(env,'thread:'+record.threadID,'remember',{channel:message.channel_id,id:message.id,reference:record.reference});
}
export async function reviewStorage(storage,action,body){
  if(action==='remember'){
    await storage.transaction(async tx=>{
      const list=await tx.get('driveMessages')||[];
      if(!list.some(x=>x.id===body.id))await tx.put('driveMessages',[body,...list].slice(0,20));
    });
    return reviewReply({saved:true});
  }
  if(action==='list')return reviewReply(await storage.get('driveMessages')||[]);
  if(action==='issue'){
    await storage.setAlarm(Date.now()+300000);
    await storage.put('reviewTicket',{...body,expires:Date.now()+300000});
    return reviewReply({ready:true});
  }
  if(action==='take'){
    const ticket=await storage.transaction(async tx=>{
      const value=await tx.get('reviewTicket');
      if(value)await tx.delete('reviewTicket');
      return value;
    });
    if(!ticket||ticket.expires<=Date.now())return reviewReply({error:'Review link expired. Click Review with Codex again.'},410);
    return reviewReply(ticket);
  }
  return reviewReply({error:'Unknown review action'},404);
}
export function claimReview(env,token){return reviewCall(env,'ticket:'+token,'take',{});}
async function webhookMessage(raw,channel,id){
  const url=new URL(raw);
  if(url.origin!=='https://discord.com'||!/^\/api\/webhooks\/\d+\/[\w-]+$/.test(url.pathname)||!/^\d+$/.test(channel)||!/^\d+$/.test(id))
    throw Error('Invalid report destination');
  url.pathname+='/messages/'+id;url.search='';url.searchParams.set('thread_id',channel);
  const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});
  if(r.status>=300&&r.status<400)throw Error('Discord returned an unexpected redirect for the saved report.');
  if(!r.ok)throw Error('Discord could not retrieve a saved report ('+r.status+').');
  const m=await r.json();
  if(m.id!==id||m.channel_id!==channel)throw Error('Discord returned a different report.');
  return m;
}
export async function prepareReview(env,report,chat){
  if(chat!==''&&!reviewUUID.test(chat))return reviewReply({error:'Enter a Codex chat ID.'},400);
  const ids=new URL(report.threadURL).pathname.split('/');
  const publicMessage=await webhookMessage(env.DISCORD_WEBHOOK_URL,ids[3],ids[4]);
  const messages=[];
  const original=/\nPrivate diagnostics: https:\/\/discord\.com\/channels\/\d+\/(\d+)\/(\d+)\s*$/.exec(publicMessage.content);
  if(original)messages.push(await webhookMessage(env.DISCORD_PRIVATE_WEBHOOK_URL,original[1],original[2]));
  const drives=await (await reviewCall(env,'thread:'+ids[3],'list',{})).json();
  for(const drive of drives)messages.push(await webhookMessage(env.DISCORD_PRIVATE_WEBHOOK_URL,drive.channel,drive.id));
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
  // Only references and Discord's short-lived attachment URLs enter the ticket.
  const entries=messages.map(m=>({message:m.content,attachments:(m.attachments||[]).map(a=>({name:a.filename,url:a.url,size:a.size}))}));
  const saved=await reviewCall(env,'ticket:'+token,'issue',{chat,reference:report.reference,title:report.title,description:publicMessage.content,entries});
  return saved.ok?reviewReply({ticket:token}):saved;
}

