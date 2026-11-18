begin;
alter table shadow_agent.verification_jobs add column outcome_reason text
 check(outcome_reason is null or outcome_reason ~ '^[a-z_]{1,80}$');
-- Preserve the original fenced finish contract; record only a sanitized outcome code.
create function public.warpcore_verification_finish(p_job uuid,p_lease uuid,p_status text,p_receipt uuid,p_reason text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if p_reason is not null and p_reason !~ '^[a-z_]{1,80}$' then raise exception 'Invalid outcome reason';end if;
 if not public.warpcore_verification_finish(p_job,p_lease,p_status,p_receipt) then return false;end if;
 update shadow_agent.verification_jobs set outcome_reason=p_reason where id=p_job;
 return true;
end $$;
revoke all on function public.warpcore_verification_finish(uuid,uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.warpcore_verification_finish(uuid,uuid,text,uuid,text) to service_role;
do $$
declare definition text;
begin
 if exists(select 1 from shadow_agent.runs where state->>'storageKind'='paged-v1' and state->>'phase' in ('scan','review','reviewing')) then raise exception 'Drain discovery before editorial cutover';end if;
 select pg_get_functiondef('public.warpcore_shadow_select_run()'::regprocedure) into definition;
 if position('2026-11-14.1' in definition)=0 then raise exception 'Unexpected producer policy version';end if;
 execute replace(definition,'2026-11-14.1','2026-11-18.1');
 update shadow_agent.producer_settings set policy_version='2026-11-18.1' where singleton;
 update shadow_agent.runtime_settings set allowed_source_hosts=(select array_agg(distinct host order by host) from unnest(allowed_source_hosts||array['api.github.com','developer.nvidia.com']) host) where singleton;
end $$;
commit;
