import test from 'node:test';
import assert from 'node:assert/strict';
import {syncSources} from './checkpoints.mjs';
import {collectRSSPage} from './rss.mjs';
const config={url:'https://rocm.blogs.amd.com/blog/atom.xml',label:'ROCm'};
const feed=date=>new Response(`<feed><entry><id>${date}</id><title>ROCm release</title><link href="https://rocm.blogs.amd.com/release"/><updated>${date}</updated></entry></feed>`,{headers:{'content-type':'application/atom+xml'}});
test('persistent ROCm 429 stays failed, preserves its window, and later schedules still collect new items',async()=>{
 const prior='2026-11-10T00:00:00Z',first='2026-11-15T12:00:00Z',later='2026-11-16T12:00:00Z';
 const states=new Map(),finishes=[],windows=[];let attempts=0;
 // Model the durable RPC contract: failures retain windows, finite gaps clear
 // windows without certifying coverage. This is an orchestration regression,
 // not a replacement for database RPC integration tests.
 const store={begin:async args=>{
  const state=states.get(args.p_source_key)??{covered_through:prior,last_success_at:prior};
  if(!state.window_until){state.window_since=prior;state.window_until=args.p_upper;}
  states.set(args.p_source_key,state);return {acquired:true,token:args.p_source_key,...state};
 },finish:async args=>{
  finishes.push(args);const state=states.get(args.p_source_key);
  if(args.p_outcome!=='failed'){state.window_since=null;state.window_until=null;}
  return {accepted:true,status:args.p_outcome,covered_through:state.covered_through,last_success_at:state.last_success_at};
 }};
 const registry={rss:{collectPage:async(selected,window)=>{
  windows.push(window);return collectRSSPage(selected,async()=>{attempts++;return attempts<=2?new Response('private diagnostic',{status:429}):feed(attempts===3?'2026-11-15T10:00:00Z':'2026-11-16T10:00:00Z');},window);
 }},fixture:{collectPage:async()=>({items:[],complete:true,cursor:null,coverageGap:false,fetchedCount:0})}};
 const selected=[{id:'rocm',adapter:'rss',config},{id:'healthy',adapter:'fixture'}];
 for(const upper of [first,later,later,later]){
  const result=await syncSources(selected,registry,store,upper);
  assert.equal(result.sources[1].status,'empty');
  const source=result.sources[0];assert.equal(source.status,attempts<=2?'failed':'gap');
  assert.equal(source.covered_through,prior);assert.equal(source.last_successful_sync,prior);
  if(attempts<=2){assert.equal(source.error,'source_http_429');assert.equal(source.count,0);}
  else assert.equal(source.count,1);
 }
 const rocm=finishes.filter(x=>x.p_source_key==='rss:rocm');
 assert.deepEqual(rocm.map(x=>x.p_outcome),['failed','failed','gap','gap']);
 assert.deepEqual(windows.map(x=>x.until),[first,first,first,later]);
 assert.equal(rocm[3].p_items[0].source_created_at,'2026-11-16T10:00:00.000Z');
 assert.doesNotMatch(JSON.stringify(rocm),/private diagnostic/);
});
