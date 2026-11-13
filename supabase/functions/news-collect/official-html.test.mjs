import test from 'node:test';import assert from 'node:assert/strict';import {parseOfficialHTML,collectOfficialHTML} from './official-html.mjs';
const now=Date.parse('2026-11-13T16:00:00Z'),anth={url:'https://www.anthropic.com/news',label:'Anthropic News'},ppl={url:'https://www.perplexity.ai/hub/blog',label:'Perplexity Blog'};
const article='<article><time>Nov 12, 2026</time><a href="/news/example"><h2>New model</h2><p>Useful detail.</p></a></article>';
const page=data=>`<script>window.__PPL_INITIAL_SERVER_DATA__=${JSON.stringify(data)};window.__PPL_INITIAL_SESSION__=null;</script>`;
test('official Anthropic dates/links and public provenance are preserved',()=>{
 const rows=parseOfficialHTML(article+article,anth,now);assert.equal(rows.length,1);assert.equal(rows[0].publishedAt,'2026-11-12T00:00:00.000Z');assert.equal(rows[0].url,'https://www.anthropic.com/news/example');assert.equal(rows[0].visibility,'public');assert.equal(rows[0].author,'Anthropic News');
 assert.throws(()=>parseOfficialHTML(article.replace('/news/example','//evil.example'),anth,now));
 assert.equal(parseOfficialHTML(article.replace('Nov 12','Oct 12'),anth,now).length,0);
 assert.equal(parseOfficialHTML(article.replace('Nov 12','Dec 12'),anth,now).length,0);
 assert.throws(()=>parseOfficialHTML('<script>'+article+'</script>',anth,now));
});
test('Perplexity embedded JSON is parsed, never evaluated, and slugs stay on origin',()=>{
 const item={slug:'new-model',title:'New model',summary:'Detail',publishedAt:'2026-11-12'};
 assert.equal(parseOfficialHTML(page({items:[item,item]}),ppl,now).length,1);
 assert.throws(()=>parseOfficialHTML(page({items:[{...item,slug:'../evil'}]}),ppl,now));
 assert.throws(()=>parseOfficialHTML('<script>window.__PPL_INITIAL_SERVER_DATA__={"x":alert(1)};window.__PPL_INITIAL_SESSION__=null;</script>',ppl,now));
});
test('official HTML fetching has exact URL allowlist, bounds, no redirects and no credentials',async()=>{
 let calls=0;await assert.rejects(()=>collectOfficialHTML({url:'https://evil.example',label:'x'},async()=>{calls++;}));assert.equal(calls,0);
 const rows=await collectOfficialHTML(anth,async(url,opts)=>{assert.equal(url,anth.url);assert.equal(opts.redirect,'error');assert.ok(opts.signal);return new Response(article,{headers:{'content-type':'text/html'}});},now);assert.equal(rows.length,1);
 await assert.rejects(()=>collectOfficialHTML(anth,async()=>new Response('x'.repeat(1000001),{headers:{'content-type':'text/html'}}),now));
 await assert.rejects(()=>collectOfficialHTML(anth,async()=>new Response(article,{headers:{'content-type':'application/json'}}),now));
 assert.throws(()=>parseOfficialHTML('changed layout',anth,now));
});
