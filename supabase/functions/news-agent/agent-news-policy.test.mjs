import test from 'node:test';import assert from 'node:assert/strict';
import {buildReviewRequest} from './evaluation.mjs';
import {buildEditorialInstructions,POLICY_VERSION} from './policy.mjs';
import fs from 'node:fs/promises';
test('discovery receives the full-history semantic dedup contract without a date cutoff',()=>{
 const request=buildReviewRequest([{id:'fixture',discoveryText:'A public launch.',sourceUrl:'https://example.com/launch'}],{model:'test/model',allowedModels:['test/model'],maxOutputTokens:2000});
 const instructions=request.messages[0].content;
 assert.match(instructions,/Read all published and unresolved publications plus all pending\/leased decisions for semantic event deduplication, without a date cutoff/);
 assert.doesNotMatch(instructions,/fourteen-day/);
 // This checks the request contract, not whether a model obeys it.
});
test('agent and JetBrains high-level guidance enters discovery without leaking regression labels',async()=>{
 const cases=JSON.parse(await fs.readFile(new URL('./interest-cases.json',import.meta.url)));
 const request=buildReviewRequest(cases,{model:'test/model',allowedModels:['test/model'],maxOutputTokens:2000});
 const policy=buildEditorialInstructions();assert.equal(POLICY_VERSION,'2026-11-21.1');
 for(const phrase of ['major releases, product launches','Pi, Hermes, OpenClaw','Prefer curated reporting/aggregation','Skip patch versions, changelog minutiae','JetBrains coverage is high-level product, service and model releases'])assert.ok(request.messages[0].content.includes(phrase),phrase);
 assert.ok(request.messages[0].content.includes(policy));assert.equal(JSON.stringify(request).includes('expectedAction'),false);
 for(const id of ['pi-major','hermes-launch','agent-patch','agent-tutorial','jetbrains-launch','jetbrains-patch'])assert.ok(cases.some(c=>c.id===id));
 // These are regression expectations, not measured model-quality results.
});

test('inference implementation detail requires demonstrated user-facing impact',()=>{
 const policy=buildEditorialInstructions();
 assert.ok(policy.includes('stream-k MUL_MAT'));
 assert.ok(policy.includes('A technically new implementation is not by itself a meaningful new capability'));
 assert.ok(policy.includes('Apply this eligibility check in both discovery and final verification'));
});
