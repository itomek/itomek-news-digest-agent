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
const milford='https://milfordtownship.org/feed/';
const library='https://buckslib.org/feed/';
test('local feeds are allowlisted and request timeout is bounded to six seconds',async()=>{
 const original=AbortSignal.timeout;const times=[];AbortSignal.timeout=ms=>{times.push(ms);return original(ms);};
 try{for(const url of [milford,library])await rss.collectRSS({url,label:'Local'},async()=>new Response(titled('Quakertown branch closed for repairs'),{headers:{'content-type':'application/rss+xml'}}),now);}finally{AbortSignal.timeout=original;}
 assert.deepEqual(times,[6000,6000]);
});
test('Milford retains practical local notices but excludes routine meetings and politics',()=>{
 for(const title of ['Road closure on Route 663','Township recycling schedule changes'])assert.equal(rss.parseFeed(titled(title),{url:milford},now).length,1,title);
 for(const title of ['Board meeting agenda','Supervisors meeting minutes','Candidate endorsement announced','Election results','Political campaign rally'])assert.equal(rss.parseFeed(titled(title),{url:milford},now).length,0,title);
});
test('library retains geographically relevant practical notices, not generic event filler',()=>{
 for(const [title,body] of [['Quakertown branch closed for repairs',''],['New opening hours','Upper Bucks branches will open later.'],['All branches closed Monday',''],['Library system launches new borrowing service','']])assert.equal(rss.parseFeed(titled(title,body),{url:library},now).length,1,title);
 for(const [title,body] of [['Doylestown branch renovation',''],['Summer reading celebration',''],['Quakertown storytime Saturday',''],['Author visit in Upper Bucks',''],['All branches host craft events','']])assert.equal(rss.parseFeed(titled(title,body),{url:library},now).length,0,title);
});
