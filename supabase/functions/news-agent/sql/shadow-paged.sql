-- EXPERIMENTAL SHADOW ONLY, outside migrations. Load shadow-state.sql first.
-- Normalized append-only snapshots remove the aggregate-checkpoint size ceiling.
-- Each transaction handles <=100 candidates/decisions and <=2MB of input JSON.
-- Worker functions never create runs/budgets, call networks or publish.
begin;
create table shadow_agent.candidates (
 run_id uuid not null references shadow_agent.runs(id),
 ordinal bigint not null check(ordinal>=0), candidate_id text not null check(candidate_id ~ '^[a-f0-9]{64}$'),
 candidate jsonb not null, primary key(run_id,ordinal), unique(run_id,candidate_id)
);
create table shadow_agent.decisions (
 run_id uuid not null, ordinal bigint not null, decision jsonb not null,
 primary key(run_id,ordinal), foreign key(run_id,ordinal) references shadow_agent.candidates(run_id,ordinal)
);
alter table shadow_agent.candidates enable row level security;
alter table shadow_agent.decisions enable row level security;
revoke all on shadow_agent.candidates,shadow_agent.decisions from public,anon,authenticated,service_role;

-- Helpers remain private. All public operations take the same run-row lock,
-- so page rows, batch identity, revision and final lease check are atomic.
create function shadow_agent.paged_lock(p_run uuid,p_lease uuid,p_revision bigint,p_phase text)
returns shadow_agent.runs language plpgsql security definer set search_path='' as $$
declare r shadow_agent.runs;
begin
 select * into r from shadow_agent.runs where id=p_run for update;
 if not found or p_lease is null or r.lease_token is distinct from p_lease
 or r.revision is distinct from p_revision or r.lease_until<=clock_timestamp() then return null; end if;
 if r.state->>'storageKind' is distinct from 'paged-v1' or r.state->>'runId' is distinct from p_run::text
 or r.state->'revision' is distinct from to_jsonb(r.revision)
 or r.state->'publishingEnabled' is distinct from 'false'::jsonb
 or jsonb_typeof(r.state->'candidateCount') is distinct from 'number'
 or jsonb_typeof(r.state->'reviewedCount') is distinct from 'number'
 or r.state->>'candidateCount' !~ '^[0-9]+$' or r.state->>'reviewedCount' !~ '^[0-9]+$'
 or (r.state->>'reviewedCount')::bigint>(r.state->>'candidateCount')::bigint
 or r.state ? 'candidates' or r.state ? 'decisions' then raise exception 'Invalid paged state'; end if;
 if r.state->>'phase' is distinct from p_phase then raise exception 'Invalid paged phase'; end if;
 return r;
end $$;
create function shadow_agent.paged_write(p_run uuid,p_lease uuid,p_revision bigint,p_next jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 update shadow_agent.runs set state=p_next,revision=revision+1 where id=p_run
 and revision=p_revision and lease_token=p_lease and lease_until>clock_timestamp();
 -- Raising here rolls back candidate/decision inserts made earlier in this call.
 if not found then raise exception 'Paged lease lost during transaction'; end if;
 return p_next;
end $$;

create function shadow_agent.paged_append(p_run uuid,p_lease uuid,p_revision bigint,p_page jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r shadow_agent.runs; c jsonb; last_id text; n integer; position bigint; next_state jsonb;
begin
 r:=shadow_agent.paged_lock(p_run,p_lease,p_revision,'scan');
 if r.id is null then return null; end if;
 if p_page is null or jsonb_typeof(p_page)<>'array' or octet_length(p_page::text)>2000000 then raise exception 'Invalid candidate page'; end if;
 n:=jsonb_array_length(p_page);
 if n>100 then raise exception 'Invalid candidate page'; end if;
 position:=(r.state->>'candidateCount')::bigint; last_id:=r.state->>'cursor';
 for c in select value from jsonb_array_elements(p_page) loop
  if jsonb_typeof(c)<>'object' or jsonb_typeof(c->'id') is distinct from 'string'
  or c->>'id' !~ '^[a-f0-9]{64}$' or (last_id is not null and c->>'id'<=last_id)
  or jsonb_typeof(c->'sourceUrl') is distinct from 'string' or c->>'sourceUrl' !~ '^https://[^/@[:space:]]+([/?#]|$)'
  or jsonb_typeof(c->'discoveryText') is distinct from 'string' or length(c->>'discoveryText')=0
  or (c-'id'-'sourceUrl'-'sourceType'-'sourceCreatedAt'-'discoveryText')<>'{}'::jsonb
  then raise exception 'Invalid candidate page'; end if;
  insert into shadow_agent.candidates(run_id,ordinal,candidate_id,candidate) values(p_run,position,c->>'id',c);
  position:=position+1;last_id:=c->>'id';
 end loop;
 next_state:=r.state||jsonb_build_object('revision',p_revision+1,'cursor',last_id,'candidateCount',position,'phase',case when n=0 then 'review' else 'scan' end);
 return shadow_agent.paged_write(p_run,p_lease,p_revision,next_state);
end $$;
-- Nonmutating bounded preview lets the runtime fit exact HTTP bytes before
-- freezing a reviewing checkpoint or reserving credit. Oversized singleton stays
-- visible so callers report an explicit hold rather than silently skip it.
create function shadow_agent.paged_preview(p_run uuid,p_lease uuid,p_revision bigint,p_size integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r shadow_agent.runs; position bigint; batch jsonb;
begin
 r:=shadow_agent.paged_lock(p_run,p_lease,p_revision,'review');
 if r.id is null then return null; end if;
 if p_size is null or p_size<1 or p_size>100 then raise exception 'Invalid preview size'; end if;
 position:=(r.state->>'reviewedCount')::bigint;
 select coalesce(jsonb_agg(candidate order by ordinal),'[]'::jsonb) into batch from (
  select candidate,ordinal,sum(octet_length(candidate::text)) over(order by ordinal) as bytes from (
   select candidate,ordinal from shadow_agent.candidates where run_id=p_run and ordinal>=position order by ordinal limit p_size
  ) bounded
 ) measured where bytes<=1500000 or ordinal=position;
 if jsonb_array_length(batch)=0 and position<>(r.state->>'candidateCount')::bigint then raise exception 'Invalid paged coverage'; end if;
 return batch;
end $$;
create function shadow_agent.paged_begin(p_run uuid,p_lease uuid,p_revision bigint,p_size integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r shadow_agent.runs; batch jsonb; ids jsonb; next_state jsonb; position bigint;
begin
 r:=shadow_agent.paged_lock(p_run,p_lease,p_revision,'review');
 if r.id is null then return null; end if;
 if p_size is null or p_size<1 or p_size>100 then raise exception 'Invalid batch size'; end if;
 position:=(r.state->>'reviewedCount')::bigint;
 if (select coalesce(sum(octet_length(candidate::text)),0) from (select candidate from shadow_agent.candidates where run_id=p_run and ordinal>=position order by ordinal limit p_size) bounded)>2000000
 then raise exception 'Invalid oversized review batch; reduce invocation batch size'; end if;
 select coalesce(jsonb_agg(candidate order by ordinal),'[]'::jsonb),coalesce(jsonb_agg(to_jsonb(candidate_id) order by ordinal),'[]'::jsonb)
 into batch,ids from (select candidate,candidate_id,ordinal from shadow_agent.candidates where run_id=p_run and ordinal>=position order by ordinal limit p_size) page;
 if jsonb_array_length(batch)=0 and position<>(r.state->>'candidateCount')::bigint then raise exception 'Invalid paged coverage'; end if;
 next_state:=r.state||jsonb_build_object('revision',p_revision+1,'phase',case when jsonb_array_length(batch)=0 then 'complete' else 'reviewing' end,'activeBatch',case when jsonb_array_length(batch)=0 then 'null'::jsonb else ids end);
 perform shadow_agent.paged_write(p_run,p_lease,p_revision,next_state);
 return jsonb_build_object('state',next_state,'batch',batch);
end $$;
create function shadow_agent.paged_commit(p_run uuid,p_lease uuid,p_revision bigint,p_decisions jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r shadow_agent.runs; d jsonb; i integer; n integer; position bigint; next_state jsonb;
begin
 r:=shadow_agent.paged_lock(p_run,p_lease,p_revision,'reviewing');
 if r.id is null then return null; end if;
 if p_decisions is null or jsonb_typeof(p_decisions)<>'array' or octet_length(p_decisions::text)>2000000
 or jsonb_typeof(r.state->'activeBatch') is distinct from 'array' then raise exception 'Invalid batch decisions'; end if;
 n:=jsonb_array_length(r.state->'activeBatch');position:=(r.state->>'reviewedCount')::bigint;
 if n<1 or n>100 or jsonb_array_length(p_decisions)<>n or position+n>(r.state->>'candidateCount')::bigint then raise exception 'Invalid batch decisions'; end if;
 if not exists(select 1 from shadow_agent.attempts where run_id=p_run and checkpoint_revision=p_revision and status='settled') then raise exception 'Batch requires settled attempt'; end if;
 for i in 0..n-1 loop
  d:=p_decisions->i;
  if jsonb_typeof(d)<>'object' or d->'id' is distinct from r.state->'activeBatch'->i
  or d->>'action' is null or d->>'action' not in ('skip','verify')
  or jsonb_typeof(d->'reason') is distinct from 'string' or length(btrim(d->>'reason'))=0 or length(d->>'reason')>1000
  or (d-'id'-'action'-'reason')<>'{}'::jsonb then raise exception 'Invalid batch decisions'; end if;
  if not exists(select 1 from shadow_agent.candidates where run_id=p_run and ordinal=position+i and to_jsonb(candidate_id)=d->'id') then raise exception 'Invalid batch identity'; end if;
  insert into shadow_agent.decisions(run_id,ordinal,decision) values(p_run,position+i,d);
 end loop;
 next_state:=r.state||jsonb_build_object('revision',p_revision+1,'phase','review','reviewedCount',position+n,'activeBatch','null'::jsonb);
 return shadow_agent.paged_write(p_run,p_lease,p_revision,next_state);
end $$;
create function shadow_agent.paged_uncertain(p_run uuid,p_lease uuid,p_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r shadow_agent.runs;
begin
 r:=shadow_agent.paged_lock(p_run,p_lease,p_revision,'reviewing');
 if r.id is null then return null; end if;
 return shadow_agent.paged_write(p_run,p_lease,p_revision,r.state||jsonb_build_object('revision',p_revision+1,'phase','uncertain'));
end $$;
revoke all on function shadow_agent.paged_lock(uuid,uuid,bigint,text),shadow_agent.paged_write(uuid,uuid,bigint,jsonb),
 shadow_agent.paged_preview(uuid,uuid,bigint,integer),shadow_agent.paged_append(uuid,uuid,bigint,jsonb),shadow_agent.paged_begin(uuid,uuid,bigint,integer),
 shadow_agent.paged_commit(uuid,uuid,bigint,jsonb),shadow_agent.paged_uncertain(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function shadow_agent.paged_preview(uuid,uuid,bigint,integer),shadow_agent.paged_append(uuid,uuid,bigint,jsonb),shadow_agent.paged_begin(uuid,uuid,bigint,integer),
 shadow_agent.paged_commit(uuid,uuid,bigint,jsonb),shadow_agent.paged_uncertain(uuid,uuid,bigint) to service_role;
commit;
