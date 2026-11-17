-- Administrative policy only. Defaults off; no budgets, cleanup or activation.
begin;
create table shadow_agent.spending_policy(
 singleton boolean primary key default true check(singleton),enabled boolean not null default false,
 daily_limit_credits numeric not null default 2 check(daily_limit_credits>0 and daily_limit_credits<=2),
 lifetime_limit_credits numeric not null default 20 check(lifetime_limit_credits>0 and lifetime_limit_credits<=20),
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
 -- Never wait holding policy resources behind reserve/settle row locks. Access
 -- exclusive also fences their preceding SELECT FOR UPDATE, not just UPDATE.
 -- A busy tick does nothing; no ledger row or old budget is changed.
 lock table shadow_agent.budgets in access exclusive mode nowait;
 d:=(clock_timestamp() at time zone 'utc')::date;
 select policy.lifetime_limit_credits-coalesce(sum(spent_credits+held_credits),0) into remaining from shadow_agent.budgets;
 if exists(select 1 from shadow_agent.budgets where day=d) then return exists(select 1 from shadow_agent.budgets where day=d and not blocked and limit_credits-spent_credits-held_credits>=minimum_required) and remaining>=minimum_required;end if;
 cap:=least(policy.daily_limit_credits,remaining);
 if cap<minimum_required then return false;end if;
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
create function public.warpcore_agent_health() returns jsonb
language plpgsql security definer set search_path='' as $$
declare policy shadow_agent.spending_policy;latest jsonb;phases jsonb;coverage jsonb;costs jsonb;daily jsonb;queue jsonb;sources jsonb;pubs jsonb;attention jsonb:='[]'::jsonb;verifier_uncertain bigint;attempt_uncertain bigint;handoff_pending bigint;handoff_deferred bigint;active_model jsonb;minimum_required numeric;
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
 'authoritativePublishedAt',null) into pubs from public.warpcore_publications;
 sources:=jsonb_build_object('installed',false);
 if to_regclass('public.warpcore_source_sync') is not null then
  select jsonb_build_object('installed',true,'configuredSourceCount',count(*),'coverageGapCount',count(*) filter(where coverage_gap),
  'uncoveredSourceCount',count(*) filter(where covered_through is null),'sourcesWithoutSuccessCount',count(*) filter(where last_success_at is null),
  'failedCount',count(*) filter(where outcome='failed'),'partialCount',count(*) filter(where outcome='partial'),'runningCount',count(*) filter(where outcome='running'),
  'latestSuccessAt',max(last_success_at),'latestAttemptAt',max(last_attempt_at),'minimumCoveredThrough',min(covered_through)) into sources from public.warpcore_source_sync;
 end if;
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
 'latestDiscovery',latest,'runPhases',phases,'coverage',coverage,'costs',costs,'currentDayBudget',daily,'queue',queue,'publications',pubs,'sourceHealth',sources,
 'verification',jsonb_build_object('uncertainJobs',verifier_uncertain,'uncertainAttempts',attempt_uncertain,'pendingHandoffs',handoff_pending,'deferredHandoffs',handoff_deferred),'attentionKeys',attention);
end $$;
revoke all on function public.warpcore_agent_health() from public,anon,authenticated,service_role;
grant execute on function public.warpcore_agent_health() to service_role;
commit;
