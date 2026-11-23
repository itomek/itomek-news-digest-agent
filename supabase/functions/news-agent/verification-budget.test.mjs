import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVerificationRequest,normalizeVerificationResult,projectVerificationInput} from './verification-contract.mjs';
import {preview} from '../_shared/publishing.mjs';
import {primarySourceAttributionLabel} from './primary-source-policy.mjs';
const opts={model:'google/gemma-4-26b-a4b-it',maxOutputTokens:4096};
function inputFor(url,links=[url]){
 const now='2026-11-23T02:30:00.000Z';
 return {storyKey:'a'.repeat(64),evidenceHash:'b'.repeat(64),evidence:[{id:'e1',visibility:'public',sourceType:'rss',url,sourceLinks:links}],sources:[{evidenceId:'e1',url,contentSha256:'c'.repeat(64),fetchedAt:now,body:'Released 2026-11-23. New capability.'}],history:{snapshotHash:'d'.repeat(64),items:[],complete:true},now};
}
const limits=request=>JSON.parse(request.messages[0].content.match(/CONCISE OUTPUT LIMITS: (\[.*?\])\./)[1])[0];
test('current request discourages observed prose overflow while the final rendering guard remains authoritative',()=>{
 const input=inputFor('https://github.com/ggml-org/llama.cpp/releases/tag/b12642');
 const historical=limits(buildVerificationRequest(input,{...opts,version:'2026-11-17.verify.7'}));
 assert.equal(historical.summaryMaxLength,220);assert.equal(historical.whyItMattersMaxLength,220);
 const reference=projectVerificationInput(input).sources[0].bodyChunks[0].id;
 const result={action:'approve',editorial:{political:false,summary:'s'.repeat(139),whyItMatters:'w'.repeat(101),change:'Release.',evidenceIds:['e1']},supports:Object.fromEntries(['summary','whyItMatters','change','publicationDate'].map(k=>[k,reference])),publicationDate:'2026-11-23',scopeReason:'Relevant.',changeReason:'New.',dedupReason:'Distinct.'};
 assert.doesNotThrow(()=>normalizeVerificationResult(result,input,{version:'2026-11-17.verify.7'}));
 assert.doesNotThrow(()=>normalizeVerificationResult(result,input));
 const current=limits(buildVerificationRequest(input,opts));
 assert.equal(current.summaryMaxLength,110);assert.equal(current.whyItMattersMaxLength,110);
 assert.throws(()=>preview({storyKey:input.storyKey,verified:true,approved:true,summary:'llama.cpp reports: '+'s'.repeat(139),whyItMatters:'w'.repeat(101),links:input.evidence[0].sourceLinks}),/Post exceeds Bluesky limits/);
});
test('current schema maxima fit canonical post rendering with varied attribution and retained links',()=>{
 for(const [url,links] of [
  ['https://github.com/ggml-org/llama.cpp/releases/tag/b12642',undefined],
  ['https://ir.amd.com/release',['https://ir.amd.com/release','https://ir.amd.com/other']],
  ['https://www.nasa.gov/example',undefined],
 ]){
  const input=inputFor(url,links),request=buildVerificationRequest(input,opts),caps=limits(request);
  assert.equal(caps.summaryMaxLength+caps.whyItMattersMaxLength,caps.summaryPlusWhyItMattersCombinedBudget);
  assert.equal(caps.summaryMaxLength,Math.floor(caps.summaryPlusWhyItMattersCombinedBudget/2));
  const summary='s'.repeat(caps.summaryMaxLength),whyItMatters='w'.repeat(caps.whyItMattersMaxLength);
  const rendered=preview({storyKey:input.storyKey,verified:true,approved:true,summary:primarySourceAttributionLabel(url)+' reports: '+summary,whyItMatters,links:input.evidence[0].sourceLinks});
  assert.equal(rendered.graphemes,300);
 }
});
