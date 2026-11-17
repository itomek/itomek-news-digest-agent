-- Explicit owner-only workflow quarantine. This NEVER resolves unknown billing,
-- releases a reservation, retries a request, or enables any producer/model.
begin;
create table shadow_agent.billing_quarantine_audit(
 id uuid primary key default gen_random_uuid(),run_id uuid not null unique references shadow_agent.runs(id),
 attempt_id uuid not null unique references shadow_agent.attempts(id),
 revision_before bigint not null,revision_after bigint not null,
 state_before jsonb not null,state_after jsonb not null,
 billing_status text not null default 'unknown_held' check(billing_status='unknown_held'),
 reserved_credits numeric not null check(reserved_credits>0),
 held_credits numeric not null check(held_credits>0),spent_credits numeric not null check(spent_credits>=0),
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 performed_at timestamptz not null default clock_timestamp(),performed_by text not null default session_user
);
alter table shadow_agent.billing_quarantine_audit enable row level security;
revoke all on shadow_agent.billing_quarantine_audit from public,anon,authenticated,service_role;
create function shadow_agent.billing_quarantine_immutable() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Billing quarantine audit immutable';end $$;
create trigger billing_quarantine_immutable before update or delete on shadow_agent.billing_quarantine_audit for each row execute function shadow_agent.billing_quarantine_immutable();
-- Existing claim() predates workflow quarantine and does not inspect blocked.
-- This additive fence prevents every lease/checkpoint/unblock mutation, while
-- leaving the existing original-token late financial settlement path intact.
create function shadow_agent.quarantined_workflow_fence() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from shadow_agent.billing_quarantine_audit where run_id=old.id)
 and row(new.state,new.revision,new.blocked,new.lease_token,new.lease_until)
 is distinct from row(old.state,old.revision,old.blocked,old.lease_token,old.lease_until)
 then raise exception 'Quarantined workflow cannot resume; billing remains held';end if;
 return new;
end $$;
create trigger quarantined_workflow_fence before update on shadow_agent.runs for each row execute function shadow_agent.quarantined_workflow_fence();
create function shadow_agent.quarantine_rate_limited_run(p_run uuid,p_revision bigint,p_reason text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r shadow_agent.runs;a shadow_agent.attempts;x jsonb;next_state jsonb;captured bigint;reviewed bigint;
begin
 if p_reason is null or length(btrim(p_reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) not between 1 and 1000
 or p_reason ~ U&'[\0001-\001F\007F-\009F]' then raise exception 'Explicit quarantine reason required';end if;
 -- Match financial accounting's budget -> run -> attempt order. No financial
 -- values are changed; locks prevent late accounting racing this audit snapshot.
 perform 1 from shadow_agent.budgets where day in (select day from shadow_agent.attempts where run_id=p_run) order by day for update;
 select * into r from shadow_agent.runs where id=p_run for update;
 if not found or p_revision is null or r.revision is distinct from p_revision then return null;end if;
 if r.state->>'storageKind' is distinct from 'paged-v1' or r.state->>'phase' is distinct from 'uncertain'
 or r.state->'revision' is distinct from to_jsonb(r.revision) or r.state->>'runId' is distinct from p_run::text
 or r.state->'publishingEnabled' is distinct from 'false'::jsonb
 or jsonb_typeof(r.state->'activeBatch') is distinct from 'array' or jsonb_array_length(r.state->'activeBatch') not between 1 and 100
 or coalesce(r.state->>'candidateCount','') !~ '^[0-9]+$' or coalesce(r.state->>'reviewedCount','') !~ '^[0-9]+$'
 then raise exception 'Not an uncertain paged workflow';end if;
 captured:=(r.state->>'candidateCount')::bigint;reviewed:=(r.state->>'reviewedCount')::bigint;
 if reviewed>=captured or reviewed+jsonb_array_length(r.state->'activeBatch')>captured
 or (select count(*) from shadow_agent.candidates where run_id=p_run)<>captured
 or exists(select 1 from shadow_agent.candidates where run_id=p_run and ordinal>=captured)
 or (select jsonb_agg(candidate_id order by ordinal) from shadow_agent.candidates where run_id=p_run and ordinal>=reviewed and ordinal<reviewed+jsonb_array_length(r.state->'activeBatch')) is distinct from r.state->'activeBatch'
 or (select count(*) from shadow_agent.decisions where run_id=p_run)<>reviewed
 or exists(select 1 from shadow_agent.decisions where run_id=p_run and ordinal>=reviewed)
 then raise exception 'Incomplete workflow history cannot quarantine';end if;
 if (select count(*) from shadow_agent.attempts where run_id=p_run and status='uncertain')<>1
 or exists(select 1 from shadow_agent.attempts where run_id=p_run and status in ('reserved','dispatched'))
 or exists(select 1 from shadow_agent.attempts t where t.run_id=p_run and t.status='settled' and
 (t.actual is null or t.actual<0 or not exists(select 1 from shadow_agent.attempt_audit audit where audit.attempt_id=t.id and audit.status='settled'
 and jsonb_typeof(audit.audit->'usage'->'costCredits')='number' and (audit.audit->'usage'->>'costCredits')::numeric=t.actual)))
 then raise exception 'Exactly one audited unknown attempt required';end if;
 select * into a from shadow_agent.attempts where run_id=p_run order by checkpoint_revision desc limit 1 for update;
 if not found or a.status<>'uncertain' or a.actual is not null or a.checkpoint_revision<>r.revision-1
 or r.held_credits is distinct from a.reserved
 or not exists(select 1 from shadow_agent.budgets where day=a.day and held_credits>=a.reserved)
 or exists(select 1 from shadow_agent.attempt_audit where attempt_id=a.id and status='settled')
 then raise exception 'Full unknown reservation must remain held';end if;
 select audit into x from shadow_agent.attempt_audit where attempt_id=a.id and status='uncertain';
 if not found or x->>'errorCode' is distinct from 'http_failure'
 or x->'diagnostic'->'httpStatus' is distinct from '429'::jsonb
 or x ? 'usage' then raise exception 'Recorded HTTP 429 required; other unknowns cannot quarantine';end if;
 if exists(select 1 from shadow_agent.ranking_runs where run_id=p_run and (assessed_count<>reviewed or finalized_at is not null))
 or exists(select 1 from shadow_agent.selection_items where run_id=p_run) then raise exception 'Invalid incomplete ranking history';end if;
 next_state:=r.state||jsonb_build_object('phase','deferred','activeBatch','null'::jsonb,'revision',p_revision+1);
 update shadow_agent.runs set state=next_state,revision=revision+1,blocked=true,lease_token=null,lease_until=null where id=p_run and revision=p_revision;
 insert into shadow_agent.billing_quarantine_audit(run_id,attempt_id,revision_before,revision_after,state_before,state_after,reserved_credits,held_credits,spent_credits,reason)
 values(p_run,a.id,p_revision,p_revision+1,r.state,next_state,a.reserved,r.held_credits,r.spent_credits,p_reason);
 return next_state;
end $$;
-- A timed-out discovery remains financially unknown; only explicit owner action
-- can terminally fence its incomplete workflow without replaying the attempt.
create function shadow_agent.quarantine_timed_out_run(p_run uuid,p_revision bigint,p_reason text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r shadow_agent.runs;a shadow_agent.attempts;x jsonb;next_state jsonb;captured bigint;reviewed bigint;
begin
 if p_reason is null or length(btrim(p_reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) not between 1 and 1000
 or p_reason ~ U&'[\0001-\001F\007F-\009F]' then raise exception 'Explicit quarantine reason required';end if;
 -- Match financial accounting's budget -> run -> attempt order. No financial
 -- values are changed; locks prevent late accounting racing this audit snapshot.
 perform 1 from shadow_agent.budgets where day in (select day from shadow_agent.attempts where run_id=p_run) order by day for update;
 select * into r from shadow_agent.runs where id=p_run for update;
 if not found or p_revision is null or r.revision is distinct from p_revision then return null;end if;
 if r.state->>'storageKind' is distinct from 'paged-v1' or r.state->>'phase' is distinct from 'uncertain'
 or r.state->'revision' is distinct from to_jsonb(r.revision) or r.state->>'runId' is distinct from p_run::text
 or r.state->'publishingEnabled' is distinct from 'false'::jsonb
 or jsonb_typeof(r.state->'activeBatch') is distinct from 'array' or jsonb_array_length(r.state->'activeBatch') not between 1 and 100
 or coalesce(r.state->>'candidateCount','') !~ '^[0-9]+$' or coalesce(r.state->>'reviewedCount','') !~ '^[0-9]+$'
 then raise exception 'Not an uncertain paged workflow';end if;
 captured:=(r.state->>'candidateCount')::bigint;reviewed:=(r.state->>'reviewedCount')::bigint;
 if reviewed>=captured or reviewed+jsonb_array_length(r.state->'activeBatch')>captured
 or (select count(*) from shadow_agent.candidates where run_id=p_run)<>captured
 or exists(select 1 from shadow_agent.candidates where run_id=p_run and ordinal>=captured)
 or (select jsonb_agg(candidate_id order by ordinal) from shadow_agent.candidates where run_id=p_run and ordinal>=reviewed and ordinal<reviewed+jsonb_array_length(r.state->'activeBatch')) is distinct from r.state->'activeBatch'
 or (select count(*) from shadow_agent.decisions where run_id=p_run)<>reviewed
 or exists(select 1 from shadow_agent.decisions where run_id=p_run and ordinal>=reviewed)
 then raise exception 'Incomplete workflow history cannot quarantine';end if;
 if (select count(*) from shadow_agent.attempts where run_id=p_run and status='uncertain')<>1
 or exists(select 1 from shadow_agent.attempts where run_id=p_run and status in ('reserved','dispatched'))
 or exists(select 1 from shadow_agent.attempts t where t.run_id=p_run and t.status='settled' and
 (t.actual is null or t.actual<0 or not exists(select 1 from shadow_agent.attempt_audit audit where audit.attempt_id=t.id and audit.status='settled'
 and jsonb_typeof(audit.audit->'usage'->'costCredits')='number' and (audit.audit->'usage'->>'costCredits')::numeric=t.actual)))
 then raise exception 'Exactly one audited unknown attempt required';end if;
 select * into a from shadow_agent.attempts where run_id=p_run order by checkpoint_revision desc limit 1 for update;
 if not found or a.status<>'uncertain' or a.actual is not null or a.checkpoint_revision<>r.revision-1
 or r.held_credits is distinct from a.reserved
 or not exists(select 1 from shadow_agent.budgets where day=a.day and held_credits>=a.reserved)
 or exists(select 1 from shadow_agent.attempt_audit where attempt_id=a.id and status='settled')
 then raise exception 'Full unknown reservation must remain held';end if;
 select audit into x from shadow_agent.attempt_audit where attempt_id=a.id and status='uncertain';
 if not found or x is distinct from '{"errorCode":"timeout"}'::jsonb then raise exception 'Recorded timeout required; other unknowns cannot quarantine';end if;
 if exists(select 1 from shadow_agent.ranking_runs where run_id=p_run and (assessed_count<>reviewed or finalized_at is not null))
 or exists(select 1 from shadow_agent.selection_items where run_id=p_run) then raise exception 'Invalid incomplete ranking history';end if;
 next_state:=r.state||jsonb_build_object('phase','deferred','activeBatch','null'::jsonb,'revision',p_revision+1);
 update shadow_agent.runs set state=next_state,revision=revision+1,blocked=true,lease_token=null,lease_until=null where id=p_run and revision=p_revision;
 insert into shadow_agent.billing_quarantine_audit(run_id,attempt_id,revision_before,revision_after,state_before,state_after,reserved_credits,held_credits,spent_credits,reason)
 values(p_run,a.id,p_revision,p_revision+1,r.state,next_state,a.reserved,r.held_credits,r.spent_credits,p_reason);
 return next_state;
end $$;
revoke all on function shadow_agent.billing_quarantine_immutable(),shadow_agent.quarantined_workflow_fence(),shadow_agent.quarantine_rate_limited_run(uuid,bigint,text),shadow_agent.quarantine_timed_out_run(uuid,bigint,text) from public,anon,authenticated,service_role;
commit;
