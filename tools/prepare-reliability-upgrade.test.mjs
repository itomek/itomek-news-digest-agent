import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareReliabilityUpgrade,extractFunction,loadReliabilityUpgrade} from './prepare-reliability-upgrade.mjs';
const fn=name=>`create function ${name}() returns jsonb language plpgsql as $$begin return '{}';end $$;`;
const operations=`-- BEGIN RELIABILITY HEALTH PROGRESS\n-- fixture\n-- END RELIABILITY HEALTH PROGRESS\n${fn('public.warpcore_agent_health')}`;
const alerts=`code text primary key check(code in ('old_code','new_code')),\n${fn('shadow_agent.track_run_progress')}\n${fn('shadow_agent.refresh_alerts')}`;
test('deterministic forward artifact replaces canonical functions and code check only',()=>{
 const sql=prepareReliabilityUpgrade({operations,alerts});assert.equal(sql,prepareReliabilityUpgrade({operations,alerts}));
 assert.equal((sql.match(/create or replace function/g)||[]).length,3);
 assert.match(sql,/check\(code in \('old_code','new_code'\)\)/);assert.match(sql,/requires installed operations/);
 assert.doesNotMatch(sql,/drop table|truncate|update .*settings|grant execute|revoke all/i);
});
test('canonical extraction fails closed on missing, duplicate or malformed contracts',()=>{
 assert.throws(()=>extractFunction('', 'public.warpcore_agent_health'));
 assert.throws(()=>extractFunction(fn('a.b')+fn('a.b'),'a.b'));
 assert.throws(()=>prepareReliabilityUpgrade({operations:operations.replace('BEGIN RELIABILITY','MISSING'),alerts}));
 assert.throws(()=>prepareReliabilityUpgrade({operations,alerts:alerts.replace("'new_code'","'bad-code'")}));
});

test('current canonical forward artifact includes acquisition health and fixed public messages',async()=>{
 const first=await loadReliabilityUpgrade();assert.equal(first,await loadReliabilityUpgrade());
 assert.match(first,/recentAcquisitionFailureCount/);assert.match(first,/heldJobsWithoutProgressCount/);assert.match(first,/verification_acquisition_failed/);assert.match(first,/verification_draft_rejected/);
 assert.doesNotMatch(first,/drop table|truncate|update .*settings/i);
});
