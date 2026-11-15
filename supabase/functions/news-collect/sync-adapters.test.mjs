import test from 'node:test';
import assert from 'node:assert/strict';
import {collectBlueskyPage} from '../bluesky-collect/core.mjs';
import {collectRSSPage} from './rss.mjs';
import {collectOfficialHTMLPage} from './official-html.mjs';
import {collectHNPage} from './hn.mjs';
const until='2026-11-15T12:00:00.000Z',since='2026-11-14T12:00:00.000Z';
const config={actors:['example.bsky.social'],terms:['AMD']};
const post=(id,date=since)=>({post:{uri:`at://did:plc:example/app.bsky.feed.post/${id}`,record:{text:'AMD release',createdAt:date}}});
test('405-item backlog resumes from serialized cursors across five separate invocations without timestamp ordering assumptions',async()=>{
 const available=Array.from({length:405},(_,i)=>post(i,i===404?'2020-01-01T00:00:00Z':since));
 let cursor=null;const ids=[];let calls=0;
 do{
  const result=await collectBlueskyPage(config,async(url,opts)=>{
   assert.equal(opts.redirect,'error');assert.equal(url.searchParams.get('limit'),'100');
   const start=Number(url.searchParams.get('cursor')??0),feed=available.slice(start,start+100);
   calls++;return Response.json({feed,...(start+100<available.length?{cursor:String(start+100)}:{})});
  },{since,until,cursor});
  assert.equal(result.coverageGap,false);ids.push(...result.items.map(x=>x.id));
  cursor=JSON.parse(JSON.stringify(result.cursor));assert.equal(result.complete,cursor===null);
 }while(cursor);
 assert.equal(calls,5);assert.equal(new Set(ids).size,405);assert.match(ids.at(-1),/404$/);
});
test('successful empty history is complete; source and non-progressing cursor failures cannot claim completion',async()=>{
 const empty=await collectBlueskyPage(config,async()=>Response.json({feed:[]}),{since,until});
 assert.equal(empty.complete,true);assert.equal(empty.fetchedCount,0);assert.equal(empty.coverageGap,false);
 await assert.rejects(()=>collectBlueskyPage(config,async()=>new Response('',{status:500}),{since,until}));
 const cursor={actor:config.actors[0],since,until,token:'repeat'};
 await assert.rejects(()=>collectBlueskyPage(config,async()=>Response.json({feed:[],cursor:'repeat'}),{since,until,cursor}),/Non-progressing/);
 await assert.rejects(()=>collectBlueskyPage(config,async()=>Response.json({feed:[]}),{since,until:'2026-11-16T00:00:00Z',cursor}),/Invalid Bluesky cursor/);
});
test('fixed upper boundary includes exact ties, skips future records and retains late old evidence',async()=>{
 const result=await collectBlueskyPage(config,async()=>Response.json({feed:[post('lower'),post('upper',until),post('future','2027-01-01T00:00:00Z'),post('late','2020-01-01T00:00:00Z')]}),{since,until});
 assert.equal(result.items.length,3);assert.ok(result.items.some(x=>x.id.endsWith('/late')));
});
test('malformed source date becomes explicit coverage gap',async()=>{
 const result=await collectBlueskyPage(config,async()=>Response.json({feed:[post('broken','nonsense')]}),{since,until});
 assert.equal(result.coverageGap,true);assert.equal(result.gapReason,'malformed_source_dates');
});
test('finite RSS retains old evidence and reports a gap instead of certifying completeness',async()=>{
 const xml='<rss><channel><item><title>Old announcement</title><link>https://example.com/old</link><pubDate>Wed, 01 Jan 2020 00:00:00 GMT</pubDate></item></channel></rss>';
 const result=await collectRSSPage({url:'https://blogs.nvidia.com/feed/',label:'NVIDIA'},async()=>new Response(xml,{headers:{'content-type':'application/rss+xml'}}),{since,until});
 assert.equal(result.items.length,1);assert.equal(result.coverageGap,true);assert.equal(result.earliestAvailableAt,'2020-01-01T00:00:00.000Z');
 await assert.rejects(()=>collectRSSPage({url:'https://blogs.nvidia.com/feed/',label:'NVIDIA'},async()=>new Response('<html/>',{headers:{'content-type':'application/xml'}}),{since,until}),/Unrecognized feed/);
});
test('finite official HTML retains old evidence and reports an explicit history gap',async()=>{
 const html='<article><time>2020-01-01</time><a href="/news/old"><h2>Old announcement</h2></a></article>';
 const result=await collectOfficialHTMLPage({url:'https://www.anthropic.com/news',label:'Anthropic'},async()=>new Response(html,{headers:{'content-type':'text/html'}}),{since,until});
 assert.equal(result.items.length,1);assert.equal(result.coverageGap,true);assert.equal(result.earliestAvailableAt,'2020-01-01T00:00:00.000Z');
});
test('HN resumes a frozen top-story snapshot while explicitly reporting its coverage limitation',async()=>{
 let cursor=null,indices=0;const ids=[];
 do{
  const result=await collectHNPage({terms:['AMD'],minScore:0,minComments:0},async url=>{
   if(url.endsWith('topstories.json')){indices++;return Response.json(Array.from({length:45},(_,i)=>i+1));}
   const id=Number(/item\/(\d+)/.exec(url)[1]);return Response.json({id,type:'story',title:'AMD news',time:1577836800,score:10,descendants:1});
  },{since,until,cursor});
  ids.push(...result.items.map(x=>x.id));assert.equal(result.coverageGap,true);cursor=JSON.parse(JSON.stringify(result.cursor));
 }while(cursor);
 assert.equal(indices,1);assert.equal(new Set(ids).size,45);
});

test('valid empty RSS is a completed finite snapshot with explicit coverage limitation',async()=>{
 const result=await collectRSSPage({url:'https://blogs.nvidia.com/feed/',label:'NVIDIA'},async()=>new Response('<rss><channel/></rss>',{headers:{'content-type':'application/rss+xml'}}),{since,until});
 assert.equal(result.complete,true);assert.equal(result.fetchedCount,0);assert.equal(result.coverageGap,true);
});

test('malformed original Bluesky evidence never certifies complete coverage',async()=>{
 const did='did:plc:abcdefghijklmnopqrstuvwx',uri=`at://${did}/app.bsky.feed.post/3n256uxsaokol`;
 const pinned={...config,actorDids:{[config.actors[0]]:did}};
 const valid={post:{uri,cid:'bafyre'+'a'.repeat(53),author:{did},record:{text:'AMD release',createdAt:since}}};
 const malformed=[
  {...valid,post:{...valid.post,cid:'broken'}},
  {...valid,post:{...valid.post,uri:undefined}},
  {...valid,post:{...valid.post,uri:'at://broken'}},
  {...valid,post:{...valid.post,record:{createdAt:since}}},
  {...valid,post:{...valid.post,author:{did:'did:plc:wrong'}}},
 ];
 for(const item of malformed){
  await assert.rejects(()=>collectBlueskyPage(pinned,async()=>Response.json({feed:[item]}),{since,until}),/Bluesky source failed/);
 }
 const good=await collectBlueskyPage(pinned,async()=>Response.json({feed:[valid]}),{since,until});
 assert.equal(good.items.length,1);assert.equal(good.complete,true);assert.equal(good.coverageGap,false);
});
