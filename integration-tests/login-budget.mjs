// Disposable SQL only. No login, social API, production state or credentials.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const db=new PGlite(),q=async(s,a=[])=>(await db.query(s,a)).rows,did='did:plc:abcdefghijklmnopqrstuvwx',second='did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const reserve=async account=>(await q('select public.warpcore_reserve_login($1) ok',[account]))[0].ok;
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');await db.exec(await fs.readFile(new URL('../supabase/migrations/20261112153023_warpcore_login_guard.sql',import.meta.url),'utf8'));
 assert.equal(await reserve(did),true);const before=(await q('select * from public.warpcore_login_slots where account_did=$1',[did]))[0];
 await db.exec(await fs.readFile(new URL('../supabase/migrations/20261117162306_warpcore_login_batch_budget.sql',import.meta.url),'utf8'));
 assert.deepEqual((await q('select * from public.warpcore_login_slots where account_did=$1',[did]))[0],{...before,attempts:1},'Existing consumed hour and timestamp remain unchanged');
 await db.exec('set role service_role');for(let i=0;i<4;i++)assert.equal(await reserve(did),true);const full=(await q('select * from public.warpcore_login_slots where account_did=$1',[did]))[0];assert.equal(full.attempts,5);assert.equal(await reserve(did),false);assert.deepEqual((await q('select * from public.warpcore_login_slots where account_did=$1',[did]))[0],full,'Denied sixth cannot reset hour/count/timestamp');
 const results=await Promise.all(Array.from({length:6},()=>reserve(second)));assert.equal(results.filter(Boolean).length,5,'Concurrent queued reservations admit only five');assert.equal((await q('select attempts from public.warpcore_login_slots where account_did=$1',[second]))[0].attempts,5);
 // Only the disposable fixture changes saved hours. Production never resets slots.
 await q('update public.warpcore_login_slots set hour_slot=hour_slot-1 where account_did=$1',[second]);assert.equal(await reserve(second),true);assert.equal((await q('select attempts from public.warpcore_login_slots where account_did=$1',[second]))[0].attempts,1);await q('update public.warpcore_login_slots set hour_slot=hour_slot+1 where account_did=$1',[second]);assert.equal(await reserve(second),false,'Clock regression cannot mint attempts');
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>reserve(did),/permission/);}console.log('PASS: preserved used slot, atomic five login attempts/hour, queued concurrent sixth denied, rollover and ACL guards');
}finally{await db.close();}
