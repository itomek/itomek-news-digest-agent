import test from 'node:test';
import assert from 'node:assert/strict';
import {syncSources} from './checkpoints.mjs';
import {collectHNPage} from './hn.mjs';
const since='2026-11-14T12:00:00.000Z',oldUpper='2026-11-21T12:00:00.000Z';
const selection={id:'hn',adapter:'hn',config:{terms:['AMD'],minScore:0,minComments:0}};
function fixture(offset=180,length=240){
 const state={window_since:since,window_until:oldUpper,cursor:{since,until:oldUpper,ids:Array.from({length},(_,i)=>i+1),offset},covered_through:null};
 const finishes=[];
 return {state,finishes,store:{begin:async()=>({acquired:true,token:'lease',...state}),finish:async args=>{finishes.push(args);if(args.p_outcome!=='failed')state.cursor=args.p_cursor;return {accepted:true,status:args.p_outcome,covered_through:state.covered_through};}}};
}
test('HN refreshes current head on successive resumed snapshots while preserving bounded backlog progress and finite coverage',async()=>{
 const f=fixture();
 for(const [index,upper] of ['2026-11-21T16:00:00.000Z','2026-11-21T16:30:00.000Z'].entries()){
  const requests=[];const head=1000+index;
  const registry={hn:{collectPage:(config,window)=>collectHNPage(config,async url=>{
   requests.push(url);
   if(url.endsWith('topstories.json'))return Response.json([head,181+index*20,...Array.from({length:38},(_,i)=>500+i)]);
   const id=Number(/item\/(\d+)/.exec(url)[1]);return Response.json({id,type:'story',title:`AMD news ${id}`,time:Date.parse(id===head?upper:since)/1000,score:10,descendants:1});
  },window)}};
  const result=await syncSources([selection],registry,f.store,upper),saved=f.finishes.at(-1);
  assert.ok(saved.p_items.some(row=>row.text===`AMD news ${head}`),'current head story is persisted');
  assert.equal(requests.filter(url=>url.endsWith('topstories.json')).length,1);
  assert.equal(requests.length,41,'two bounded twenty-item pages plus one refreshed index');
  assert.equal(saved.p_cursor.offset,200+index*20);assert.equal(saved.p_cursor.until,oldUpper);assert.equal(saved.p_cursor.ids[0],1);
  assert.equal(saved.p_fetched,40);assert.equal(saved.p_items.length,39,'head and backlog overlap persists once');assert.equal(new Set(saved.p_items.map(row=>row.uri)).size,39);assert.equal(saved.p_outcome,'partial');assert.equal(f.state.covered_through,null);
  assert.equal(result.sources[0].head_checked_at,upper);assert.equal(result.sources[0].coverage_gap,true);
  assert.deepEqual(result.sources[0].coverage_reasons,['finite_top_story_snapshot']);
 }
});
test('HN exhausted snapshot remains a coverage gap and head failure preserves saved progress',async()=>{
 for(const failHead of [false,true]){
  const f=fixture(20,21),original=structuredClone(f.state.cursor);
  const result=await syncSources([selection],{hn:{collectPage:(config,window)=>collectHNPage(config,async url=>{
   if(url.endsWith('topstories.json')){if(failHead)throw Error('head unavailable');return Response.json([]);}
   const id=Number(/item\/(\d+)/.exec(url)[1]);return Response.json({id,type:'story',title:'AMD news',time:Date.parse(since)/1000,score:1,descendants:1});
  },window)}},f.store,'2026-11-21T16:00:00.000Z');
  assert.equal(result.sources[0].status,failHead?'failed':'gap');assert.equal(f.state.covered_through,null);
  assert.deepEqual(f.state.cursor,failHead?original:null);
  if(failHead)assert.deepEqual(f.finishes[0].p_items,[]);
 }
});
