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
