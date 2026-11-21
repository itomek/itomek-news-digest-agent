-- Install after 20261115204734 checkpoint migration, before deploying collector.
-- Owner-managed roster is deliberately empty: populate exact source_key/config_hash
-- pairs from the reviewed deployed NEWS_SOURCE_CONFIG using configurationHash.
-- Never infer the trusted roster from historical checkpoints or request selections.
begin;
alter table public.warpcore_source_sync add column head_checked_at timestamptz,
 add column last_accepted_at timestamptz,add column progressed_at timestamptz,
 add column coverage_reasons text[] not null default '{}',add column observation_generation integer;
alter table public.warpcore_source_sync_attempts add column head_checked_at timestamptz,
 add column coverage_reasons text[] not null default '{}';
create table public.warpcore_source_roster(
 source_key text primary key check(length(source_key) between 1 and 512),
 config_hash text not null check(config_hash ~ '^[a-f0-9]{64}$'),
 configured_at timestamptz not null default clock_timestamp()
);
alter table public.warpcore_source_roster enable row level security;
revoke all on public.warpcore_source_roster from public,anon,authenticated,service_role;
grant select on public.warpcore_source_roster to service_role;
-- Add persisted head context without changing existing begin arguments.
alter function public.warpcore_sync_begin(text,text,text,text,timestamptz,timestamptz) rename to warpcore_sync_begin_legacy;
create function public.warpcore_sync_begin(p_source_key text,p_source_type text,p_source_id text,p_config_hash text,p_bootstrap_since timestamptz,p_upper timestamptz)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;head timestamptz;
begin
 result:=public.warpcore_sync_begin_legacy(p_source_key,p_source_type,p_source_id,p_config_hash,p_bootstrap_since,p_upper);
 select head_checked_at into head from public.warpcore_source_sync where source_key=p_source_key and config_hash=p_config_hash and observation_generation=generation;
 return result||jsonb_build_object('head_checked_at',head);
end $$;
revoke all on function public.warpcore_sync_begin(text,text,text,text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.warpcore_sync_begin(text,text,text,text,timestamptz,timestamptz) to service_role;
-- Rename the implementation so PostgREST sees exactly one public RPC signature.
-- Defaults preserve all existing eight-argument callers.
alter function public.warpcore_sync_finish(text,uuid,jsonb,text,jsonb,timestamptz,text,integer) rename to warpcore_sync_finish_legacy;
revoke all on function public.warpcore_sync_finish_legacy(text,uuid,jsonb,text,jsonb,timestamptz,text,integer) from public,anon,authenticated;
create function public.warpcore_sync_finish(p_source_key text,p_token uuid,p_items jsonb,p_outcome text,p_cursor jsonb,p_earliest_available timestamptz,p_error_code text,p_fetched integer,p_head_checked_at timestamptz default null,p_coverage_reasons text[] default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare before_row public.warpcore_source_sync; result jsonb; stamp timestamptz:=clock_timestamp();
begin
 if p_coverage_reasons is null or cardinality(p_coverage_reasons)>4
 or exists(select 1 from unnest(p_coverage_reasons) r where r is null or r not in ('finite_feed_history','finite_index_history','finite_top_story_snapshot','malformed_source_dates'))
 or (p_head_checked_at is not null and (p_head_checked_at>stamp+interval '5 minutes' or p_outcome='failed')) then raise exception 'invalid source observation';end if;
 select * into before_row from public.warpcore_source_sync where source_key=p_source_key for update;
 result:=public.warpcore_sync_finish_legacy(p_source_key,p_token,p_items,p_outcome,p_cursor,p_earliest_available,p_error_code,p_fetched);
 if not coalesce((result->>'accepted')::boolean,false) then return result;end if;
 update public.warpcore_source_sync_attempts set head_checked_at=p_head_checked_at,coverage_reasons=p_coverage_reasons where token=p_token;
 -- A begin/config change resets effective observations through generation matching;
 -- failed acquisition cannot establish freshness or clear previous typed evidence.
 update public.warpcore_source_sync set
 head_checked_at=case when p_outcome='failed' then case when observation_generation=generation then head_checked_at end else greatest(p_head_checked_at,case when observation_generation=generation then head_checked_at end) end,
 last_accepted_at=case when p_outcome<>'failed' then stamp when observation_generation=generation then last_accepted_at end,
 progressed_at=case when p_outcome<>'failed' and (observation_generation is distinct from generation or p_cursor is distinct from before_row.cursor or (result->>'new')::int>0 or p_outcome in ('complete','empty','gap')) then stamp when observation_generation=generation then progressed_at end,
 coverage_reasons=case when p_outcome='failed' and observation_generation=generation then coverage_reasons when before_row.cursor is not null and observation_generation=generation then array(select distinct unnest(coverage_reasons||p_coverage_reasons)) else p_coverage_reasons end,
 observation_generation=generation where source_key=p_source_key;
 return result||jsonb_build_object('generation',before_row.generation);
end $$;
revoke all on function public.warpcore_sync_finish(text,uuid,jsonb,text,jsonb,timestamptz,text,integer,timestamptz,text[]) from public,anon,authenticated;
grant execute on function public.warpcore_sync_finish(text,uuid,jsonb,text,jsonb,timestamptz,text,integer,timestamptz,text[]) to service_role;
create view public.warpcore_configured_source_health with(security_invoker=true) as
 select r.source_key,r.configured_at,s.config_hash=r.config_hash as configuration_matches,
 case when s.config_hash=r.config_hash then s.last_attempt_at end last_attempt_at,
 case when s.config_hash=r.config_hash then s.outcome end outcome,
 case when s.config_hash=r.config_hash then s.coverage_gap end coverage_gap,
 case when s.config_hash=r.config_hash then s.covered_through end covered_through,
 case when s.config_hash=r.config_hash then s.last_success_at end last_success_at,
 case when s.config_hash=r.config_hash and s.observation_generation=s.generation then s.head_checked_at end head_checked_at,
 case when s.config_hash=r.config_hash and s.observation_generation=s.generation then s.last_accepted_at end last_accepted_at,
 case when s.config_hash=r.config_hash and s.observation_generation=s.generation then s.progressed_at end progressed_at,
 case when s.config_hash=r.config_hash and s.observation_generation=s.generation then s.coverage_reasons else '{}'::text[] end coverage_reasons
 from public.warpcore_source_roster r left join public.warpcore_source_sync s using(source_key);
revoke all on public.warpcore_configured_source_health from public,anon,authenticated;
grant select on public.warpcore_configured_source_health to service_role;
commit;
