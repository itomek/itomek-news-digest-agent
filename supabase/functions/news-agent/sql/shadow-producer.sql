-- SHADOW ONLY; outside migrations. Load state, paged and audit contracts first.
-- No scheduler, activation, credentials or publishing. Administrator alone owns
-- enablement, run limits and supported policy. Worker RPCs cannot modify them.
begin;
create table shadow_agent.producer_settings(
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 run_limit_credits numeric check(run_limit_credits>0 and run_limit_credits<1000000),
 policy_version text,
 first_seen_since timestamptz default null
);
insert into shadow_agent.producer_settings(singleton) values(true);
create table shadow_agent.producer_slots(
 utc_hour timestamptz primary key,
 run_id uuid not null unique references shadow_agent.runs(id)
);
alter table shadow_agent.producer_settings enable row level security;
alter table shadow_agent.producer_slots enable row level security;
revoke all on shadow_agent.producer_settings,shadow_agent.producer_slots from public,anon,authenticated,service_role;
-- Bounded workflow recovery, never a billing resolution or request retry.
create function shadow_agent.advance_gemma_discovery_failures() returns integer
language plpgsql security definer set search_path='' as $$
declare r record; model_id text; continued integer:=0; daily_count integer; d jsonb; retry_seconds integer; result jsonb;
 reason_prefix constant text:='automatic_gemma_discovery_failure_v1:';
begin
 if to_regprocedure('shadow_agent.quarantine_timed_out_run(uuid,bigint,text)') is null
 or to_regprocedure('shadow_agent.quarantine_rate_limited_run(uuid,bigint,text)') is null
 or to_regclass('shadow_agent.runtime_settings') is null then return 0;end if;
 -- Reuse the original recovery lock so an in-flight older selector cannot race
 -- this combined timeout/429 daily cap during a rolling SQL replacement.
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('warpcore_gemma_discovery_timeout_v1',0)) then
  raise exception using errcode='55P03',message='Discovery failure recovery busy';end if;
 select model into model_id from shadow_agent.runtime_settings where singleton for share nowait;
 if model_id is distinct from 'google/gemma-4-26b-a4b-it' then return 0;end if;
 select count(*) into daily_count from shadow_agent.billing_quarantine_audit
 where (left(reason,length(reason_prefix))=reason_prefix
 or left(reason,length('automatic_gemma_discovery_timeout_v1:'))='automatic_gemma_discovery_timeout_v1:')
 and (performed_at at time zone 'utc')::date=(clock_timestamp() at time zone 'utc')::date;
 if daily_count>=10 then return 0;end if;
 for r in select old.*,x.audit as failure_audit from shadow_agent.runs old
 join shadow_agent.run_config cfg on cfg.run_id=old.id
 join shadow_agent.attempts a on a.run_id=old.id and a.status='uncertain' and a.actual is null and a.reserved=.036045
 join shadow_agent.attempt_audit x on x.attempt_id=a.id and x.status='uncertain'
 where old.state->>'storageKind'='paged-v1' and old.state->>'phase'='uncertain'
 and old.lease_until<=clock_timestamp()-interval '5 minutes'
 and cfg.config->>'model'='google/gemma-4-26b-a4b-it'
 and cfg.config->>'expectedProvider'='PrimeIntellect'
 and cfg.config->'maxCostCredits'='0.036045'::jsonb
 and cfg.config->'requestProfile'->>'version'='2026-11-17.8'
 order by old.id limit 10 loop
  result:=null;retry_seconds:=300;d:=r.failure_audit->'diagnostic';
  if r.failure_audit='{"errorCode":"timeout"}'::jsonb then
   result:=shadow_agent.quarantine_timed_out_run(r.id,r.revision,reason_prefix||' Exact timeout; preserve full unknown hold and never replay this request.');
  elsif jsonb_typeof(r.failure_audit)='object' and (r.failure_audit-'errorCode'-'diagnostic')='{}'::jsonb
  and r.failure_audit->>'errorCode'='http_failure' and jsonb_typeof(d)='object'
  and (d-'httpStatus'-'limitSource'-'errorProvider'-'providerErrorCode'-'retryAfterSeconds'-'cloudflareRay'-'requestId'-'providerErrorType')='{}'::jsonb
  and d->'httpStatus'='429'::jsonb and d->>'limitSource'='upstream_provider_shared_pool'
  and d->>'errorProvider'='PrimeIntellect' and d->>'providerErrorCode'='rate_limited'
  and (not(d ? 'providerErrorType') or d->>'providerErrorType' in ('rate_limit_error','rate_limit_exceeded')) then
   if d ? 'retryAfterSeconds' then
    if jsonb_typeof(d->'retryAfterSeconds') is distinct from 'number' or coalesce(d->>'retryAfterSeconds','') !~ '^[0-9]{1,5}$' then continue;end if;
    retry_seconds:=(d->>'retryAfterSeconds')::integer;
    if retry_seconds>86400 then continue;end if;
    retry_seconds:=greatest(300,retry_seconds);
   end if;
   if clock_timestamp()<r.lease_until+pg_catalog.make_interval(secs=>retry_seconds) then continue;end if;
   result:=shadow_agent.quarantine_rate_limited_run(r.id,r.revision,reason_prefix||' Recorded PrimeIntellect shared-pool429; preserve full unknown hold and never replay this request.');
  end if;
  -- Existing owner contracts recheck CAS, exact history, full unknown holds,
  -- audits and financial lock order before terminally fencing ONLY this run.
  if result is not null then
   continued:=continued+1;
   if daily_count+continued>=10 then exit;end if;
  end if;
 end loop;
 return continued;
end $$;
revoke all on function shadow_agent.advance_gemma_discovery_failures() from public,anon,authenticated,service_role;
create function public.warpcore_shadow_select_run() returns jsonb
language plpgsql security definer set search_path='' as $$
declare settings shadow_agent.producer_settings; r shadow_agent.runs; run_id uuid; stamp timestamptz; verification_ready boolean; batch jsonb; item jsonb; position integer:=0;
begin
 -- Serializes waiting-list selection across scheduled triggers. Claim is
 -- independently fenced; callers receiving one ID still compete for one lease.
 select * into settings from shadow_agent.producer_settings where singleton for update;
 if not found or not settings.enabled then return null; end if;
 if settings.run_limit_credits is null or (settings.policy_version is null or settings.policy_version not in ('2026-11-14.1','2026-11-18.1','2026-11-18.2','2026-11-19.1','2026-11-21.1'))
 then raise exception 'Invalid producer configuration'; end if;
 if to_regprocedure('shadow_agent.advance_verification_rate_limits()') is not null then
  perform shadow_agent.advance_verification_rate_limits();end if;
 perform shadow_agent.advance_gemma_discovery_failures();
 if exists(select 1 from shadow_agent.runs where state->>'storageKind'='paged-v1' and state->>'phase'='reviewing' and lease_until>clock_timestamp()) then return null; end if;
 select * into r from shadow_agent.runs where state->>'storageKind'='paged-v1'
 and state->>'phase'='scan' order by (state->>'scanStartedAt')::timestamptz,id limit 1;
 if found then
  if r.lease_until>clock_timestamp() then return null; end if;
  return to_jsonb(r.id);
 end if;
 if to_regprocedure('shadow_agent.unpaid_verification_retry_available()') is not null then if shadow_agent.unpaid_verification_retry_available() then return null;end if;end if;
 -- Complete selected work before taking another waiting-list batch. Optional
 -- verifier tables are installed later; dynamic SQL preserves that install order.
 if to_regclass('shadow_agent.verification_settings') is not null
 and to_regclass('shadow_agent.verification_jobs') is not null
 and to_regprocedure('shadow_agent.next_verification_candidate()') is not null then
  execute $priority$
   with cfg as (select * from shadow_agent.verification_settings where singleton and enabled and job_limit_credits is not null),
   handoff as (
    select v.* from shadow_agent.verification_jobs v,cfg where cfg.submit_enabled and shadow_agent.verification_queue_has_capacity()
    and v.status='verified' and not v.quarantined and v.handoff_status='pending'
    and not exists(select 1 from public.warpcore_curator_inbox i where i.verification_receipt_id=v.receipt_id)
    order by v.id limit 1
   ), pending as (select * from shadow_agent.verification_jobs where status='pending' and not quarantined order by id limit 1)
   select exists(select 1 from cfg) and (
    exists(select 1 from handoff h join shadow_agent.runs r on r.id=h.child_run_id
     where r.lease_until is null or r.lease_until<=clock_timestamp())
    or (not exists(select 1 from handoff) and (
     -- Yield once for claim's authoritative lost-attempt classification.
     exists(select 1 from shadow_agent.verification_jobs v join shadow_agent.runs r on r.id=v.child_run_id
      where v.status='pending' and not v.quarantined and r.lease_until<=clock_timestamp()
      and exists(select 1 from shadow_agent.attempts a where a.run_id=r.id))
     or (
     -- Claim converts expired attempted pending jobs to uncertain before selection.
     not exists(select 1 from shadow_agent.verification_jobs v join shadow_agent.runs r on r.id=v.child_run_id
      where v.status='pending' and not v.quarantined and r.lease_until<=clock_timestamp()
      and exists(select 1 from shadow_agent.attempts a where a.run_id=r.id))
     and (exists(select 1 from pending p join shadow_agent.runs r on r.id=p.child_run_id
       where shadow_agent.verification_queue_has_capacity() and (r.lease_until is null or r.lease_until<=clock_timestamp())
       and not exists(select 1 from shadow_agent.attempts a where a.run_id=r.id))
      or (not exists(select 1 from pending) and exists(
       select 1 from shadow_agent.next_verification_candidate()
      )))
    )))
   )
  $priority$ into verification_ready;
  if verification_ready then return null; end if;
 end if;
 select * into r from shadow_agent.runs where state->>'storageKind'='paged-v1' and state->>'phase'='review'
 order by (state->>'scanStartedAt')::timestamptz,id limit 1;
 if found then
  if r.lease_until>clock_timestamp() then return null;end if;
  return to_jsonb(r.id);
 end if;
 -- Take a small immutable batch directly from the durable waiting list. There
 -- is no hourly scan backlog: unfinished runs resume above, and committed
 -- decisions below remove finished items from future batches.
 stamp:=clock_timestamp();
 select coalesce(jsonb_agg(value order by value->>'story_key'),'[]'::jsonb) into batch
 from (select value from jsonb_array_elements(public.warpcore_shadow_candidate_page(stamp,null))
       order by value->>'story_key' limit 16) pending;
 if jsonb_array_length(batch)=0 then return null;end if;
 run_id:=gen_random_uuid();
 insert into shadow_agent.runs(id,state,limit_credits) values(run_id,jsonb_build_object(
  'storageKind','paged-v1','runId',run_id::text,
  'scanStartedAt',to_char(stamp at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'policyVersion',settings.policy_version,'revision',0,'phase','review','cursor',batch->-1->>'story_key',
  'candidateCount',jsonb_array_length(batch),'reviewedCount',0,'activeBatch',null,'publishingEnabled',false),settings.run_limit_credits);
 for item in select value from jsonb_array_elements(batch) loop
  insert into shadow_agent.candidates(run_id,ordinal,candidate_id,candidate) values(run_id,position,item->>'story_key',
   jsonb_build_object('id',item->>'story_key','sourceUrl',item->>'source_url','sourceType',item->>'source_type',
                     'sourceCreatedAt',item->>'source_created_at','discoveryText',item->>'excerpt'));
  position:=position+1;
 end loop;
 return to_jsonb(run_id);
end $$;
create function public.warpcore_shadow_candidate_page(p_started timestamptz,p_cursor text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;cutoff timestamptz;
begin
 if p_started is null or not isfinite(p_started) then raise exception 'Invalid scan timestamp'; end if;
 if p_cursor is not null and p_cursor !~ '^[a-f0-9]{64}$' then raise exception 'Invalid candidate cursor'; end if;
 select first_seen_since into cutoff from shadow_agent.producer_settings where singleton;
 with newest as (
  select distinct on (s.story_key) s.story_key,c.source_type,c.source_created_at,c.source_url,left(c.text,800) as excerpt
  from public.warpcore_stories s join public.warpcore_candidates c using(story_key)
  where s.status='unverified_review_required'
   and (cutoff is null or s.collected_at>=cutoff)
   and s.collected_at<=p_started and c.collected_at<=p_started
   and c.source_created_at between p_started-interval '7 days' and p_started+interval '5 minutes'
   and (p_cursor is null or s.story_key>p_cursor)
   and not exists(select 1 from public.warpcore_curator_inbox i where i.story_key=s.story_key)
   and not exists(select 1 from public.warpcore_publications p where p.story_key=s.story_key)
   -- An assessed item is finished even when the decision was to skip it.
   and not exists(select 1 from shadow_agent.candidates seen join shadow_agent.decisions d
     on d.run_id=seen.run_id and d.ordinal=seen.ordinal where seen.candidate_id=s.story_key)
   -- Unknown paid requests remain held; a fresh batch must never replay them.
   and not exists(select 1 from shadow_agent.candidates held join shadow_agent.attempts a on a.run_id=held.run_id
     where held.candidate_id=s.story_key and a.status in ('reserved','dispatched','uncertain'))
  order by s.story_key,c.source_created_at desc,c.uri
 ), page as (
  select story_key,source_type,source_url,excerpt,
   to_char(source_created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as source_created_at
  from newest order by story_key limit 100
 ) select coalesce(jsonb_agg(to_jsonb(page) order by story_key),'[]'::jsonb) into result from page;
 return result;
end $$;
-- Compact private tracing: counts only, never source text, credentials or payloads.
create function shadow_agent.queue_summary() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare cutoff timestamptz;stamp timestamptz:=statement_timestamp();result jsonb;pending_verification bigint:=0;
begin
 select first_seen_since into cutoff from shadow_agent.producer_settings where singleton;
 with waiting as (
  select s.story_key,s.collected_at from public.warpcore_stories s
  where s.status='unverified_review_required' and (cutoff is null or s.collected_at>=cutoff) and s.collected_at<=stamp
  and exists(select 1 from public.warpcore_candidates c where c.story_key=s.story_key and c.collected_at<=stamp
   and c.source_created_at between stamp-interval '7 days' and stamp+interval '5 minutes')
  and not exists(select 1 from public.warpcore_curator_inbox i where i.story_key=s.story_key)
  and not exists(select 1 from public.warpcore_publications p where p.story_key=s.story_key)
  and not exists(select 1 from shadow_agent.candidates seen join shadow_agent.decisions d
   on d.run_id=seen.run_id and d.ordinal=seen.ordinal where seen.candidate_id=s.story_key)
  and not exists(select 1 from shadow_agent.candidates held join shadow_agent.attempts a on a.run_id=held.run_id
   where held.candidate_id=s.story_key and a.status in ('reserved','dispatched','uncertain'))
 ), assessed as (
  select d.decision from shadow_agent.decisions d join shadow_agent.runs r on r.id=d.run_id
  where cutoff is null or (r.state->>'scanStartedAt')::timestamptz>=cutoff
 ) select jsonb_build_object(
  'sinceReset',cutoff,'asOf',stamp,
  'waiting',(select count(*) from waiting),'oldestWaitingAt',(select min(collected_at) from waiting),
  'reviewed',(select count(*) from assessed),'skipped',(select count(*) from assessed where decision->>'action'='skip'),
  'qualified',(select count(*) from assessed where decision->>'action'='verify'),
  'activeBatches',(select count(*) from shadow_agent.runs where state->>'storageKind'='paged-v1' and state->>'phase' in ('scan','review','reviewing')),
  'uncertainBatches',(select count(*) from shadow_agent.runs where state->>'storageKind'='paged-v1' and state->>'phase'='uncertain'),
  'published',(select count(*) from public.warpcore_publications where state='published' and (cutoff is null or prepared_at>=cutoff))) into result;
 if to_regclass('shadow_agent.verification_jobs') is not null then
  execute $pending$select count(*) from shadow_agent.verification_jobs v join shadow_agent.runs r on r.id=v.ranking_run_id
   where not v.quarantined and (v.status='pending' or (v.status='verified' and v.handoff_status='pending'))
   and ($1 is null or (r.state->>'scanStartedAt')::timestamptz>=$1)$pending$ into pending_verification using cutoff;
 end if;
 return result||jsonb_build_object('pendingVerification',pending_verification);
end $$;
revoke all on function shadow_agent.queue_summary() from public,anon,authenticated,service_role;
create function public.warpcore_shadow_claim(p_run uuid,p_seconds integer) returns jsonb
language sql security definer set search_path='' as $$
 select to_jsonb(shadow_agent.claim(p_run,p_seconds))
$$;
create function public.warpcore_shadow_load(p_run uuid) returns jsonb
language sql security definer set search_path='' as $$
 select to_jsonb(shadow_agent.load(p_run))
$$;
create function public.warpcore_shadow_paged_append(p_run uuid,p_lease uuid,p_revision bigint,p_page jsonb) returns jsonb
language sql security definer set search_path='' as $$
 select to_jsonb(shadow_agent.paged_append(p_run,p_lease,p_revision,p_page))
$$;
create function public.warpcore_shadow_paged_preview(p_run uuid,p_lease uuid,p_revision bigint,p_size integer) returns jsonb
language sql security definer set search_path='' as $$
 select to_jsonb(shadow_agent.paged_preview(p_run,p_lease,p_revision,p_size))
$$;
create function public.warpcore_shadow_paged_begin(p_run uuid,p_lease uuid,p_revision bigint,p_size integer) returns jsonb
language sql security definer set search_path='' as $$
 select to_jsonb(shadow_agent.paged_begin(p_run,p_lease,p_revision,p_size))
$$;
create function public.warpcore_shadow_paged_commit(p_run uuid,p_lease uuid,p_revision bigint,p_decisions jsonb) returns jsonb
language sql security definer set search_path='' as $$
 select to_jsonb(shadow_agent.paged_commit(p_run,p_lease,p_revision,p_decisions))
$$;
create function public.warpcore_shadow_paged_uncertain(p_run uuid,p_lease uuid,p_revision bigint) returns jsonb
language sql security definer set search_path='' as $$
 select to_jsonb(shadow_agent.paged_uncertain(p_run,p_lease,p_revision))
$$;
create function public.warpcore_shadow_paged_bind_config(p_run uuid,p_lease uuid,p_config jsonb) returns jsonb
language sql security definer set search_path='' as $$
 select to_jsonb(shadow_agent.paged_bind_config(p_run,p_lease,p_config))
$$;
create function public.warpcore_shadow_paged_reserve(p_run uuid,p_lease uuid,p_revision bigint,p_hash text,p_max numeric) returns jsonb
language sql security definer set search_path='' as $$
 select to_jsonb(shadow_agent.paged_reserve(p_run,p_lease,p_revision,p_hash,p_max))
$$;
create function public.warpcore_shadow_dispatch(p_attempt uuid,p_lease uuid) returns jsonb
language sql security definer set search_path='' as $$
 select to_jsonb(shadow_agent.dispatch(p_attempt,p_lease))
$$;
create function public.warpcore_shadow_paged_settle(p_attempt uuid,p_lease uuid,p_status text,p_cost numeric,p_audit jsonb) returns jsonb
language sql security definer set search_path='' as $$
 select to_jsonb(shadow_agent.paged_settle(p_attempt,p_lease,p_status,p_cost,p_audit))
$$;
revoke all on function public.warpcore_shadow_select_run() from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_select_run() to service_role;
revoke all on function public.warpcore_shadow_candidate_page(timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_candidate_page(timestamptz,text) to service_role;
revoke all on function public.warpcore_shadow_claim(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_claim(uuid,integer) to service_role;
revoke all on function public.warpcore_shadow_load(uuid) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_load(uuid) to service_role;
revoke all on function public.warpcore_shadow_paged_append(uuid,uuid,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_paged_append(uuid,uuid,bigint,jsonb) to service_role;
revoke all on function public.warpcore_shadow_paged_preview(uuid,uuid,bigint,integer) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_paged_preview(uuid,uuid,bigint,integer) to service_role;
revoke all on function public.warpcore_shadow_paged_begin(uuid,uuid,bigint,integer) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_paged_begin(uuid,uuid,bigint,integer) to service_role;
revoke all on function public.warpcore_shadow_paged_commit(uuid,uuid,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_paged_commit(uuid,uuid,bigint,jsonb) to service_role;
revoke all on function public.warpcore_shadow_paged_uncertain(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_paged_uncertain(uuid,uuid,bigint) to service_role;
revoke all on function public.warpcore_shadow_paged_bind_config(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_paged_bind_config(uuid,uuid,jsonb) to service_role;
revoke all on function public.warpcore_shadow_paged_reserve(uuid,uuid,bigint,text,numeric) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_paged_reserve(uuid,uuid,bigint,text,numeric) to service_role;
revoke all on function public.warpcore_shadow_dispatch(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_dispatch(uuid,uuid) to service_role;
revoke all on function public.warpcore_shadow_paged_settle(uuid,uuid,text,numeric,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_paged_settle(uuid,uuid,text,numeric,jsonb) to service_role;
create function public.warpcore_shadow_selection(p_run uuid) returns jsonb
language sql security definer set search_path='' as $$
 select shadow_agent.selection_summary(p_run)
$$;
revoke all on function public.warpcore_shadow_selection(uuid) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_selection(uuid) to service_role;
commit;
