-- Workflow continuation only: an unknown 429 remains fully held, never retried.
-- Install after verification-quarantine.sql. No activation or budget changes.
begin;
create table shadow_agent.verification_rate_limit_audit(
 job_id uuid primary key references shadow_agent.verification_jobs(id),
 attempt_id uuid not null unique references shadow_agent.attempts(id),
 run_id uuid not null references shadow_agent.runs(id),request_hash text not null,
 job_before jsonb not null,run_before jsonb not null,attempt_before jsonb not null,
 budget_before jsonb not null,unknown_audit jsonb not null,
 held_credits numeric not null check(held_credits=0.036045),
 billing_status text not null default 'unknown_held' check(billing_status='unknown_held'),
 backoff_until timestamptz not null,performed_at timestamptz not null default clock_timestamp(),
 performed_by text not null default session_user
);
alter table shadow_agent.verification_rate_limit_audit enable row level security;
revoke all on shadow_agent.verification_rate_limit_audit from public,anon,authenticated,service_role;
create trigger verification_rate_limit_immutable before update or delete on shadow_agent.verification_rate_limit_audit
for each row execute function shadow_agent.verification_quarantine_immutable();
create function shadow_agent.advance_verification_rate_limits() returns integer
language plpgsql security definer set search_path='' as $$
declare j shadow_agent.verification_jobs;r shadow_agent.runs;a shadow_agent.attempts;b shadow_agent.budgets;
 x jsonb;d jsonb;approved jsonb;model_id text;deadline timestamptz;retry_seconds integer;continued integer:=0;daily_count integer;
begin
 perform shadow_agent.verification_lock();
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('warpcore_shared_admission_v1',0)) then
  raise exception using errcode='55P03',message='Shared admission busy';end if;
 select model into model_id from shadow_agent.runtime_settings where singleton for share nowait;
 approved:=shadow_agent.approved_runtime_model(model_id);
 if model_id is distinct from 'google/gemma-4-26b-a4b-it'
 or approved->>'model' is distinct from model_id or approved->>'provider' is distinct from 'PrimeIntellect'
 or approved->'maxCostCredits' is distinct from '0.036045'::jsonb then return 0;end if;
 select count(*) into daily_count from shadow_agent.verification_rate_limit_audit
 where (performed_at at time zone 'utc')::date=(clock_timestamp() at time zone 'utc')::date;
 if daily_count>=10 then return 0;end if;
 -- Bounded scan, serialized with claim and other continuation workers.
 for j in select * from shadow_agent.verification_jobs where status='uncertain' and not quarantined order by id limit 10 loop
  if j.metadata is distinct from '{"model":"google/gemma-4-26b-a4b-it","profileVersion":"2026-11-17.verify.8","expectedProvider":"PrimeIntellect"}'::jsonb then continue;end if;
  select audit into x from shadow_agent.verification_audit where job_id=j.id and status='uncertain';d:=x->'diagnostic';
  if jsonb_typeof(x) is distinct from 'object' or (x-'errorCode'-'diagnostic')<>'{}'::jsonb
  or x->>'errorCode' is distinct from 'http_failure' or jsonb_typeof(d) is distinct from 'object'
  or (d-'httpStatus'-'limitSource'-'errorProvider'-'providerErrorCode'-'retryAfterSeconds'-'cloudflareRay'-'requestId'-'providerErrorType')<>'{}'::jsonb
  or d->'httpStatus' is distinct from '429'::jsonb or d->>'limitSource' is distinct from 'upstream_provider_shared_pool'
  or d->>'errorProvider' is distinct from 'PrimeIntellect' or d->>'providerErrorCode' is distinct from 'rate_limited'
  or (d ? 'providerErrorType' and not coalesce(d->>'providerErrorType' in ('rate_limit_error','rate_limit_exceeded'),false))
  then continue;end if;
  retry_seconds:=300;
  if d ? 'retryAfterSeconds' then
   if jsonb_typeof(d->'retryAfterSeconds') is distinct from 'number' or coalesce(d->>'retryAfterSeconds','') !~ '^[0-9]{1,5}$' then continue;end if;
   retry_seconds:=(d->>'retryAfterSeconds')::integer;
   if retry_seconds>86400 then continue;end if;
   retry_seconds:=greatest(300,retry_seconds);
  end if;
  if (select count(*) from shadow_agent.attempts where run_id=j.child_run_id)<>1
  or exists(select 1 from shadow_agent.verification_audit where job_id=j.id and status='settled') then continue;end if;
  -- Match the accounting lock order, so late original-token settlement cannot race a snapshot.
  select * into b from shadow_agent.budgets where day=(select day from shadow_agent.attempts where run_id=j.child_run_id) for update nowait;
  select * into r from shadow_agent.runs where id=j.child_run_id for update nowait;
  select * into a from shadow_agent.attempts where run_id=j.child_run_id for update nowait;
  select * into j from shadow_agent.verification_jobs where id=j.id for update nowait;
  if j.status is distinct from 'uncertain' or j.quarantined or a.status is distinct from 'uncertain' or a.actual is not null
  or r.state->>'storageKind' is distinct from 'verification-v1' or r.state->>'runId' is distinct from r.id::text
  or r.state->'revision' is distinct from to_jsonb(r.revision) or r.state->'publishingEnabled' is distinct from 'false'::jsonb
  or a.checkpoint_revision is distinct from r.revision
  or a.reserved<>0.036045 or r.held_credits is distinct from a.reserved or b.held_credits is null or b.held_credits<a.reserved
  or r.lease_until is null or r.lease_token is distinct from a.lease_token
  or j.receipt_id is not null or j.handoff_inbox_id is not null
  or exists(select 1 from agent_verification.receipts where material->>'storyKey'=j.story_key)
  or exists(select 1 from public.warpcore_curator_inbox where story_key=j.story_key)
  or exists(select 1 from public.warpcore_publications where story_key=j.story_key) then continue;end if;
  -- The original lease expires after dispatch; using its expiry is deliberately
  -- more conservative than trusting the upstream Retry-After as a billing signal.
  deadline:=r.lease_until+pg_catalog.make_interval(secs=>retry_seconds);
  if clock_timestamp()<deadline then continue;end if;
  insert into shadow_agent.verification_rate_limit_audit(job_id,attempt_id,run_id,request_hash,job_before,run_before,attempt_before,budget_before,unknown_audit,held_credits,backoff_until)
  values(j.id,a.id,r.id,a.request_hash,to_jsonb(j),to_jsonb(r),to_jsonb(a),to_jsonb(b),x,a.reserved,deadline);
  update shadow_agent.verification_jobs set quarantined=true where id=j.id;
  continued:=continued+1;
  if daily_count+continued>=10 then exit;end if;
 end loop;
 return continued;
end $$;
revoke all on function shadow_agent.advance_verification_rate_limits() from public,anon,authenticated,service_role;
commit;
