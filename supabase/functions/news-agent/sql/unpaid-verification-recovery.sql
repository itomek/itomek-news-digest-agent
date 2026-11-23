-- Install after verification-jobs, outcome reasons, and reliability health clocks.
-- Reopens source acquisition only: never retries any run with a paid attempt.
begin;
create table shadow_agent.verification_source_retry_audit(
 job_id uuid not null references shadow_agent.verification_jobs(id),
 retry_number integer not null check(retry_number between 1 and 3),
 outcome_reason text not null check(outcome_reason in ('source_timeout','source_transport_failure','source_http_failure')),
 failed_at timestamptz not null,retried_at timestamptz not null default clock_timestamp(),
 revision_before bigint not null,revision_after bigint not null check(revision_after=revision_before+1),
 job_before jsonb not null,run_before jsonb not null,
 primary key(job_id,retry_number)
);
alter table shadow_agent.verification_source_retry_audit enable row level security;
revoke all on shadow_agent.verification_source_retry_audit from public,anon,authenticated,service_role;
create function shadow_agent.verification_source_retry_immutable() returns trigger
language plpgsql set search_path='' as $$begin raise exception 'Verification source retry audit immutable';end $$;
create trigger verification_source_retry_immutable before update or delete on shadow_agent.verification_source_retry_audit for each row execute function shadow_agent.verification_source_retry_immutable();
revoke all on function shadow_agent.verification_source_retry_immutable() from public,anon,authenticated,service_role;
-- Read-only eligibility. Unknown/old creation clocks cannot bootstrap retries.
-- Both the source failure clock and last retry enforce the minimum backoff.
create view shadow_agent.verification_source_retry_candidates with(security_invoker=true) as
 select j.id job_id,j.child_run_id,p.progressed_at failed_at,history.retry_count,
 greatest(p.progressed_at,history.last_retry_at)+interval '15 minutes' next_retry_at
 from shadow_agent.verification_jobs j join shadow_agent.runs r on r.id=j.child_run_id
 join shadow_agent.health_progress p on p.entity='verification_jobs' and p.entity_id=j.id::text
 cross join lateral (select count(*)::integer retry_count,max(a.retried_at) last_retry_at from shadow_agent.verification_source_retry_audit a where a.job_id=j.id) history
 where coalesce((select enabled from shadow_agent.producer_settings where singleton),false)
 and coalesce((select enabled from shadow_agent.verification_settings where singleton),false)
 and j.status='deferred' and not j.quarantined and j.outcome_reason in ('source_timeout','source_transport_failure','source_http_failure')
 and j.metadata is null and j.receipt_id is null and j.handoff_status='pending' and j.handoff_reason is null and j.handoff_inbox_id is null
 and not r.blocked and r.held_credits=0 and r.spent_credits=0
 and r.state->>'storageKind'='verification-v1' and r.state->>'runId'=r.id::text
 and r.state->>'phase'='deferred' and r.state->'revision'=to_jsonb(r.revision)
 and r.state->'activeBatch'='null'::jsonb and r.state->'publishingEnabled'='false'::jsonb
 and (r.lease_until is null or r.lease_until<=clock_timestamp())
 and p.created_at>=clock_timestamp()-interval '24 hours' and p.created_at<=clock_timestamp() and p.progressed_at is not null
 and history.retry_count<3
 and not exists(select 1 from shadow_agent.attempts a where a.run_id=r.id)
 and not exists(select 1 from shadow_agent.candidates held join shadow_agent.attempts a on a.run_id=held.run_id where held.candidate_id=j.story_key and a.status in ('reserved','dispatched','uncertain'))
 and not exists(select 1 from shadow_agent.verification_jobs sibling where sibling.id<>j.id and sibling.story_key=j.story_key and
  (sibling.status='uncertain' or exists(select 1 from shadow_agent.attempts a where a.run_id=sibling.child_run_id)
   or exists(select 1 from shadow_agent.verification_audit a where a.job_id=sibling.id)))
 and not exists(select 1 from shadow_agent.verification_audit a where a.job_id=j.id)
 and not exists(select 1 from agent_verification.receipts receipt where receipt.material->>'storyKey'=j.story_key)
 and not exists(select 1 from public.warpcore_curator_inbox i where i.story_key=j.story_key)
 and not exists(select 1 from public.warpcore_publications publication where publication.story_key=j.story_key)
 and not exists(select 1 from public.warpcore_curator_inbox i where i.state in ('pending','leased'))
 and not exists(select 1 from public.warpcore_publications publication where publication.state in ('prepared','sending','uncertain','manual_review'));
revoke all on shadow_agent.verification_source_retry_candidates from public,anon,authenticated,service_role;
create function shadow_agent.unpaid_verification_retry_available() returns boolean
language sql stable security invoker set search_path='' as $$
 select not exists(select 1 from shadow_agent.verification_jobs where status='pending' and not quarantined)
 and exists(select 1 from shadow_agent.verification_source_retry_candidates where next_retry_at<=clock_timestamp())
$$;
revoke all on function shadow_agent.unpaid_verification_retry_available() from public,anon,authenticated,service_role;
create function shadow_agent.advance_unpaid_verification_retry() returns uuid
language plpgsql security definer set search_path='' as $$
declare candidate record;j shadow_agent.verification_jobs;r shadow_agent.runs;
begin
 -- All ordinary verification reserve/finish/claim operations share this lock.
 perform shadow_agent.verification_lock();
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('warpcore_shared_admission_v1',0)) then return null;end if;
 if not shadow_agent.unpaid_verification_retry_available() or not shadow_agent.verification_queue_has_capacity() then return null;end if;
 select * into candidate from shadow_agent.verification_source_retry_candidates where next_retry_at<=clock_timestamp() order by next_retry_at,job_id limit 1;
 if not found then return null;end if;
 -- Financial paths lock the child before creating an attempt; re-read every
 -- safety predicate after that lock to fence a concurrent reservation.
 select * into r from shadow_agent.runs where id=candidate.child_run_id for update;
 select * into j from shadow_agent.verification_jobs where id=candidate.job_id for update;
 select * into candidate from shadow_agent.verification_source_retry_candidates where job_id=j.id and next_retry_at<=clock_timestamp();
 if not found then return null;end if;
 insert into shadow_agent.verification_source_retry_audit(job_id,retry_number,outcome_reason,failed_at,revision_before,revision_after,job_before,run_before)
 values(j.id,candidate.retry_count+1,j.outcome_reason,candidate.failed_at,r.revision,r.revision+1,to_jsonb(j),to_jsonb(r));
 update shadow_agent.runs set revision=r.revision+1,
 state=r.state||jsonb_build_object('revision',r.revision+1,'phase','reviewing','activeBatch',jsonb_build_array(j.story_key)),
 lease_token=null,lease_until=null where id=r.id and revision=r.revision;
 if not found then raise exception 'Unpaid retry revision changed';end if;
 update shadow_agent.verification_jobs set status='pending',outcome_reason=null where id=j.id;
 return j.id;
end $$;
revoke all on function shadow_agent.advance_unpaid_verification_retry() from public,anon,authenticated,service_role;
-- Surgical hooks retain the installed selector's policy guard, OID, grants and
-- unrelated gates. Unknown function shapes abort the entire installation.
do $hooks$
declare definition text;anchor text;hook text;
begin
 select pg_get_functiondef('public.warpcore_verification_claim()'::regprocedure) into definition;
 anchor:=' select * into j from shadow_agent.verification_jobs where status=''pending'' and not quarantined order by id limit 1;';
 hook:=' if to_regprocedure(''shadow_agent.advance_unpaid_verification_retry()'') is not null then perform shadow_agent.advance_unpaid_verification_retry();end if;';
 if position(hook in definition)=0 then
  if (length(definition)-length(replace(definition,anchor,'')))<>length(anchor) then raise exception 'Unexpected verification claim shape';end if;
  execute replace(definition,anchor,hook||E'\n'||anchor);
 end if;
 select pg_get_functiondef('public.warpcore_shadow_select_run()'::regprocedure) into definition;
 anchor:=' -- Complete selected work before taking another waiting-list batch. Optional';
 hook:=' if to_regprocedure(''shadow_agent.unpaid_verification_retry_available()'') is not null then if shadow_agent.unpaid_verification_retry_available() then return null;end if;end if;';
 if position(hook in definition)=0 then
  if (length(definition)-length(replace(definition,anchor,'')))<>length(anchor) then raise exception 'Unexpected producer selector shape';end if;
  execute replace(definition,anchor,hook||E'\n'||anchor);
 end if;
end $hooks$;
commit;
