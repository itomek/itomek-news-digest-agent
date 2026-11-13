import test from 'node:test';
import assert from 'node:assert/strict';
import * as rss from './rss.mjs';
const now=Date.parse('2026-11-12T12:00:00Z');
const xml='<rss><channel><title>Vendor</title><item><guid>release1</guid><title>New release</title><link>https://example.com/news</link><description><![CDATA[<p>Useful change.</p>]]></description><pubDate>Thu, 12 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>';
test('parses RSS public evidence without HTML and retains attribution',()=>{
 assert.equal(typeof rss.parseFeed,'function');
 const rows=rss.parseFeed(xml,{url:'https://example.com/rss',label:'Vendor'},now);
 assert.equal(rows[0].text,'New release\nUseful change.');assert.equal(rows[0].author,'Vendor');assert.equal(rows[0].url,'https://example.com/news');assert.equal(rows[0].visibility,'public');
});
test('rejects DTD, oversized XML, invalid dates and unsafe links',()=>{
 assert.equal(typeof rss.parseFeed,'function');
 assert.throws(()=>rss.parseFeed('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+xml,{},now));
 assert.throws(()=>rss.parseFeed('x'.repeat(1000001),{},now));
 assert.equal(rss.parseFeed(xml.replace('https://example.com/news','http://127.0.0.1/'),{},now).length,0);
 assert.equal(rss.parseFeed(xml.replace('Thu, 12 Nov 2026 10:00:00 GMT','invalid'),{},now).length,0);
});
test('parses Atom and holds stale or future entries',()=>{
 assert.equal(typeof rss.parseFeed,'function');
 const atom='<feed><entry><id>one</id><title>Release</title><link href="https://example.com/new"/><updated>2026-11-12T10:00:00Z</updated><summary>Changed.</summary></entry></feed>';
 assert.equal(rss.parseFeed(atom,{label:'Vendor'},now)[0].text,'Release\nChanged.');
 assert.equal(rss.parseFeed(atom.replace('2026-11-12','2026-10-12'),{},now).length,0);
 assert.equal(rss.parseFeed(atom.replace('2026-11-12','2026-12-12'),{},now).length,0);
});
test('fetches only configured HTTPS feed with timeout and redirects denied',async()=>{
 const rows=await rss.collectRSS({url:'https://blogs.nvidia.com/feed/',label:'Vendor'},async(url,opts)=>{assert.equal(url,'https://blogs.nvidia.com/feed/');assert.equal(opts.redirect,'error');assert.ok(opts.signal);return new Response(xml,{headers:{'content-type':'application/rss+xml'}});},now);assert.equal(rows.length,1);
 await assert.rejects(()=>rss.collectRSS({url:'http://localhost/rss',label:'x'}));
 await assert.rejects(()=>rss.collectRSS({url:'https://example.com/rss',label:'x'},async()=>new Response('html',{headers:{'content-type':'text/html'}})));
});

test('rejects unapproved DNS destinations before fetching',async()=>{let calls=0;await assert.rejects(()=>rss.collectRSS({url:'https://internal.company.example/rss',label:'x'},async()=>{calls++;return new Response(xml);}));assert.equal(calls,0);});

const motorsport='https://www.motorsport.com/rss/f1/news/';
const amd='https://ir.amd.com/news-events/press-releases/rss';
const titled=(title,body='Useful change.')=>xml.replace('New release',title).replace('Useful change.',body);
test('approved AMD feed retains announcements as evidence, never approved drafts',async()=>{
 const rows=await rss.collectRSS({url:amd,label:'AMD'},async url=>{assert.equal(url,amd);return new Response(xml,{headers:{'content-type':'application/rss+xml'}});},now);
 assert.equal(rows.length,1);assert.equal(rows[0].approved,undefined);assert.equal(rows[0].author,'AMD');
});
test('Motorsport feed retains only explicit selected team titles, not drivers or body mentions',async()=>{
 for(const title of ['Haas announces technical partnership','Cadillac confirms team leadership','Mercedes unveils car upgrade']){
 const rows=await rss.collectRSS({url:motorsport,label:'Motorsport F1'},async()=>new Response(titled(title),{headers:{'content-type':'application/rss+xml'}}),now);assert.equal(rows.length,1,title);assert.equal(rows[0].approved,undefined);
 }
 for(const title of ['Ferrari announces upgrade','Russell signs contract','Antonelli scores points','Ocon tests new car','Bearman leads practice','SuperHaas speculation'])assert.equal(rss.parseFeed(titled(title,'Mercedes, Cadillac and Haas are also mentioned.'),{url:motorsport,label:'F1'},now).length,0,title);
});
test('selected F1 teams do not admit merchandise or lifestyle headlines',()=>{
 for(const title of ['Mercedes launches new merchandise','Haas team shirts now on sale','Buy Cadillac team caps','Mercedes fashion collection revealed','Haas driver wedding photos','Cadillac launches lifestyle range'])assert.equal(rss.parseFeed(titled(title),{url:motorsport},now).length,0,title);
});
test('selected team financial and acquisition news is not mistaken for merchandise',()=>{
 for(const title of ['Mercedes responds to cost cap ruling','Haas team sale confirmed','Cadillac to buy technical supplier'])assert.equal(rss.parseFeed(titled(title),{url:motorsport},now).length,1,title);
});
test('expanded official feeds remain exact allowlisted destinations',async()=>{
 for(const url of ['https://openai.com/news/rss.xml','https://devblogs.microsoft.com/dotnet/feed/','https://github.com/vllm-project/vllm/releases.atom','https://milfordtownship.org/feed/']){
  const rows=await rss.collectRSS({url,label:'Official'},async()=>new Response(xml,{headers:{'content-type':'application/xml'}}),now);assert.equal(rows.length,1);
 }
});
test('Mistral text/plain exception still requires valid bounded XML and is not global',async()=>{
 const config={url:'https://mistral.ai/news/rss',label:'Mistral'};
 assert.equal((await rss.collectRSS(config,async()=>new Response(xml,{headers:{'content-type':'text/plain'}}),now)).length,1);
 await assert.rejects(()=>rss.collectRSS(config,async()=>new Response('<html>Not a feed',{headers:{'content-type':'text/plain'}}),now));
 await assert.rejects(()=>rss.collectRSS({url:'https://blogs.nvidia.com/feed/',label:'NVIDIA'},async()=>new Response(xml,{headers:{'content-type':'text/plain'}}),now));
});
test('public newsletter publisher feeds preserve attribution without mailbox content',async()=>{
 for(const url of ['https://www.theverge.com/rss/index.xml','https://www.technologyreview.com/feed/']){
  const rows=await rss.collectRSS({url,label:'Public publisher'},async()=>new Response(xml,{headers:{'content-type':'application/rss+xml'}}),now);assert.equal(rows.length,1);assert.equal(rows[0].author,'Public publisher');
 }
});

test('additional verified feeds use exact reviewed URLs',async()=>{
 for(const url of ['https://github.blog/feed/','https://www.intc.com/news-events/press-releases/rss','https://pytorch.org/blog/feed/','https://github.com/anthropics/claude-code/releases.atom','https://www.servethehome.com/feed/','https://www.techpowerup.com/rss/news']){
  assert.equal((await rss.collectRSS({url,label:'Public source'},async()=>new Response(xml,{headers:{'content-type':'application/xml'}}),now)).length,1);
 }
});
test('The Race discovery is restricted to selected team titles and excludes lifestyle',async()=>{
 const url='https://www.the-race.com/rss/';
 assert.equal((await rss.collectRSS({url,label:'The Race'},async()=>new Response(titled('Haas appoints technical director'),{headers:{'content-type':'application/rss+xml'}}),now)).length,1);
 for(const title of ['Ferrari changes driver','Mercedes merchandise collection','Cadillac lifestyle launch','Russell signs contract'])assert.equal(rss.parseFeed(titled(title,'Haas mentioned in body'),{url},now).length,0,title);
});
test('HTML DOCTYPE inside CDATA is inert, actual XML declarations still rejected',()=>{
 const inert=xml.replace('<p>Useful change.</p>','<!DOCTYPE html PUBLIC "x" "https://evil.example/dtd"><p>Useful change.</p>');
 assert.equal(rss.parseFeed(inert,{},now)[0].text,'New release\nUseful change.');
 for(const tail of ['<!DOCTYPE rss>','<!ENTITY x SYSTEM "file:///etc/passwd">'])assert.throws(()=>rss.parseFeed(inert+tail,{},now));
 assert.throws(()=>rss.parseFeed('<!DOCTYPE rss [<!ENTITY x "<![CDATA[ignored]]>">]>'+xml,{},now));
 assert.throws(()=>rss.parseFeed(xml.replace(']]>',''),{},now));
});

test('comment CDATA marker cannot conceal real XML DTD/entity declarations',()=>{
 const prefix='<!-- <![CDATA[ --><!DOCTYPE rss [<!ENTITY injected "expanded">]><!-- ]]> -->';
 assert.throws(()=>rss.parseFeed(prefix+xml,{},now));
 assert.throws(()=>rss.parseFeed('<?fake <![CDATA[ ?><!DOCTYPE rss><!-- ]]> -->'+xml,{},now));
});

test('all entries within bounded feed are considered, without first100 or20 cutoff',()=>{
 const item=xml.match(/<item>[\s\S]*?<\/item>/)[0];
 const feed='<rss><channel>'+Array.from({length:125},(_,i)=>item.replace('release1','release'+i).replace('/news','/news'+i)).join('')+'</channel></rss>';
 assert.equal(rss.parseFeed(feed,{},now).length,125);
});
