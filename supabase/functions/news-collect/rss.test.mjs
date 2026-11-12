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
