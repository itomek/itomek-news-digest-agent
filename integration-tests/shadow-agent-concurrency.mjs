// Independent PostgreSQL sessions in an explicitly disposable loopback fixture.
// This never connects to Supabase, calls a model, or publishes a post.
import {Client} from 'pg';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {newShadowRun} from '../supabase/functions/news-agent/workflow.mjs';

const connection = process.env.WARPCORE_TEST_DATABASE_URL;
if (!connection) throw Error('WARPCORE_TEST_DATABASE_URL must name a disposable loopback warpcore_test database');
const url = new URL(connection);
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/warpcore_test' || url.search || url.hash) {
  throw Error('Dedicated loopback warpcore_test database without URL options required');
}
const clients = Array.from({length: 3}, () => new Client({connectionString: url.href}));
const [a, b, observer] = clients;
const query = (client, text, args = []) => client.query(text, args);
const scalar = async (client, text, args = []) => (await query(client, text, args)).rows[0].value;
const states = new Map();
const claim = (client, id) => scalar(client, 'select shadow_agent.claim($1,60) as value', [id]);
const save = (client, id, token, revision) => scalar(client,
  'select shadow_agent.save($1,$2,$3,$4) as value',
  [id, token, revision, {...states.get(id), revision:revision + 1}]);
const reserve = (client, id, token, hash, cost) => scalar(client,
  'select shadow_agent.reserve($1,$2,$3,$4) as value', [id, token, hash, cost]);
const dispatch = (client, attempt, token) => scalar(client,
  'select shadow_agent.dispatch($1,$2) as value', [attempt, token]);

async function seed(id, cap = 1) {
  const candidate = {id:'a'.repeat(64),sourceUrl:'https://example.com/shadow-concurrency',
    sourceType:'rss',sourceCreatedAt:new Date().toISOString(),discoveryText:'Synthetic test candidate, not public evidence.'};
  const state = {...newShadowRun({runId:id,scanStartedAt:new Date().toISOString()}),
    phase:'reviewing',activeBatch:[candidate.id],cursor:candidate.id,candidates:[candidate]};
  states.set(id, state);
  await query(observer, 'insert into shadow_agent.runs(id,state,limit_credits) values ($1,$2,$3)',
    [id, state, cap]);
}
async function waitsOnLock(pid) {
  for (let i = 0; i < 100; i++) {
    const row = (await query(observer,
      'select wait_event_type from pg_stat_activity where pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}
// Capture rejections immediately so a delayed transaction cannot cause an
// unhandled rejection while the observer checks actual lock contention.
const outcome = promise => promise.then(value => ({value}), error => ({error}));

try {
  await Promise.all(clients.map(client => client.connect()));
  await Promise.all(clients.map(client => query(client, "set statement_timeout='8s'")));
  // Never drop/reuse a possibly active shadow fixture or alter existing limits.
  assert.equal(await scalar(observer,
    "select exists(select 1 from pg_namespace where nspname='shadow_agent') as value"), false,
    'Use a fresh disposable database: shadow_agent already exists');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    if (!(await query(observer, 'select 1 from pg_roles where rolname=$1', [role])).rowCount) {
      await query(observer, `create role ${role}`);
    }
  }
  await query(observer, await fs.readFile(new URL('../supabase/functions/news-agent/sql/shadow-state.sql', import.meta.url), 'utf8'));
  await query(observer, "insert into shadow_agent.budgets(day,limit_credits) values ((now() at time zone 'utc')::date,1)");
  await Promise.all([a, b].map(client => query(client, 'set role service_role')));
  const bPid = await scalar(b, 'select pg_backend_pid() as value');

  // Competing workers cannot obtain the same run lease.
  const run = randomUUID();
  await seed(run);
  const claims = await Promise.all([claim(a, run), claim(b, run)]);
  assert.equal(claims.filter(Boolean).length, 1, 'Exactly one claimant wins');
  const lease = claims.find(Boolean);

  // Both sessions attempt the same old revision. B must really wait for A.
  await query(a, 'begin');
  assert.equal(await save(a, run, lease, 0), true);
  const competingSave = outcome(save(b, run, lease, 0));
  assert.equal(await waitsOnLock(bPid), true, 'CAS updates must contend on the run row');
  await query(a, 'commit');
  const saved = await competingSave;
  assert.ifError(saved.error);
  assert.equal(saved.value, false, 'CAS loser cannot overwrite the winning state');
  const state = await scalar(observer, 'select state as value from shadow_agent.runs where id=$1', [run]);
  assert.equal(state.revision, 1);

  // Distinct runs share the daily budget, not merely a per-run ceiling.
  const first = randomUUID(), second = randomUUID();
  await seed(first); await seed(second);
  const firstLease = await claim(a, first), secondLease = await claim(b, second);
  await query(a, 'begin');
  const attempt = await reserve(a, first, firstLease, 'a'.repeat(64), 0.6);
  assert.ok(attempt);
  const competingReservation = outcome(reserve(b, second, secondLease, 'b'.repeat(64), 0.6));
  assert.equal(await waitsOnLock(bPid), true, 'Different runs must contend on the global daily budget');
  await query(a, 'commit');
  const reservation = await competingReservation;
  assert.ok(reservation.error, 'Second 0.6 reservation cannot fit the remaining 0.4');
  assert.match(reservation.error.message, /budget/i);
  // The rejected transaction must not poison the run or reserve phantom credit.
  const remaining = await reserve(b, second, secondLease, 'c'.repeat(64), 0.4);
  assert.ok(remaining);
  await assert.rejects(() => reserve(a, first, firstLease, 'd'.repeat(64), 0.001), /already reserved/i);
  const budgetProbe = randomUUID();
  await seed(budgetProbe);
  const probeLease = await claim(a, budgetProbe);
  await assert.rejects(() => reserve(a, budgetProbe, probeLease, 'd'.repeat(64), 0.001), /budget/i);

  // Exactly one worker may dispatch an already reserved attempt.
  const dispatches = await Promise.all([dispatch(a, attempt, firstLease), dispatch(b, attempt, firstLease)]);
  assert.deepEqual(dispatches.sort(), [false, true], 'A reserved request is dispatched at most once');

  // Two late settlement callers account for a completed request only once.
  const settle = client => scalar(client,
    "select shadow_agent.settle($1,$2,'settled',0.3) as value", [attempt, firstLease]);
  await query(a, 'begin');
  assert.equal(await settle(a), true);
  const competingSettlement = outcome(settle(b));
  assert.equal(await waitsOnLock(bPid), true, 'Concurrent settlement must serialize accounting');
  await query(a, 'commit');
  const settled = await competingSettlement;
  assert.ifError(settled.error);
  assert.equal(settled.value, true, 'Identical settlement is idempotent');
  const accounting = (await query(observer,
    'select held_credits::float as held,spent_credits::float as spent from shadow_agent.budgets')).rows[0];
  assert.deepEqual(accounting, {held:0.4, spent:0.3}, 'Release only the first reservation and charge once');
  // Advance to a distinct, coherent reviewing checkpoint before a second call.
  const prior = states.get(first);
  const nextCandidate = {...prior.candidates[0], id:'b'.repeat(64)};
  states.set(first, {...prior, candidates:[...prior.candidates, nextCandidate],
    decisions:[{id:prior.candidates[0].id,action:'skip',reason:'Synthetic concurrency fixture.'}],
    cursor:nextCandidate.id,activeBatch:[nextCandidate.id]});
  assert.equal(await save(a, first, firstLease, 0), true);
  const lastAttempt = await reserve(a, first, firstLease, 'e'.repeat(64), 0.3);
  assert.ok(lastAttempt);
  await assert.rejects(() => reserve(b, second, secondLease, 'f'.repeat(64), 0.001), /already reserved/i);
  await assert.rejects(() => reserve(a, budgetProbe, probeLease, 'f'.repeat(64), 0.001), /budget/i);

  // Overspend must block dispatch in a different, individually healthy run.
  assert.equal(await dispatch(a, lastAttempt, firstLease), true);
  assert.equal(await scalar(a, "select shadow_agent.settle($1,$2,'settled',0.5) as value",
    [lastAttempt, firstLease]), true);
  assert.equal(await scalar(observer, 'select blocked as value from shadow_agent.runs where id=$1', [second]), false);
  assert.equal(await scalar(observer, 'select status as value from shadow_agent.attempts where id=$1', [remaining]), 'reserved');
  assert.equal(await dispatch(b, remaining, secondLease), false, 'Global circuit breaker blocks other runs before network dispatch');

  // Lease fencing survives expiration/reacquisition, even at a valid revision.
  await query(observer, "update shadow_agent.runs set lease_until=now()-interval '1 second' where id=$1", [run]);
  const replacement = await claim(b, run);
  assert.ok(replacement);
  assert.notEqual(replacement, lease);
  assert.equal(await save(a, run, lease, 1), false, 'Expired worker cannot save after another worker reacquires');
  assert.equal(await save(b, run, replacement, 1), true, 'New lease can continue from exact revision');
  console.log('PASS: real PostgreSQL concurrent lease, CAS, shared daily budget, one-time dispatch, idempotent settlement and lease fencing; no external calls');
} finally {
  await Promise.all(clients.map(client => query(client, 'rollback').catch(() => {})));
  await Promise.all(clients.map(client => client.end().catch(() => {})));
}
