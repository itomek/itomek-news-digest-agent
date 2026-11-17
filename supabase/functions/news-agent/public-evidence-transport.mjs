// Deno outbound TCP + TLS, never fetch(host): the approved DNS address is the
// actual socket destination; TLS authenticates the original hostname. Requires
// allow-net for DNS, selected IP:443 and hostname:443 (startTls permission).
// No proxy, environment lookup, redirects, client certificate or retry.
// Use only as fetchCapturedEvidence.fetcher: that helper owns the <=30s deadline.
// Bounded HTTP/1.0/1.1 only: <=16KiB headers, <=232768 wire bytes, <=200000
// decoded bytes; identity encoding, single headers and simple chunked framing.
// Duplicate headers (except ignored Server metadata), chunk extensions/trailers
// and compression fail closed.
const fail=()=>{throw Error('Public evidence transport rejected');};
const ipv4=s=>{
 if(typeof s!=='string'||!/^\d+\.\d+\.\d+\.\d+$/.test(s))return null;
 const a=s.split('.');if(a.some(x=>! /^(0|[1-9]\d{0,2})$/.test(x)||Number(x)>255))return null;
 return a.reduce((n,x)=>(n<<8n)+BigInt(x),0n);
};
function ipv6(s){
 if(typeof s!=='string'||!s.includes(':')||/[^a-fA-F0-9:]/.test(s)||s.split('::').length>2)return null;
 const halves=s.split('::'),left=halves[0]?halves[0].split(':'):[],right=halves[1]?halves[1].split(':'):[];
 if([...left,...right].some(x=>! /^[a-fA-F0-9]{1,4}$/.test(x)))return null;
 const count=left.length+right.length;if(halves.length===1?count!==8:count>=8)return null;
 return [...left,...Array(8-count).fill('0'),...right].reduce((n,x)=>(n<<16n)+BigInt('0x'+x),0n);
}
const inRange=(n,base,bits,width)=>n>>BigInt(width-bits)===base>>BigInt(width-bits);
export function isPublicAddress(address){
 const n=ipv4(address);
 if(n!==null)return ![['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]].some(([base,bits])=>inRange(n,ipv4(base),bits,32));
 const v=ipv6(address);
 // Only ordinary global unicast; conservatively exclude special-purpose and
 // transition allocations, including mapped IPv4, NAT64, Teredo and 6to4.
 return v!==null&&inRange(v,ipv6('2000::'),3,128)&&! [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]].some(([base,bits])=>inRange(v,ipv6(base),bits,128));
}
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const MAX_BODY=200000,MAX_HEADERS=16384,MAX_WIRE=232768;
const close=c=>{try{c?.close();}catch{}};
function parseHeaders(text){
 const lines=text.split('\r\n'),status=/^HTTP\/1\.[01] (\d{3}) [\x20-\x7e]*$/.exec(lines.shift());
 if(!status||Number(status[1])<200||Number(status[1])>=300)fail();
 const headers=new Headers(),seen=new Set();
 for(const line of lines){const m=/^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([\x20-\x7e\t]*)$/.exec(line);if(!m)fail();const name=m[1].toLowerCase();if(seen.has(name)&&name!=='server')fail();seen.add(name);if(name!=='server')headers.set(name,m[2].trim());}
 const length=headers.get('content-length'),transfer=headers.get('transfer-encoding'),encoding=headers.get('content-encoding');
 if(encoding&&encoding!=='identity'||transfer&&transfer.toLowerCase()!=='chunked'||transfer&&length!==null||length!==null&&(!/^\d{1,6}$/.test(length)||Number(length)>MAX_BODY))fail();
 return {status:Number(status[1]),headers,length:length===null?null:Number(length),chunked:transfer!==null};
}
function decodeChunks(bytes){
 const out=[];let offset=0,total=0;
 const line=()=>{const start=offset;while(offset+1<bytes.length&&(bytes[offset]!==13||bytes[offset+1]!==10))offset++;if(offset+1>=bytes.length||offset-start>128)fail();const result=decoder.decode(bytes.subarray(start,offset));offset+=2;return result;};
 for(;;){const sizeText=line();if(!/^[0-9a-fA-F]{1,6}$/.test(sizeText))fail();const size=parseInt(sizeText,16);if(size===0){if(line()!==''||offset!==bytes.length)fail();break;}total+=size;if(total>MAX_BODY||offset+size+2>bytes.length)fail();out.push(bytes.slice(offset,offset+size));offset+=size;if(bytes[offset++]!==13||bytes[offset++]!==10)fail();}
 const result=new Uint8Array(total);let at=0;for(const part of out){result.set(part,at);at+=part.length;}return result;
}
export function createPublicEvidenceTransport({runtime=globalThis.Deno}={}){
 return async function publicEvidenceFetch(url,options){
  let parsed;try{parsed=new URL(url);}catch{fail();}
  if(!runtime||!['resolveDns','connect','startTls'].every(k=>typeof runtime[k]==='function')||typeof url!=='string'||parsed.href!==url||parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.hash||! /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(parsed.hostname)||options?.method!=='GET'||options.redirect!=='error'||options.credentials!=='omit'||options.referrerPolicy!=='no-referrer'||!options.signal||options.signal.aborted)fail();
  const headers=new Headers(options.headers);if([...headers.keys()].some(k=>k!=='accept')||headers.get('accept')!=='text/plain, text/html, application/json')fail();
  let tcp,tls,aborted=false;const signal=options.signal;
  const abort=()=>{aborted=true;close(tls);close(tcp);};signal.addEventListener('abort',abort,{once:true});
  try{
   const answers=await Promise.all(['A','AAAA'].map(async type=>{try{const a=await runtime.resolveDns(parsed.hostname,type);if(!Array.isArray(a)||a.length>32)fail();return a;}catch(e){if(runtime.errors?.NotFound&&e instanceof runtime.errors.NotFound)return [];throw e;}}));
   const addresses=answers.flat();if(aborted||!addresses.length||addresses.some(a=>!isPublicAddress(a)))fail();
   const ip=addresses[0];tcp=await runtime.connect({hostname:ip,port:443,transport:'tcp'});if(aborted){close(tcp);fail();}
   if(tcp.remoteAddr?.hostname!==ip)fail();
   tls=await runtime.startTls(tcp,{hostname:parsed.hostname,alpnProtocols:['http/1.1']});if(aborted){close(tls);fail();}
   const request=encoder.encode(`GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\nHost: ${parsed.hostname}\r\nAccept: text/plain, text/html, application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
   for(let offset=0;offset<request.length;){const n=await tls.write(request.subarray(offset));if(aborted||!Number.isInteger(n)||n<1||n>request.length-offset)fail();offset+=n;}
   const wire=new Uint8Array(MAX_WIRE),buffer=new Uint8Array(8192);let size=0,end=-1,head;
   for(;;){const n=await tls.read(buffer);if(aborted)fail();if(n===null)break;if(!Number.isInteger(n)||n<1||n>buffer.length||size+n>MAX_WIRE)fail();wire.set(buffer.subarray(0,n),size);const prior=size;size+=n;
    if(end<0){for(let i=Math.max(0,prior-3);i+3<size;i++)if(wire[i]===13&&wire[i+1]===10&&wire[i+2]===13&&wire[i+3]===10){end=i+4;break;}if(end<0&&size>MAX_HEADERS||end>MAX_HEADERS)fail();if(end>=0)head=parseHeaders(decoder.decode(wire.subarray(0,end-4)));}
    if(head&&!head.chunked&&size-end>MAX_BODY)fail();
   }
   if(!head)fail();let body=wire.slice(end,size);if(head.chunked)body=decodeChunks(body);else if(body.length>MAX_BODY||head.length!==null&&head.length!==body.length)fail();
   // Reconstructed Response owns only bounded bytes. Never expose Set-Cookie or
   // other origin headers; source-verification still checks type, size and hash.
   const safeHeaders=new Headers();for(const name of ['content-type']){const value=head.headers.get(name);if(value!==null)safeHeaders.set(name,value);}safeHeaders.set('content-length',String(body.length));
   return new Response(body,{status:head.status,headers:safeHeaders});
  }catch{fail();}finally{signal.removeEventListener('abort',abort);close(tls);close(tcp);}
 };
}
