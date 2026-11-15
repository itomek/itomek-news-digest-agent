import test from 'node:test';
import assert from 'node:assert/strict';
import {syncSources,configurationHash,createCheckpointStore} from './checkpoints.mjs';
const upper='2026-11-15T12:00:00.000Z';
const selection={id:'fixture',adapter:'fixture',config:{}};
const item=(id,publishedAt='2026-11-14T12:00:00Z')=>({id:String(id),text:`Story ${id}`,publishedAt,url:`https://example.com/${id}`,visibility:'public'});
function fixture(){
 const state={cursor:null,window_since:'2026-11-01T00:00:00Z',window_until:upper,covered_through:null};
 const finishes=[];
 const store={begin:async()=>({acquired:true,token:'token',...state}),finish:async args=>{finishes.push(args);if(args.p_outcome==='failed')return {accepted:true,status:'failed'};state.cursor=args.p_cursor;if(['complete','empty'].includes(args.p_outcome))state.covered_through=state.window_until;return {accepted:true,status:args.p_outcome,covered_through:state.covered_through,new:args.p_items.length,duplicate:0};}};
 return {state,finishes,store};
}
test('405-item backlog survives invocation restarts and advances only after final durable page',async()=>{
 const f=fixture();const seen=[];
 const registry={fixture:{collectPage:async(config,window)=>{assert.equal(window.until,upper);const offset=window.cursor?.offset??0;const end=Math.min(offset+100,405);return {items:Array.from({length:end-offset},(_,i)=>item(offset+i)),complete:end===405,cursor:end===405?null:{offset:end},coverageGap:false,earliestAvailableAt:null,fetchedCount:end-offset};}}};
 for(let i=0;i<5;i++){const result=await syncSources([selection],registry,f.store,upper);seen.push(result.sources[0].status);if(i<4)assert.equal(f.state.covered_through,null);}
 assert.deepEqual(seen,['partial','partial','partial','partial','complete']);
 assert.equal(f.finishes.reduce((sum,x)=>sum+x.p_items.length,0),405);
 assert.equal(new Set(f.finishes.flatMap(x=>x.p_items.map(i=>i.uri))).size,405);
 assert.equal(f.state.covered_through,upper);
});
test('genuine empty success persists and finite empty feed records a gap',async()=>{
 for(const gap of [false,true]){const f=fixture();const result=await syncSources([selection],{fixture:{collectPage:async()=>({items:[],complete:true,cursor:null,coverageGap:gap,earliestAvailableAt:null,fetchedCount:0})}},f.store,upper);assert.equal(result.sources[0].status,gap?'gap':'empty');assert.equal(f.state.covered_through,gap?null:upper);}
});
test('parsing or persistence failure preserves checkpoint and successful sources progress independently',async()=>{
 const f=fixture();const original=f.store.finish;f.store.finish=async args=>{if(args.p_items.length)throw Error('secret db token');return original(args);};
 const registry={fixture:{collectPage:async()=>({items:[item(1)],complete:true,coverageGap:false,cursor:null,fetchedCount:1})}};
 const result=await syncSources([selection],registry,f.store,upper);
 assert.equal(result.sources[0].status,'failed');assert.equal(f.state.covered_through,null);assert.doesNotMatch(JSON.stringify(result),/secret db token/);
 const good=fixture();const both=await syncSources([selection,{id:'broken',adapter:'broken'}],{...registry,broken:{collectPage:async()=>{throw Error('secret');}}},good.store,upper);
 assert.deepEqual(both.sources.map(x=>x.status),['complete','failed']);
});
test('busy lease does not fetch; unfenced completion rejected; partial without cursor fails',async()=>{
 let fetched=false;const registry={fixture:{collectPage:async()=>{fetched=true;return {};}}};
 const busy=await syncSources([selection],registry,{begin:async()=>({acquired:false})},upper);assert.equal(busy.sources[0].status,'busy');assert.equal(fetched,false);
 const f=fixture();const partial=await syncSources([selection],{fixture:{collectPage:async()=>({items:[],complete:false,coverageGap:false,cursor:null,fetchedCount:0})}},f.store,upper);assert.equal(partial.sources[0].status,'failed');assert.equal(f.state.covered_through,null);
});
test('fixed upper excludes future records while exact timestamp ties persist',async()=>{
 const f=fixture();await syncSources([selection],{fixture:{collectPage:async()=>({items:[item(1,upper),item(2,'2026-11-16T00:00:00Z')],complete:true,coverageGap:false,cursor:null,fetchedCount:2})}},f.store,upper);assert.equal(f.finishes[0].p_items.length,1);assert.equal(f.finishes[0].p_items[0].source_created_at,upper);
});
test('configuration hashes are stable under object key ordering and change with source config',async()=>{
 assert.equal(await configurationHash({...selection,config:{b:1,a:2}}),await configurationHash({...selection,config:{a:2,b:1}}));assert.notEqual(await configurationHash(selection),await configurationHash({...selection,config:{actor:'new'}}));
});
test('checkpoint store sends authenticated RPC requests without exposing raw errors',async()=>{
 const calls=[];const store=createCheckpointStore({SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'private'},async(url,options)=>{calls.push({url:String(url),options});return Response.json({acquired:true});});
 await store.begin({p_source_key:'rss:test'});assert.match(calls[0].url,/rpc\/warpcore_sync_begin$/);assert.equal(calls[0].options.redirect,'error');assert.equal(JSON.parse(calls[0].options.body).p_source_key,'rss:test');
});
test('handler production path persists checkpoints and never falls back to generic writes',async()=>{
 const {handle}=await import('./handler.mjs');const token='a'.repeat(32);const f=fixture();
 const response=await handle(new Request('https://example.com',{method:'POST',headers:{'x-warpcore-token':token}}),{WARPCORE_CRON_TOKEN:token,NEWS_SOURCE_CONFIG:JSON.stringify([selection])},{fixture:{collectPage:async()=>({items:[],complete:true,coverageGap:false,cursor:null,fetchedCount:0})}},{store:f.store,upper});
 assert.equal(response.status,200);assert.equal(f.finishes[0].p_outcome,'empty');assert.equal((await response.json()).sources[0].covered_through,upper);
 const rejected=fixture();rejected.store.finish=async()=>({accepted:false});const result=await syncSources([selection],{fixture:{collectPage:async()=>({items:[],complete:true,coverageGap:false,cursor:null,fetchedCount:0})}},rejected.store,upper);assert.equal(result.sources[0].status,'failed');assert.equal(rejected.state.covered_through,null);
});
test('retained feed snapshots exceeding 500 candidates persist atomically without truncation',async()=>{
 const f=fixture();const rows=Array.from({length:1387},(_,index)=>item(index));
 const result=await syncSources([selection],{fixture:{collectPage:async()=>({items:rows,complete:true,coverageGap:true,cursor:null,fetchedCount:rows.length})}},f.store,upper);
 assert.equal(result.sources[0].status,'gap');assert.equal(result.sources[0].count,1387);
 assert.equal(f.finishes.length,1);assert.equal(f.finishes[0].p_outcome,'gap');assert.equal(f.finishes[0].p_items.length,1387);
 assert.equal(new Set(f.finishes[0].p_items.map(row=>row.uri)).size,1387);assert.equal(f.state.covered_through,null);
});
test('oversized snapshots and malformed evidence in later validation chunks cannot persist candidates or advance coverage',async()=>{
 for(const rows of [Array.from({length:5001},(_,index)=>item(index)),[...Array.from({length:600},(_,index)=>item(index)),{...item(600),visibility:'private'}]]){
  const f=fixture();const prior='2026-11-10T00:00:00Z';f.state.covered_through=prior;
  const result=await syncSources([selection],{fixture:{collectPage:async()=>({items:rows,complete:true,coverageGap:true,cursor:null,fetchedCount:rows.length})}},f.store,upper);
  assert.equal(result.sources[0].status,'failed');assert.equal(f.state.covered_through,prior);
  assert.equal(f.finishes.length,1);assert.equal(f.finishes[0].p_outcome,'failed');assert.deepEqual(f.finishes[0].p_items,[]);
 }
});
test('only fixed diagnostic codes reach durable attempts and operations responses',async()=>{
 for(const incoming of ['source_http_403','source_parse_failed','source_timeout','secret token https://private.example']){
  const f=fixture();const expected=incoming.startsWith('secret')?'source_or_persistence_failed':incoming;
  const result=await syncSources([selection],{fixture:{collectPage:async()=>{throw Object.assign(Error('private upstream details'),{code:incoming});}}},f.store,upper);
  assert.equal(f.finishes[0].p_error_code,expected);assert.equal(result.sources[0].error,expected);
  assert.doesNotMatch(JSON.stringify(result),/private|secret/);assert.equal(f.state.covered_through,null);
 }
});
