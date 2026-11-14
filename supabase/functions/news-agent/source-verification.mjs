// Acquisition ONLY. A fetched page is untrusted evidence, never proof of factual
// claims or source authorship. No scripts, embedded links or page instructions run.
// The injected transport must enforce public-network egress/DNS policy; an exact
// trusted hostname allowlist alone cannot prevent DNS rebinding/private resolution.
class EvidenceFetchError extends Error {}
const fail=code=>{throw new EvidenceFetchError(`Evidence fetch: ${code}`);};
const integer=(n,max)=>Number.isSafeInteger(n)&&n>0&&n<=max;
const hostAllowed=h=>typeof h==='string'&&h===h.toLowerCase()&&h.length<=253&&
 h.includes('.')&&!h.endsWith('.')&&!/^[0-9.]+$/.test(h)&&
 !/(^|\.)(localhost|local|internal|test|invalid)$/.test(h)&&
 h.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
export async function fetchCapturedEvidence({url,evidence,config={},fetcher}={}){
 if(config.enabled!==true)return {status:'disabled',factsVerified:false};
 const timeoutMs=config.timeoutMs??10000,maxBytes=config.maxBytes??200000;
 if(typeof fetcher!=='function'||!integer(timeoutMs,30000)||!integer(maxBytes,200000)||!Array.isArray(config.allowedHosts))fail('invalid_configuration');
 if(evidence?.visibility!=='public'||typeof evidence?.id!=='string'||!evidence.id.trim()||typeof evidence?.sourceType!=='string'||!evidence.sourceType||evidence.sourceType==='bluesky')fail('invalid_public_primary_evidence');
 const evidenceId=evidence.id;
 const captured=[evidence.url,evidence.nativeUrl,...(Array.isArray(evidence.sourceLinks)?evidence.sourceLinks:[])];
 if(!captured.includes(url))fail('uncaptured_url');
 let parsed;try{parsed=new URL(url);}catch{fail('invalid_url');}
 if(typeof url!=='string'||parsed.href!==url||parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||url.includes('#')||!hostAllowed(parsed.hostname)||!config.allowedHosts.includes(parsed.hostname))fail('forbidden_url');

 const controller=new AbortController();let timer;
 const deadline=new Promise((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new EvidenceFetchError('Evidence fetch: timeout'));},timeoutMs);});
 const operation=(async()=>{
  const response=await fetcher(url,{method:'GET',redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal,headers:{Accept:'text/plain, text/html, application/json'}});
  let reader;
  const cancel=()=>{if(reader)void reader.cancel().catch(()=>{});else if(response instanceof Response&&response.body)void response.body.cancel().catch(()=>{});};
  try{
   if(!(response instanceof Response)||!response.ok||response.redirected)fail('http_failure');
   if(controller.signal.aborted)fail('timeout');
   // Custom transports must not return a different destination silently.
   if(response.url&&response.url!==url)fail('destination_mismatch');
   const contentType=(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
   if(!['text/plain','text/html','application/json'].includes(contentType))fail('unsupported_content_type');
   const declared=response.headers.get('content-length');
   if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes))fail('response_size_limit');
   if(!response.body)fail('empty_body');
   reader=response.body.getReader();controller.signal.addEventListener('abort',cancel,{once:true});
   let size=0;const chunks=[];
   for(;;){const {done,value}=await reader.read();if(controller.signal.aborted)fail('timeout');if(done)break;size+=value.byteLength;if(size>maxBytes)fail('response_size_limit');chunks.push(value);}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   let body;try{body=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('invalid_encoding');}
   const digest=await crypto.subtle.digest('SHA-256',bytes);
   if(controller.signal.aborted)fail('timeout');
   return Object.freeze({evidenceId,url,fetchedAt:new Date().toISOString(),contentType,contentSha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),body,byteLength:size,untrustedContent:true,factsVerified:false});
  }finally{controller.signal.removeEventListener('abort',cancel);cancel();if(reader)reader.releaseLock();}
 })();
 try{return await Promise.race([operation,deadline]);}
 catch(error){if(error instanceof EvidenceFetchError)throw error;throw new EvidenceFetchError('Evidence fetch: transport_failure');}
 finally{clearTimeout(timer);controller.abort();}
}
