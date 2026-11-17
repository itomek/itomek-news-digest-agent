-- Install after ranking and agent-verification. No budgets, activation or public writes.
begin;
do $$begin
 if to_regclass('shadow_agent.ranking_runs') is null or to_regclass('shadow_agent.selection_items') is null
 or to_regprocedure('agent_verification.receipt_current(uuid)') is null then raise exception 'Verification ranking/receipt contracts required';end if;
end $$;
create table shadow_agent.verification_settings(
 singleton boolean primary key default true check(singleton),enabled boolean not null default false,
 submit_enabled boolean not null default false,
 job_limit_credits numeric check(job_limit_credits>0 and job_limit_credits<=1)
);
insert into shadow_agent.verification_settings(singleton) values(true);
create table shadow_agent.verification_jobs(
 id uuid primary key default gen_random_uuid(),ranking_run_id uuid not null references shadow_agent.runs(id),
 story_key text not null check(story_key ~ '^[a-f0-9]{64}$'),child_run_id uuid not null unique references shadow_agent.runs(id),
 status text not null default 'pending' check(status in ('pending','verified','deferred','uncertain')),
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
create function public.warpcore_verification_claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg shadow_agent.verification_settings;j shadow_agent.verification_jobs;c record;child uuid;token uuid;
begin
 perform shadow_agent.verification_lock();
 select * into cfg from shadow_agent.verification_settings where singleton;
 if not found or not cfg.enabled then return null;end if;
 if cfg.job_limit_credits is null then raise exception 'Invalid verification configuration';end if;
 -- Recover a completed verification's unsent receipt without paid replay.
 select * into j from shadow_agent.verification_jobs v where cfg.submit_enabled and v.status='verified' and v.handoff_status='pending'
 and not exists(select 1 from public.warpcore_curator_inbox inbox where inbox.verification_receipt_id=v.receipt_id) order by v.id limit 1;
 if found then
  token:=shadow_agent.claim(j.child_run_id,120);if token is null then return null;end if;
  return jsonb_build_object('jobId',j.id,'rankingRunId',j.ranking_run_id,'storyKey',j.story_key,'lease',token,'handoffReceiptId',j.receipt_id);
 end if;
 -- A lost response after reservation is never an authorization to dispatch again.
 update shadow_agent.verification_jobs existing_job set status='uncertain' from shadow_agent.runs r
 where existing_job.child_run_id=r.id and existing_job.status='pending' and r.lease_until<=clock_timestamp()
 and exists(select 1 from shadow_agent.attempts a where a.run_id=r.id);
 if exists(select 1 from shadow_agent.verification_jobs where status='uncertain') then return null;end if;
 select * into j from shadow_agent.verification_jobs where status='pending' order by id limit 1;
 if not found then
  select s.run_id,captured.candidate_id into c from shadow_agent.selection_items s
  join shadow_agent.ranking_runs k on k.run_id=s.run_id and k.finalized_at is not null
  join shadow_agent.runs r on r.id=s.run_id and r.state->>'phase'='complete'
  join shadow_agent.candidates captured on captured.run_id=s.run_id and captured.ordinal=s.ordinal
  where not exists(select 1 from shadow_agent.verification_jobs existing_job where existing_job.ranking_run_id=s.run_id and existing_job.story_key=captured.candidate_id)
  order by k.finalized_at,s.run_id,s.rank limit 1;
  if not found then return null;end if;
  child:=gen_random_uuid();
  insert into shadow_agent.runs(id,state,limit_credits) values(child,jsonb_build_object('storageKind','verification-v1','runId',child,'phase','reviewing','revision',0,'activeBatch',jsonb_build_array(c.candidate_id),'publishingEnabled',false),cfg.job_limit_credits);
  insert into shadow_agent.verification_jobs(ranking_run_id,story_key,child_run_id) values(c.run_id,c.candidate_id,child) returning * into j;
 end if;
 if exists(select 1 from shadow_agent.attempts where run_id=j.child_run_id) then return null;end if;
 token:=shadow_agent.claim(j.child_run_id,120);if token is null then return null;end if;
 return jsonb_build_object('jobId',j.id,'rankingRunId',j.ranking_run_id,'storyKey',j.story_key,'lease',token);
end $$;
create function public.warpcore_verification_reserve(p_job uuid,p_lease uuid,p_hash text,p_max numeric,p_metadata jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare j shadow_agent.verification_jobs;attempt uuid;
begin
 perform shadow_agent.verification_lock();
 if not coalesce((select enabled from shadow_agent.verification_settings where singleton),false) then raise exception 'Verification disabled';end if;
 if p_metadata is null or jsonb_typeof(p_metadata) is distinct from 'object' or (p_metadata-'model'-'profileVersion'-'expectedProvider')<>'{}'::jsonb
 or p_metadata->>'profileVersion' is distinct from '2026-11-16.verify.1'
 or not coalesce((p_metadata->>'model'='openai/gpt-oss-120b' and p_metadata->>'expectedProvider'='Groq' and p_max=0.058983)
 or (p_metadata->>'model'='nvidia/nemotron-3.5-super-vl' and p_metadata->>'expectedProvider'='DeepInfra' and p_max=0.157287)
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
declare j shadow_agent.verification_jobs;a uuid;u jsonb;k text;prior jsonb;d jsonb;
begin
 perform shadow_agent.verification_lock();select * into j from shadow_agent.verification_jobs where id=p_job;
 if not found then return false;end if;
 select id into a from shadow_agent.attempts where run_id=j.child_run_id;if a is null then return false;end if;
 if j.metadata is null or p_audit is null or jsonb_typeof(p_audit)<>'object' or octet_length(p_audit::text)>4000 then raise exception 'Invalid verification audit';end if;
 if p_audit ? 'diagnostic' then
  d:=p_audit->'diagnostic';
  if jsonb_typeof(d) is distinct from 'object' or d='{}'::jsonb or octet_length(d::text)>3000
  or (d-'generationId'-'model'-'provider'-'httpStatus'-'validationIssue'-'decisionIndex')<>'{}'::jsonb then raise exception 'Invalid verification diagnostic';end if;
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
   if (p_audit-'model'-'provider'-'generationId'-'usage'-'validationError'-'diagnostic')<>'{}'::jsonb
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
