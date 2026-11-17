-- Optional continuation handoff only. No checkpoint, budget or attempt mutation.
-- Install after shadow-state and shadow-paged; worker execution is service-only.
begin;
create function shadow_agent.release(p_run uuid,p_lease uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare r shadow_agent.runs;
begin
 select * into r from shadow_agent.runs where id=p_run for update;
 if not found or p_lease is null or r.lease_token is distinct from p_lease
 or r.lease_until is null or r.lease_until<=clock_timestamp()
 or r.state->>'storageKind' is distinct from 'paged-v1'
 or not coalesce(r.state->>'phase' in ('scan','review','complete'),false)
 or r.state->'activeBatch' is distinct from 'null'::jsonb
 or exists(select 1 from shadow_agent.attempts where run_id=p_run and status<>'settled')
 then return false;end if;
 update shadow_agent.runs set lease_token=null,lease_until=null where id=p_run and lease_token=p_lease;
 return true;
end $$;
create function public.warpcore_shadow_release(p_run uuid,p_lease uuid) returns boolean
language sql security definer set search_path='' as $$
 select shadow_agent.release(p_run,p_lease)
$$;
revoke all on function shadow_agent.release(uuid,uuid),public.warpcore_shadow_release(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function shadow_agent.release(uuid,uuid),public.warpcore_shadow_release(uuid,uuid) to service_role;
commit;
