begin;
-- Pause the producer and drain active work before deploying the matching worker.
do $$
declare definition text; previous text;
begin
 select policy_version into previous from shadow_agent.producer_settings where singleton for update;
 if previous not in ('2026-11-19.1') or previous is null then
  raise exception 'Unexpected producer policy version';
 end if;
 if exists(select 1 from shadow_agent.runs where state->>'storageKind'='paged-v1' and state->>'phase' in ('scan','review','reviewing')) then
  raise exception 'Drain discovery before editorial cutover';
 end if;
 if exists(select 1 from shadow_agent.producer_settings where singleton and enabled)
 or exists(select 1 from shadow_agent.runs where lease_until>clock_timestamp()) then
  raise exception 'Pause producer and drain leases before editorial cutover';
 end if;
 select pg_get_functiondef('public.warpcore_shadow_select_run()'::regprocedure) into definition;
 if position(previous in definition)=0 then raise exception 'Unexpected selector policy version';end if;
 execute replace(definition,quote_literal(previous),quote_literal(previous)||','||quote_literal('2026-11-21.1'));
 if to_regprocedure('shadow_agent.create_validation_run(text,numeric)') is not null then
  select pg_get_functiondef('shadow_agent.create_validation_run(text,numeric)'::regprocedure) into definition;
  execute replace(definition,'2026-11-19.1','2026-11-21.1');
 end if;
 update shadow_agent.producer_settings set policy_version='2026-11-21.1' where singleton;
end $$;
commit;
