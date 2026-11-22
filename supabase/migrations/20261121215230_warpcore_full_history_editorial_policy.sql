begin;
-- Pause the producer and drain active work before deploying the matching worker.
do $$
declare definition text; previous text; guard text; matches integer; strict_guard text;
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
 strict_guard:='settings.policy_version is distinct from '||quote_literal(previous);
 select count(*) into matches from regexp_matches(definition,$pattern$(?:settings\.)?policy_version[[:space:]]+(?:not[[:space:]]+)?in[[:space:]]*\([^)]*\)$pattern$,'gi');
 if position(strict_guard in definition)>0 and substring(definition from position(strict_guard in definition)+length(strict_guard)) ~ '^[[:space:]]+then' and matches=0
 and (length(definition)-length(replace(definition,strict_guard,'')))/length(strict_guard)=1 then
  -- A strict live guard admits one version; a comma list is not a boolean.
  execute replace(definition,strict_guard, 'settings.policy_version is distinct from '||quote_literal('2026-11-21.1'));
 elsif matches=1 and position(strict_guard in definition)=0 then
  guard:=(regexp_match(definition,$pattern$(?:settings\.)?policy_version[[:space:]]+(?:not[[:space:]]+)?in[[:space:]]*\([^)]*\)$pattern$,'i'))[1];
  if position(quote_literal(previous) in guard)=0 or position(quote_literal('2026-11-21.1') in guard)>0 then raise exception 'Unexpected selector policy guard';end if;
  -- Preserve the existing IN-list semantics and all unrelated function text.
  execute replace(definition,guard,replace(guard,quote_literal(previous),quote_literal(previous)||','||quote_literal('2026-11-21.1')));
 else raise exception 'Unexpected selector policy guard';end if;
 if to_regprocedure('shadow_agent.create_validation_run(text,numeric)') is not null then
  select pg_get_functiondef('shadow_agent.create_validation_run(text,numeric)'::regprocedure) into definition;
  execute replace(definition,'2026-11-19.1','2026-11-21.1');
 end if;
 update shadow_agent.producer_settings set policy_version='2026-11-21.1' where singleton;
end $$;
commit;
