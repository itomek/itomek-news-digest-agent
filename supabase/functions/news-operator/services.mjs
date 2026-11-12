import {readJson} from '../_shared/adapters.mjs';
import {createReviewPacket,approveReview} from '../_shared/curation.mjs';
import {prepareTransport} from '../_shared/transport.mjs';
// No network work on construction; the handler denies an empty operator allowlist first.
export function operatorServices(config,fetcher=fetch){
 const project=()=>{const u=new URL(config.projectUrl);if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co')||u.username||u.password)throw Error('Invalid project');return u;};
 const request=async(path,params={},body)=>{const url=new URL(path,project());url.search=new URLSearchParams(params);return readJson(await fetcher(url,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{apikey:config.serviceKey,Authorization:`Bearer ${config.serviceKey}`,'Content-Type':'application/json',Prefer:'return=representation'},...(body?{body:JSON.stringify(body)}:{})}));};
 const decide=async(body,reviewer,approve)=>{
  if(!/^[0-9a-f-]{36}$/.test(body.reviewId)||!Number.isInteger(body.revision))throw Error('Saved review required');
  const rows=await request('/rest/v1/warpcore_reviews',{select:'*',id:'eq.'+body.reviewId,limit:'1'}),r=rows[0];
  if(!r||r.state!=='pending'||r.revision!==body.revision||r.content_hash!==body.contentHash)throw Error('Stale review');
  if(approve)await approveReview(r.packet,{...body.review,contentHash:body.contentHash});
  const ok=await request('/rest/v1/rpc/warpcore_decide_review',{}, {p_id:r.id,p_hash:r.content_hash,p_revision:r.revision,p_reviewer:reviewer,p_approve:approve});
  if(ok!==true)throw Error('Concurrent review conflict');return {approved:approve,rejected:!approve,publishing_enabled:false};
 };
 return {
  identify:async token=>readJson(await fetcher(new URL('/auth/v1/user',project()),{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{apikey:config.serviceKey,Authorization:`Bearer ${token}`}})),
  list:async()=>({stories:await request('/rest/v1/warpcore_stories',{select:'story_key,status,collected_at',status:'eq.unverified_review_required',order:'collected_at.desc',limit:'20'}),reviews:await request('/rest/v1/warpcore_reviews',{select:'id,content_hash,revision,state,packet,job,created_at',state:'eq.pending',order:'created_at.desc',limit:'20'})}),
  preview:async body=>{
   if(!/^[a-f0-9]{64}$/.test(body.storyKey))throw Error('Invalid story');
   const rows=await request('/rest/v1/warpcore_candidates',{select:'uri,source_url,text,source_type',story_key:'eq.'+body.storyKey,limit:'20'});
   // This table's ingestion contract rejects private input; only public article evidence belongs here.
   const packet=await createReviewPacket({storyKey:body.storyKey,editorial:body.editorial,evidence:rows.map(r=>({id:r.uri,url:r.source_url,text:r.text,sourceType:r.source_type,visibility:'public'}))});
   // These flags enable record formatting only. SQL approval remains absent until decide_review.
   const prepared=await prepareTransport({...packet.recordDraft,verified:true,approved:true},config.accountDid,new Date().toISOString());
   const job={...prepared,storyKey:body.storyKey};
   const saved=await request('/rest/v1/warpcore_reviews',{}, {packet,job,content_hash:packet.contentHash});
   return {reviewId:saved[0].id,revision:saved[0].revision,contentHash:packet.contentHash,packet,record:job.record,publishing_enabled:false};
  },
  approve:(body,reviewer)=>decide(body,reviewer,true),
  reject:(body,reviewer)=>decide(body,reviewer,false),
 };
}
