begin;
-- Continue the existing queue after useful work, without another schedule.
-- pg_net starts only after commit; existing job leases prevent duplicate work.
create function public.warpcore_worker_continue() returns bigint
language plpgsql security definer set search_path='' as $$
begin
 if not coalesce((select enabled from shadow_agent.producer_settings where singleton),false) then return null;end if;
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('warpcore_worker_continue',0)) then return null;end if;
 -- Do not spin while a receipt is being curated/published. Its terminal state
 -- change wakes us below. Uncertain sends still require reconciliation.
 if exists(select 1 from public.warpcore_curator_inbox where state in ('pending','leased'))
 or exists(select 1 from public.warpcore_publications where state in ('prepared','sending','uncertain','manual_review')) then return null;end if;
 if not exists(select 1 from shadow_agent.next_verification_candidate())
 and not exists(select 1 from shadow_agent.verification_jobs where not quarantined and
  (status='pending' or status='verified' and handoff_status='pending'))
 and coalesce((shadow_agent.queue_summary()->>'waiting')::bigint,0)=0
 and not exists(select 1 from shadow_agent.runs where not blocked and state->>'storageKind'='paged-v1'
  and state->>'phase' in ('scan','review')) then return null;end if;
 -- Intentionally bypass the scheduler's minute bucket: this is a continuation
 -- of completed work, not a second timer. Keep the existing protected route.
 return shadow_agent.alerting_enqueue();
end $$;
revoke all on function public.warpcore_worker_continue() from public,anon,authenticated;
grant execute on function public.warpcore_worker_continue() to service_role;
create function shadow_agent.worker_after_terminal() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.state is distinct from old.state and (
  tg_table_name='warpcore_publications' and new.state in ('published','rejected')
  or tg_table_name='warpcore_curator_inbox' and new.state='rejected') then
  perform public.warpcore_worker_continue();
 end if;
 return new;
exception when others then
 -- Never roll back a published post or rejected item if dispatch is unavailable.
 -- The existing sync remains the recovery wake-up.
 return new;
end $$;
revoke all on function shadow_agent.worker_after_terminal() from public,anon,authenticated,service_role;
create trigger warpcore_worker_after_publication after update of state on public.warpcore_publications
 for each row execute function shadow_agent.worker_after_terminal();
create trigger warpcore_worker_after_rejection after update of state on public.warpcore_curator_inbox
 for each row execute function shadow_agent.worker_after_terminal();
commit;
