-- SHADOW ONLY; outside migrations. Load state, paged and audit contracts first.
-- No scheduler, activation, credentials or publishing. Administrator alone owns
-- enablement, run limits and supported policy. Worker RPCs cannot modify them.
begin;
create table shadow_agent.producer_settings(
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 run_limit_credits numeric check(run_limit_credits>0 and run_limit_credits<1000000),
 policy_version text
);
insert into shadow_agent.producer_settings(singleton) values(true);
create table shadow_agent.producer_slots(
 utc_hour timestamptz primary key,
 run_id uuid not null unique references shadow_agent.runs(id)
);
alter table shadow_agent.producer_settings enable row level security;
alter table shadow_agent.producer_slots enable row level security;
revoke all on shadow_agent.producer_settings,shadow_agent.producer_slots from public,anon,authenticated,service_role;
create function public.warpcore_shadow_select_run() returns jsonb
language plpgsql security definer set search_path='' as $$
declare settings shadow_agent.producer_settings; r shadow_agent.runs; run_id uuid; stamp timestamptz; slot timestamptz;
begin
 -- Serializes slot creation and selection across scheduled triggers. Claim is
 -- independently fenced; callers receiving one ID still compete for one lease.
 select * into settings from shadow_agent.producer_settings where singleton for update;
 if not found or not settings.enabled then return null; end if;
 if settings.run_limit_credits is null or settings.policy_version is distinct from '2026-11-14.1'
 then raise exception 'Invalid producer configuration'; end if;
 if exists(select 1 from shadow_agent.runs where state->>'storageKind'='paged-v1' and state->>'phase' in ('reviewing','uncertain')) then return null; end if;
 select * into r from shadow_agent.runs where state->>'storageKind'='paged-v1'
 and state->>'phase' in ('scan','review') order by (state->>'scanStartedAt')::timestamptz,id limit 1;
 if found then
  if r.lease_until>clock_timestamp() then return null; end if;
  return to_jsonb(r.id);
 end if;
 stamp:=clock_timestamp();slot:=date_trunc('hour',stamp at time zone 'utc') at time zone 'utc';
 if exists(select 1 from shadow_agent.producer_slots where utc_hour=slot) then return null; end if;
 run_id:=gen_random_uuid();
 insert into shadow_agent.runs(id,state,limit_credits) values(run_id,jsonb_build_object(
  'storageKind','paged-v1','runId',run_id::text,
  'scanStartedAt',to_char(stamp at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'policyVersion',settings.policy_version,'revision',0,'phase','scan','cursor',null,
  'candidateCount',0,'reviewedCount',0,'activeBatch',null,'publishingEnabled',false),settings.run_limit_credits);
 insert into shadow_agent.producer_slots(utc_hour,run_id) values(slot,run_id);
 return to_jsonb(run_id);
end $$;
create function public.warpcore_shadow_candidate_page(p_started timestamptz,p_cursor text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if p_started is null or not isfinite(p_started) then raise exception 'Invalid scan timestamp'; end if;
 if p_cursor is not null and p_cursor !~ '^[a-f0-9]{64}$' then raise exception 'Invalid candidate cursor'; end if;
 with newest as (
  select distinct on (s.story_key) s.story_key,c.source_type,c.source_created_at,c.source_url,left(c.text,800) as excerpt
  from public.warpcore_stories s join public.warpcore_candidates c using(story_key)
  where s.status='unverified_review_required'
   and s.collected_at<=p_started and c.collected_at<=p_started
   and c.source_created_at between p_started-interval '7 days' and p_started+interval '5 minutes'
   and (p_cursor is null or s.story_key>p_cursor)
   and not exists(select 1 from public.warpcore_curator_inbox i where i.story_key=s.story_key)
   and not exists(select 1 from public.warpcore_publications p where p.story_key=s.story_key)
  order by s.story_key,c.source_created_at desc,c.uri
 ), page as (
  select story_key,source_type,source_url,excerpt,
   to_char(source_created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as source_created_at
  from newest order by story_key limit 100
 ) select coalesce(jsonb_agg(to_jsonb(page) order by story_key),'[]'::jsonb) into result from page;
 return result;
end $$;
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
commit;
