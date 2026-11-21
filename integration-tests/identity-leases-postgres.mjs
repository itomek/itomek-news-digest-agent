// Actual PostgreSQL sessions; fresh disposable loopback DB only. No model/PDS calls.
// Catches identity migrations rewriting uncertain records and stale workers changing
// a replacement lease. Historical migrations are followed by current guard SQL.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {deterministicTid} from '../supabase/functions/_shared/publishing.mjs';
import {createReviewPacket} from '../supabase/functions/_shared/curation.mjs';
import {prepareTransport} from '../supabase/functions/_shared/transport.mjs';

const url = new URL(process.env.WARPCORE_TEST_DATABASE_URL ?? 'http://invalid');
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/warpcore_test' || url.search || url.hash) {
  throw Error('Fresh disposable loopback warpcore_test required');
}
const a = new Client({connectionString: url.href});
const b = new Client({connectionString: url.href});
const q = async (c, sql, args = []) => (await c.query(sql, args)).rows;
const load = async path => a.query(await fs.readFile(new URL(path, import.meta.url), 'utf8'));
const migration = name => load('../supabase/migrations/' + name);
const account = 'did:plc:pfq2p7n2oiiy2k4pv6xnsgdk';
const key = n => n.toString(16).padStart(64, '0');
const attestations = {factsVerified: true, meaningfulChange: true, scopeApproved: true};

try {
  await Promise.all([a.connect(), b.connect()]);
  await Promise.all([a, b].map(c => c.query("set statement_timeout='10s'")));
  assert.equal((await q(a, "select to_regclass('public.warpcore_stories') absent"))[0].absent, null);
  await a.query(`do $$declare r text;begin foreach r in array array['anon','authenticated','service_role'] loop
    if not exists(select 1 from pg_roles where rolname=r) then execute format('create role %I',r);end if;
    end loop;end $$; alter role service_role bypassrls;`);
  for (const name of [
    '20261112145946_warpcore_review_base.sql',
    '20261112153023_warpcore_login_guard.sql',
    '20261112164434_warpcore_source_provenance.sql',
    '20261112175929_warpcore_curator_inbox.sql',
    '20261112190000_warpcore_publication_hour_guard.sql',
  ]) await migration(name);

  // Seed a historical unknown outcome before either identity migration.
  await q(a, "insert into warpcore_stories(story_key,status) values($1,'approved')", [key(1)]);
  await q(a, `insert into warpcore_publications(account_did,story_key,record_key,content_hash,state,record_payload)
    values($1,$2,'legacy-key','legacy-hash','uncertain',$3)`,
    [account, key(1), {$type: 'app.bsky.feed.post', text: 'Historical immutable record', createdAt: '2026-11-12T12:00:00.000Z'}]);
  await q(a, 'insert into warpcore_publication_slots(account_did,hour_slot) values($1,12345)', [account]);
  const before = await q(a, 'select to_jsonb(p) row from warpcore_publications p');
  const slots = await q(a, 'select to_jsonb(s) row from warpcore_publication_slots s');
  await migration('20261112192659_warpcore_tid_record_keys.sql');
  assert.deepEqual(await q(a, 'select to_jsonb(p) row from warpcore_publications p'), before);
  assert.deepEqual(await q(a, 'select to_jsonb(s) row from warpcore_publication_slots s'), slots);
  await migration('20261112201145_warpcore_hourly_batch_budget.sql');
  await migration('20261113011427_warpcore_native_reposts.sql');
  assert.deepEqual(await q(a, 'select to_jsonb(p) row from warpcore_publications p'), before);
  await migration('20261117162306_warpcore_login_batch_budget.sql');
  await migration('20261118180116_warpcore_drain_without_hourly_quota.sql');

  const tid = async (story, stamp) => (await q(a, 'select warpcore_record_tid($1,$2) tid', [story, stamp]))[0].tid;
  assert.equal(await tid('a'.repeat(64), '2026-11-12T12:00:00Z'), '3n24gaky622pe');
  for (const story of [key(0), 'f'.repeat(64)]) {
    for (const stamp of ['1970-01-01T00:00:00.000Z', '2026-11-12T18:30:05.999Z']) {
      assert.equal(await tid(story, stamp), deterministicTid(story, stamp));
    }
  }
  for (const role of ['anon', 'authenticated']) {
    await a.query('set role ' + role);
    await assert.rejects(() => tid(key(1), '2026-11-12T12:00:00Z'), e => e.code === '42501');
    await a.query('reset role');
  }

  // Existing Dot submissions must survive adding truthful agent identity.
  const story = key(2), uri = 'fixture:lease:2', source = 'https://example.com/lease';
  await q(a, 'select warpcore_ingest($1::jsonb)', [JSON.stringify([{
    uri, story_key: story, source_type: 'rss', source_id: 'fixture', actor: 'fixture',
    text: 'Public release', source_created_at: new Date().toISOString(), source_url: source, source_links: [source],
  }])]);
  const snapshot = (await q(a, 'select warpcore_curator_snapshot($1) s', [story]))[0].s;
  const editorial = {summary: 'A release adds a capability.', whyItMatters: 'It expands access.',
    change: 'New capability', political: false, evidenceIds: [uri],
    verification: {checkedAt: new Date().toISOString(), sourceUrls: [source], reason: 'Synthetic primary-source fixture.'}};
  const id = (await q(a, 'select warpcore_curator_submit($1,$2,$3,$4,$5,$6) id',
    [story, snapshot.evidence_hash, editorial, attestations, 'fixture-dot', randomUUID()]))[0].id;
  const oldInbox = (await q(a, 'select to_jsonb(i) row from warpcore_curator_inbox i where id=$1', [id]))[0].row;
  await load('../supabase/functions/news-agent/sql/shared-admission.sql');
  await load('../supabase/functions/news-agent/sql/agent-verification.sql');
  const migrated = (await q(a, 'select to_jsonb(i) row from warpcore_curator_inbox i where id=$1', [id]))[0].row;
  assert.deepEqual(migrated, {...oldInbox, agent_id: null, verification_receipt_id: null});
  await assert.rejects(() => q(a, "update warpcore_curator_inbox set actor_kind='agent',dot_id=null,agent_id='warpcore-news-agent-v1' where id=$1", [id]), /immutable/i);

  await Promise.all([a, b].map(c => c.query('set role service_role')));
  const oldLease = (await q(a, 'select * from warpcore_curator_claim(1)'))[0];
  assert.equal(oldLease.id, id);
  assert.equal((await q(b, 'select * from warpcore_curator_claim(1)')).length, 0);
  await a.query('reset role');
  await q(a, "update warpcore_curator_inbox set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [id]);
  await a.query('set role service_role');
  // Hold the replacement transaction open: the current shared admission guard
  // deliberately refuses a competing writer with 55P03 rather than waiting.
  await a.query('begin');
  const replacements = await q(a, 'select * from warpcore_curator_claim(1)');
  assert.equal(replacements.length, 1);
  const replacement = replacements[0];
  await assert.rejects(() => q(b, 'select * from warpcore_curator_claim(1)'), e => e.code === '55P03');
  await a.query('commit');
  assert.equal((await q(b, 'select * from warpcore_curator_claim(1)')).length, 0);
  assert.notEqual(replacement.lease_token, oldLease.lease_token);
  assert.equal(replacement.attempts, 2);
  const packet = await createReviewPacket({storyKey: story, evidence: snapshot.evidence, editorial});
  const job = {...await prepareTransport({...packet.recordDraft, verified: true, approved: true}, account,
    new Date(replacement.created_at).toISOString()), storyKey: story};
  assert.equal((await q(a, 'select warpcore_curator_finalize($1,$2,$3,$4) ok', [id, oldLease.lease_token, packet, job]))[0].ok, false);
  assert.equal((await q(a, 'select warpcore_curator_fail($1,$2,$3) ok', [id, oldLease.lease_token, 'stale-worker']))[0].ok, false);
  assert.equal((await q(b, 'select warpcore_curator_finalize($1,$2,$3,$4) ok', [id, replacement.lease_token, packet, job]))[0].ok, true);
  assert.equal((await q(a, 'select warpcore_curator_finalize($1,$2,$3,$4) ok', [id, replacement.lease_token, packet, job]))[0].ok, false);
  await a.query('reset role');
  assert.equal((await q(a, 'select count(*)::int n from warpcore_publications where story_key=$1', [story]))[0].n, 1);
  assert.deepEqual(await q(a, 'select to_jsonb(p) row from warpcore_publications p where story_key=$1', [key(1)]), before);
  console.log('PASS: real PostgreSQL TID/native/agent identity migration preservation, role denial, concurrent expired-lease replacement, stale-token fencing and single finalization');
} finally {
  await Promise.allSettled([a.end(), b.end()]);
}
