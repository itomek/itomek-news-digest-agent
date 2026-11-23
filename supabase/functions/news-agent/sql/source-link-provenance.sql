-- Private, read-only building block for the headline lane. Never grants send
-- rights and is deliberately not wired to an RPC or installed in production.
begin;
create function shadow_agent.source_link_capture(p_run uuid,p_story text,p_snapshot_hash text)
returns jsonb language sql stable security invoker set search_path='' as $fn$
 with ranked as (
  select c.candidate
  from shadow_agent.candidates c
  join shadow_agent.decisions d on d.run_id=c.run_id and d.ordinal=c.ordinal
  join shadow_agent.ranking_runs k on k.run_id=c.run_id
  join shadow_agent.runs reviewed on reviewed.id=c.run_id
  join public.warpcore_stories story on story.story_key=c.candidate_id
  where c.run_id=p_run and c.candidate_id=p_story and p_story ~ '^[0-9a-f]{64}$'
   and p_snapshot_hash ~ '^[0-9a-f]{64}$'
   and k.finalized_at is not null and reviewed.state->>'phase'='complete'
   and story.status='unverified_review_required'
   and c.candidate->>'id'=p_story and d.decision->>'id'=p_story and d.decision->>'action'='verify'
 ), snapshot as materialized (
  select candidate, public.warpcore_curator_snapshot(p_story) as value from ranked
 )
 select jsonb_build_object('method','captured-source-headline-v1','factsVerified',false,
  'runId',p_run,'storyKey',p_story,'evidenceHash',p_snapshot_hash,
  'sourceKey',expected.source_key,'configHash',expected.config_hash,'evidence',e.item)
 from snapshot s
 cross join lateral jsonb_array_elements(s.value->'evidence') e(item)
 join public.warpcore_candidates capture on capture.story_key=p_story and capture.uri=e.item->>'id'
 join public.warpcore_source_roster expected on expected.source_key=capture.source_type||':'||capture.source_id
 join public.warpcore_source_sync current_source on current_source.source_key=expected.source_key
  and current_source.config_hash=expected.config_hash
 where s.value->>'story_key'=p_story and s.value->>'evidence_hash'=p_snapshot_hash
  and capture.source_type in ('rss','official_html') and capture.native_uri is null
  and capture.source_type=s.candidate->>'sourceType' and capture.source_type=e.item->>'sourceType'
  and capture.source_url=s.candidate->>'sourceUrl' and capture.source_url=e.item->>'url'
  and capture.text=e.item->>'text' and e.item->>'visibility'='public'
  and split_part(capture.text,chr(10),1)=split_part(s.candidate->>'discoveryText',chr(10),1)
  and capture.collected_at between statement_timestamp()-interval '24 hours' and statement_timestamp()
  and not exists(select 1 from public.warpcore_curator_inbox i where i.story_key=p_story)
  and not exists(select 1 from public.warpcore_publications p where p.story_key=p_story)
  and not exists(
   select 1 from public.warpcore_candidates prior
   where prior.source_url=capture.source_url and prior.story_key<>p_story
    and (exists(select 1 from public.warpcore_publications p where p.story_key=prior.story_key and p.state in ('prepared','sending','uncertain','manual_review','published'))
      or exists(select 1 from public.warpcore_curator_inbox i where i.story_key=prior.story_key and i.state in ('pending','leased'))))
 order by capture.source_created_at desc,capture.uri
 limit 1
$fn$;
revoke all on function shadow_agent.source_link_capture(uuid,text,text) from public,anon,authenticated,service_role;
commit;
