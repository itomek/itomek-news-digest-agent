-- Private verification proposals only. Install after audit, before producer.
begin;
create table shadow_agent.ranking_runs(
 run_id uuid primary key references shadow_agent.runs(id),
 rubric_version text not null check(rubric_version='2026-11-16.1'),
 algorithm_version text not null check(algorithm_version='importance-relevance-id-v1'),
 assessed_count bigint not null default 0 check(assessed_count>=0),
 eligible_count bigint check(eligible_count>=0), selected_count integer check(selected_count between 0 and 5),
 finalized_revision bigint, finalized_at timestamptz,
 check((finalized_at is null and finalized_revision is null and selected_count is null and eligible_count is null)
 or (finalized_at is not null and finalized_revision is not null and selected_count is not null and eligible_count is not null))
);
create table shadow_agent.selection_items(
 run_id uuid not null references shadow_agent.ranking_runs(run_id),
 rank integer not null check(rank between 1 and 5), ordinal bigint not null,
 status text not null default 'requires_verification' check(status='requires_verification'),
 facts_verified boolean not null default false check(not facts_verified),
 publication_approved boolean not null default false check(not publication_approved),
 primary key(run_id,rank), unique(run_id,ordinal),
 foreign key(run_id,ordinal) references shadow_agent.decisions(run_id,ordinal)
);
alter table shadow_agent.ranking_runs enable row level security;
alter table shadow_agent.selection_items enable row level security;
revoke all on shadow_agent.ranking_runs,shadow_agent.selection_items from public,anon,authenticated,service_role;
create function shadow_agent.ranking_bind(p_run uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from shadow_agent.runs where id=p_run and state->>'phase' in ('scan','review') and state->>'reviewedCount'='0')
 or exists(select 1 from shadow_agent.attempts where run_id=p_run) or exists(select 1 from shadow_agent.decisions where run_id=p_run)
 then raise exception 'Ranked run must be fresh'; end if;
 insert into shadow_agent.ranking_runs(run_id,rubric_version,algorithm_version) values(p_run,'2026-11-16.1','importance-relevance-id-v1');
end $$;
create function shadow_agent.ranking_finalize(p_run uuid,p_lease uuid,p_revision bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r shadow_agent.runs; ranking shadow_agent.ranking_runs; n bigint; eligible bigint; selected integer; result jsonb;
begin
 r:=shadow_agent.paged_lock(p_run,p_lease,p_revision,'review');
 if r.id is null then return null; end if;
 select * into ranking from shadow_agent.ranking_runs where run_id=p_run for update;
 if not found or ranking.finalized_at is not null then raise exception 'Invalid ranking finalization'; end if;
 n:=(r.state->>'candidateCount')::bigint;
 if (r.state->>'reviewedCount')::bigint<>n or ranking.assessed_count<>n
 or (select count(*) from shadow_agent.candidates where run_id=p_run)<>n
 or (select count(*) from shadow_agent.decisions where run_id=p_run)<>n
 or exists(select 1 from shadow_agent.decisions where run_id=p_run and not shadow_agent.ranking_valid_decision(decision))
 then raise exception 'Incomplete ranking coverage'; end if;
 -- Canonical relations are deliberately required even for an empty scan.
 perform 1 from public.warpcore_stories limit 0;
 perform 1 from public.warpcore_curator_inbox limit 0;
 perform 1 from public.warpcore_publications limit 0;
 with eligible as (
 select c.ordinal,c.candidate_id,d.decision from shadow_agent.candidates c join shadow_agent.decisions d using(run_id,ordinal)
 join public.warpcore_stories s on s.story_key=c.candidate_id
 where c.run_id=p_run and d.decision->>'action'='verify' and s.status='unverified_review_required'
 and not exists(select 1 from public.warpcore_curator_inbox i where i.story_key=c.candidate_id)
 and not exists(select 1 from public.warpcore_publications p where p.story_key=c.candidate_id)
 ), ordered as (
 select ordinal,row_number() over(order by (decision->>'importance')::integer desc,(decision->>'relevance')::integer desc,candidate_id) as rank,
 count(*) over() as total from eligible
 ), added as (
 insert into shadow_agent.selection_items(run_id,rank,ordinal) select p_run,rank,ordinal from ordered where rank<=5 returning rank
 ) select coalesce((select max(total) from ordered),0),(select count(*) from added) into eligible,selected;
 update shadow_agent.ranking_runs set eligible_count=eligible,selected_count=selected,finalized_revision=p_revision+1,finalized_at=clock_timestamp() where run_id=p_run;
 result:=shadow_agent.paged_write(p_run,p_lease,p_revision,r.state||jsonb_build_object('revision',p_revision+1,'phase','complete','activeBatch','null'::jsonb));
 return result;
end $$;
create function shadow_agent.selection_summary(p_run uuid) returns jsonb
language sql security definer set search_path='' as $$
 select jsonb_build_object('runId',r.run_id,'rubricVersion',r.rubric_version,'algorithmVersion',r.algorithm_version,
 'assessedCount',r.assessed_count,'eligibleCount',r.eligible_count,'selectedCount',r.selected_count,
 'finalizedRevision',r.finalized_revision,'finalizedAt',r.finalized_at,'items',coalesce((
 select jsonb_agg(jsonb_build_object('rank',i.rank,'candidate',c.candidate,'decision',d.decision,
 'status',i.status,'factsVerified',i.facts_verified,'publicationApproved',i.publication_approved) order by i.rank)
 from shadow_agent.selection_items i join shadow_agent.candidates c using(run_id,ordinal)
 join shadow_agent.decisions d using(run_id,ordinal) where i.run_id=r.run_id and r.finalized_at is not null),'[]'::jsonb))
 from shadow_agent.ranking_runs r where r.run_id=p_run
$$;
revoke all on function shadow_agent.ranking_valid_decision(jsonb),shadow_agent.ranking_bind(uuid),shadow_agent.ranking_finalize(uuid,uuid,bigint),shadow_agent.selection_summary(uuid) from public,anon,authenticated,service_role;
commit;
