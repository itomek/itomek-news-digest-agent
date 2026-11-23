-- Install after ranking and agent-verification. No budgets, activation or public writes.
begin;
do $$begin
 if to_regclass('shadow_agent.ranking_runs') is null or to_regclass('shadow_agent.selection_items') is null
 or to_regprocedure('agent_verification.receipt_current(uuid)') is null then raise exception 'Verification ranking/receipt contracts required';end if;
end $$;
create table shadow_agent.verification_settings(
 singleton boolean primary key default true check(singleton),enabled boolean not null default false,
 submit_enabled boolean not null default false,
 backfill_enabled boolean not null default false,
 ranking_finalized_since timestamptz, -- Owner-only new-job cohort; NULL preserves all history.
 job_limit_credits numeric check(job_limit_credits>0 and job_limit_credits<=1)
);
insert into shadow_agent.verification_settings(singleton) values(true);
create table shadow_agent.verification_jobs(
 id uuid primary key default gen_random_uuid(),ranking_run_id uuid not null references shadow_agent.runs(id),
 story_key text not null check(story_key ~ '^[a-f0-9]{64}$'),child_run_id uuid not null unique references shadow_agent.runs(id),
 status text not null default 'pending' check(status in ('pending','verified','deferred','uncertain')),
 quarantined boolean not null default false,
 metadata jsonb,receipt_id uuid references agent_verification.receipts(id),
 handoff_status text not null default 'pending' check(handoff_status in ('pending','submitted','deferred')),
 handoff_reason text check(handoff_reason='stale_receipt'),handoff_inbox_id uuid unique references public.warpcore_curator_inbox(id),
 unique(ranking_run_id,story_key)
);
create table shadow_agent.verification_audit(
 job_id uuid not null references shadow_agent.verification_jobs(id),status text not null check(status in ('uncertain','settled')),
 audit jsonb not null,primary key(job_id,status)
);
alter table shadow_agent.verification_settings enable row level security;
alter table shadow_agent.verification_jobs enable row level security;
alter table shadow_agent.verification_audit enable row level security;
revoke all on shadow_agent.verification_settings,shadow_agent.verification_jobs,shadow_agent.verification_audit from public,anon,authenticated,service_role;
create function shadow_agent.verification_lock() returns void language plpgsql security definer set search_path='' as $$
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Verification jobs require READ COMMITTED';end if;
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('warpcore_verification_jobs_v1',0)) then
  raise exception using errcode='55P03',message='Verification jobs busy';end if;
end $$;
-- One deterministic source of new work for claim and the discovery selector.
-- Existing jobs preserve attempted candidates; original top-five proposals stay immutable.
-- A fenced terminal parent can contribute its paid committed prefix, never its failed batch.
create function shadow_agent.quarantined_gemma_prefix_eligible(p_run uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
 if to_regclass('shadow_agent.billing_quarantine_audit') is null then return false;end if;
 return exists(select 1 from shadow_agent.runs r join shadow_agent.run_config cfg on cfg.run_id=r.id
 join shadow_agent.billing_quarantine_audit a on a.run_id=r.id and a.state_after=r.state
 join shadow_agent.attempt_audit x on x.attempt_id=a.attempt_id and x.status='uncertain'
 where r.id=p_run and r.blocked and r.state->>'storageKind'='paged-v1' and r.state->>'phase'='deferred'
 and r.state->'activeBatch'='null'::jsonb and a.billing_status='unknown_held'
 and cfg.config->>'model'='google/gemma-4-26b-a4b-it' and cfg.config->>'expectedProvider'='PrimeIntellect'
 and cfg.config->'maxCostCredits'='0.036045'::jsonb and cfg.config->'requestProfile'->>'version'='2026-11-17.8'
 and (x.audit='{"errorCode":"timeout"}'::jsonb or (x.audit-'errorCode'-'diagnostic')='{}'::jsonb
  and x.audit @> '{"errorCode":"http_failure","diagnostic":{"httpStatus":429,"limitSource":"upstream_provider_shared_pool","errorProvider":"PrimeIntellect","providerErrorCode":"rate_limited"}}'::jsonb
  and ((x.audit->'diagnostic')-'httpStatus'-'limitSource'-'errorProvider'-'providerErrorCode'-'retryAfterSeconds'-'cloudflareRay'-'requestId'-'providerErrorType')='{}'::jsonb
  and (not(x.audit->'diagnostic' ? 'providerErrorType') or x.audit->'diagnostic'->>'providerErrorType' in ('rate_limit_error','rate_limit_exceeded'))));
end $$;
revoke all on function shadow_agent.quarantined_gemma_prefix_eligible(uuid) from public,anon,authenticated,service_role;
create function shadow_agent.verification_queue_has_capacity() returns boolean
language sql stable security definer set search_path='' as $$
 select count(*)<5 from (
  select story_key from public.warpcore_curator_inbox where state in ('pending','leased')
  union select story_key from public.warpcore_publications where state in ('prepared','sending','uncertain','manual_review')
 ) live
$$;
revoke all on function shadow_agent.verification_queue_has_capacity() from public,anon,authenticated,service_role;
create function shadow_agent.next_verification_candidate()
returns table(ranking_run_id uuid,story_key text,ordinal bigint)
language sql stable security definer set search_path='' as $$
 select k.run_id,c.candidate_id,c.ordinal
 from shadow_agent.ranking_runs k
 join shadow_agent.runs r on r.id=k.run_id and r.state->>'phase' in ('review','complete','deferred')
 join shadow_agent.candidates c on c.run_id=k.run_id
 join shadow_agent.decisions d on d.run_id=c.run_id and d.ordinal=c.ordinal
 cross join shadow_agent.verification_settings cfg
 where cfg.singleton and cfg.enabled and shadow_agent.verification_queue_has_capacity()
 and ((r.state->>'phase'='complete' and k.finalized_at is not null)
  or (r.state->>'phase'='review' and k.finalized_at is null and r.state->'activeBatch'='null'::jsonb
   and (r.lease_until is null or r.lease_until<=clock_timestamp())
   and k.assessed_count=(r.state->>'reviewedCount')::bigint and c.ordinal<(r.state->>'reviewedCount')::bigint
   and not exists(select 1 from shadow_agent.verification_jobs prior join shadow_agent.runs child on child.id=prior.child_run_id
    where prior.ranking_run_id=r.id and child.state->'parentReviewedCount'=r.state->'reviewedCount'))
  or (r.state->>'phase'='deferred' and shadow_agent.quarantined_gemma_prefix_eligible(r.id)
   and k.finalized_at is null and k.assessed_count=(r.state->>'reviewedCount')::bigint and c.ordinal<(r.state->>'reviewedCount')::bigint))
 and (cfg.ranking_finalized_since is null or coalesce(k.finalized_at,(r.state->>'scanStartedAt')::timestamptz)>=cfg.ranking_finalized_since)
 and not exists(select 1 from shadow_agent.verification_jobs v where v.ranking_run_id=c.run_id and v.story_key=c.candidate_id)
 and not exists(select 1 from shadow_agent.verification_jobs held where held.story_key=c.candidate_id and held.status='uncertain')
 and d.decision->>'action'='verify'
 and exists(select 1 from public.warpcore_stories s where s.story_key=c.candidate_id and s.status='unverified_review_required')
 and not exists(select 1 from public.warpcore_curator_inbox i where i.story_key=c.candidate_id)
 and not exists(select 1 from public.warpcore_publications p where p.story_key=c.candidate_id)
 order by coalesce(k.finalized_at,(r.state->>'scanStartedAt')::timestamptz),k.run_id,
 (d.decision->>'importance')::integer desc,(d.decision->>'relevance')::integer desc,c.candidate_id
 limit 1
$$;
revoke all on function shadow_agent.next_verification_candidate() from public,anon,authenticated,service_role;
create function public.warpcore_verification_claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg shadow_agent.verification_settings;j shadow_agent.verification_jobs;c record;parent shadow_agent.runs;child uuid;token uuid;
begin
 perform shadow_agent.verification_lock();
 select * into cfg from shadow_agent.verification_settings where singleton;
 if not found or not cfg.enabled then return null;end if;
 if cfg.job_limit_credits is null then raise exception 'Invalid verification configuration';end if;
 if to_regprocedure('shadow_agent.advance_verification_rate_limits()') is not null then
  perform shadow_agent.advance_verification_rate_limits();end if;
 -- A lost response after reservation is never an authorization to dispatch again.
 update shadow_agent.verification_jobs existing_job set status='uncertain' from shadow_agent.runs r
 where existing_job.child_run_id=r.id and existing_job.status='pending' and not existing_job.quarantined and r.lease_until<=clock_timestamp()
 and exists(select 1 from shadow_agent.attempts a where a.run_id=r.id);
 -- Freeze one publication history at a time. A second paid verification must
 -- wait until the earlier handoff reaches a terminal publication/inbox state;
 -- otherwise each receipt can invalidate the other's pending-history snapshot.
 -- Match finish/handoff's verification -> shared-admission lock order. Try-lock
 -- avoids waiting while an editorial transaction owns story/account row locks.
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('warpcore_shared_admission_v1',0)) then return null;end if;
 if exists(select 1 from public.warpcore_curator_inbox where state in ('pending','leased'))
 or exists(select 1 from public.warpcore_publications where state in ('prepared','sending','uncertain','manual_review')) then return null;end if;
 -- Recover a completed verification's unsent receipt without paid replay.
 select * into j from shadow_agent.verification_jobs v where cfg.submit_enabled and shadow_agent.verification_queue_has_capacity() and v.status='verified' and not v.quarantined and v.handoff_status='pending'
 and not exists(select 1 from public.warpcore_curator_inbox inbox where inbox.verification_receipt_id=v.receipt_id) order by v.id limit 1;
 if found then
  token:=shadow_agent.claim(j.child_run_id,180);if token is null then return null;end if;
  return jsonb_build_object('jobId',j.id,'rankingRunId',j.ranking_run_id,'storyKey',j.story_key,'lease',token,'handoffReceiptId',j.receipt_id);
 end if;
 if not shadow_agent.verification_queue_has_capacity() then return null;end if;
 if to_regprocedure('shadow_agent.advance_unpaid_verification_retry()') is not null then perform shadow_agent.advance_unpaid_verification_retry();end if;
 select * into j from shadow_agent.verification_jobs where status='pending' and not quarantined order by id limit 1;
 if not found then
  select next.ranking_run_id as run_id,next.story_key as candidate_id into c from shadow_agent.next_verification_candidate() next;
  if not found then return null;end if;
  select * into parent from shadow_agent.runs where id=c.run_id for share nowait;
  if not found or not exists(select 1 from shadow_agent.next_verification_candidate() fresh where fresh.ranking_run_id=c.run_id and fresh.story_key=c.candidate_id) then return null;end if;
  child:=gen_random_uuid();
  insert into shadow_agent.runs(id,state,limit_credits) values(child,jsonb_build_object('storageKind','verification-v1','runId',child,'phase','reviewing','revision',0,'activeBatch',jsonb_build_array(c.candidate_id),'publishingEnabled',false,'parentReviewedCount',parent.state->'reviewedCount'),cfg.job_limit_credits);
  insert into shadow_agent.verification_jobs(ranking_run_id,story_key,child_run_id) values(c.run_id,c.candidate_id,child) returning * into j;
 end if;
 if exists(select 1 from shadow_agent.attempts where run_id=j.child_run_id) then return null;end if;
 token:=shadow_agent.claim(j.child_run_id,180);if token is null then return null;end if;
 return jsonb_build_object('jobId',j.id,'rankingRunId',j.ranking_run_id,'storyKey',j.story_key,'lease',token);
end $$;
create function public.warpcore_verification_reserve(p_job uuid,p_lease uuid,p_hash text,p_max numeric,p_metadata jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare j shadow_agent.verification_jobs;attempt uuid;
begin
 perform shadow_agent.verification_lock();
 if not coalesce((select enabled from shadow_agent.verification_settings where singleton),false) then raise exception 'Verification disabled';end if;
 if p_metadata is null or jsonb_typeof(p_metadata) is distinct from 'object' or (p_metadata-'model'-'profileVersion'-'expectedProvider')<>'{}'::jsonb
 or not coalesce(p_metadata->>'profileVersion' in ('2026-11-16.verify.1','2026-11-17.verify.2','2026-11-17.verify.3','2026-11-17.verify.4','2026-11-17.verify.5','2026-11-17.verify.6','2026-11-17.verify.7') or (p_metadata->>'profileVersion'='2026-11-17.verify.8' and p_metadata->>'model' in ('openai/gpt-oss-120b','google/gemma-4-26b-a4b-it')),false)
 or not coalesce(p_metadata->>'model' in ('openai/gpt-oss-120b','google/gemma-4-26b-a4b-it'),false) -- Retired models remain accounting history, never new reservations.
 or not coalesce((p_metadata->>'model'='openai/gpt-oss-120b' and p_metadata->>'expectedProvider'='Groq' and p_max=0.058983)
 or (p_metadata->>'model'='openai/gpt-oss-120b' and p_metadata->>'expectedProvider'='Cerebras' and p_max=0.076596)
 or (p_metadata->>'model'='google/gemma-4-26b-a4b-it' and p_metadata->>'expectedProvider'='PrimeIntellect' and p_metadata->>'profileVersion'='2026-11-17.verify.8' and p_max=0.036045)
 or (p_metadata->>'model'='nvidia/nemotron-3.5-super-vl' and p_metadata->>'expectedProvider' in ('DeepInfra','Together') and p_max=0.157287)
 or (p_metadata->>'model'='meta-llama/llama-4-maverick' and p_metadata->>'expectedProvider'='Parasail' and p_metadata->>'profileVersion'='2026-11-17.verify.7' and p_max=0.216269)
 or (p_metadata->>'model'='nvidia/nemotron-3-super-120b-a12b' and p_metadata->>'expectedProvider'='DeepInfra' and p_max=0.026215),false) then raise exception 'Invalid verification metadata';end if;
 select * into j from shadow_agent.verification_jobs where id=p_job;
 if not found or j.status<>'pending' then raise exception 'Verification job unavailable';end if;
 if j.metadata is not null and j.metadata is distinct from p_metadata then raise exception 'Immutable verification metadata';end if;
 attempt:=shadow_agent.reserve(j.child_run_id,p_lease,p_hash,p_max);
 update shadow_agent.verification_jobs set metadata=p_metadata where id=p_job;
 return attempt;
end $$;
create function public.warpcore_verification_dispatch(p_job uuid,p_lease uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare j shadow_agent.verification_jobs;a uuid;
begin
 perform shadow_agent.verification_lock();
 if not coalesce((select enabled from shadow_agent.verification_settings where singleton),false) then return false;end if;
 select * into j from shadow_agent.verification_jobs where id=p_job;
 if not found or j.status<>'pending' then return false;end if;
 select id into a from shadow_agent.attempts where run_id=j.child_run_id;
 if a is null then return false;end if;return shadow_agent.dispatch(a,p_lease);
end $$;
create function public.warpcore_verification_settle(p_job uuid,p_lease uuid,p_status text,p_cost numeric,p_audit jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare j shadow_agent.verification_jobs;a uuid;u jsonb;k text;prior jsonb;d jsonb;result jsonb;editorial jsonb;item jsonb;
begin
 perform shadow_agent.verification_lock();select * into j from shadow_agent.verification_jobs where id=p_job;
 if not found then return false;end if;
 select id into a from shadow_agent.attempts where run_id=j.child_run_id;if a is null then return false;end if;
 if j.metadata is null or p_audit is null or jsonb_typeof(p_audit)<>'object' or octet_length(p_audit::text)>(case when p_audit ? 'result' then 70000 else 4000 end) then raise exception 'Invalid verification audit';end if;
 -- Archival wire result only, never approval authorization. Semantically bad
 -- dates/hashes/coverage remain visible; receipt validation independently gates approval.
 if p_audit ? 'result' then
  if p_status is distinct from 'settled' or p_audit ? 'errorCode' or p_audit ? 'validationError' then raise exception 'Invalid verification audit';end if;
  result:=p_audit->'result';
  if jsonb_typeof(result) is distinct from 'object' or octet_length(result::text)>65536 then raise exception 'Invalid verification result';end if;
  if result->>'action'='defer' then
   if (result-'action'-'reason')<>'{}'::jsonb or jsonb_typeof(result->'reason') is distinct from 'string' or length(result->>'reason')>1000 then raise exception 'Invalid verification result';end if;
  elsif result->>'action'='approve' then
   if (result-'action'-'editorial'-'claims'-'supports'-'publicationDate'-'scopeReason'-'changeReason'-'dedupReason')<>'{}'::jsonb or (result ? 'claims')=(result ? 'supports') then raise exception 'Invalid verification result';end if;
   foreach k in array array['publicationDate','scopeReason','changeReason','dedupReason'] loop
    if jsonb_typeof(result->k) is distinct from 'string' or length(result->>k)>(case when k='publicationDate' then 64 else 1000 end) then raise exception 'Invalid verification result';end if;
   end loop;
   editorial:=result->'editorial';
   if jsonb_typeof(editorial) is distinct from 'object' or jsonb_typeof(editorial->'political') is distinct from 'boolean' then raise exception 'Invalid verification result';end if;
   if editorial ? 'mode' then
    if editorial->>'mode' is distinct from 'repost' or (editorial-'mode'-'political'-'change'-'evidenceIds')<>'{}'::jsonb then raise exception 'Invalid verification result';end if;
   else
    if (editorial-'political'-'summary'-'whyItMatters'-'change'-'evidenceIds')<>'{}'::jsonb then raise exception 'Invalid verification result';end if;
    foreach k in array array['summary','whyItMatters'] loop
     if jsonb_typeof(editorial->k) is distinct from 'string' or length(editorial->>k)>3000 then raise exception 'Invalid verification result';end if;
    end loop;
   end if;
   if jsonb_typeof(editorial->'change') is distinct from 'string' or length(editorial->>'change')>3000
   or jsonb_typeof(editorial->'evidenceIds') is distinct from 'array' then raise exception 'Invalid verification result';end if;
   if jsonb_array_length(editorial->'evidenceIds')>20 then raise exception 'Invalid verification result';end if;
   for item in select value from jsonb_array_elements(editorial->'evidenceIds') loop
    if jsonb_typeof(item) is distinct from 'string' or length(item#>>'{}')>2048 then raise exception 'Invalid verification result';end if;
   end loop;
   if result ? 'claims' then
    if jsonb_typeof(result->'claims') is distinct from 'array' then raise exception 'Invalid verification result';end if;
    if jsonb_array_length(result->'claims')>20 then raise exception 'Invalid verification result';end if;
    for item in select value from jsonb_array_elements(result->'claims') loop
     if jsonb_typeof(item) is distinct from 'object' or (item-'claim'-'evidenceId'-'url'-'contentSha256'-'quote')<>'{}'::jsonb then raise exception 'Invalid verification result';end if;
     foreach k in array array['claim','evidenceId','url','contentSha256','quote'] loop
      if jsonb_typeof(item->k) is distinct from 'string' or length(item->>k)>(case when k in ('claim','quote') then 3000 when k='contentSha256' then 64 else 2048 end) then raise exception 'Invalid verification result';end if;
     end loop;
    end loop;
   else
    if jsonb_typeof(result->'supports') is distinct from 'object'
    or ((result->'supports')-'summary'-'whyItMatters'-'change'-'publicationDate')<>'{}'::jsonb then raise exception 'Invalid verification result';end if;
    if editorial->>'mode'='repost' then
     if (result->'supports') ? 'summary' or (result->'supports') ? 'whyItMatters' then raise exception 'Invalid verification result';end if;
    else
     if not ((result->'supports') ? 'summary' and (result->'supports') ? 'whyItMatters') then raise exception 'Invalid verification result';end if;
    end if;
    if not ((result->'supports') ? 'change' and (result->'supports') ? 'publicationDate') then raise exception 'Invalid verification result';end if;
    if (select count(distinct jsonb_typeof(value)) from jsonb_each(result->'supports'))<>1 then raise exception 'Invalid verification result';end if;
    for item in select value from jsonb_each(result->'supports') loop
     if jsonb_typeof(item)='string' then
      if length(item#>>'{}')>128 or item#>>'{}' !~ '^source-[1-9][0-9]*-(chunk-[0-9]{4}|original-text|created-at)$'
      or item#>>'{}' ~ U&'[\0001-\001F\007F-\009F]' then raise exception 'Invalid verification result';end if;
     elsif jsonb_typeof(item)='object' then
      if (item-'evidenceId'-'quote')<>'{}'::jsonb
      or jsonb_typeof(item->'evidenceId') is distinct from 'string' or length(item->>'evidenceId')>2048
      or jsonb_typeof(item->'quote') is distinct from 'string' or length(item->>'quote')>3000 then raise exception 'Invalid verification result';end if;
     else raise exception 'Invalid verification result';end if;
    end loop;
   end if;
  else raise exception 'Invalid verification result';end if;
 end if;
 if p_audit ? 'diagnostic' then
  d:=p_audit->'diagnostic';
  if jsonb_typeof(d) is distinct from 'object' or d='{}'::jsonb or octet_length(d::text)>3000
  or (d-'generationId'-'model'-'provider'-'httpStatus'-'validationIssue'-'decisionIndex'-'providerErrorCode'-'providerErrorType'-'errorProvider'-'limitSource'-'retryAfterSeconds'-'requestId'-'cloudflareRay')<>'{}'::jsonb then raise exception 'Invalid verification diagnostic';end if;
  if d ? 'providerErrorCode' and not coalesce((jsonb_typeof(d->'providerErrorCode')='number' and d->>'providerErrorCode' in ('400','401','402','403','404','408','409','413','422','429','500','502','503','504','529')) or (jsonb_typeof(d->'providerErrorCode')='string' and d->>'providerErrorCode' in ('rate_limit_exceeded','insufficient_quota','invalid_request_error','authentication_error','permission_error','not_found_error','overloaded_error','api_error','context_length_exceeded','unsupported_parameter','rate_limited','rate_limit_error','quota_exceeded','too_many_requests','RESOURCE_EXHAUSTED','engine_overloaded')),false) then raise exception 'Invalid verification diagnostic';end if;
  if d ? 'providerErrorType' and (jsonb_typeof(d->'providerErrorType') is distinct from 'string' or not coalesce(d->>'providerErrorType' in ('invalid_request_error','authentication_error','permission_error','not_found_error','rate_limit_error','overloaded_error','api_error','server_error','insufficient_quota','context_length_exceeded','rate_limit_exceeded','provider_overloaded','provider_unavailable','timeout','server','authentication','permission_denied','payment_required','invalid_request','content_policy_violation','refusal','unmapped'),false)) then raise exception 'Invalid verification diagnostic';end if;
  if d ? 'errorProvider' and (jsonb_typeof(d->'errorProvider') is distinct from 'string' or not coalesce(d->>'errorProvider' in ('DeepInfra','Together','Cerebras','Parasail','Groq','Anthropic','OpenAI','PrimeIntellect','Google AI Studio'),false)) then raise exception 'Invalid verification diagnostic';end if;
  if d ? 'limitSource' and (jsonb_typeof(d->'limitSource') is distinct from 'string' or not coalesce(d->>'limitSource' in ('upstream_provider_shared_pool','openrouter_in_flight_budget','openrouter_key_limit','openrouter_credits','openrouter_guardrail_budget','openrouter_workspace_budget'),false)) then raise exception 'Invalid verification diagnostic';end if;
  if d ? 'retryAfterSeconds' and (jsonb_typeof(d->'retryAfterSeconds') is distinct from 'number' or coalesce(d->>'retryAfterSeconds','') !~ '^[0-9]{1,5}$' or (d->>'retryAfterSeconds')::numeric not between 0 and 86400) then raise exception 'Invalid verification diagnostic';end if;
  if d ? 'requestId' and (jsonb_typeof(d->'requestId') is distinct from 'string' or length(d->>'requestId')>128 or d->>'requestId' !~ '^(req[-_]|gen-)[A-Za-z0-9_-]{1,124}$' or d->>'requestId' ~ U&'[\0001-\001F\007F-\009F]') then raise exception 'Invalid verification diagnostic';end if;
  if d ? 'cloudflareRay' and (jsonb_typeof(d->'cloudflareRay') is distinct from 'string' or d->>'cloudflareRay' !~ '^[a-f0-9]{16}-[A-Z]{3}$' or d->>'cloudflareRay' ~ U&'[\0001-\001F\007F-\009F]') then raise exception 'Invalid verification diagnostic';end if;

  foreach k in array array['generationId','model','provider'] loop
   if d ? k and (jsonb_typeof(d->k) is distinct from 'string' or length(d->>k) not between 1 and case when k='generationId' then 256 else 128 end
   or d->>k<>btrim(d->>k) or d->>k ~ U&'[\0001-\001F\007F-\009F]') then raise exception 'Invalid verification diagnostic';end if;
  end loop;
  if d ? 'httpStatus' and (jsonb_typeof(d->'httpStatus') is distinct from 'number' or d->>'httpStatus' !~ '^[0-9]{3}$' or (d->>'httpStatus')::integer not between 100 and 599) then raise exception 'Invalid verification diagnostic';end if;
  if d ? 'decisionIndex' and (jsonb_typeof(d->'decisionIndex') is distinct from 'number' or d->>'decisionIndex' !~ '^[0-9]{1,2}$' or (d->>'decisionIndex')::integer not between 0 and 99) then raise exception 'Invalid verification diagnostic';end if;
  if d ? 'validationIssue' and not coalesce(d->>'validationIssue' in ('invalid_shape','unexpected_fields','unknown_id','duplicate_id','invalid_action','invalid_reason','invalid_scores'),false) then raise exception 'Invalid verification diagnostic';end if;
 end if;
 if p_status='uncertain' then
  if p_cost is not null or (p_audit-'diagnostic') is distinct from jsonb_build_object('errorCode',p_audit->>'errorCode')
  or not coalesce(p_audit->>'errorCode' in ('timeout','http_failure','transport_failure','invalid_json','missing_or_invalid_usage','response_too_large','reservation_exceeded','invalid_completion','invalid_verification_json','invalid_verification_schema','unknown_failure'),false) then raise exception 'Invalid verification audit';end if;
 elsif p_status='settled' then
  if p_audit ? 'errorCode' then
   if (p_audit-'usage'-'errorCode'-'diagnostic')<>'{}'::jsonb or not coalesce(p_audit->>'errorCode' in ('reservation_exceeded','invalid_completion','invalid_verification_json','invalid_verification_schema'),false) then raise exception 'Invalid verification audit';end if;
  else
   if (p_audit-'model'-'provider'-'generationId'-'usage'-'validationError'-'diagnostic'-'result')<>'{}'::jsonb
   or jsonb_typeof(p_audit->'model') is distinct from 'string' or length(btrim(p_audit->>'model')) not between 1 and 128 or p_audit->>'model' ~ '[[:cntrl:]]'
   or jsonb_typeof(p_audit->'provider') is distinct from 'string' or length(btrim(p_audit->>'provider')) not between 1 and 128 or p_audit->>'provider' ~ '[[:cntrl:]]'
   or jsonb_typeof(p_audit->'generationId') is distinct from 'string' or length(btrim(p_audit->>'generationId')) not between 1 and 256
   or p_audit->>'generationId' ~ '[[:cntrl:]]' then raise exception 'Invalid verification audit';end if;
   if p_audit ? 'diagnostic' and not(p_audit ? 'validationError') then raise exception 'Invalid verification audit';end if;
  end if;
  if p_audit ? 'validationError' and (jsonb_typeof(p_audit->'validationError') is distinct from 'string' or not coalesce(p_audit->>'validationError' in ('reservation_exceeded','invalid_completion','invalid_verification_json','invalid_verification_schema'),false)) then raise exception 'Invalid verification audit';end if;
  u:=p_audit->'usage';if jsonb_typeof(u) is distinct from 'object' or (u-'promptTokens'-'completionTokens'-'totalTokens'-'costCredits')<>'{}'::jsonb then raise exception 'Invalid verification audit';end if;
  foreach k in array array['promptTokens','completionTokens','totalTokens'] loop
   if jsonb_typeof(u->k) is distinct from 'number' or u->>k !~ '^[0-9]+$' or (u->>k)::numeric>9007199254740991 then raise exception 'Invalid verification audit';end if;
  end loop;
  if (u->>'promptTokens')::numeric+(u->>'completionTokens')::numeric<>(u->>'totalTokens')::numeric
  or jsonb_typeof(u->'costCredits') is distinct from 'number' or (u->>'costCredits')::numeric is distinct from p_cost then raise exception 'Invalid verification audit';end if;
 else raise exception 'Invalid verification audit';end if;
 select audit into prior from shadow_agent.verification_audit where job_id=p_job and status=p_status;
 if found and prior is distinct from p_audit then raise exception 'Immutable verification audit';end if;
 if not shadow_agent.settle(a,p_lease,p_status,p_cost) then return false;end if;
 insert into shadow_agent.verification_audit(job_id,status,audit) values(p_job,p_status,p_audit) on conflict do nothing;
 if p_status='uncertain' then update shadow_agent.verification_jobs set status='uncertain' where id=p_job;end if;
 return true;
end $$;
create function public.warpcore_verification_finish(p_job uuid,p_lease uuid,p_status text,p_receipt uuid default null) returns boolean
language plpgsql security definer set search_path='' as $$
declare j shadow_agent.verification_jobs;r shadow_agent.runs;a shadow_agent.attempts;m jsonb;paid_audit jsonb;
begin
 perform shadow_agent.verification_lock();select * into j from shadow_agent.verification_jobs where id=p_job;
 if not found then return false;end if;
 select * into r from shadow_agent.runs where id=j.child_run_id for update;
 if p_lease is null or r.lease_token is distinct from p_lease or r.lease_until<=clock_timestamp() then return false;end if;
 if p_status is null or p_status not in ('verified','deferred') then raise exception 'Invalid verification finish';end if;
 if j.status=p_status and j.receipt_id is not distinct from p_receipt then return true;end if;
 if j.status<>'pending' then return false;end if;
 select * into a from shadow_agent.attempts where run_id=j.child_run_id;
 if found and (a.status<>'settled' or not exists(select 1 from shadow_agent.verification_audit where job_id=p_job and status='settled')) then raise exception 'Settled verification attempt required';end if;
 if p_status='verified' then
  if a.id is null then raise exception 'Settled verification attempt required';end if;
  select audit into paid_audit from shadow_agent.verification_audit where job_id=p_job and status='settled';
  if paid_audit->'model' is distinct from j.metadata->'model' or paid_audit->'provider' is distinct from j.metadata->'expectedProvider' or paid_audit ? 'validationError' or paid_audit ? 'errorCode' or r.blocked
  or coalesce((select blocked from shadow_agent.budgets where day=a.day),true) then raise exception 'Verification paid validation blocked';end if;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('warpcore_shared_admission_v1',0)) then raise exception using errcode='55P03',message='Shared admission busy';end if;
  select material into m from agent_verification.receipts where id=p_receipt;
  if not found or m->>'storyKey' is distinct from j.story_key or m->>'runId' is distinct from j.ranking_run_id::text
  or m->>'requestSha256' is distinct from a.request_hash or m->'model' is distinct from j.metadata->'model'
  or m->'requestProfileVersion' is distinct from j.metadata->'profileVersion' or not agent_verification.receipt_current(p_receipt)
  then raise exception 'Invalid verification receipt binding';end if;
 elsif p_receipt is not null then raise exception 'Deferred verification cannot bind receipt';end if;
 update shadow_agent.verification_jobs set status=p_status,receipt_id=p_receipt where id=p_job;
 update shadow_agent.runs set state=jsonb_set(jsonb_set(jsonb_set(state,'{revision}',to_jsonb(r.revision+1)),'{phase}',to_jsonb(case when p_status='verified' then 'complete'::text else 'deferred'::text end)),'{activeBatch}','null'::jsonb),revision=revision+1
 where id=r.id and lease_token=p_lease and lease_until>clock_timestamp();
 if not found then raise exception 'Verification lease expired during finish';end if;
 return true;
end $$;
create function public.warpcore_verification_handoff(p_job uuid,p_lease uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare j shadow_agent.verification_jobs;r shadow_agent.runs;m jsonb;a shadow_agent.attempts;inbox_id uuid;
begin
 if not coalesce((select enabled and submit_enabled from shadow_agent.verification_settings where singleton),false) then return null;end if;
 perform shadow_agent.verification_lock();select * into j from shadow_agent.verification_jobs where id=p_job;
 if not found or j.status<>'verified' or j.receipt_id is null then return null;end if;
 select material into m from agent_verification.receipts where id=j.receipt_id;
 select * into a from shadow_agent.attempts where run_id=j.child_run_id and status='settled';
 if a.id is null or m->>'storyKey' is distinct from j.story_key or m->>'runId' is distinct from j.ranking_run_id::text
 or m->>'requestSha256' is distinct from a.request_hash or m->'model' is distinct from j.metadata->'model'
 or m->'requestProfileVersion' is distinct from j.metadata->'profileVersion' then raise exception 'Invalid verification handoff binding';end if;
 select id into inbox_id from public.warpcore_curator_inbox where verification_receipt_id=j.receipt_id
 and story_key=j.story_key and run_id=j.ranking_run_id and actor_kind='agent';
 if found then
  update shadow_agent.verification_jobs set handoff_status='submitted',handoff_inbox_id=inbox_id,handoff_reason=null where id=p_job;
  return inbox_id; -- Reconcile only already durable inbox identity; no resubmission.
 end if;
 select * into r from shadow_agent.runs where id=j.child_run_id for update;
 if j.handoff_status<>'pending' or p_lease is null or r.lease_token is distinct from p_lease or r.lease_until<=clock_timestamp() then return null;end if;
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('warpcore_shared_admission_v1',0)) then raise exception using errcode='55P03',message='Shared admission busy';end if;
 if not agent_verification.receipt_current(j.receipt_id) then
  update shadow_agent.verification_jobs set handoff_status='deferred',handoff_reason='stale_receipt' where id=p_job;
  return null; -- Preserve verified audit outcome, never replay paid work.
 end if;
 inbox_id:=public.warpcore_agent_submit(j.receipt_id);
 if not exists(select 1 from shadow_agent.runs where id=r.id and lease_token=p_lease and lease_until>clock_timestamp()) then raise exception 'Verification handoff lease lost';end if;
 update shadow_agent.verification_jobs set handoff_status='submitted',handoff_inbox_id=inbox_id where id=p_job;
 return inbox_id;
end $$;
revoke all on function public.warpcore_verification_handoff(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_verification_handoff(uuid,uuid) to service_role;
revoke all on function shadow_agent.verification_lock() from public,anon,authenticated,service_role;
revoke all on function public.warpcore_verification_claim(),public.warpcore_verification_reserve(uuid,uuid,text,numeric,jsonb),public.warpcore_verification_dispatch(uuid,uuid),public.warpcore_verification_settle(uuid,uuid,text,numeric,jsonb),public.warpcore_verification_finish(uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_verification_claim(),public.warpcore_verification_reserve(uuid,uuid,text,numeric,jsonb),public.warpcore_verification_dispatch(uuid,uuid),public.warpcore_verification_settle(uuid,uuid,text,numeric,jsonb),public.warpcore_verification_finish(uuid,uuid,text,uuid) to service_role;
commit;
