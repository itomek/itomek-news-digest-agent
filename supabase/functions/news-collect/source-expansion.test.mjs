import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {registry} from './adapters.mjs';
import {collectRSS} from './rss.mjs';
import {parseOfficialHTML} from './official-html.mjs';
import {MAX_SOURCES} from '../_shared/pipeline.mjs';
import {runAdapters} from '../_shared/pipeline.mjs';
import {candidateRow} from '../bluesky-collect/store.mjs';
const now=Date.parse('2026-11-18T12:00:00Z');
test('approved expansion retains existing sources and supports each new exact feed',async()=>{
 const roster=JSON.parse(await fs.readFile(new URL('./initial-sources.json',import.meta.url)));
 const ids=['deepseek_updates','openclaw_news','pi_announcements','jetbrains_blog','infoq_agents','huggingface_posts','esa_science','spacenews','virgin_galactic_news'];
 assert.equal(roster.length,55);assert.ok(roster.length<=MAX_SOURCES);
 for(const id of ids){const s=roster.find(s=>s.id===id);assert.ok(s,id);assert.equal(typeof registry[s.adapter]?.collectPage,'function');
  if(s.adapter==='rss')await collectRSS(s.config,async(url,opts)=>{assert.equal(url,s.config.url);assert.equal(opts.redirect,'error');return new Response('<rss><channel/></rss>',{headers:{'content-type':'application/xml'}});},now);
 }
});
test('DeepSeek dated sections retain distinct identities and reject undated/script-only layouts',async()=>{
 const config={url:'https://api-docs.deepseek.com/updates/',label:'DeepSeek'};
 const html='<article><h2 id="date-2026-11-17">Date: 2026-11-17</h2><h3>New model</h3><p>New capabilities.</p><h2 id="date-2026-11-16">Date: 2026-11-16</h2><h3>New service</h3><p>Available now.</p></article>';
 const items=parseOfficialHTML(html,config,now);assert.equal(items.length,2);assert.notEqual(items[0].id,items[1].id);assert.equal(items[0].url,config.url);assert.match(items[0].text,/2026-11-17/);
 const normalized=await runAdapters([{id:'deepseek_updates',adapter:'official_html'}],{official_html:{collect:async()=>items}});
 const rows=await Promise.all(normalized.candidates.map(candidateRow));assert.notEqual(rows[0].story_key,rows[1].story_key,'separate dates on a rolling changelog are separate stories');
 assert.throws(()=>parseOfficialHTML('<script>'+html+'</script>',config,now));
 assert.throws(()=>parseOfficialHTML('<h3>Undated announcement</h3>',config,now));
 assert.equal(parseOfficialHTML(html,config,now,{since:'2026-11-17T00:00:00Z',until:'2026-11-18T00:00:00Z'}).length,1);
});
test('official space/company cards require visible dates and same-origin article paths',()=>{
 for(const [url,heading] of [['https://x.ai/news','<h3>New model</h3>'],['https://www.virgingalactic.com/news','<p class="font-title-lg">Flight milestone</p>']]){
  const html=`<a href="/news/launch">${heading}<p>November 17, 2026</p></a>`;
  assert.equal(parseOfficialHTML(html,{url,label:'Official'},now).length,1);
  assert.throws(()=>parseOfficialHTML('<script>'+html+'</script>',{url,label:'Official'},now));
 }
});
