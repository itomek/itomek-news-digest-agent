import test from 'node:test';import assert from 'node:assert/strict';
import {RANKING_RUBRIC_VERSION,buildRankingInstructions} from './ranking-rubric.mjs';
test('absolute versioned rubric specifies every importance and relevance anchor and policy authority',()=>{
 assert.equal(RANKING_RUBRIC_VERSION,'2026-11-16.1');const text=buildRankingInstructions();
 for(const anchor of ['absolute','never relative','Existing editorial policy decides scope','1 modest meaningful development','2 material improvement','3 important new capability','4 exceptional major change','1 meaningful but indirect permitted interest','2 clear stated interest','3 direct work relevance','4 strong direct priority','skip requires importance=0 and relevance=0','verify requires both scores 1..4','Account for every candidate'])assert.ok(text.includes(anchor),anchor);
});
