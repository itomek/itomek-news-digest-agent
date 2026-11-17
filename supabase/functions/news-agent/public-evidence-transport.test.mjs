import test from 'node:test';import assert from 'node:assert/strict';
const mod=()=>import('./public-evidence-transport.mjs');
const options=()=>({method:'GET',redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',signal:new AbortController().signal,headers:{Accept:'text/plain, text/html, application/json'}});
function fixture({answers=['93.184.216.34'],wire='HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello',tlsError=false}={}){
 let connected=[],tls=[],sent='',closed=0;const bytes=new TextEncoder().encode(wire);let at=0;
 const socket={remoteAddr:{hostname:answers[0]},close(){closed++;},async write(b){sent+=new TextDecoder().decode(b);return b.length;},async read(b){if(at===bytes.length)return null;const n=Math.min(7,b.length,bytes.length-at);b.set(bytes.slice(at,at+n));at+=n;return n;}};
 return {runtime:{errors:{NotFound:class extends Error{}},async resolveDns(_h,type){return type==='A'?answers:[];},async connect(o){connected.push(o);return socket;},async startTls(c,o){tls.push(o);if(tlsError)throw Error('certificate failure secret');return c;}},get connected(){return connected;},get tls(){return tls;},get sent(){return sent;},get closed(){return closed;}};
}
test('public classifier rejects reserved, malformed, mapped and transition addresses',async()=>{
 const {isPublicAddress}=await mod();
 for(const ip of ['0.0.0.0','10.0.0.1','100.64.0.1','127.0.0.1','169.254.169.254','172.31.0.1','192.0.0.9','192.0.2.1','192.168.1.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','0177.0.0.1','127.1','::','::1','::ffff:8.8.8.8','64:ff9b::808:808','100::1','2001:db8::1','2001::1','2002:808:808::1','3fff::1','fc00::1','fe80::1','ff02::1','2606:4700::1%eth0'])assert.equal(isPublicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','93.184.216.34','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(isPublicAddress(ip),true,ip);
});
test('pins approved address and TLS hostname and sends no ambient credentials',async()=>{
 const {createPublicEvidenceTransport}=await mod();const f=fixture();const r=await createPublicEvidenceTransport({runtime:f.runtime})('https://example.com/path?q=1',options());
 assert.equal(await r.text(),'hello');assert.deepEqual(f.connected,[{hostname:'93.184.216.34',port:443,transport:'tcp'}]);assert.deepEqual(f.tls,[{hostname:'example.com',alpnProtocols:['http/1.1']}]);
 assert.match(f.sent,/Host: example.com\r\n/);assert.doesNotMatch(f.sent,/authorization|cookie|referer/i);assert.ok(f.closed);
});
test('mixed DNS and TLS certificate failures fail closed without fallback',async()=>{
 const {createPublicEvidenceTransport}=await mod();for(const answers of [['8.8.8.8','127.0.0.1'],['8.8.8.8','::1'],[]]){const f=fixture({answers});await assert.rejects(createPublicEvidenceTransport({runtime:f.runtime})('https://example.com/',options()));assert.equal(f.connected.length,0);}
 const f=fixture({tlsError:true});await assert.rejects(createPublicEvidenceTransport({runtime:f.runtime})('https://example.com/',options()));assert.equal(f.connected.length,1);assert.equal(f.sent,'');assert.ok(f.closed);
});
test('strict framing rejects redirects, ambiguous framing, compression and oversized responses',async()=>{
 const {createPublicEvidenceTransport}=await mod();
 for(const wire of ['HTTP/1.1 302 Found\r\nLocation: https://example.org/\r\n\r\n','HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx','HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n','HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\nx','HTTP/1.1 200 OK\r\nContent-Length: 200001\r\n\r\n','HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nx','HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\nx\r\n0\r\n\r\n']){const f=fixture({wire});await assert.rejects(createPublicEvidenceTransport({runtime:f.runtime})('https://example.com/',options()));assert.ok(f.closed);}
});
test('supports bounded chunked and connection-close responses',async()=>{
 const {createPublicEvidenceTransport}=await mod();for(const wire of ['HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n','HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nhello']){const f=fixture({wire});assert.equal(await(await createPublicEvidenceTransport({runtime:f.runtime})('https://example.com/',options())).text(),'hello');}
});
test('acquisition timeout aborts the pinned socket and preserves the existing helper API',async()=>{
 const {createPublicEvidenceTransport}=await mod();const {fetchCapturedEvidence}=await import('./source-verification.mjs');const f=fixture();
 const originalConnect=f.runtime.connect;f.runtime.connect=async o=>{const c=await originalConnect(o);c.read=()=>new Promise(()=>{});return c;};
 await assert.rejects(fetchCapturedEvidence({url:'https://example.com/',evidence:{url:'https://example.com/',id:'fixture',sourceType:'web',visibility:'public'},config:{enabled:true,allowedHosts:['example.com'],timeoutMs:10},fetcher:createPublicEvidenceTransport({runtime:f.runtime})}),/timeout/);
 assert.ok(f.closed);
});
test('forbids unsafe request controls and never falls back to ambient fetch',async()=>{
 const {createPublicEvidenceTransport}=await mod();const f=fixture();const transport=createPublicEvidenceTransport({runtime:f.runtime});
 for(const [url,opts] of [['https://example.com/',{...options(),headers:{Authorization:'secret'}}],['https://example.com/',{...options(),redirect:'follow'}],['https://127.0.0.1/',options()],['https://user:pass@example.com/',options()],['https://example.com:444/',options()],['https://example.com/#fragment',options()]])await assert.rejects(transport(url,opts));
 assert.deepEqual(f.connected,[]);
 await assert.rejects(createPublicEvidenceTransport({runtime:{}})('https://example.com/',options()));
});
test('streaming wire and header limits reject before buffering unbounded content',async()=>{
 const {createPublicEvidenceTransport}=await mod();
 for(const wire of ['HTTP/1.1 200 OK\r\nX-Large: '+ 'a'.repeat(17000),'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n'+'a'.repeat(200001),'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'+'a'.repeat(233000)]){const f=fixture({wire});await assert.rejects(createPublicEvidenceTransport({runtime:f.runtime})('https://example.com/',options()));assert.ok(f.closed);}
});
test('abort while connect is pending closes the late socket before TLS or request bytes',async()=>{
 const {createPublicEvidenceTransport}=await mod();const f=fixture();let release,started;
 const connecting=new Promise(r=>{started=r;});const original=f.runtime.connect;
 f.runtime.connect=async o=>{started();await new Promise(r=>{release=r;});return original(o);};
 const controller=new AbortController();const pending=createPublicEvidenceTransport({runtime:f.runtime})('https://example.com/',{...options(),signal:controller.signal});
 await connecting;controller.abort();release();await assert.rejects(pending);assert.ok(f.closed);assert.deepEqual(f.tls,[]);assert.equal(f.sent,'');
});
test('encoded path stays encoded on wire and raw request-line injection is refused',async()=>{
 const {createPublicEvidenceTransport}=await mod();const f=fixture();await createPublicEvidenceTransport({runtime:f.runtime})('https://example.com/%0d%0aCookie%3Asecret',options());
 assert.match(f.sent,/^GET \/%0d%0aCookie%3Asecret HTTP\/1.1\r\n/);assert.doesNotMatch(f.sent,/\r\nCookie:/i);
 await assert.rejects(createPublicEvidenceTransport({runtime:fixture().runtime})('https://example.com/\r\nCookie:secret',options()));
});
test('chunked trailers, extensions, trailing bytes and folded headers fail closed',async()=>{
 const {createPublicEvidenceTransport}=await mod();
 for(const body of ['1;x=y\r\nx\r\n0\r\n\r\n','1\r\nx\r\n0\r\nTrailer: value\r\n\r\n','0\r\n\r\nHTTP/1.1 200 OK\r\n\r\n']){const f=fixture({wire:'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'+body});await assert.rejects(createPublicEvidenceTransport({runtime:f.runtime})('https://example.com/',options()));}
 const folded=fixture({wire:'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n injected: value\r\n\r\nx'});await assert.rejects(createPublicEvidenceTransport({runtime:folded.runtime})('https://example.com/',options()));
});
test('duplicate informational Server headers do not change framing or returned metadata',async()=>{
 const {createPublicEvidenceTransport}=await mod();const f=fixture({wire:'HTTP/1.1 200 OK\r\nServer: deno\r\nServer: deployd\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello'});
 const r=await createPublicEvidenceTransport({runtime:f.runtime})('https://example.com/',options());assert.equal(await r.text(),'hello');assert.equal(r.headers.has('server'),false);
});
test('repeated Set-Cookie headers are ignored without accepting ambiguous framing or persisting cookies',async()=>{
 const {createPublicEvidenceTransport}=await mod();
 const cookies='Set-Cookie: first=one; Secure\r\nSet-Cookie: second=two; Secure\r\n';
 const f=fixture({wire:'HTTP/1.1 200 OK\r\n'+cookies+'Content-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello'});
 const r=await createPublicEvidenceTransport({runtime:f.runtime})('https://example.com/',options());
 assert.equal(await r.text(),'hello');assert.equal(r.headers.has('set-cookie'),false);assert.doesNotMatch(f.sent,/\r\nCookie:/i);
 const ambiguous=fixture({wire:'HTTP/1.1 200 OK\r\n'+cookies+'Content-Length: 1\r\nContent-Length: 1\r\n\r\nx'});
 await assert.rejects(createPublicEvidenceTransport({runtime:ambiguous.runtime})('https://example.com/',options()));
});
