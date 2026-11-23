// Pure formatting only. Callers must bind evidence to a configured public
// publisher, an in-scope decision and the guarded publication pipeline.
const headlineTypes=new Set(['rss','official_html']);
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const bytes=new TextEncoder();

export function sourceLinkDraft(evidence){
 if(evidence?.visibility!=='public'||!headlineTypes.has(evidence.sourceType)||typeof evidence.text!=='string'||typeof evidence.url!=='string')throw Error('Source-link requires captured public publisher evidence');
 // These collectors serialize the normalized captured headline as the first
 // line. Ignore all subsequent description text rather than summarizing it.
 const headline=evidence.text.split(/\r?\n/,1)[0].trim();
 if(!headline||/[<>\p{Cc}\p{Bidi_Control}]/u.test(headline)||/\b(?:https?:\/\/|www\.)/i.test(headline))throw Error('Source-link headline has unsupported formatting');
 let link;
 try{link=new URL(evidence.url);}catch{throw Error('Source-link requires a canonical HTTPS URL');}
 if(link.protocol!=='https:'||link.href!==evidence.url||link.username||link.password||link.port||link.hash)throw Error('Source-link requires a canonical HTTPS URL');
 const prefix='Headline: '+headline+'\n\n';
 const text=prefix+link.href;
 const byteEnd=bytes.encode(text).length;
 if(byteEnd>3000||[...segmenter.segment(text)].length>300)throw Error('Source-link draft exceeds Bluesky limits');
 return {mode:'source_link',text,link:{uri:link.href,byteStart:bytes.encode(prefix).length,byteEnd},factsVerified:false};
}
