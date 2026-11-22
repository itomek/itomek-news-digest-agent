-- Repair only the known malformed live policy comparison. No producer settings,
-- queue rows, leases, budgets or publication records are changed.
begin;
do $repair$
declare definition text; broken text; matches integer; valid_count integer;
begin
 select pg_get_functiondef('public.warpcore_shadow_select_run()'::regprocedure) into definition;
 select count(*) into matches from regexp_matches(definition,$pattern$settings\.policy_version[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+'2026-11-19\.1'[[:space:]]*,[[:space:]]*'2026-11-21\.1'(?=[[:space:]]+then)$pattern$,'gi');
 if matches=1 then
  broken:=(regexp_match(definition,$pattern$settings\.policy_version[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+'2026-11-19\.1'[[:space:]]*,[[:space:]]*'2026-11-21\.1'(?=[[:space:]]+then)$pattern$,'i'))[1];
  -- CREATE OR REPLACE from pg_get_functiondef retains OID, owner and ACL.
  execute replace(definition,broken,'settings.policy_version is distinct from ''2026-11-21.1''');
 elsif matches=0 then
  select count(*) into valid_count from regexp_matches(definition,$pattern$settings\.policy_version[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+'2026-11-21\.1'(?=[[:space:]]+then)$pattern$,'gi');
  if valid_count=1 then return;end if;
  -- A clean install may already carry the repository's approved IN-list guard.
  select count(*) into valid_count from regexp_matches(definition,$pattern$settings\.policy_version[[:space:]]+not[[:space:]]+in[[:space:]]*\([[:space:]]*'2026-11-14\.1'[[:space:]]*,[[:space:]]*'2026-11-18\.1'[[:space:]]*,[[:space:]]*'2026-11-18\.2'[[:space:]]*,[[:space:]]*'2026-11-19\.1'[[:space:]]*,[[:space:]]*'2026-11-21\.1'[[:space:]]*\)$pattern$,'gi');
  if valid_count<>1 then raise exception 'Unexpected selector policy guard; manual review required';end if;
 else raise exception 'Unexpected selector policy guard; manual review required';end if;
end $repair$;
commit;
