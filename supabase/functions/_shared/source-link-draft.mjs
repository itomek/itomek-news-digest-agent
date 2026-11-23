// Pure formatting only. Callers must bind evidence to a configured public
// publisher, an in-scope decision and the guarded publication pipeline.
const headlineTypes=new Set(['rss','official_html']);
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const bytes=new TextEncoder();

export function sourceLinkDraft(evidence,articleExcerpt){
 if(evidence?.visibility!=='public'||!headlineTypes.has(evidence.sourceType)||typeof evidence.text!=='string'||typeof evidence.url!=='string')throw Error('Source-link requires captured public publisher evidence');
 // These collectors serialize the normalized captured headline as the first
 // line. Any optional publisher excerpt comes from the article reader.
 const headline=evidence.text.split(/\r?\n/,1)[0].trim();
 if(!headline||/[<>\p{Cc}\p{Bidi_Control}]/u.test(headline)||/\b(?:https?:\/\/|www\.)/i.test(headline))throw Error('Source-link headline has unsupported formatting');
 let link;
 try{link=new URL(evidence.url);}catch{throw Error('Source-link requires a canonical HTTPS URL');}
 if(link.protocol!=='https:'||link.href!==evidence.url||link.username||link.password||link.port||link.hash)throw Error('Source-link requires a canonical HTTPS URL');
 const fits=text=>bytes.encode(text).length<=3000&&[...segmenter.segment(text)].length<=300;
 const base=headline+'\n\n';
 const excerpt=typeof articleExcerpt==='string'&&articleExcerpt===articleExcerpt.trim()&&articleExcerpt.length>=36&&articleExcerpt.length<=180
  &&articleExcerpt.split(' ').length<=25&&!/[<>\p{Cc}\p{Bidi_Control}]/u.test(articleExcerpt)&&!/\b(?:https?:\/\/|www\.)/i.test(articleExcerpt)?articleExcerpt+'\n\n':'';
 const prefix=excerpt&&fits(base+excerpt+link.href)?base+excerpt:base;
 const text=prefix+link.href;
 const byteEnd=bytes.encode(text).length;
 if(!fits(text))throw Error('Source-link draft exceeds Bluesky limits');
 return {mode:'source_link',text,link:{uri:link.href,byteStart:bytes.encode(prefix).length,byteEnd},factsVerified:false};
}
