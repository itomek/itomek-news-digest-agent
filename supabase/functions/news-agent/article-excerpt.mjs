import {fetchCapturedEvidence} from './source-verification.mjs';

// Optional publisher context after relevance selection. Never follow page links,
// run scripts, pass article content to the model, or use a second model call.
const entities={amp:'&',apos:"'",quot:'"',nbsp:' ',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“',ndash:'–',mdash:'—',hellip:'…',lt:'<',gt:'>'};
const segment=new Intl.Segmenter('en',{granularity:'sentence'});
function plain(text){
 return text.replace(/<[^>]*>/g,' ').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(_,id)=>{
  if(id[0]!=='#')return Object.hasOwn(entities,id)?entities[id]:' ';
  const n=id[1].toLowerCase()==='x'?parseInt(id.slice(2),16):Number(id.slice(1));
  return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):' ';
 }).replace(/\s+/gu,' ').trim();
}
function firstSentence(text,title){
 const clean=plain(text.slice(0,1200));
 const sentence=segment.segment(clean)[Symbol.iterator]().next().value?.segment?.trim();
 if(!sentence||sentence.length<36||sentence.length>180||sentence.split(' ').length>25||!/[.!?][”’"']?$/.test(sentence))return;
 if(/[<>\p{Cc}\p{Bidi_Control}]/u.test(sentence)||/\b(?:https?:\/\/|www\.)/i.test(sentence))return;
 if(sentence.replace(/[.!?]+$/,'').toLowerCase()===plain(title).replace(/[.!?]+$/,'').toLowerCase())return;
 if(/\b(?:access denied|enable javascript|cookies? policy|all rights reserved|sign in to continue|subscribe to continue|verify you are human)\b/i.test(sentence))return;
 return sentence;
}
export async function tryArticleExcerpt(candidate,{allowedHosts,fetcher,timeoutMs=2400}={}){
 if(!Array.isArray(allowedHosts)||typeof fetcher!=='function'||!['rss','official_html'].includes(candidate?.sourceType))return;
 try{
  const url=candidate.sourceUrl;
  const evidence={visibility:'public',id:candidate.id,url,sourceType:candidate.sourceType};
  const {body,contentType}=await fetchCapturedEvidence({url,evidence,config:{enabled:true,allowedHosts,timeoutMs,maxBytes:200000},fetcher});
  const title=candidate.discoveryText.split(/\r?\n/,1)[0];
  if(contentType==='text/plain')return firstSentence(body,title);
  if(contentType!=='text/html')return;
  const html=body.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,' ');
  const opening=/<article\b[^>]*>/i.exec(html)??/<main\b[^>]*>/i.exec(html);
  if(opening){
   const start=opening.index+opening[0].length;
   const bodyWindow=html.slice(start,start+24000).split(/<\/(?:article|main)\s*>/i,1)[0];
   for(const part of bodyWindow.split(/<p\b[^>]*>/i).slice(1,21)){
    const end=part.search(/<\/p\s*>/i);if(end<0)continue;
    const excerpt=firstSentence(part.slice(0,end),title);if(excerpt)return excerpt;
   }
  }
  // Many publishers expose context in their page metadata rather than <article>.
  const head=html.slice(0,24000).split(/<\/head\s*>/i,1)[0];
  for(const [tag] of head.matchAll(/<meta\s+(?:[^>"']|"[^"]*"|'[^']*')*>/gi)){
   const attributes=Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([,k,a,b])=>[k.toLowerCase(),a??b]));
   if(['description','og:description'].includes((attributes.name??attributes.property??'').toLowerCase())&&attributes.content){
    const excerpt=firstSentence(attributes.content,title);if(excerpt)return excerpt;
   }
  }
 }catch{/* Fetch, policy, body and parsing failures leave the post unchanged. */}
}
