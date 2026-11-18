begin;
-- Match the worker's reviewed GAIA repository; retain every receipt binding.
do $$
declare definition text; old_pattern constant text:='(lemonade-sdk/lemonade|ROCm/TheRock|';new_pattern constant text:='(amd/gaia|lemonade-sdk/lemonade|ROCm/TheRock|';
begin
 select pg_get_functiondef('public.warpcore_agent_issue_receipt(jsonb)'::regprocedure) into definition;
 if position(new_pattern in definition)>0 then return;end if;
 if position(old_pattern in definition)=0 then raise exception 'Unexpected GitHub receipt guard';end if;
 execute replace(definition,old_pattern,new_pattern);
end $$;
commit;
