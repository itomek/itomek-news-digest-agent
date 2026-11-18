import test from 'node:test';import assert from 'node:assert/strict';
import {selectDevelopmentBatch} from './batches.mjs';
test('bounded half-batches cover the same eight cases exactly once without changing identities',()=>{
 const cases=Array.from({length:8},(_,i)=>({id:'neutral-'+i}));
 const a=selectDevelopmentBatch(cases,'first-half'),b=selectDevelopmentBatch(cases,'second-half');
 assert.equal(a.length,4);assert.equal(b.length,4);assert.deepEqual([...a,...b],cases);
 assert.deepEqual(selectDevelopmentBatch(cases,'all'),cases);assert.equal(cases.length,8);
 assert.throws(()=>selectDevelopmentBatch(cases,'retry'));assert.throws(()=>selectDevelopmentBatch(cases.slice(1),'first-half'));
});
test('scope regression removes the published-summary shortcut without exposing the owner label',()=>{
 const cases=Array.from({length:8},(_,i)=>({id:'neutral-'+i,sourceType:'published-summary',discoveryText:'Public discovery text',expectedAction:'skip'}));
 const [c]=selectDevelopmentBatch(cases,'helion-scope');
 assert.equal(c.id,cases[7].id);assert.equal(c.discoveryText,cases[7].discoveryText);
 assert.equal(c.sourceType,'rss');assert.equal(new URL(c.sourceUrl).hostname,'pytorch.org');
 assert.equal(c.sourceCreatedAt,'2026-11-12');assert.equal(cases[7].sourceType,'published-summary');
});
test('scope challenge uses the same eight captured cases and never forwards provisional labels',async()=>{
 const {buildReviewRequest}=await import('../../supabase/functions/news-agent/evaluation.mjs');
 const {requestProfileForModel}=await import('../../supabase/functions/news-agent/model-profiles.mjs');
 const input=Array.from({length:8},(_,i)=>({id:'old-'+i})),cases=selectDevelopmentBatch(input,'scope-challenge');
 assert.equal(cases.length,8);assert.equal(new Set(cases.map(c=>c.id)).size,8);assert.equal(cases.filter(c=>c.expectedAction==='verify').length,5);
 for(const model of ['nvidia/nemotron-3.5-super-vl','nvidia/nemotron-3-super-120b-a12b']){
 const r=buildReviewRequest(cases,{model,allowedModels:[model],maxOutputTokens:2048,requestProfile:requestProfileForModel(model)});
 const data=JSON.parse(r.messages[1].content);assert.deepEqual(data.candidates.map(c=>c.id),cases.map(c=>c.id));assert.equal(r.max_tokens,2048);assert.match(r.messages[0].content,/AMD or Lemonade connection is not (?:a prerequisite|required)/);assert.equal(/expectedAction|rationale|ownerRationale|labelStatus|capturedCandidateId|rankingRunId/.test(r.messages[1].content),false);
 }
 const old=buildReviewRequest(cases,{model:'openai/gpt-oss-120b',allowedModels:['openai/gpt-oss-120b'],maxOutputTokens:2048,requestProfile:requestProfileForModel('openai/gpt-oss-120b','2026-11-16.4')});assert.equal(old.messages[0].content.includes('POLICY CLARIFICATION:'),false);
});
test('trial profile validation rejects reasoning, ZDR and schema downgrades',async()=>{
 const {validateRequestProfile}=await import('../../supabase/functions/news-agent/review-contract.mjs');
 const {requestProfileForModel}=await import('../../supabase/functions/news-agent/model-profiles.mjs');
 const p=requestProfileForModel('nvidia/nemotron-3.5-super-vl');
 for(const patch of [{reasoning:{effort:'low'}},{responseFormat:'discovery-json-schema-v1'},{rankingRubricVersion:'other'},{provider:{...p.provider,zdr:false}}])assert.throws(()=>validateRequestProfile({...p,...patch}));
});
test('stage-aware protocol preserves its shape and later verification guards under current editorial policy',async()=>{
 const {buildReviewRequest}=await import('../../supabase/functions/news-agent/evaluation.mjs');
 const {requestProfileForModel}=await import('../../supabase/functions/news-agent/model-profiles.mjs');
 const {createHash}=await import('node:crypto');
 const cases=selectDevelopmentBatch(Array(8).fill({id:'unused'}),'scope-challenge');
 const model='nvidia/nemotron-3.5-super-vl';
 const build=version=>buildReviewRequest(cases,{model,allowedModels:[model],maxOutputTokens:2048,requestProfile:requestProfileForModel(model,version)});
 const old=build('2026-11-17.1');
 assert.equal(createHash('sha256').update(JSON.stringify(old)).digest('hex'),'7fc267f00d22af21863e5fc303fc5e9bae6589e9af84b7b229f69e5752cf0acd');
 const profile=requestProfileForModel(model,'2026-11-17.3');assert.equal(profile.version,'2026-11-17.3');
 const current=build('2026-11-17.3');assert.deepEqual(current.provider,old.provider);assert.deepEqual(current.response_format,old.response_format);assert.deepEqual(current.messages[1],old.messages[1]);
 const system=current.messages[0].content;
 for(const phrase of ['trusted discovery query','Time eligibility','potential native repost','identity, dates, facts and deduplication','preview lacks','plausibly meaningful capability','Every named interest category','batch winners','absent from the excerpt'])assert.ok(system.includes(phrase),phrase);
 assert.equal(old.messages[0].content.includes('STAGE-AWARE DISCOVERY'),false);
 assert.equal(requestProfileForModel('nvidia/nemotron-3-super-120b-a12b').version,'2026-11-17.2');
 assert.equal(requestProfileForModel('openai/gpt-oss-120b','2026-11-16.4').version,'2026-11-16.4');
});

test('17.3 protocol body has an explicit snapshot under current editorial policy',async()=>{const {createHash}=await import('node:crypto'),{buildReviewRequest}=await import('../../supabase/functions/news-agent/evaluation.mjs'),{requestProfileForModel}=await import('../../supabase/functions/news-agent/model-profiles.mjs');const model='nvidia/nemotron-3.5-super-vl',cases=selectDevelopmentBatch(Array(8).fill({id:'unused'}),'scope-challenge');const old=buildReviewRequest(cases,{model,allowedModels:[model],maxOutputTokens:2048,requestProfile:requestProfileForModel(model,'2026-11-17.3')});assert.equal(createHash('sha256').update(JSON.stringify(old)).digest('hex'),'8a1a6986353a70eb6f24e5f280852e46da0a875580ed7e51aa2635e98d22cc30');assert.equal(requestProfileForModel(model,'2026-11-17.4').version,'2026-11-17.4');});
