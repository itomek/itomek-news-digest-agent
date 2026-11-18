import test from 'node:test';import assert from 'node:assert/strict';
import {buildReviewRequest} from './evaluation.mjs';
import {buildEditorialInstructions,POLICY_VERSION} from './policy.mjs';
import fs from 'node:fs/promises';
test('agent and JetBrains high-level guidance enters discovery without leaking regression labels',async()=>{
 const cases=JSON.parse(await fs.readFile(new URL('./interest-cases.json',import.meta.url)));
 const request=buildReviewRequest(cases,{model:'test/model',allowedModels:['test/model'],maxOutputTokens:2000});
 const policy=buildEditorialInstructions();assert.equal(POLICY_VERSION,'2026-11-18.2');
 for(const phrase of ['major releases, product launches','Pi, Hermes, OpenClaw','Prefer curated reporting/aggregation','Skip patch versions, changelog minutiae','JetBrains coverage is high-level product, service and model releases'])assert.ok(request.messages[0].content.includes(phrase),phrase);
 assert.ok(request.messages[0].content.includes(policy));assert.equal(JSON.stringify(request).includes('expectedAction'),false);
 for(const id of ['pi-major','hermes-launch','agent-patch','agent-tutorial','jetbrains-launch','jetbrains-patch'])assert.ok(cases.some(c=>c.id===id));
 // These are regression expectations, not measured model-quality results.
});
