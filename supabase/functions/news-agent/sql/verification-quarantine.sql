-- Explicit owner action only. Unknown billing remains held; no dispatch or activation.
begin;
alter table shadow_agent.verification_jobs add column if not exists quarantined boolean not null default false;
create table shadow_agent.verification_quarantine_audit(
 job_id uuid primary key references shadow_agent.verification_jobs(id),
 attempt_id uuid not null unique references shadow_agent.attempts(id),
 run_id uuid not null references shadow_agent.runs(id),revision bigint not null,
 request_hash text not null,job_before jsonb not null,run_before jsonb not null,
 attempt_before jsonb not null,budget_before jsonb not null,unknown_audit jsonb not null,
 billing_status text not null default 'unknown_held' check(billing_status='unknown_held'),
 held_credits numeric not null check(held_credits>0),spent_credits numeric not null check(spent_credits>=0),
 replacement_model text not null,reason text not null,
 performed_at timestamptz not null default clock_timestamp(),performed_by text not null default session_user
);
alter table shadow_agent.verification_quarantine_audit enable row level security;
revoke all on shadow_agent.verification_quarantine_audit from public,anon,authenticated,service_role;
create function shadow_agent.verification_quarantine_immutable() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Verification quarantine audit immutable';end $$;
create trigger verification_quarantine_immutable before update or delete on shadow_agent.verification_quarantine_audit
for each row execute function shadow_agent.verification_quarantine_immutable();
create function shadow_agent.verification_quarantined_job_fence() returns trigger
language plpgsql set search_path='' as $$
begin
 if old.quarantined then raise exception 'Quarantined verification job cannot change';end if;
 return new;
end $$;
create trigger verification_quarantined_job_fence before update or delete on shadow_agent.verification_jobs
for each row execute function shadow_agent.verification_quarantined_job_fence();
create function shadow_agent.verification_quarantined_run_fence() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from shadow_agent.verification_jobs where child_run_id=old.id and quarantined)
 and row(new.state,new.revision,new.lease_token,new.lease_until,new.limit_credits)
 is distinct from row(old.state,old.revision,old.lease_token,old.lease_until,old.limit_credits)
 then raise exception 'Quarantined verification workflow cannot resume';end if;
 -- held/spent/blocked may change ONLY through existing authorized financial paths.
 return new;
end $$;
create trigger verification_quarantined_run_fence before update on shadow_agent.runs
for each row execute function shadow_agent.verification_quarantined_run_fence();
create function shadow_agent.quarantine_verification_job(p_job uuid,p_attempt uuid,p_revision bigint,p_reason text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j shadow_agent.verification_jobs;r shadow_agent.runs;a shadow_agent.attempts;b shadow_agent.budgets;x jsonb;model_id text;approved jsonb;
begin
 if p_reason is null or length(btrim(p_reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) not between 1 and 1000
 or p_reason ~ U&'[\0001-\001F\007F-\009F]' then raise exception 'Explicit quarantine reason required';end if;
 perform shadow_agent.verification_lock();
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('warpcore_shared_admission_v1',0)) then
  raise exception using errcode='55P03',message='Shared admission busy';end if;
 -- Freeze reviewed runtime selection until this transaction ends.
 select model into model_id from shadow_agent.runtime_settings where singleton for share nowait;
 approved:=shadow_agent.approved_runtime_model(model_id);
 if approved is null or approved->>'model' is distinct from model_id then raise exception 'Reviewed active runtime model required';end if;
 select * into j from shadow_agent.verification_jobs where id=p_job;
 if not found or j.quarantined then return null;end if;
 -- Follow accounting's budget -> run -> attempt order. Job identity is stable
 -- under the shared verification lock; no financial values are rewritten.
 select * into b from shadow_agent.budgets where day=(select day from shadow_agent.attempts where id=p_attempt and run_id=j.child_run_id) for update;
 select * into r from shadow_agent.runs where id=j.child_run_id for update;
 if not found or p_revision is null or r.revision is distinct from p_revision then return null;end if;
 select * into a from shadow_agent.attempts where id=p_attempt and run_id=j.child_run_id for update;
 if not found then return null;end if;
 if j.status is distinct from 'uncertain' then raise exception 'Uncertain verification job required';end if;
 if jsonb_typeof(j.metadata->'model') is distinct from 'string' or j.metadata->>'model'=model_id then raise exception 'Different reviewed active model required';end if;
 if r.state->>'storageKind' is distinct from 'verification-v1' or r.state->>'runId' is distinct from r.id::text
 or r.state->'revision' is distinct from to_jsonb(r.revision) or r.state->'publishingEnabled' is distinct from 'false'::jsonb
 then raise exception 'Invalid verification workflow snapshot';end if;
 if a.status<>'uncertain' or a.actual is not null or (select count(*) from shadow_agent.attempts where run_id=r.id)<>1
 or exists(select 1 from shadow_agent.verification_audit where job_id=p_job and status='settled')
 then raise exception 'Exactly one unknown unsettled attempt required';end if;
 if a.reserved<=0 or r.held_credits is distinct from a.reserved or b.held_credits is null or b.held_credits<a.reserved then raise exception 'Full unknown hold required';end if;
 if j.receipt_id is not null or j.handoff_inbox_id is not null
 or exists(select 1 from agent_verification.receipts where material->>'storyKey'=j.story_key)
 or exists(select 1 from public.warpcore_curator_inbox where story_key=j.story_key)
 or exists(select 1 from public.warpcore_publications where story_key=j.story_key)
 then raise exception 'Receipt or inbox/publication already exists';end if;
 select audit into x from shadow_agent.verification_audit where job_id=p_job and status='uncertain';
 if not found or x ? 'usage' or not coalesce(x->>'errorCode'='timeout'
 or (x->>'errorCode'='http_failure' and x->'diagnostic'->'httpStatus'='429'::jsonb),false)
 then raise exception 'Recorded timeout or HTTP 429 required';end if;
 insert into shadow_agent.verification_quarantine_audit(job_id,attempt_id,run_id,revision,request_hash,job_before,run_before,attempt_before,budget_before,unknown_audit,held_credits,spent_credits,replacement_model,reason)
 values(j.id,a.id,r.id,r.revision,a.request_hash,to_jsonb(j),to_jsonb(r),to_jsonb(a),to_jsonb(b),x,r.held_credits,r.spent_credits,model_id,p_reason);
 update shadow_agent.verification_jobs set quarantined=true where id=j.id and not quarantined;
 return jsonb_build_object('jobId',j.id,'attemptId',a.id,'quarantined',true,'billingStatus','unknown_held');
end $$;
revoke all on function shadow_agent.verification_quarantine_immutable(),shadow_agent.verification_quarantined_job_fence(),shadow_agent.verification_quarantined_run_fence(),shadow_agent.quarantine_verification_job(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
commit;
