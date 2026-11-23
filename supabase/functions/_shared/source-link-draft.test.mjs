import test from 'node:test';
import assert from 'node:assert/strict';
import * as renderer from './source-link-draft.mjs';
const source={visibility:'public',sourceType:'rss',url:'https://publisher.example/updates/release',text:'Example Publisher announces a new processor\nEarlier rumors said it might ship in spring.'};
test('link-only draft renders the captured headline and original link, with no extra claims', ()=>{
 const draft=renderer.sourceLinkDraft(source);
 assert.equal(draft.mode,'source_link');
 assert.equal(draft.text,'Headline: Example Publisher announces a new processor\n\n'+source.url);
 assert.deepEqual(draft.link,{uri:source.url,byteStart:new TextEncoder().encode('Headline: Example Publisher announces a new processor\n\n').length,byteEnd:new TextEncoder().encode(draft.text).length});
 assert.equal(draft.factsVerified,false);
});
test('link-only draft rejects sources without a known collector headline format', ()=>{
 for(const s of [{...source,visibility:'private'},{...source,sourceType:'bluesky'},{...source,sourceType:'hn'},{...source,sourceType:'newsletter'},{...source,text:''},{...source,text:'<script>Not a headline</script>'}])assert.throws(()=>renderer.sourceLinkDraft(s),/Source-link/);
});
test('link-only draft preserves Unicode link offsets and refuses to cut a headline', ()=>{
 const row={...source,sourceType:'official_html',text:'Example: café researchers 🧪 announce a result'};
 const result=renderer.sourceLinkDraft(row);
 assert.equal(new TextDecoder().decode(new TextEncoder().encode(result.text).slice(result.link.byteStart,result.link.byteEnd)),row.url);
 assert.throws(()=>renderer.sourceLinkDraft({...row,text:'x'.repeat(300)}),/Source-link/);
});
test('link-only draft cannot substitute a different destination or embed a second link', ()=>{
 for(const row of [{...source,url:'http://publisher.example/'},{...source,url:'https://login:password@publisher.example/'},{...source,url:'https://publisher.example/releases#fragment'},{...source,text:'Headline https://unrelated.example/'},{...source,text:'Headline\u202E reordered'}])assert.throws(()=>renderer.sourceLinkDraft(row),/Source-link/);
});

test('the configured RSS parser supplies a headline without fetching the linked article', async ()=>{
 const {parseFeed}=await import('../news-collect/rss.mjs');
 const now=Date.parse('2026-11-23T15:00:00Z');
 const xml='<rss><channel><item><title>Example Publisher ships a new tool</title><link>'+source.url+'</link><pubDate>Mon, 23 Nov 2026 14:00:00 GMT</pubDate><description><![CDATA[<p>Unneeded full-page evidence for this format.</p>]]></description></item></channel></rss>';
 const [capture]=parseFeed(xml,{url:'https://publisher.example/feed',label:'Example Publisher'},now);
 const draft=renderer.sourceLinkDraft({...capture,sourceType:'rss'});
 assert.equal(draft.text,'Headline: Example Publisher ships a new tool\n\n'+source.url);
});
