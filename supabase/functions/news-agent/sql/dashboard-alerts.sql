-- Authenticated dashboard projection only. No activation, refresh, cron or HTTP.
begin;
do $$begin
 if to_regclass('shadow_agent.alert_settings') is null or to_regclass('shadow_agent.alert_state') is null then raise exception 'Installed private agent alerts required';end if;
end $$;
create function public.warpcore_agent_active_alerts() returns jsonb
language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('code',code,'message',message,'changedAt',changed_at,'affectedCount',least(affected_count,2147483647)) order by changed_at desc,code),'[]'::jsonb)
 from (
  select a.code,a.changed_at,a.affected_count,case a.code
   when 'discovery_stalled' then 'News review has stopped making progress.'
   when 'source_attempt_outage' then 'A news source has not been checked recently.'
   when 'source_failed' then 'A news source could not be refreshed.'
   when 'budget_unavailable' then 'News review is paused because its spending allowance is unavailable.'
   when 'accounting_uncertain' then 'A model request has unresolved billing.'
   when 'verification_uncertain' then 'A verification request needs reconciliation.'
   when 'publication_reconciliation' then 'A publishing attempt needs reconciliation before it can continue.'
   when 'handoff_deferred' then 'Verified news could not move to the publishing queue.'
   when 'handoff_stalled' then 'Verified news is waiting to enter the publishing queue.'
   when 'scheduler_http_failure' then 'A scheduled news-agent request failed.'
   when 'scheduler_response_unavailable' then 'The result of a scheduled news-agent request is unavailable.'
   when 'scheduler_enqueue_failed' then 'The next news-agent check could not be scheduled.'
   when 'lifetime_headroom_exhausted' then 'News review is paused because its approved spending allowance has been reached.'
   when 'queue_above_limit' then 'The publishing queue needs attention before more news can be added.'
  end as message
  from shadow_agent.alert_state a
  where a.active and coalesce((select enabled from shadow_agent.alert_settings where singleton),false)
  and a.code in ('discovery_stalled','source_attempt_outage','source_failed','budget_unavailable','accounting_uncertain','verification_uncertain','publication_reconciliation','handoff_deferred','handoff_stalled','scheduler_http_failure','scheduler_response_unavailable','scheduler_enqueue_failed','lifetime_headroom_exhausted','queue_above_limit')
  order by a.changed_at desc,a.code limit 15
 ) bounded
$$;
revoke all on function public.warpcore_agent_active_alerts() from public,anon,authenticated,service_role;
grant execute on function public.warpcore_agent_active_alerts() to authenticated,service_role;
commit;
