const ttl = 15 * 60_000;
const limit = 10 * 1024 * 1024 - 65536;
const chunkSize = 96 * 1024;
const root = '/report/galaxy';
const noStore = {'Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
const json = (data,status=200)=>Response.json(data,{status,headers:noStore});
const hex = bytes=>Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
const instance=(env,key)=>env.REPORTS.get(env.REPORTS.idFromName('staged-report:'+key));
const isThread=url=>/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(url);
const labels={starport:'StarPort',controller:'Bluetooth controller',connection:'App connection'};

export async function stageUpload(request,env,{base,bounded,diagnosticText}){
  if(request.method!=='POST'||request.headers.get('Content-Type')!=='application/zip')return json({error:'Expected a diagnostic ZIP.'},415);
  let meta;
  try{
    const field=request.headers.get('X-Galaxy-Report') || '';
    if(field.length>12000)throw Error();
    const input=field ? JSON.parse(decodeURIComponent(field)) : {
      kind:request.headers.get('X-Galaxy-Kind'),
      note:decodeURIComponent(request.headers.get('X-Galaxy-Note') || ''),
      phone:request.headers.get('X-Galaxy-Platform'),
    };
    if(!field && !['ios','android'].includes(input.phone))throw Error();
    if(!Object.hasOwn(labels,input.kind)||typeof input.note!=='string'||!input.note.trim()||input.note.length>1000)throw Error();
    meta={kind:input.kind,note:input.note.trim()};
    if(['ios','android'].includes(input.phone))meta.phone=input.phone;
    for(const key of ['model','car','branch','commit']){
      if(typeof input[key]==='string' && input[key].length<=160)meta[key]=input[key];
    }
  }catch{return json({error:'Invalid report details.'},400);}
  if(Number(request.headers.get('Content-Length'))>limit)return json({error:'ZIP exceeds the upload limit.'},413);
  const ip=request.headers.get('CF-Connecting-IP')||'local';
  const key=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip)));
  const reservation=await instance(env,'rate:'+key).fetch('https://reports/stage/rate',{method:'POST'});
  if(!reservation.ok)return reservation;
  let bytes;
  try{bytes=await bounded(request.body,limit);}catch{return json({error:'ZIP exceeds the upload limit.'},413);}
  try{
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(bytes.length<52||view.getUint32(0,true)!==0x04034b50||view.getUint32(bytes.length-22,true)!==0x06054b50)throw Error();
    if(meta.kind!=='starport'){
      const diagnostic=await diagnosticText(new Blob([bytes]));
      if(Boolean(diagnostic.controllerLog)!==(meta.kind==='controller'))throw Error();
    }
  }catch{return json({error:'Unexpected diagnostic ZIP.'},400);}
  const token=hex(crypto.getRandomValues(new Uint8Array(32)));
  const saved=await instance(env,token).fetch('https://reports/stage/save',{method:'POST',headers:{'X-Meta':encodeURIComponent(JSON.stringify(meta))},body:bytes});
  return saved.ok?json({claimUrl:base+root+'/claim/'+token}):saved;
}

export async function stageStorage(request,storage,env){
  const path=new URL(request.url).pathname, now=Date.now();
  if(path==='/stage/rate'){
    return storage.transaction(async tx=>{
      const hits=(await tx.get('hits')||[]).filter(t=>t>now-ttl);
      if(hits.length>=8)return json({error:'Too many uploads. Try again in 15 minutes.'},429);
      await tx.put('hits',[...hits,now]);await tx.setAlarm(now+ttl);return json({ok:true});
    });
  }
  if(path==='/stage/save'){
    const bytes=new Uint8Array(await request.arrayBuffer());
    const meta=JSON.parse(decodeURIComponent(request.headers.get('X-Meta')));
    const count=Math.ceil(bytes.length/chunkSize);
    await storage.transaction(async tx=>{await tx.setAlarm(now+ttl);await tx.put('stageCleanup',true);});
    for(let i=0;i<count;i++)await storage.put('zip:'+i,bytes.slice(i*chunkSize,(i+1)*chunkSize));
    await storage.put('stage',{...meta,count,expires:now+ttl,reference:crypto.randomUUID()});
    return json({ok:true});
  }
  const state=await storage.get('stage');
  if(!state||state.expires<=now)return json({error:'This report expired. Send it again from Galaxy.'},410);
  const {user,threadID,platform}=await request.json();
  if(state.owner&&state.owner!==user.id)return json({error:'Open this report with the account that posted it.'},403);
  if(state.receipt)return json(state.receipt);
  if(path==='/stage/preview')return json({phone:state.phone,note:state.note,kind:state.kind,model:state.model,car:state.car,branch:state.branch,commit:state.commit});
  if(path!=='/stage/post')return json({},404);
  const owner=env.REPORTS.get(env.REPORTS.idFromName(user.id));
  const target=threadID||'';
  if(state.kind==='connection' && state.phone && state.phone!==platform)return json({error:'Select the same phone platform.'},400);
  if(target){
    const threads=await owner.fetch('https://reports/list',{method:'POST',body:JSON.stringify({platform,kind:state.kind})});
    if(!threads.ok)return json({error:'Could not verify your threads. Try again.'},503);
    if(!(await threads.json()).reports.some(t=>t.id===target))return json({error:'Choose one of your matching open threads.'},400);
  }
  const reserved=await storage.transaction(async tx=>{
    const current=await tx.get('stage');
    if(!current||current.expires<=Date.now())return false;
    if(current.owner && (current.owner!==user.id||current.target!==target||current.platform!==platform))return false;
    await tx.put('stage',{...current,owner:user.id,target,platform});return true;
  });
  if(!reserved)return json({error:'Retry with the original account and thread.'},409);
  const parts=[];
  for(let i=0;i<state.count;i++){
    const part=await storage.get('zip:'+i);
    if(!part){const latest=await storage.get('stage');return latest?.receipt?json(latest.receipt):json({error:'The capture expired.'},410);}
    parts.push(part);
  }
  const form=new FormData();
  const summary=['model','car','branch','commit'].filter(k=>state[k]).map(k=>k+': '+state[k]).join('\n');
  form.set('metadata',JSON.stringify({user,platform,threadID:target||undefined,reference:state.reference,description:state.note,
    source:state.kind==='starport'?'starport':'galaxy',controllerLog:state.kind==='controller',deviceCapture:true,deviceSummary:summary}));
  form.set('archive',new Blob(parts,{type:'application/zip'}),'capture.zip');
  const result=await owner.fetch('https://reports/submit-stage',{method:'POST',body:form});
  const sent=await result.json();
  if(!result.ok||!sent.sent||!isThread(sent.threadURL))return json({error:sent.error||'Could not confirm delivery. Please retry.'},result.ok?502:result.status);
  const receipt={threadURL:sent.threadURL,sent:true};
  await storage.transaction(async tx=>{
    await tx.put('stage',{owner:user.id,receipt,expires:now+ttl});
    await tx.delete(Array.from({length:state.count},(_,i)=>'zip:'+i));
    await tx.setAlarm(now+ttl);
  });
  return json(receipt);
}

export async function claimPage(request,env,{base,user,token,escape}){
  const path=root+'/claim/'+token;
  const back=(notice='')=>new Response(null,{status:303,headers:{...noStore,Location:path+(notice?'?notice='+notice:'')}});
  const notices={
    review:'Review your report below before posting.',
    destination:'Select an open support thread or create a new one.',
    limited:'Too many reports. Please wait before posting again.',
    delivery:'Delivery could not be confirmed. Check your Discord thread before retrying.',
  };
  function page(contents,status=200){
    return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Post Galaxy report</title><style>:root{color-scheme:dark}body{background:#15111e;color:#f6f1ff;font:1rem/1.55 system-ui;margin:0;padding:1rem}main{max-width:32rem;margin:5vh auto;padding:1.5rem;border-radius:1rem;background:#221b30}select,button,a{font:inherit}select,button{display:block;width:100%;padding:.65rem;margin:.7rem 0;border-radius:.65rem}button{background:#d4b7ff;color:#21152d;border:0;font-weight:600}a{color:#dabdff}blockquote{margin:1rem 0;white-space:pre-wrap;overflow-wrap:anywhere}</style><main><h1>Galaxy support</h1>'+contents+'</main>',{status,headers:{...noStore,'Content-Type':'text/html;charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"}});
  }
  if(!user)return new Response(null,{status:303,headers:{...noStore,Location:root+'/sign-in?return='+encodeURIComponent(path)}});
  const call=(action,data)=>instance(env,token).fetch('https://reports/stage/'+action,{method:'POST',body:JSON.stringify({user,...data})});
  const preview=await call('preview',{}), data=await preview.json();
  const receipt=url=>page('<p>Your report was posted.</p><a href="'+escape(url)+'">Open your Discord thread ↗</a>');
  if(!preview.ok)return request.method==='POST'?back():page(escape(data.error),preview.status);
  if(data.sent)return request.method==='POST'?back():receipt(data.threadURL);
  // Bind the form to this signed-in reporter and capture even when Safari omits Origin.
  const formKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.DISCORD_CLIENT_SECRET),
    {name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  const formData=new TextEncoder().encode(JSON.stringify(['galaxy-confirm',base,token,user.id]));
  if(request.method==='POST'){
    const origin=request.headers.get('Origin');
    if(origin && origin!=='null' && origin!==base)return back('review');
    let form;
    try{form=await request.formData();}catch{return back('review');}
    if(origin!==base){
      const proof=form.get('confirmation');
      if(typeof proof!=='string'||!/^[a-f0-9]{64}$/.test(proof))return back('review');
      const bytes=Uint8Array.from(proof.match(/../g),pair=>parseInt(pair,16));
      if(!await crypto.subtle.verify('HMAC',formKey,bytes,formData))return back('review');
    }
    const target=form.get('destination');
    const match=/^(ios|android):(\d{1,20})$/.exec(target);
    if(!['new','new-android'].includes(target)&&!match)return back('destination');
    if(target==='new-android' && (data.kind!=='connection'||data.phone==='ios'))return back('destination');
    const result=await call('post',{threadID:match?.[2],platform:match?.[1]||(target==='new-android'?'android':data.phone || (data.kind==='connection'?'ios':'android'))});
    if(result.ok)return back();
    return back(result.status===429?'limited':result.status===400?'destination':'delivery');
  }
  if(request.method!=='GET')return page('Open the confirmation page.',405);
  const owner=env.REPORTS.get(env.REPORTS.idFromName(user.id));
  const platforms=data.kind==='connection' && data.phone?[data.phone]:['ios','android'];
  const lists=await Promise.all(platforms.map(async platform=>{
    const result=await owner.fetch('https://reports/list',{method:'POST',body:JSON.stringify({platform,kind:data.kind})});
    if(!result.ok)return null;
    return (await result.json()).reports.map(t=>'<option value="'+platform+':'+escape(t.id)+'">'+escape(t.title)+(t.requestedForKind?' (staff requested these logs)':'')+'</option>').join('');
  }));
  const confirmation=hex(new Uint8Array(await crypto.subtle.sign('HMAC',formKey,formData)));
  const notice=new URL(request.url).searchParams.get('notice');
  const banner=Object.hasOwn(notices,notice)?'<p role="status">'+notices[notice]+'</p>':'';
  const newCategory=data.kind==='connection'?(data.phone==='android'?'Android':'iOS'):labels[data.kind];
  const choosePhone=data.kind==='connection' && !data.phone;
  return page(banner+'<p>Signed in as <strong>'+escape(user.global_name||user.username)+'</strong></p><h2>'+labels[data.kind]+' report</h2><blockquote>'+escape(data.note)+'</blockquote><p>Your note appears in the thread. Only staff receive the ZIP and device details.</p><form method="post"><input type="hidden" name="confirmation" value="'+confirmation+'"><label>Post to<select name="destination" required>'+(choosePhone?'<option value="" selected disabled>Choose a phone platform or existing thread</option>':'')+'<option value="new">Create a new '+newCategory+' support thread</option>'+(choosePhone?'<option value="new-android">Create a new Android support thread</option>':'')+lists.join('')+'</select></label>'+(lists.includes(null)?'<p>Some threads could not be loaded. Refresh to try again.</p>':'')+'<button>Post report</button></form>');
}
