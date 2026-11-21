-- Administrative policy only. Defaults off; no budgets, cleanup or activation.
begin;
create table shadow_agent.spending_policy(
 singleton boolean primary key default true check(singleton),enabled boolean not null default false,
 daily_limit_credits numeric default 2 check(daily_limit_credits>0 and daily_limit_credits<=2),
 lifetime_limit_credits numeric default 20 check(lifetime_limit_credits>0 and lifetime_limit_credits<=20),
 exclusive_agent boolean not null default false
);
insert into shadow_agent.spending_policy(singleton) values(true);
alter table shadow_agent.spending_policy enable row level security;
revoke all on shadow_agent.spending_policy from public,anon,authenticated,service_role;
-- The bootstrap registry owns production choices. The absent-table branch is
-- only for explicit legacy/disposable fixtures without runtime bootstrap.
create function shadow_agent.active_runtime_model() returns jsonb
language plpgsql security definer set search_path='' as $$
declare model_id text;approved jsonb;
begin
 if to_regclass('shadow_agent.runtime_settings') is null then
  return jsonb_build_object('model','openai/gpt-oss-120b','provider','Groq','discoveryProfileVersion','2026-11-16.4','maxCostCredits',0.058983,'maxOutputTokens',4096,'reviewBatchSize',16);
 end if;
 select model into model_id from shadow_agent.runtime_settings where singleton;
 approved:=shadow_agent.approved_runtime_model(model_id);
 if approved is null then raise exception 'Invalid active runtime model';end if;
 return approved;
end $$;
revoke all on function shadow_agent.active_runtime_model() from public,anon,authenticated,service_role;
create function shadow_agent.ensure_daily_budget() returns boolean
language plpgsql security definer set search_path='' as $$
declare policy shadow_agent.spending_policy;d date;remaining numeric;cap numeric;producer_enabled boolean;minimum_required numeric;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Budget provisioning requires READ COMMITTED';end if;
 select * into policy from shadow_agent.spending_policy where singleton for share nowait;
 if not found or not policy.enabled then return false;end if;
 select enabled into producer_enabled from shadow_agent.producer_settings where singleton for share nowait;
 if not coalesce(producer_enabled,false) then return false;end if;
 if to_regclass('shadow_agent.runtime_settings') is not null then perform 1 from shadow_agent.runtime_settings where singleton for share nowait;end if;
 minimum_required:=(shadow_agent.active_runtime_model()->>'maxCostCredits')::numeric;
 -- NULL policy limits explicitly mean no application spending cap.
 -- Never wait holding policy resources behind reserve/settle row locks. Access
 -- exclusive also fences their preceding SELECT FOR UPDATE, not just UPDATE.
 -- A busy tick does nothing; no ledger row or old budget is changed.
 lock table shadow_agent.budgets in access exclusive mode nowait;
 d:=(clock_timestamp() at time zone 'utc')::date;
 select policy.lifetime_limit_credits-coalesce(sum(spent_credits+held_credits),0) into remaining from shadow_agent.budgets;
 if exists(select 1 from shadow_agent.budgets where day=d) then return exists(select 1 from shadow_agent.budgets where day=d and not blocked and (limit_credits is null or limit_credits-spent_credits-held_credits>=minimum_required)) and (remaining is null or remaining>=minimum_required);end if;
 cap:=least(policy.daily_limit_credits,remaining);
 if cap is not null and cap<minimum_required then return false;end if;
 insert into shadow_agent.budgets(day,limit_credits) values(d,cap);
 return true;
exception when lock_not_available then return false;
end $$;
-- A separately reviewed inactive cron command may call this wrapper. Preserve
-- the existing helper's approved-origin and unique Vault-secret validation.
-- This installer does not alter cron commands, active flags or existing jobs.
create function shadow_agent.budgeted_enqueue() returns bigint
language plpgsql security definer set search_path='' as $$
begin
 if not shadow_agent.ensure_daily_budget() then return null;end if;
 return shadow_agent.enqueue_continuation();
end $$;
revoke all on function shadow_agent.budgeted_enqueue() from public,anon,authenticated,service_role;
-- Existing trusted owner/cron SECURITY DEFINER code may call this; no runtime
-- worker can provision/raise a budget or change the lifetime prepaid-credit cap.
revoke all on function shadow_agent.ensure_daily_budget() from public,anon,authenticated,service_role;
-- Serialize explicit cutover with the same admission transaction boundary as
-- all inbox/publication writers. Busy cutover refuses rather than racing them.
create function shadow_agent.serialize_producer_cutover() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.exclusive_agent is distinct from old.exclusive_agent and not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('warpcore_shared_admission_v1',0)) then
  raise exception using errcode='55P03',message='Producer cutover busy';
 end if;
 return new;
end $$;
revoke all on function shadow_agent.serialize_producer_cutover() from public,anon,authenticated,service_role;
create trigger warpcore_serialize_producer_cutover before update on shadow_agent.spending_policy
 for each row execute function shadow_agent.serialize_producer_cutover();
create function shadow_agent.fence_new_dot_submissions() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.actor_kind='dot' and coalesce((select exclusive_agent from shadow_agent.spending_policy where singleton),false) then
  raise exception 'Autonomous agent is exclusive producer; new Dot submissions disabled';
 end if;
 return new;
end $$;
revoke all on function shadow_agent.fence_new_dot_submissions() from public,anon,authenticated,service_role;
create trigger warpcore_exclusive_agent_insert before insert on public.warpcore_curator_inbox
 for each row execute function shadow_agent.fence_new_dot_submissions();
-- BEGIN RELIABILITY HEALTH PROGRESS
-- Existing rows retain unknown creation/progress clocks. Only observed INSERTs
-- and semantic transitions establish these timestamps; no backdated receipts.
create table if not exists shadow_agent.health_progress(
 entity text not null,entity_id text not null,created_at timestamptz,progressed_at timestamptz,
 primary key(entity,entity_id)
);
alter table shadow_agent.health_progress enable row level security;
revoke all on shadow_agent.health_progress from public,anon,authenticated,service_role;
create or replace function shadow_agent.track_health_progress() returns trigger
language plpgsql security definer set search_path='' as $$
declare current_row jsonb:=to_jsonb(new);previous_row jsonb;identity text;meaningful boolean:=false;
begin
 identity:=coalesce(current_row->>'id',current_row->>'story_key');
 if identity is null then return new;end if;
 if tg_op='INSERT' then meaningful:=true;
 else
  previous_row:=to_jsonb(old);
  if tg_table_name='runs' then
   meaningful:=((current_row->'state')-'revision') is distinct from ((previous_row->'state')-'revision');
  elsif tg_table_name='verification_jobs' then
   meaningful:=(current_row->'status',current_row->'handoff_status',current_row->'receipt_id') is distinct from (previous_row->'status',previous_row->'handoff_status',previous_row->'receipt_id');
  elsif tg_table_name='warpcore_curator_inbox' then
   meaningful:=(case when current_row->>'state' in ('pending','leased') then 'pending' else current_row->>'state' end,current_row->'packet',current_row->'job') is distinct from
    (case when previous_row->>'state' in ('pending','leased') then 'pending' else previous_row->>'state' end,previous_row->'packet',previous_row->'job');
  else
   meaningful:=(current_row->'state',current_row->'remote_uri') is distinct from (previous_row->'state',previous_row->'remote_uri');
  end if;
 end if;
 if meaningful then
  insert into shadow_agent.health_progress(entity,entity_id,created_at,progressed_at)
  values(tg_table_name,identity,case when tg_op='INSERT' then clock_timestamp() end,clock_timestamp())
  on conflict(entity,entity_id) do update set progressed_at=excluded.progressed_at;
 end if;
 return new;
end $$;
revoke all on function shadow_agent.track_health_progress() from public,anon,authenticated,service_role;
drop trigger if exists warpcore_health_progress on shadow_agent.runs;
create trigger warpcore_health_progress after insert or update on shadow_agent.runs for each row execute function shadow_agent.track_health_progress();
drop trigger if exists warpcore_health_progress on shadow_agent.verification_jobs;
create trigger warpcore_health_progress after insert or update on shadow_agent.verification_jobs for each row execute function shadow_agent.track_health_progress();
drop trigger if exists warpcore_health_progress on public.warpcore_curator_inbox;
create trigger warpcore_health_progress after insert or update on public.warpcore_curator_inbox for each row execute function shadow_agent.track_health_progress();
drop trigger if exists warpcore_health_progress on public.warpcore_publications;
create trigger warpcore_health_progress after insert or update on public.warpcore_publications for each row execute function shadow_agent.track_health_progress();
-- END RELIABILITY HEALTH PROGRESS
create function public.warpcore_agent_health() returns jsonb
language plpgsql security definer set search_path='' as $$
declare verifier_enabled boolean:=false;submit_enabled boolean:=false;downstream_busy boolean;eligible_rows jsonb:='[]'::jsonb;active_discovery uuid[];stages jsonb;operational jsonb;stage_stalled bigint;stage_pending bigint; policy shadow_agent.spending_policy;latest jsonb;phases jsonb;coverage jsonb;costs jsonb;daily jsonb;queue jsonb;sources jsonb;pubs jsonb;attention jsonb:='[]'::jsonb;verifier_uncertain bigint;attempt_uncertain bigint;handoff_pending bigint;handoff_deferred bigint;active_model jsonb;minimum_required numeric;
begin
 select * into policy from shadow_agent.spending_policy where singleton;
 active_model:=shadow_agent.active_runtime_model();minimum_required:=(active_model->>'maxCostCredits')::numeric;
 select jsonb_build_object('phase',case when state->>'phase' in ('scan','review','reviewing','uncertain','complete','deferred') then state->>'phase' else 'unknown' end,
 'scanStartedAt',(state->>'scanStartedAt')::timestamptz,
 'candidateCount',case when jsonb_typeof(state->'candidateCount')='number' and state->>'candidateCount' ~ '^[0-9]{1,16}$' then state->'candidateCount' else null end,
 'reviewedCount',case when jsonb_typeof(state->'reviewedCount')='number' and state->>'reviewedCount' ~ '^[0-9]{1,16}$' then state->'reviewedCount' else null end) into latest
 from shadow_agent.runs where state->>'storageKind'='paged-v1' order by (state->>'scanStartedAt')::timestamptz desc nulls last,id limit 1;
 select coalesce(jsonb_object_agg(phase,n),'{}'::jsonb) into phases from (select case when state->>'phase' in ('scan','review','reviewing','uncertain','complete','deferred') then state->>'phase' else 'unknown' end phase,count(*) n from shadow_agent.runs group by 1)x;
 select jsonb_build_object('finalizedRunCount',count(*) filter(where finalized_at is not null),'assessedCandidates',coalesce(sum(assessed_count),0),'selectedProposals',coalesce(sum(selected_count),0),'latestFinalizedAt',max(finalized_at)) into coverage from shadow_agent.ranking_runs;
 select jsonb_build_object('spentCredits',coalesce(sum(spent_credits),0),'heldCredits',coalesce(sum(held_credits),0),'blockedBudgetCount',count(*) filter(where blocked)) into costs from shadow_agent.budgets;
 select jsonb_build_object('day',day,'limitCredits',limit_credits,'spentCredits',spent_credits,'heldCredits',held_credits,'blocked',blocked) into daily from shadow_agent.budgets where day=(clock_timestamp() at time zone 'utc')::date;
 select jsonb_build_object('distinctStories',count(distinct story_key),'oldestWorkAt',min(stamp)) into queue from (
  select story_key,created_at stamp from public.warpcore_curator_inbox where state in ('pending','leased')
  union all select story_key,prepared_at from public.warpcore_publications where state in ('prepared','sending','uncertain','manual_review')
 )pending;
 select jsonb_build_object('publishedCount',count(*) filter(where state='published'),'uncertainCount',count(*) filter(where state='uncertain'),
 'sendingCount',count(*) filter(where state='sending'),'manualReviewCount',count(*) filter(where state='manual_review'),
 'latestPreparedAtAmongPublished',max(prepared_at) filter(where state='published'),'latestCheckedAtAmongPublished',max(last_checked_at) filter(where state='published'),
 'publishedWithRemoteUriCount',count(*) filter(where state='published' and nullif(to_jsonb(warpcore_publications)->>'remote_uri','') is not null),'authoritativePublishedAt',null) into pubs from public.warpcore_publications;
 sources:=jsonb_build_object('installed',to_regclass('public.warpcore_source_sync') is not null,'rosterConfigured',false,'configuredSourceCount',0);
 if to_regclass('public.warpcore_configured_source_health') is not null then
  select jsonb_build_object('installed',true,'rosterConfigured',count(*)>0,'configuredSourceCount',count(*),'coverageGapCount',count(*) filter(where coverage_gap),
  'uncoveredSourceCount',count(*) filter(where covered_through is null),'sourcesWithoutSuccessCount',count(*) filter(where last_success_at is null),
  'failedCount',count(*) filter(where outcome='failed'),'partialCount',count(*) filter(where outcome='partial'),'runningCount',count(*) filter(where outcome='running'),
  'latestSuccessAt',max(last_success_at),'latestAttemptAt',max(last_attempt_at),'minimumCoveredThrough',min(covered_through),
  'staleHeadCount',count(*) filter(where coalesce(head_checked_at,configured_at)<clock_timestamp()-interval '2 hours'),
  'missedAttemptCount',count(*) filter(where coalesce(last_attempt_at,configured_at)<clock_timestamp()-interval '2 hours'),
  'malformedDatesCount',count(*) filter(where 'malformed_source_dates'=any(coverage_reasons)),
  'progressingPartialCount',count(*) filter(where outcome='partial' and progressed_at>clock_timestamp()-interval '15 minutes'),'latestAcceptedAt',max(last_accepted_at),'latestProgressAt',max(progressed_at)) into sources from public.warpcore_configured_source_health;
 end if;
 if to_regclass('shadow_agent.producer_slots') is not null then
  select coalesce(array_agg(run_id),'{}'::uuid[]) into active_discovery from shadow_agent.producer_slots;
 end if;
 if to_regclass('shadow_agent.verification_settings') is not null then
  select coalesce((to_jsonb(v)->>'enabled')::boolean,false),coalesce((to_jsonb(v)->>'submit_enabled')::boolean,false) into verifier_enabled,submit_enabled from shadow_agent.verification_settings v where singleton;
 end if;
 downstream_busy:=exists(select 1 from public.warpcore_curator_inbox where state in ('pending','leased')) or exists(select 1 from public.warpcore_publications where state in ('prepared','sending','uncertain','manual_review'));
 -- The canonical selector is read-only and authoritative for eligible unclaimed
 -- decisions. It returns the next eligible item, so this is a lower-bound count.
 if to_regprocedure('shadow_agent.next_verification_candidate()') is not null then
  select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) into eligible_rows from shadow_agent.next_verification_candidate() c;
 end if;
 with work as (
  select 'discovery' stage,coalesce(p.progressed_at,(r.state->>'scanStartedAt')::timestamptz) progress,
   coalesce(p.created_at,(r.state->>'scanStartedAt')::timestamptz) oldest,false unclaimed
  from shadow_agent.runs r left join shadow_agent.health_progress p on p.entity='runs' and p.entity_id=r.id::text
  where (active_discovery is null or r.id=any(active_discovery)) and r.state->>'storageKind'='paged-v1' and r.state->>'phase' in ('scan','review','reviewing')
  union all
  select case when j.status='verified' then 'handoff' else 'verification' end,
   greatest(p.progressed_at,rp.progressed_at),coalesce(p.created_at,rp.created_at),false
  from shadow_agent.verification_jobs j
  left join shadow_agent.health_progress p on p.entity='verification_jobs' and p.entity_id=to_jsonb(j)->>'id'
  left join shadow_agent.health_progress rp on rp.entity='runs' and rp.entity_id=to_jsonb(j)->>'child_run_id'
  where (j.status='pending' or (j.status='verified' and j.handoff_status='pending')) and not coalesce((to_jsonb(j)->>'quarantined')::boolean,false)
  union all
  select 'verification',coalesce(k.finalized_at,p.progressed_at,(r.state->>'scanStartedAt')::timestamptz),coalesce(k.finalized_at,p.created_at,(r.state->>'scanStartedAt')::timestamptz),true
  from jsonb_array_elements(eligible_rows) c left join shadow_agent.runs r on r.id::text=c->>'ranking_run_id'
  left join shadow_agent.ranking_runs k on to_jsonb(k)->>'run_id'=c->>'ranking_run_id'
  left join shadow_agent.health_progress p on p.entity='runs' and p.entity_id=c->>'ranking_run_id'
  union all
  select 'curation',coalesce(p.progressed_at,i.created_at),i.created_at,false from public.warpcore_curator_inbox i
  left join shadow_agent.health_progress p on p.entity='warpcore_curator_inbox' and p.entity_id=to_jsonb(i)->>'id' where i.state in ('pending','leased')
  union all
  select 'publication',coalesce(p.progressed_at,pub.prepared_at),pub.prepared_at,false from public.warpcore_publications pub
  left join shadow_agent.health_progress p on p.entity='warpcore_publications' and p.entity_id=coalesce(to_jsonb(pub)->>'id',pub.story_key) where pub.state in ('prepared','sending')
 ), stage_names as(select unnest(array['discovery','verification','handoff','curation','publication']) stage), counts as(
  select n.stage,count(w.stage) backlog,min(w.oldest) oldest,max(w.progress) latest_progress,count(*) filter(where w.unclaimed) unclaimed_count,
   count(w.stage) filter(where w.progress<clock_timestamp()-interval '15 minutes') aged,
   case when n.stage='discovery' and not coalesce((select enabled from shadow_agent.producer_settings where singleton),false) then 'paused'
    when n.stage in ('verification','handoff') and (not coalesce((select enabled from shadow_agent.producer_settings where singleton),false) or not coalesce(verifier_enabled,false) or (n.stage='handoff' and not coalesce(submit_enabled,false))) then 'paused'
    when n.stage in ('verification','handoff') and downstream_busy then 'waiting'
    when n.stage='discovery' and verifier_enabled and (jsonb_array_length(eligible_rows)>0 or exists(select 1 from shadow_agent.verification_jobs j where j.status='pending' or (submit_enabled and j.status='verified' and j.handoff_status='pending'))) and not exists(select 1 from shadow_agent.runs r where r.state->>'phase'='scan') then 'waiting' else null end blocked
  from stage_names n left join work w using(stage) group by n.stage
 ) select jsonb_object_agg(stage,jsonb_build_object('backlogCount',backlog,'oldestWorkAt',oldest,'latestProgressAt',latest_progress,'unclaimedCount',unclaimed_count,'unclaimedCountIsLowerBound',true,'stalledCount',case when blocked is null then aged else 0 end,
 'state',case when backlog=0 then 'healthy_quiet' when blocked is not null then blocked when aged>0 then 'stalled' when latest_progress is null then 'waiting' else 'progressing' end)),sum(case when blocked is null then aged else 0 end),sum(backlog)
 into stages,stage_stalled,stage_pending from counts;
 operational:=jsonb_build_object('state',case when stage_stalled>0 then 'stalled'
 when coalesce((sources->>'failedCount')::bigint,0)+coalesce((sources->>'staleHeadCount')::bigint,0)+coalesce((sources->>'missedAttemptCount')::bigint,0)+coalesce((sources->>'malformedDatesCount')::bigint,0)>0 then 'degraded'
 when coalesce((sources->>'progressingPartialCount')::bigint,0)>0 then 'progressing'
 when stage_pending>0 and not exists(select 1 from jsonb_each(stages) s where (s.value->>'backlogCount')::bigint>0 and s.value->>'state'<>'paused') then 'paused'
 when stage_pending>0 and not exists(select 1 from jsonb_each(stages) s where (s.value->>'backlogCount')::bigint>0 and s.value->>'state' not in ('paused','waiting')) then 'waiting'
 when stage_pending>0 then 'progressing' when coalesce((sources->>'coverageGapCount')::bigint,0)>0 then 'coverage_limited' else 'healthy_quiet' end,
 'sourceProgressingCount',coalesce((sources->>'progressingPartialCount')::bigint,0),'sourceStaleHeadCount',coalesce((sources->>'staleHeadCount')::bigint,0),'coverageLimitedCount',coalesce((sources->>'coverageGapCount')::bigint,0),'sourceRosterConfigured',coalesce((sources->>'rosterConfigured')::boolean,false),'stageStalledCount',stage_stalled);
 select count(*) filter(where status='uncertain'),count(*) filter(where status='verified' and handoff_status='pending'),count(*) filter(where handoff_status='deferred') into verifier_uncertain,handoff_pending,handoff_deferred from shadow_agent.verification_jobs;
 select count(*) into attempt_uncertain from shadow_agent.attempts where status='uncertain';
 if verifier_uncertain>0 then attention:=attention||'"verification_uncertain"'::jsonb;end if;
 if attempt_uncertain>0 then attention:=attention||'"accounting_uncertain"'::jsonb;end if;
 if handoff_deferred>0 then attention:=attention||'"handoff_deferred"'::jsonb;end if;
 if (pubs->>'manualReviewCount')::bigint>0 or (pubs->>'uncertainCount')::bigint>0 then attention:=attention||'"publication_reconciliation"'::jsonb;end if;
 if (sources->>'coverageGapCount')::bigint>0 then attention:=attention||'"source_coverage_gap"'::jsonb;end if;
 if (costs->>'blockedBudgetCount')::bigint>0 then attention:=attention||'"spending_blocked"'::jsonb;end if;
 if handoff_pending>0 then attention:=attention||'"handoff_pending"'::jsonb;end if;
 if (queue->>'distinctStories')::bigint>5 then attention:=attention||'"queue_above_limit"'::jsonb;end if;
 if policy.enabled and policy.lifetime_limit_credits-(costs->>'spentCredits')::numeric-(costs->>'heldCredits')::numeric<minimum_required then attention:=attention||'"lifetime_headroom_exhausted"'::jsonb;end if;
 if daily is null and coalesce(policy.enabled,false) and coalesce((select enabled from shadow_agent.producer_settings where singleton),false) then attention:=attention||'"daily_budget_missing"'::jsonb;end if;
 return jsonb_build_object('generatedAt',clock_timestamp(),'activeModel',active_model,'producerEnabled',coalesce((select enabled from shadow_agent.producer_settings where singleton),false),
 'spendingPolicy',jsonb_build_object('enabled',policy.enabled,'dailyLimitCredits',policy.daily_limit_credits,'lifetimeLimitCredits',policy.lifetime_limit_credits,'exclusiveAgent',policy.exclusive_agent),
 'stages',stages,'operationalHealth',operational,'latestDiscovery',latest,'runPhases',phases,'coverage',coverage,'costs',costs,'currentDayBudget',daily,'queue',queue,'publications',pubs,'sourceHealth',sources,
 'verification',jsonb_build_object('uncertainJobs',verifier_uncertain,'uncertainAttempts',attempt_uncertain,'pendingHandoffs',handoff_pending,'deferredHandoffs',handoff_deferred),'attentionKeys',attention);
end $$;
revoke all on function public.warpcore_agent_health() from public,anon,authenticated,service_role;
grant execute on function public.warpcore_agent_health() to service_role;
commit;
