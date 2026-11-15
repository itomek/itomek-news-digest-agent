-- Acquisition state only: no editorial approval, publishing or schedule changes.
create table public.warpcore_source_sync (
 source_key text primary key check(length(source_key) between 1 and 512),
 source_type text not null, source_id text not null, config_hash text not null,
 generation integer not null default 1,
 bootstrap_since timestamptz not null,
 covered_through timestamptz,
 last_attempt_at timestamptz, last_success_at timestamptz,
 outcome text not null default 'pending' check(outcome in ('pending','running','complete','empty','partial','gap','failed')),
 window_since timestamptz, window_until timestamptz, cursor jsonb,
 earliest_available timestamptz, error_code text, coverage_gap boolean not null default false,
 fetched_count integer not null default 0, new_count integer not null default 0, duplicate_count integer not null default 0,
 lease_token uuid, lease_until timestamptz,
 check(covered_through is null or covered_through>=bootstrap_since)
);
create table public.warpcore_source_sync_attempts (
 token uuid primary key,
 source_key text not null references public.warpcore_source_sync(source_key), generation integer not null,
 started_at timestamptz not null, finished_at timestamptz,
 window_since timestamptz not null, window_until timestamptz not null,
 outcome text not null check(outcome in ('running','complete','empty','partial','gap','failed')),
 cursor jsonb, earliest_available timestamptz, error_code text,
 fetched_count integer not null default 0, new_count integer not null default 0, duplicate_count integer not null default 0
);
create index warpcore_source_sync_attempts_source on public.warpcore_source_sync_attempts(source_key,started_at desc);
alter table public.warpcore_source_sync enable row level security;
alter table public.warpcore_source_sync_attempts enable row level security;
revoke all on public.warpcore_source_sync,public.warpcore_source_sync_attempts from public,anon,authenticated;
grant select,insert,update on public.warpcore_source_sync,public.warpcore_source_sync_attempts to service_role;

create function public.warpcore_sync_begin(p_source_key text,p_source_type text,p_source_id text,p_config_hash text,p_bootstrap_since timestamptz,p_upper timestamptz)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare s public.warpcore_source_sync; t uuid; stamp timestamptz:=clock_timestamp();
begin
 if p_source_key is null or p_source_type is null or p_source_id is null or p_config_hash is null
 or length(p_source_type) not between 1 and 32 or length(p_source_id) not between 1 and 2048 or p_config_hash !~ '^[a-f0-9]{64}$'
 or p_upper is null or p_bootstrap_since is null or p_bootstrap_since>p_upper or p_upper>stamp+interval '5 minutes' then raise exception 'invalid sync configuration';end if;
 insert into public.warpcore_source_sync(source_key,source_type,source_id,config_hash,bootstrap_since)
 values(p_source_key,p_source_type,p_source_id,p_config_hash,p_bootstrap_since) on conflict do nothing;
 select * into s from public.warpcore_source_sync where source_key=p_source_key for update;
 if s.lease_until>stamp then return jsonb_build_object('acquired',false,'status','busy','covered_through',s.covered_through,'last_success_at',s.last_success_at);end if;
 if s.lease_token is not null then
  update public.warpcore_source_sync_attempts set outcome='failed',finished_at=stamp,error_code='lease_expired' where token=s.lease_token and outcome='running';
 end if;
 -- Config changes start a separately audited generation. Old evidence and attempts survive.
 if s.config_hash<>p_config_hash or s.source_type<>p_source_type or s.source_id<>p_source_id then
  s.generation:=s.generation+1;s.covered_through:=null;s.last_success_at:=null;s.cursor:=null;
  s.window_since:=null;s.window_until:=null;s.earliest_available:=null;s.coverage_gap:=false;s.bootstrap_since:=p_bootstrap_since;
 end if;
 if s.window_until is null then
  s.window_since:=greatest(s.bootstrap_since,coalesce(s.covered_through,s.bootstrap_since)-interval '24 hours');
  s.window_until:=greatest(p_upper,coalesce(s.covered_through,p_upper));s.cursor:=null;s.coverage_gap:=false;s.earliest_available:=null;
 end if;
 t:=gen_random_uuid();
 update public.warpcore_source_sync set source_type=p_source_type,source_id=p_source_id,config_hash=p_config_hash,generation=s.generation,
 bootstrap_since=s.bootstrap_since,covered_through=s.covered_through,last_success_at=s.last_success_at,
 window_since=s.window_since,window_until=s.window_until,cursor=s.cursor,earliest_available=s.earliest_available,
 coverage_gap=s.coverage_gap,last_attempt_at=stamp,outcome='running',lease_token=t,lease_until=stamp+interval '5 minutes',error_code=null where source_key=p_source_key;
 insert into public.warpcore_source_sync_attempts(token,source_key,generation,started_at,window_since,window_until,outcome)
 values(t,p_source_key,s.generation,stamp,s.window_since,s.window_until,'running');
 return jsonb_build_object('acquired',true,'token',t,'source_key',p_source_key,'generation',s.generation,'covered_through',s.covered_through,'last_success_at',s.last_success_at,
 'window_since',s.window_since,'window_until',s.window_until,'cursor',s.cursor);
end;$fn$;

create function public.warpcore_sync_finish(p_source_key text,p_token uuid,p_items jsonb,p_outcome text,p_cursor jsonb,p_earliest_available timestamptz,p_error_code text,p_fetched integer)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare s public.warpcore_source_sync;n integer:=0;total integer;stamp timestamptz:=clock_timestamp();
begin
 select * into s from public.warpcore_source_sync where source_key=p_source_key for update;
 if not found or p_token is null or s.lease_token is distinct from p_token or s.lease_until<=stamp then
  return jsonb_build_object('accepted',false,'status','stale_lease');end if;
 if p_outcome is null or p_outcome not in ('complete','empty','partial','gap','failed') or jsonb_typeof(p_items) is distinct from 'array'
 or jsonb_array_length(p_items)>5000 or p_fetched is null or p_fetched<0
 or (p_cursor is not null and (jsonb_typeof(p_cursor)<>'object' or octet_length(p_cursor::text)>16384))
 or (p_outcome='partial' and p_cursor is null)
 or (p_outcome='empty' and (jsonb_array_length(p_items)>0 or p_fetched<>0))
 or (p_outcome='failed' and jsonb_array_length(p_items)>0)
 or (p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{0,63}$') then raise exception 'invalid sync result';end if;
 total:=(select count(distinct x->>'uri') from jsonb_array_elements(p_items) x);
 if total>p_fetched then raise exception 'invalid sync counts';end if;
 if exists(select 1 from jsonb_array_elements(p_items) x where x->>'source_type' is distinct from s.source_type or x->>'source_id' is distinct from s.source_id) then raise exception 'sync source mismatch';end if;
 -- Table locks serialize origin count accounting with legacy ingest callers.
 -- Lock order matches legacy ingestion (stories before candidates); uniqueness remains authoritative.
 lock table public.warpcore_stories,public.warpcore_candidates in share row exclusive mode;
 select count(*)::integer into n from (select distinct x->>'uri' uri from jsonb_array_elements(p_items) x) incoming
 where not exists(select 1 from public.warpcore_candidates c where c.uri=incoming.uri);
 perform public.warpcore_ingest(p_items);
 if s.coverage_gap or p_error_code='upstream_history_unproven' then
  if p_outcome in ('complete','empty') then p_outcome:='gap';end if;
 end if;
 update public.warpcore_source_sync_attempts set finished_at=stamp,outcome=p_outcome,cursor=p_cursor,
 earliest_available=p_earliest_available,error_code=p_error_code,fetched_count=p_fetched,new_count=n,duplicate_count=total-n where token=p_token;
 update public.warpcore_source_sync set outcome=p_outcome,lease_token=null,lease_until=null,
 covered_through=case when p_outcome in ('complete','empty') then s.window_until else s.covered_through end,
 last_success_at=case when p_outcome in ('complete','empty') then stamp else s.last_success_at end,
 cursor=case when p_outcome='partial' then p_cursor when p_outcome='failed' then s.cursor else null end,
 window_since=case when p_outcome in ('partial','failed') then s.window_since else null end,
 window_until=case when p_outcome in ('partial','failed') then s.window_until else null end,
 earliest_available=least(p_earliest_available,s.earliest_available),error_code=p_error_code,
 coverage_gap=s.coverage_gap or p_outcome='gap' or coalesce(p_error_code='upstream_history_unproven',false),
 fetched_count=p_fetched,new_count=n,duplicate_count=total-n where source_key=p_source_key;
 return jsonb_build_object('accepted',true,'status',p_outcome,'fetched',p_fetched,'new',n,'duplicate',total-n,
 'covered_through',case when p_outcome in ('complete','empty') then s.window_until else s.covered_through end,
 'last_success_at',case when p_outcome in ('complete','empty') then stamp else s.last_success_at end,
 'cursor',case when p_outcome='partial' then p_cursor when p_outcome='failed' then s.cursor else null end);
end;$fn$;
revoke all on function public.warpcore_sync_begin(text,text,text,text,timestamptz,timestamptz),public.warpcore_sync_finish(text,uuid,jsonb,text,jsonb,timestamptz,text,integer) from public,anon,authenticated;
grant execute on function public.warpcore_sync_begin(text,text,text,text,timestamptz,timestamptz),public.warpcore_sync_finish(text,uuid,jsonb,text,jsonb,timestamptz,text,integer) to service_role;
create view public.warpcore_source_sync_health with (security_invoker=true) as
 select source_key,source_type,source_id,generation,last_attempt_at,last_success_at,covered_through,
 extract(epoch from (clock_timestamp()-covered_through)) as lag_seconds,
 outcome,outcome in ('partial','gap','failed','running') as incomplete_catchup,earliest_available,error_code,fetched_count,new_count,duplicate_count
 from public.warpcore_source_sync;
revoke all on public.warpcore_source_sync_health from public,anon,authenticated;
grant select on public.warpcore_source_sync_health to service_role;
