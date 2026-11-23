-- Existing discovery request learns about prior public coverage. This artifact
-- binds the history and admits eligible exact relays. Nothing activates a job.
begin;
create table shadow_agent.source_link_reviews(
 run_id uuid not null references shadow_agent.runs(id),
 revision bigint not null,
 lease uuid not null,
 history_hash text not null check(history_hash ~ '^[0-9a-f]{64}$'),
 prepared_at timestamptz not null,
 slots integer not null check(slots between 0 and 5),
 attempt_id uuid unique references shadow_agent.attempts(id),
 current_at_commit boolean,
 relay_count integer check(relay_count between 0 and slots),
 primary key(run_id,revision)
);
alter table shadow_agent.source_link_reviews enable row level security;
revoke all on shadow_agent.source_link_reviews from public,anon,authenticated,service_role;

create function public.warpcore_shadow_paged_link_history(p_run uuid,p_lease uuid,p_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare r shadow_agent.runs; entries jsonb; digest text; total bigint; usable bigint; slots integer;
 prepared_at timestamptz:=date_trunc('milliseconds',clock_timestamp());
begin
 r:=shadow_agent.paged_lock(p_run,p_lease,p_revision,'review');
 if r.id is null then return null;end if;
 perform agent_verification.lock_history();
 digest:=agent_verification.history_hash();
 select greatest(0,5-count(*))::int into slots from (
  select story_key from public.warpcore_curator_inbox where state in ('pending','leased')
  union select story_key from public.warpcore_publications where state in ('prepared','sending','uncertain','manual_review')
 ) occupied;
 with history as (
  select h.key,h.item,jsonb_build_object('storyKey',h.item->>'storyKey',
   'headline',coalesce(nullif(btrim(split_part(c.entry->>'text',chr(10),1)),''),left(nullif(btrim(split_part(h.item->'record'->>'text',chr(10),1)),''),800)),
   'url',c.entry->>'url') as projected
  from agent_verification.history_rows() h left join lateral (
   select x as entry from jsonb_array_elements(h.item->'candidateContext') with ordinality e(x,n)
   where x->>'url' ~ '^https://[^/@[:space:]]+([/?#]|$)' order by e.n limit 1
  ) c on true
 )
 select count(*),count(*) filter(where projected->>'headline' is not null and projected->>'url' is not null),
  coalesce(jsonb_agg(projected order by key),'[]'::jsonb) into total,usable,entries from history;
 if total<>usable or octet_length(entries::text)>100000 then raise exception 'Source-link history incomplete or too large';end if;
 insert into shadow_agent.source_link_reviews as previous(run_id,revision,lease,history_hash,prepared_at,slots)
 values(p_run,p_revision+1,p_lease,digest,prepared_at,slots)
 on conflict(run_id,revision) do update set lease=excluded.lease,history_hash=excluded.history_hash,prepared_at=excluded.prepared_at,slots=excluded.slots where previous.attempt_id is null;
 if not found then raise exception 'History already reserved';end if;
 return jsonb_build_object('snapshotHash',digest,'complete',true,'entries',entries,'slots',slots,'preparedAt',to_char(prepared_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $fn$;

create function public.warpcore_shadow_paged_link_reserve(p_run uuid,p_lease uuid,p_revision bigint,p_hash text,p_max numeric,p_history text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare r shadow_agent.runs; bound shadow_agent.source_link_reviews; reserved jsonb;
begin
 r:=shadow_agent.paged_lock(p_run,p_lease,p_revision,'reviewing');
 if r.id is null then return null;end if;
 select * into bound from shadow_agent.source_link_reviews where run_id=p_run and revision=p_revision for update;
 if not found or bound.lease is distinct from p_lease or bound.history_hash is distinct from p_history or bound.attempt_id is not null then raise exception 'Source-link history binding mismatch';end if;
 reserved:=shadow_agent.paged_reserve(p_run,p_lease,p_revision,p_hash,p_max);
 if reserved->>'status'='reserved' then
  update shadow_agent.source_link_reviews set attempt_id=(reserved->>'attemptId')::uuid where run_id=p_run and revision=p_revision;
 end if;
 return reserved;
end $fn$;

create function public.warpcore_shadow_paged_link_commit(p_run uuid,p_lease uuid,p_revision bigint,p_decisions jsonb,p_history text,p_relays jsonb)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare r shadow_agent.runs; bound shadow_agent.source_link_reviews; result jsonb; fresh boolean; relay jsonb; story text; sent integer:=0; offset_ms integer:=0;
begin
 r:=shadow_agent.paged_lock(p_run,p_lease,p_revision,'reviewing');
 if r.id is null then return null;end if;
 select * into bound from shadow_agent.source_link_reviews where run_id=p_run and revision=p_revision for update;
 if not found or bound.lease is distinct from p_lease or bound.history_hash is distinct from p_history or not exists(
  select 1 from shadow_agent.attempts a where a.id=bound.attempt_id and a.run_id=p_run and a.checkpoint_revision=p_revision and a.status='settled'
 ) then raise exception 'Settled source-link review required';end if;
 perform agent_verification.lock_history();
 if jsonb_typeof(p_relays) is distinct from 'array' or jsonb_array_length(p_relays)>bound.slots or octet_length(p_relays::text)>30000 then
  raise exception 'Invalid source-link relay batch';end if;
 fresh:=agent_verification.history_hash()=bound.history_hash;
 result:=shadow_agent.paged_commit(p_run,p_lease,p_revision,p_decisions);
 if fresh then
  for relay in select value from jsonb_array_elements(p_relays) loop
   story:=relay->>'storyKey';
   if story is null or story !~ '^[a-f0-9]{64}$' or not exists(
    select 1 from jsonb_array_elements(p_decisions) d where d->>'id'=story and d->>'action'='verify'
   ) then raise exception 'Source-link relay was not selected';end if;
   if shadow_agent.admit_source_link(p_run,story,bound.prepared_at+offset_ms*interval '1 millisecond',relay) then sent:=sent+1;end if;
   offset_ms:=offset_ms+1;
  end loop;
 end if;
 update shadow_agent.source_link_reviews set current_at_commit=fresh,relay_count=sent where run_id=p_run and revision=p_revision;
 return result;
end $fn$;
revoke all on function public.warpcore_shadow_paged_link_history(uuid,uuid,bigint),public.warpcore_shadow_paged_link_reserve(uuid,uuid,bigint,text,numeric,text),public.warpcore_shadow_paged_link_commit(uuid,uuid,bigint,jsonb,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_shadow_paged_link_history(uuid,uuid,bigint),public.warpcore_shadow_paged_link_reserve(uuid,uuid,bigint,text,numeric,text),public.warpcore_shadow_paged_link_commit(uuid,uuid,bigint,jsonb,text,jsonb) to service_role;
commit;
