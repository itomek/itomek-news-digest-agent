import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewRequest, evaluateDecisions} from './evaluation.mjs';
import {readFile} from 'node:fs/promises';
const cases=JSON.parse(await readFile(new URL('./real-story-cases.json',import.meta.url)));
test('real-story expectations never enter model input',()=>{
 const request=buildReviewRequest(cases,{model:'test/model',allowedModels:['test/model'],maxOutputTokens:2000});
 const text=JSON.stringify(request);
 assert.equal(text.includes('expectedAction'),false);
 assert.equal(text.includes('ownerRationale'),false);
 assert.equal(text.includes('owner-helion-rejection'),false);
 assert.equal(text.includes('Negative expectation'),false);
 assert.equal(request.model,'test/model');
 assert.equal(request.max_tokens,2000);
 assert.equal(request.messages[0].role,'system');
 assert.equal(request.messages[1].role,'user');
 assert.equal(JSON.parse(request.messages[1].content).candidates.length,cases.length);
});
test('requires explicit model allowlist and bounded integer output budget',()=>{
 for(const config of [{},{model:'a',allowedModels:['b'],maxOutputTokens:10},{model:'a',allowedModels:['a'],maxOutputTokens:0},{model:'a',allowedModels:['a'],maxOutputTokens:1.5}])assert.throws(()=>buildReviewRequest(cases,config));
});
test('scores recorded decisions but never calls matching labels a live model pass',()=>{
 const result=evaluateDecisions(cases,cases.map(c=>({id:c.id,action:c.expectedAction,reason:'Recorded test decision'})));
 assert.equal(result.complete,true);
 assert.equal(result.correct,cases.length);
 assert.equal(result.modelQualityProven,false);
 assert.equal(result.publishingEnabled,false);
});
test('missing decisions fail coverage, even if remaining labels match',()=>{
 const r=evaluateDecisions(cases,[]);assert.equal(r.complete,false);assert.equal(r.missing.length,cases.length);
});
test('rejects duplicates, unknown cases, malformed actions and empty reasons',()=>{
 const d={id:cases[0].id,action:'skip',reason:'Routine'};
 for(const decisions of [[d,d],[{...d,id:'unknown'}],[{...d,action:'publish'}],[{...d,reason:''}]])assert.throws(()=>evaluateDecisions(cases,decisions));
});
test('owner-rejected Helion story is a false positive if agent selects it',()=>{
 const c=cases.find(c=>c.id==='case-008');assert.ok(c);
 const r=evaluateDecisions([c],[{id:c.id,action:'verify',reason:'GPU optimization'}]);
 assert.equal(r.correct,0);assert.deepEqual(r.falsePositives,[c.id]);
});
test('important model launch skipped is a missed candidate',()=>{
 const c=cases.find(c=>c.expectedAction==='verify');
 assert.deepEqual(evaluateDecisions([c],[{id:c.id,action:'skip',reason:'No'}]).missedCandidates,[c.id]);
});
test('all 405 same-source candidates enter request without quotas',()=>{
 const many=Array.from({length:405},(_,i)=>({...cases[0],id:String(i)}));
 const request=buildReviewRequest(many,{model:'test/model',allowedModels:['test/model'],maxOutputTokens:16384});
 assert.equal(JSON.parse(request.messages[1].content).candidates.length,405);
 assert.equal(evaluateDecisions(many,[]).missing.length,405);
});
test('invalid provenance and duplicate cases fail closed',()=>{
 const d={id:cases[0].id,action:'skip',reason:'Routine'};
 for(const list of [[cases[0],cases[0]],[{...cases[0],sourceUrl:'http://example.com/'}],[{...cases[0],sourceUrl:'https://user:password@example.com/'}]])assert.throws(()=>evaluateDecisions(list,[d]));
});
test('CLI rejects invalid output and does not mistake incomplete coverage for pass',async()=>{
 const {spawnSync}=await import('node:child_process');
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(tmpdir()+'/warpcore-eval-');
 try{
  const output=dir+'/response.json';
  await writeFile(output,JSON.stringify({decisions:[]}));
  const cli=new URL('./evaluate-cli.mjs',import.meta.url).pathname;
  const fixture=new URL('./real-story-cases.json',import.meta.url).pathname;
  const missing=spawnSync(process.execPath,[cli,fixture,output],{encoding:'utf8'});
  assert.equal(missing.status,1);assert.equal(JSON.parse(missing.stdout).complete,false);
  await writeFile(output,'not json');
  assert.equal(spawnSync(process.execPath,[cli,fixture,output]).status,2);
  assert.equal(spawnSync(process.execPath,[cli]).status,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
