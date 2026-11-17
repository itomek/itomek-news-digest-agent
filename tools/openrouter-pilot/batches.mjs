// Fixed development paging experiment after the eight-case latency canary.
// No retries or mutation of IDs; both halves together cover the same fixture.
export function selectDevelopmentBatch(cases,batch='all'){
 if(!Array.isArray(cases)||cases.length!==8||!['all','first-half','second-half','helion-scope'].includes(batch))throw Error('Expected fixed eight-case development fixture and explicit batch');
 // Same owner-negative discovery text, sourced to the original article rather
 // than the already-published summary. Date is the article's date, not an invented time.
 if(batch==='helion-scope')return [{...cases[7],sourceType:'rss',sourceUrl:'https://pytorch.org/blog/fast-by-default-compile-time-heuristics-for-helion-kernels/',sourceCreatedAt:'2026-11-12'}];
 return batch==='all'?cases.slice():batch==='first-half'?cases.slice(0,4):cases.slice(4);
}
