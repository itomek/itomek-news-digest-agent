import {createAgentService} from '../news-agent/services.mjs';
const PRODUCTION_REF='eedfyviypptfpghyffip';
const MODEL='fixture/hosted-spike';
const DUMMY_KEY='fabricated-hosted-spike-no-model-credential';
const OPENROUTER='https://openrouter.ai/api/v1/chat/completions';
const operations=new Set(['select_run','candidate_page','claim','load','paged_append','paged_preview','paged_begin','paged_commit','paged_uncertain','paged_bind_config','paged_reserve','dispatch','paged_settle']);
// Isolated spike only. Model completions are fabricated in-process; this adapter
// cannot forward a model request or fetch source URLs. It never looks up secrets.
export function createSpikeService(config={},fetcher=fetch){
 const {projectRef,projectUrl,serviceKey}=config;
 let project;
 try{project=new URL(projectUrl);}catch{throw Error('Invalid isolated spike project');}
 if(typeof projectRef!=='string'||!/^[a-z0-9]{20}$/.test(projectRef)||projectRef===PRODUCTION_REF||project.origin!==`https://${projectRef}.supabase.co`||project.username||project.password||project.pathname!=='/'||project.search||project.hash||project.port||typeof serviceKey!=='string'||!serviceKey||/[\r\n]/.test(serviceKey)||typeof fetcher!=='function')throw Error('Invalid isolated spike project');
 let generation=0;
 const transport=async(raw,options={})=>{
  let url;try{url=new URL(raw);}catch{throw Error('Invalid spike transport destination');}
  if(url.href===OPENROUTER){
   if(options.method!=='POST'||options.redirect!=='error'||options.headers?.Authorization!==`Bearer ${DUMMY_KEY}`||typeof options.body!=='string')throw Error('Invalid fabricated spike request');
   const request=JSON.parse(options.body);
   if(request.model!==MODEL||request.stream!==false||!Array.isArray(request.messages)||request.messages.length!==2)throw Error('Invalid fabricated spike model');
   const candidates=JSON.parse(request.messages[1].content).candidates;
   if(!Array.isArray(candidates)||candidates.length<1||candidates.length>25||candidates.some(c=>typeof c?.id!=='string'||!/^[a-f0-9]{64}$/.test(c.id))||new Set(candidates.map(c=>c.id)).size!==candidates.length)throw Error('Invalid fabricated spike candidates');
   generation++;
   return Response.json({id:`fixture-hosted-spike-${generation}`,model:MODEL,
    usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0,cost:0},
    choices:[{finish_reason:'stop',message:{content:JSON.stringify({decisions:candidates.map(c=>({id:c.id,action:'skip',reason:'Fabricated hosted-spike response; no editorial judgment.'}))})}}]});
  }
  const operation=url.pathname.startsWith('/rest/v1/rpc/warpcore_shadow_')?url.pathname.slice('/rest/v1/rpc/warpcore_shadow_'.length):null;
  if(url.origin!==project.origin||url.username||url.password||url.search||url.hash||!operations.has(operation)||options.method!=='POST'||options.redirect!=='error'||options.headers?.apikey!==serviceKey||options.headers?.Authorization!==`Bearer ${serviceKey}`)throw Error('Spike transport destination refused');
  return fetcher(url,options);
 };
 return createAgentService({projectUrl:project.origin,serviceKey,runtimeConfig:{
  enabled:config.enabled===true,model:MODEL,allowedModels:[MODEL],apiKey:DUMMY_KEY,
  requireModelProfile:false,maxOutputTokens:2000,maxCostCredits:0.01,
  timeoutMs:1000,maxResponseBytes:200000,leaseSeconds:60,
 },invocationOptions:{pageSteps:1,reviewBatchSize:25}},transport);
}
