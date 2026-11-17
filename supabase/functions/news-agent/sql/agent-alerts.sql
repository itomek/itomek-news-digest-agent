-- Prepared exception-only dashboard delivery option, NOT a selected/active channel.
-- Install after operations.sql. No cron edits, HTTP destinations or credentials.
begin;
do $$begin
 if to_regprocedure('shadow_agent.budgeted_enqueue()') is null or to_regprocedure('public.warpcore_agent_health()') is null or to_regclass('public.system_logs') is null then raise exception 'Installed operations and dashboard logs required';end if;
end $$;
alter table shadow_agent.runs add column progressed_at timestamptz not null default clock_timestamp();
create function shadow_agent.track_run_progress() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.state is distinct from old.state or new.revision is distinct from old.revision then new.progressed_at:=clock_timestamp();end if;
 return new;
end $$;
create trigger warpcore_run_progress before update of state,revision on shadow_agent.runs for each row execute function shadow_agent.track_run_progress();
create table shadow_agent.alert_settings(
 singleton boolean primary key default true check(singleton),enabled boolean not null default false,
 resolution_info boolean not null default true,installed_at timestamptz not null default clock_timestamp(),
 last_enqueue_failed_at timestamptz,last_enqueue_success_at timestamptz
);
insert into shadow_agent.alert_settings(singleton) values(true);
create table shadow_agent.alert_state(
 code text primary key check(code in ('discovery_stalled','source_attempt_outage','source_failed','budget_unavailable','accounting_uncertain','verification_uncertain','publication_reconciliation','handoff_deferred','handoff_stalled','scheduler_http_failure','scheduler_response_unavailable','scheduler_enqueue_failed','lifetime_headroom_exhausted','queue_above_limit')),
 active boolean not null,affected_count bigint not null check(affected_count>=0),changed_at timestamptz not null default clock_timestamp()
);
-- IDs and timestamps only: no request headers, URLs, bodies or provider errors.
create table shadow_agent.alert_requests(
 request_id bigint primary key check(request_id>0),queued_at timestamptz not null default clock_timestamp(),
 checked_at timestamptz,http_failed_at timestamptz,response_unavailable_at timestamptz
);
alter table shadow_agent.alert_settings enable row level security;
alter table shadow_agent.alert_state enable row level security;
alter table shadow_agent.alert_requests enable row level security;
revoke all on shadow_agent.alert_settings,shadow_agent.alert_state,shadow_agent.alert_requests from public,anon,authenticated,service_role;
create function shadow_agent.set_alert(p_code text,p_count bigint,p_resolve boolean) returns void
language plpgsql security definer set search_path='' as $$
declare previous boolean;active_now boolean:=p_count>0;
begin
 select active into previous from shadow_agent.alert_state where code=p_code;
 if previous is null and not active_now then return;end if;
 if previous is distinct from active_now then
  insert into public.system_logs(level,category,message,metadata)
  select case when active_now then 'warn' else 'info' end,'warpcore_agent',p_code,
   jsonb_build_object('code',p_code,'active',active_now,'affected_count',p_count)
  where active_now or p_resolve;
 end if;
 insert into shadow_agent.alert_state(code,active,affected_count) values(p_code,active_now,p_count)
 on conflict(code) do update set active=excluded.active,affected_count=excluded.affected_count,
 changed_at=case when alert_state.active is distinct from excluded.active then clock_timestamp() else alert_state.changed_at end;
end $$;
create function shadow_agent.refresh_alerts() returns void
language plpgsql security definer set search_path='' as $$
declare settings shadow_agent.alert_settings;health jsonb;req shadow_agent.alert_requests;response record;latest shadow_agent.alert_requests;n bigint;missing_response boolean;bad_http boolean;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('warpcore_agent_alerts_v1',0)) then return;end if;
 select * into settings from shadow_agent.alert_settings where singleton;
 if not found or not settings.enabled then return;end if;
 -- pg_net is optional in disposable fixtures. Missing response bookkeeping is
 -- an explicit exception after the request's timeout/grace, never HTTP success.
 for req in select * from shadow_agent.alert_requests where checked_at is null order by queued_at,request_id limit 100 loop
  missing_response:=false;bad_http:=false;
  if to_regclass('net._http_response') is null then
   if req.queued_at>clock_timestamp()-interval '3 minutes' then continue;end if;
   missing_response:=true;
  else
   select status_code,timed_out,error_msg is not null as has_error into response from net._http_response where id=req.request_id;
   if not found then
    if req.queued_at>clock_timestamp()-interval '3 minutes' then continue;end if;
    missing_response:=true;
   else
    bad_http:=coalesce(response.timed_out,false) or response.has_error or response.status_code is null or response.status_code<200 or response.status_code>=300;
   end if;
  end if;
  update shadow_agent.alert_requests set checked_at=clock_timestamp(),
   http_failed_at=case when bad_http then clock_timestamp() else null end,
   response_unavailable_at=case when missing_response then clock_timestamp() else null end where request_id=req.request_id;
 end loop;
 health:=public.warpcore_agent_health();
 n:=0;
 if coalesce((health->>'producerEnabled')::boolean,false) then
  select count(*) into n from shadow_agent.runs r join shadow_agent.producer_slots s on s.run_id=r.id
  where r.state->>'storageKind'='paged-v1' and r.progressed_at<clock_timestamp()-interval '15 minutes'
  and r.state->>'phase' in ('scan','review','reviewing');
 end if;
 perform shadow_agent.set_alert('discovery_stalled',n,settings.resolution_info);
 n:=0;
 if to_regclass('public.warpcore_source_sync') is not null then
  select count(*) into n from public.warpcore_source_sync where coalesce(last_attempt_at,settings.installed_at)<clock_timestamp()-interval '2 hours';
 end if;
 perform shadow_agent.set_alert('source_attempt_outage',n,settings.resolution_info);
 n:=0;
 if to_regclass('public.warpcore_source_sync') is not null then
  select count(*) into n from public.warpcore_source_sync where outcome='failed';
 end if;
 perform shadow_agent.set_alert('source_failed',n,settings.resolution_info);
 n:=0;
 if coalesce((health->>'producerEnabled')::boolean,false) and coalesce((health->'spendingPolicy'->>'enabled')::boolean,false) and
  (health->'currentDayBudget' is null or health->'currentDayBudget'='null'::jsonb or
   coalesce((health->'currentDayBudget'->>'blocked')::boolean,false) or
   (health->'currentDayBudget'->>'limitCredits')::numeric-(health->'currentDayBudget'->>'spentCredits')::numeric-(health->'currentDayBudget'->>'heldCredits')::numeric<0.058983 or
   coalesce((health->'costs'->>'blockedBudgetCount')::bigint,0)>0) then n:=1;end if;
 perform shadow_agent.set_alert('budget_unavailable',n,settings.resolution_info);
 perform shadow_agent.set_alert('accounting_uncertain',coalesce((health->'verification'->>'uncertainAttempts')::bigint,0),settings.resolution_info);
 perform shadow_agent.set_alert('verification_uncertain',coalesce((health->'verification'->>'uncertainJobs')::bigint,0),settings.resolution_info);
 perform shadow_agent.set_alert('publication_reconciliation',coalesce((health->'publications'->>'uncertainCount')::bigint,0)+coalesce((health->'publications'->>'manualReviewCount')::bigint,0),settings.resolution_info);
 perform shadow_agent.set_alert('handoff_deferred',coalesce((health->'verification'->>'deferredHandoffs')::bigint,0),settings.resolution_info);
 n:=0;
 if coalesce((health->'verification'->>'pendingHandoffs')::bigint,0)>0 and coalesce((select submit_enabled from shadow_agent.verification_settings where singleton),false) then
  select count(*) into n from shadow_agent.verification_jobs j join shadow_agent.runs r on r.id=j.child_run_id
  where j.status='verified' and j.handoff_status='pending' and r.progressed_at<clock_timestamp()-interval '15 minutes';
 end if;
 perform shadow_agent.set_alert('handoff_stalled',n,settings.resolution_info);
 perform shadow_agent.set_alert('lifetime_headroom_exhausted',case when health->'attentionKeys' ? 'lifetime_headroom_exhausted' then 1 else 0 end,settings.resolution_info);
 perform shadow_agent.set_alert('queue_above_limit',case when coalesce((health->'queue'->>'distinctStories')::bigint,0)>5 then 1 else 0 end,settings.resolution_info);
 select * into latest from shadow_agent.alert_requests where checked_at is not null order by queued_at desc,request_id desc limit 1;
 perform shadow_agent.set_alert('scheduler_http_failure',case when latest.http_failed_at is not null then 1 else 0 end,settings.resolution_info);
 perform shadow_agent.set_alert('scheduler_response_unavailable',case when latest.response_unavailable_at is not null then 1 else 0 end,settings.resolution_info);
 perform shadow_agent.set_alert('scheduler_enqueue_failed',case when settings.last_enqueue_failed_at is not null and (settings.last_enqueue_success_at is null or settings.last_enqueue_failed_at>settings.last_enqueue_success_at) then 1 else 0 end,settings.resolution_info);
end $$;
create function shadow_agent.alerting_enqueue() returns bigint
language plpgsql security definer set search_path='' as $$
declare request_id bigint;
begin
 begin
  request_id:=shadow_agent.budgeted_enqueue();
  if request_id is not null then insert into shadow_agent.alert_requests(request_id) values(request_id);end if;
  update shadow_agent.alert_settings set last_enqueue_success_at=clock_timestamp() where singleton;
 exception when others then
  -- Fixed classification only: never SQLERRM, response bodies, URLs or secrets.
  request_id:=null;
  update shadow_agent.alert_settings set last_enqueue_failed_at=clock_timestamp() where singleton;
 end;
 perform shadow_agent.refresh_alerts();
 return request_id;
end $$;
revoke all on function shadow_agent.track_run_progress(),shadow_agent.set_alert(text,bigint,boolean),shadow_agent.refresh_alerts(),shadow_agent.alerting_enqueue() from public,anon,authenticated,service_role;
commit;
