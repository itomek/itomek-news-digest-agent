import {authorized} from '../bluesky-collect/store.mjs';
const flags={publishing_enabled:false};
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
// Injected shadow-producer boundary only: no server, env access or scheduler.
// A future deployment must additionally retain platform JWT verification.
async function emptyBody(req){
 const length=req.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>256))throw Error('Invalid body');
 if(!req.body)return;
 const reader=req.body.getReader();let timer;
 const read=(async()=>{
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>256)throw Error('Invalid body');chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(!text.trim())return;
  const body=JSON.parse(text);
  if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length)throw Error('Invalid body');
 })();
 try{await Promise.race([read,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Invalid body')),1000);})]);}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
export async function handleAgent(req,config={},service={}){
 if(req.method!=='POST')return new Response('POST required',{status:405});
 const token=req.headers.get('x-warpcore-agent-token');
 if(typeof config.producerToken!=='string'||config.producerToken.length<32||config.producerToken.length>4096||!token||token.length>4096||!await authorized(token,config.producerToken))return new Response('Unauthorized',{status:401});
 if(config.enabled!==true)return Response.json({mode:'disabled',...flags});
 try{await emptyBody(req);}catch{return Response.json({error:'invalid_agent_request',...flags},{status:400});}
 try{
  if(typeof service.selectRun!=='function'||typeof service.runInvocation!=='function')throw Error('Invalid service');
  const runId=await service.selectRun();
  if(runId===null)return Response.json({mode:'idle',...flags});
  if(typeof runId!=='string'||!uuid.test(runId))throw Error('Invalid run');
  const result=await service.runInvocation(runId);
  if(!result||!['advanced','busy','deferred','disabled'].includes(result.status))throw Error('Invalid result');
  const summary={mode:'shadow',status:result.status,runId};
  if(result.status==='advanced'){
   const state=result.state;
   if(!state||!['scan','review','reviewing','uncertain','complete','deferred'].includes(state.phase))throw Error('Invalid state');
   summary.phase=state.phase;
   for(const field of ['candidateCount','reviewedCount'])if(state[field]!==undefined){if(!Number.isSafeInteger(state[field])||state[field]<0)throw Error('Invalid coverage');summary[field]=state[field];}
   if(summary.reviewedCount!==undefined&&summary.candidateCount!==undefined&&summary.reviewedCount>summary.candidateCount)throw Error('Invalid coverage');
  }
  return Response.json({...summary,...flags});
 }catch{return Response.json({error:'agent_run_failed',...flags},{status:502});}
}
