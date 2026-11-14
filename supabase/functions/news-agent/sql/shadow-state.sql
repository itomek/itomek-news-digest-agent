-- EXPERIMENTAL SHADOW ONLY: deliberately outside migrations; never installs cron,
-- publisher hooks or network calls. Administrator provisions UTC daily budgets
-- and run limits. Amounts are OpenRouter credits, NOT assumed USD.
-- Checkpoints >2MB fail explicitly; normalized candidate persistence is needed
-- for larger full scans. Never truncate candidates to fit this prototype.
-- Lock order: daily budget, run, attempt. A reservation is single-use even when
-- dispatch is never confirmed. Unknown spend remains held for reconciliation.
begin;
create schema shadow_agent;
revoke all on schema shadow_agent from public,anon,authenticated,service_role;
create table shadow_agent.budgets (
 day date primary key, limit_credits numeric not null check(limit_credits>0 and limit_credits<1000000),
 held_credits numeric not null default 0 check(held_credits>=0),
 spent_credits numeric not null default 0 check(spent_credits>=0), blocked boolean not null default false
);
create table shadow_agent.runs (
 id uuid primary key, state jsonb not null, revision bigint not null default 0,
 limit_credits numeric not null check(limit_credits>0 and limit_credits<1000000),
 held_credits numeric not null default 0, spent_credits numeric not null default 0,
 blocked boolean not null default false, lease_token uuid, lease_until timestamptz
);
create table shadow_agent.attempts (
 id uuid primary key default gen_random_uuid(), run_id uuid not null references shadow_agent.runs,
 day date not null references shadow_agent.budgets, lease_token uuid not null,
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 reserved numeric not null check(reserved>0 and reserved<1000000),
 status text not null default 'reserved' check(status in ('reserved','dispatched','uncertain','settled')),
 actual numeric, checkpoint_revision bigint not null check(checkpoint_revision>=0),
 unique(run_id,request_hash), unique(run_id,checkpoint_revision)
);
alter table shadow_agent.budgets enable row level security;
alter table shadow_agent.runs enable row level security;
alter table shadow_agent.attempts enable row level security;
revoke all on all tables in schema shadow_agent from public,anon,authenticated,service_role;
create function shadow_agent.load(p_run uuid) returns jsonb
language sql security definer set search_path='' as $$
 select state from shadow_agent.runs where id=p_run
$$;
create function shadow_agent.claim(p_run uuid,p_seconds integer) returns uuid
language plpgsql security definer set search_path='' as $$
declare t uuid;
begin
 if p_seconds is null or p_seconds<1 or p_seconds>300 then raise exception 'Invalid lease duration'; end if;
 update shadow_agent.runs set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_seconds)
 where id=p_run and (lease_until is null or lease_until<=clock_timestamp()) returning lease_token into t;
 return t;
end $$;
create function shadow_agent.save(p_run uuid,p_lease uuid,p_revision bigint,p_next jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare old_state jsonb;
begin
 select state into old_state from shadow_agent.runs where id=p_run for update;
 if p_next is null or jsonb_typeof(p_next)<>'object' or p_next->>'runId' is distinct from p_run::text
 or p_next->'publishingEnabled' is distinct from 'false'::jsonb
 or p_next->'revision' is distinct from to_jsonb(p_revision+1)
 or p_next->'scanStartedAt' is distinct from old_state->'scanStartedAt'
 or p_next->'policyVersion' is distinct from old_state->'policyVersion'
 or octet_length(p_next::text)>2000000 then raise exception 'Invalid shadow state'; end if;
 update shadow_agent.runs set state=p_next,revision=revision+1 where id=p_run and revision=p_revision
 and lease_token=p_lease and lease_until>clock_timestamp();
 return found;
end $$;
create function shadow_agent.reserve(p_run uuid,p_lease uuid,p_hash text,p_max numeric) returns uuid
language plpgsql security definer set search_path='' as $$
declare b shadow_agent.budgets; r shadow_agent.runs; a uuid; d date:=(clock_timestamp() at time zone 'utc')::date;
begin
 if p_max is null or not(p_max>0 and p_max<1000000) or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid reservation'; end if;
 select * into b from shadow_agent.budgets where day=d for update;
 if not found then raise exception 'Missing daily budget'; end if;
 select * into r from shadow_agent.runs where id=p_run for update;
 if not found or r.lease_token is distinct from p_lease or p_lease is null or r.lease_until<=clock_timestamp() then raise exception 'Lease lost'; end if;
 if r.state->>'phase' is distinct from 'reviewing' or jsonb_typeof(r.state->'activeBatch') is distinct from 'array' or jsonb_array_length(r.state->'activeBatch')<1 then raise exception 'Run must be reviewing'; end if;
 if exists(select 1 from shadow_agent.attempts where run_id=p_run and request_hash=p_hash) then raise exception 'Request already reserved; no automatic retry'; end if;
 if exists(select 1 from shadow_agent.attempts where run_id=p_run and checkpoint_revision=r.revision) then raise exception 'Review checkpoint already reserved; no automatic retry'; end if;
 if b.blocked or r.blocked then raise exception 'Spending blocked'; end if;
 if b.spent_credits+b.held_credits+p_max>b.limit_credits or r.spent_credits+r.held_credits+p_max>r.limit_credits then raise exception 'Insufficient budget'; end if;
 insert into shadow_agent.attempts(run_id,day,lease_token,request_hash,reserved,checkpoint_revision) values(p_run,d,p_lease,p_hash,p_max,r.revision) returning id into a;
 update shadow_agent.budgets set held_credits=held_credits+p_max where day=d;
 update shadow_agent.runs set held_credits=held_credits+p_max where id=p_run;
 return a;
end $$;
create function shadow_agent.dispatch(p_attempt uuid,p_lease uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare r shadow_agent.runs; a shadow_agent.attempts; b shadow_agent.budgets;
begin
 select * into a from shadow_agent.attempts where id=p_attempt;
 if not found then return false; end if;
 select * into b from shadow_agent.budgets where day=a.day for update;
 select * into r from shadow_agent.runs where id=a.run_id for update;
 if p_lease is null or r.lease_token is distinct from p_lease or r.lease_until<=clock_timestamp() or r.revision<>a.checkpoint_revision or r.state->>'phase' is distinct from 'reviewing' or r.blocked or b.blocked or a.day<>(clock_timestamp() at time zone 'utc')::date then return false; end if;
 update shadow_agent.attempts set status='dispatched' where id=p_attempt and lease_token=p_lease and status='reserved';
 return found;
end $$;
create function shadow_agent.settle(p_attempt uuid,p_lease uuid,p_status text,p_cost numeric default null) returns boolean
language plpgsql security definer set search_path='' as $$
declare a shadow_agent.attempts;
begin
 if p_status is null or p_status not in ('uncertain','settled') or
 (p_status='uncertain' and p_cost is not null) or
 (p_status='settled' and (p_cost is null or not(p_cost>=0 and p_cost<1000000))) then raise exception 'Invalid settlement'; end if;
 select * into a from shadow_agent.attempts where id=p_attempt;
 if not found then return false; end if;
 perform 1 from shadow_agent.budgets where day=a.day for update;
 perform 1 from shadow_agent.runs where id=a.run_id for update;
 select * into a from shadow_agent.attempts where id=p_attempt for update;
 -- Original reservation token permits late accounting even after lease expiry;
 -- Settlement is charged to reservation day, even when reported later.
 -- it does not permit dispatch or state writes. No attempt may be retried.
 if p_lease is null or a.lease_token is distinct from p_lease then return false; end if;
 if a.status='settled' then
  if p_status='settled' and a.actual=p_cost then return true; end if;
  raise exception 'Immutable settlement';
 end if;
 if p_status='uncertain' then
  update shadow_agent.attempts set status='uncertain' where id=p_attempt;
  return true;
 end if;
 if a.status='reserved' then raise exception 'Dispatch not recorded'; end if;
 update shadow_agent.attempts set status='settled',actual=p_cost where id=p_attempt;
 update shadow_agent.budgets set held_credits=held_credits-a.reserved,spent_credits=spent_credits+p_cost,
 blocked=blocked or p_cost>a.reserved where day=a.day;
 update shadow_agent.runs set held_credits=held_credits-a.reserved,spent_credits=spent_credits+p_cost,
 blocked=blocked or p_cost>a.reserved where id=a.run_id;
 return true;
end $$;
revoke all on all functions in schema shadow_agent from public,anon,authenticated,service_role;
grant usage on schema shadow_agent to service_role;
grant execute on all functions in schema shadow_agent to service_role;
commit;
