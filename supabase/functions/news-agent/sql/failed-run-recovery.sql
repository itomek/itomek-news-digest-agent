-- Owner-only, explicit recovery. Never retries an attempt or changes accounting.
-- Requires normalized paged/audit/ranking/producer contracts; not an activation.
begin;
create table shadow_agent.run_recovery_audit(
 id uuid primary key default gen_random_uuid(),
 action text not null check(action in ('close_known_failed','create_validation')),
 run_id uuid not null references shadow_agent.runs(id),
 revision_before bigint,revision_after bigint not null,
 failed_attempt_id uuid references shadow_agent.attempts(id),
 state_before jsonb,state_after jsonb not null,
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 performed_at timestamptz not null default clock_timestamp(),
 performed_by text not null default session_user,
 unique(run_id,action)
);
alter table shadow_agent.run_recovery_audit enable row level security;
revoke all on shadow_agent.run_recovery_audit from public,anon,authenticated,service_role;
create function shadow_agent.recovery_audit_immutable() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Recovery audit immutable';end $$;
create trigger recovery_audit_immutable before update or delete on shadow_agent.run_recovery_audit for each row execute function shadow_agent.recovery_audit_immutable();
create function shadow_agent.adminclose_known_failed_run(p_run uuid,p_revision bigint,p_reason text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r shadow_agent.runs;a shadow_agent.attempts;x jsonb;next_state jsonb;captured bigint;reviewed bigint;
begin
 if p_reason is null or length(btrim(p_reason)) not between 1 and 1000 or p_reason ~ '[[:cntrl:]]' then raise exception 'Explicit recovery reason required';end if;
 select * into r from shadow_agent.runs where id=p_run for update;
 if not found or p_revision is null or r.revision is distinct from p_revision then return null;end if;
 if r.state->>'storageKind' is distinct from 'paged-v1' or r.state->>'phase' is distinct from 'uncertain'
 or r.state->'revision' is distinct from to_jsonb(r.revision) or r.state->>'runId' is distinct from p_run::text
 or r.state->'publishingEnabled' is distinct from 'false'::jsonb
 or jsonb_typeof(r.state->'activeBatch') is distinct from 'array' or jsonb_array_length(r.state->'activeBatch') not between 1 and 100
 or coalesce(r.state->>'candidateCount','') !~ '^[0-9]+$' or coalesce(r.state->>'reviewedCount','') !~ '^[0-9]+$'
 or r.held_credits<>0 then raise exception 'Not a known failed paged run';end if;
 captured:=(r.state->>'candidateCount')::bigint;reviewed:=(r.state->>'reviewedCount')::bigint;
 if reviewed>=captured or reviewed+jsonb_array_length(r.state->'activeBatch')>captured
 or exists(select 1 from shadow_agent.candidates where run_id=p_run and ordinal>=captured)
 or (select jsonb_agg(candidate_id order by ordinal) from shadow_agent.candidates where run_id=p_run and ordinal>=reviewed and ordinal<reviewed+jsonb_array_length(r.state->'activeBatch')) is distinct from r.state->'activeBatch'
 or (select count(*) from shadow_agent.candidates where run_id=p_run)<>captured
 or (select count(*) from shadow_agent.decisions where run_id=p_run)<>reviewed
 or exists(select 1 from shadow_agent.decisions where run_id=p_run and ordinal>=reviewed)
 or exists(select 1 from shadow_agent.attempts where run_id=p_run and (status<>'settled' or actual is null or actual<0))
 or exists(select 1 from shadow_agent.attempts t where t.run_id=p_run and not exists(select 1 from shadow_agent.attempt_audit audit where audit.attempt_id=t.id and audit.status='settled' and jsonb_typeof(audit.audit->'usage'->'costCredits')='number' and (audit.audit->'usage'->>'costCredits')::numeric=t.actual))
 then raise exception 'Incomplete accounting or history; unknown cost cannot close';end if;
 select * into a from shadow_agent.attempts where run_id=p_run order by checkpoint_revision desc limit 1;
 if not found or a.checkpoint_revision<>r.revision-1 then raise exception 'Latest failed checkpoint required';end if;
 select audit into x from shadow_agent.attempt_audit where attempt_id=a.id and status='settled';
 if not found or not coalesce(x->>'errorCode' in ('invalid_completion','invalid_decision_json','incomplete_decisions','invalid_decisions'),false)
 or jsonb_typeof(x->'usage'->'costCredits') is distinct from 'number'
 or (x->'usage'->>'costCredits')::numeric is distinct from a.actual then raise exception 'Known billed invalid completion required';end if;
 if exists(select 1 from shadow_agent.ranking_runs where run_id=p_run and (assessed_count<>reviewed or finalized_at is not null))
 or exists(select 1 from shadow_agent.selection_items where run_id=p_run) then raise exception 'Invalid unfinished ranking history';end if;
 next_state:=r.state||jsonb_build_object('phase','deferred','activeBatch','null'::jsonb,'revision',p_revision+1);
 update shadow_agent.runs set state=next_state,revision=revision+1 where id=p_run and revision=p_revision;
 insert into shadow_agent.run_recovery_audit(action,run_id,revision_before,revision_after,failed_attempt_id,state_before,state_after,reason)
 values('close_known_failed',p_run,p_revision,p_revision+1,a.id,r.state,next_state,p_reason);
 return next_state;
end $$;
create function shadow_agent.create_validation_run(p_reason text,p_limit numeric default 0.5) returns uuid
language plpgsql security invoker set search_path='' as $$
declare run_id uuid:=gen_random_uuid();stamp timestamptz:=clock_timestamp();initial jsonb;
begin
 if p_reason is null or length(btrim(p_reason)) not between 1 and 1000 or p_reason ~ '[[:cntrl:]]' then raise exception 'Explicit validation reason required';end if;
 if p_limit is null or not(p_limit>0 and p_limit<=0.5) then raise exception 'Validation limit must be positive and at most 0.5';end if;
 -- Never bypass a paid-uncertain or otherwise unfinished paged run. Serialize
 -- against the selector without inventing or editing a UTC-hour slot.
 perform 1 from shadow_agent.producer_settings where singleton for update;
 if exists(select 1 from shadow_agent.runs where state->>'storageKind'='paged-v1' and state->>'phase' in ('scan','review','reviewing','uncertain')) then raise exception 'Existing unfinished paged run';end if;
 initial:=jsonb_build_object('storageKind','paged-v1','runId',run_id::text,'scanStartedAt',to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'policyVersion',coalesce((select policy_version from shadow_agent.producer_settings where singleton),'2026-11-18.2'),'revision',0,'phase','scan','cursor',null,'candidateCount',0,'reviewedCount',0,'activeBatch',null,'publishingEnabled',false);
 insert into shadow_agent.runs(id,state,limit_credits) values(run_id,initial,p_limit);
 insert into shadow_agent.run_recovery_audit(action,run_id,revision_before,revision_after,state_after,reason)
 values('create_validation',run_id,null,0,initial,p_reason);
 return run_id;
end $$;
revoke all on function shadow_agent.recovery_audit_immutable(),shadow_agent.adminclose_known_failed_run(uuid,bigint,text),shadow_agent.create_validation_run(text,numeric) from public,anon,authenticated,service_role;
commit;
