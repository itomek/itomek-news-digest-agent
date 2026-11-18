begin;
-- Review/verification must agree on policy version. Do not orphan an active scan.
do $$
declare definition text;
begin
 -- The producer takes this same lock before creating a run. Acquire it before
 -- checking for active scans so no old-policy run can race the cutover.
 perform 1 from shadow_agent.producer_settings where singleton for update;
 if exists(select 1 from shadow_agent.runs where state->>'storageKind'='paged-v1' and state->>'phase' in ('scan','review','reviewing')) then raise exception 'Drain discovery before editorial cutover';end if;
 select pg_get_functiondef('public.warpcore_shadow_select_run()'::regprocedure) into definition;
 if position('2026-11-18.1' in definition)=0 then raise exception 'Unexpected producer policy version';end if;
 execute replace(definition,'2026-11-18.1','2026-11-18.2');
 if to_regprocedure('shadow_agent.create_validation_run(text,numeric)') is not null then
  select pg_get_functiondef('shadow_agent.create_validation_run(text,numeric)'::regprocedure) into definition;
  execute replace(definition,'2026-11-18.1','2026-11-18.2');
 end if;
 update shadow_agent.producer_settings set policy_version='2026-11-18.2' where singleton;
 -- Merge reviewed public verification hosts; retain every existing host.
 update shadow_agent.runtime_settings set allowed_source_hosts=(select array_agg(distinct host order by host) from unnest(allowed_source_hosts||array[
  'api-docs.deepseek.com','openclaw.ai','earendil.com','blog.jetbrains.com',
  'www.infoq.com','www.esa.int','spacenews.com','www.virgingalactic.com','x.ai'
 ]) host) where singleton;
end $$;
commit;
