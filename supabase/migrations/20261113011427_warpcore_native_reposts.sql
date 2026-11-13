-- Native repost support. No live source selection, credential, role, scheduler or record changes.
-- Existing evidence hashes remain unchanged when native CID metadata is absent.
alter table public.warpcore_candidates add column native_cid text, add column native_author_did text;
alter table public.warpcore_candidates add constraint warpcore_native_repost_identity check (
 (native_cid is null and native_author_did is null) or
 (source_type='bluesky' and native_cid ~ '^bafyre[a-z2-7]{53}$' and native_author_did ~ '^did:plc:[a-z2-7]{24}$'
  and native_uri ~ '^at://did:plc:[a-z2-7]{24}/app[.]bsky[.]feed[.]post/[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$'
  and split_part(native_uri,'/',3)=native_author_did and native_cid is not null and native_author_did is not null and native_uri is not null));
create or replace function public.warpcore_ingest(items jsonb) returns void
language plpgsql security invoker set search_path='' as $fn$
begin
 if jsonb_typeof(items)<>'array' or jsonb_array_length(items)>5000 then raise exception 'invalid ingest batch';end if;
 insert into public.warpcore_stories(story_key)
 select distinct x.story_key from jsonb_to_recordset(items) as x(story_key text)
 order by x.story_key on conflict do nothing;
 insert into public.warpcore_candidates(uri,story_key,source_type,source_id,actor,text,source_created_at,source_url,source_links,native_uri,native_url,native_cid,native_author_did)
 select uri,story_key,source_type,source_id,actor,text,source_created_at,source_url,
 coalesce(source_links,case when source_url is null then '[]'::jsonb else jsonb_build_array(source_url) end),native_uri,native_url,native_cid,native_author_did
 from jsonb_to_recordset(items) as x(uri text,story_key text,source_type text,source_id text,actor text,text text,source_created_at timestamptz,source_url text,source_links jsonb,native_uri text,native_url text,native_cid text,native_author_did text)
 order by uri on conflict do nothing;
end;$fn$;
create or replace function public.warpcore_curator_snapshot(p_story text) returns jsonb
language sql security invoker set search_path='' as $fn$
 with e as (
 select coalesce(jsonb_agg(jsonb_build_object('id',uri,'url',source_url,'text',text,'sourceType',source_type,'visibility','public','sourceLinks',source_links,'nativeUri',native_uri,'nativeUrl',native_url) || case when native_cid is null then '{}'::jsonb else jsonb_build_object('nativeCid',native_cid,'nativeAuthorDid',native_author_did) end order by uri),'[]'::jsonb) as evidence
 from public.warpcore_candidates where story_key=p_story
 ) select jsonb_build_object('story_key',p_story,'evidence',evidence,'evidence_hash',encode(sha256(convert_to(evidence::text,'UTF8')),'hex')) from e;
$fn$;
create function public.warpcore_valid_repost_evidence(e jsonb) returns boolean
language sql immutable security invoker set search_path='' as $fn$
 select coalesce(e->>'sourceType'='bluesky' and e->>'nativeCid' ~ '^bafyre[a-z2-7]{53}$'
 and e->>'nativeUri' ~ '^at://did:plc:[a-z2-7]{24}/app[.]bsky[.]feed[.]post/[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$'
 and e->>'nativeAuthorDid'=split_part(e->>'nativeUri','/',3),false);
$fn$;
revoke all on function public.warpcore_valid_repost_evidence(jsonb) from public,anon,authenticated;
grant execute on function public.warpcore_valid_repost_evidence(jsonb) to service_role;
create or replace function public.warpcore_curator_submit(p_story text,p_evidence_hash text,p_editorial jsonb,p_attestations jsonb,p_dot_id text,p_run_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $fn$
declare s jsonb;r public.warpcore_curator_inbox;status text;
begin
 if p_story is null or p_story !~ '^[a-f0-9]{64}$' or p_dot_id is null or length(p_dot_id) not between 1 and 128 or p_run_id is null then raise exception 'Invalid curator identity'; end if;
 -- Serialize a run's bounded submissions as well as a story's evidence.
 perform pg_advisory_xact_lock(hashtextextended('warpcore_curator_submit',0));
 select * into r from public.warpcore_curator_inbox where dot_id=p_dot_id and run_id=p_run_id and story_key=p_story;
 if found then
  if r.evidence_hash is distinct from p_evidence_hash or r.editorial is distinct from p_editorial or r.attestations is distinct from p_attestations then raise exception 'Immutable submission conflict'; end if;
  return r.id;
 end if;
 update public.warpcore_curator_inbox set state='rejected',completed_at=now(),reason='expired_or_attempt_limit' where (state='pending' or (state='leased' and lease_expires_at<=now())) and (created_at<now()-interval '24 hours' or attempts>=3);
 if (select count(*) from public.warpcore_curator_inbox where state in ('pending','leased'))>=24 then raise exception 'Curator backlog limit';end if;
 if (select count(*) from public.warpcore_curator_inbox where dot_id=p_dot_id and run_id=p_run_id)>=5 then raise exception 'Curator run limit'; end if;
 select st.status into status from public.warpcore_stories st where st.story_key=p_story for update;
 if status is distinct from 'unverified_review_required' then raise exception 'Story unavailable'; end if;
 s:=public.warpcore_curator_snapshot(p_story);
 if p_evidence_hash is null or s->>'evidence_hash'<>p_evidence_hash or jsonb_array_length(s->'evidence') not between 1 and 20 or octet_length((s->'evidence')::text)>200000 then raise exception 'Stale or oversized evidence'; end if;
 if p_attestations is distinct from '{"factsVerified":true,"meaningfulChange":true,"scopeApproved":true}'::jsonb then raise exception 'Explicit curator attestations required'; end if;
 if jsonb_typeof(p_editorial) is distinct from 'object' or octet_length(p_editorial::text)>16000 or p_editorial->'political' is distinct from 'false'::jsonb then raise exception 'Invalid editorial'; end if;
 if jsonb_typeof(p_editorial->'evidenceIds') is distinct from 'array' or jsonb_array_length(p_editorial->'evidenceIds') not between 1 and 20 then raise exception 'Evidence IDs required'; end if;
 if (select count(*)<>count(distinct value) from jsonb_array_elements_text(p_editorial->'evidenceIds')) then raise exception 'Duplicate evidence IDs';end if;
 if exists(select 1 from jsonb_array_elements_text(p_editorial->'evidenceIds') id where not exists(select 1 from jsonb_array_elements(s->'evidence') e where e->>'id'=id)) then raise exception 'Unknown evidence'; end if;
 if p_editorial ? 'mode' and (jsonb_typeof(p_editorial->'mode') is distinct from 'string' or p_editorial->>'mode' not in ('post','repost')) then raise exception 'Unknown editorial mode';end if;
 if coalesce(p_editorial->>'mode','post')<>'repost' and exists(select 1 from jsonb_array_elements(s->'evidence') e where p_editorial->'evidenceIds' ? (e->>'id') and e->>'sourceType'='bluesky') then raise exception 'Bluesky evidence requires native repost';end if;
 if p_editorial->>'mode'='repost' and (jsonb_array_length(p_editorial->'evidenceIds')<>1 or not exists(select 1 from jsonb_array_elements(s->'evidence') e where e->>'id'=p_editorial->'evidenceIds'->>0 and public.warpcore_valid_repost_evidence(e))) then raise exception 'Exact native repost source required';end if;
 if exists(select 1 from unnest(case when p_editorial->>'mode'='repost' then array['change'] else array['summary','whyItMatters','change'] end) k where jsonb_typeof(p_editorial->k) is distinct from 'string' or length(public.warpcore_curator_trim(p_editorial->>k)) not between 1 and 3000) then raise exception 'Original editorial text required'; end if;
 if jsonb_typeof(p_editorial->'verification') is distinct from 'object'
 or jsonb_typeof(p_editorial->'verification'->'checkedAt') is distinct from 'string'
 or (p_editorial->'verification'->>'checkedAt')::timestamptz not between now()-interval '24 hours' and now()+interval '5 minutes'
 or jsonb_typeof(p_editorial->'verification'->'reason') is distinct from 'string'
 or length(public.warpcore_curator_trim(p_editorial->'verification'->>'reason')) not between 1 and 1000
 or jsonb_typeof(p_editorial->'verification'->'sourceUrls') is distinct from 'array'
 or jsonb_array_length(p_editorial->'verification'->'sourceUrls') not between 1 and 20 then raise exception 'Verification audit required';end if;
 if exists(select 1 from jsonb_array_elements_text(p_editorial->'verification'->'sourceUrls') u where u !~ '^https://' or not exists(select 1 from jsonb_array_elements(s->'evidence') e where e->>'url'=u or e->>'nativeUrl'=u or e->'sourceLinks' ? u)) then raise exception 'Unknown verification source';end if;
 insert into public.warpcore_curator_inbox(story_key,evidence_hash,evidence,editorial,attestations,dot_id,run_id) values(p_story,p_evidence_hash,s->'evidence',p_editorial,p_attestations,p_dot_id,p_run_id) returning id into r.id;
 return r.id;
end;$fn$;
create or replace function public.warpcore_curator_finalize(p_id uuid,p_lease_token uuid,p_packet jsonb,p_job jsonb) returns boolean
language plpgsql security invoker set search_path='' as $fn$
declare r public.warpcore_curator_inbox;s jsonb;selected jsonb;links jsonb;draft jsonb;material jsonb;expected_packet jsonb;expected_record jsonb;facets jsonb:='[]'::jsonb;post_text text;link text;cursor_bytes integer;packet_hash text;expected_hash text;
begin
 select * into r from public.warpcore_curator_inbox where id=p_id for update;
 if not found or r.state<>'leased' or r.lease_token is distinct from p_lease_token or r.lease_expires_at<=now() then return false; end if;
 perform 1 from public.warpcore_stories where story_key=r.story_key and status='unverified_review_required' for update;
 if not found then return false; end if;
 s:=public.warpcore_curator_snapshot(r.story_key);
 if s->>'evidence_hash'<>r.evidence_hash then
  update public.warpcore_curator_inbox set state='rejected',reason='stale_evidence',completed_at=now() where id=p_id;return false;
 end if;
 -- Rebuild exact normalized evidence, attribution, packet and transport. Source order is stable.
 select jsonb_agg(e || jsonb_build_object('sourceLinks',(
  select jsonb_agg(v order by first_ord) from (select v,min(ord) first_ord from jsonb_array_elements(jsonb_build_array(e->'url') || coalesce(e->'sourceLinks','[]'::jsonb) || case when e->>'nativeUrl' is null then '[]'::jsonb else jsonb_build_array(e->'nativeUrl') end) with ordinality x(v,ord) group by v) d
 )) order by ord) into selected from jsonb_array_elements(r.evidence) with ordinality x(e,ord) where r.editorial->'evidenceIds' ? (e->>'id');
 if r.editorial->>'mode'='repost' then
  if jsonb_array_length(selected) is distinct from 1 or not public.warpcore_valid_repost_evidence(selected->0) then raise exception 'Invalid native repost';end if;
  draft:=jsonb_build_object('storyKey',r.story_key,'mode','repost','subject',jsonb_build_object('uri',selected->0->>'nativeUri','cid',selected->0->>'nativeCid'));
  expected_record:=jsonb_build_object('$type','app.bsky.feed.repost','subject',draft->'subject','createdAt',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  expected_hash:=encode(sha256(convert_to(public.warpcore_curator_canonical(expected_record),'UTF8')),'hex');
 else
 select jsonb_agg(v order by first_ord) into links from (
 select v,min(ord*100+lord) first_ord from jsonb_array_elements(selected) with ordinality x(e,ord),jsonb_array_elements(e->'sourceLinks') with ordinality y(v,lord) group by v) d;
 if selected is null or links is null or jsonb_array_length(links) not between 1 and 3 then raise exception 'Invalid attribution';end if;
 draft:=jsonb_build_object('storyKey',r.story_key,'summary',public.warpcore_curator_trim(r.editorial->>'summary'),'whyItMatters',public.warpcore_curator_trim(r.editorial->>'whyItMatters'),'links',links);
 post_text:=(draft->>'summary')||E'\n\n'||(draft->>'whyItMatters');
 cursor_bytes:=octet_length(post_text);
 for link in select jsonb_array_elements_text(links) loop
  facets:=facets||jsonb_build_array(jsonb_build_object('index',jsonb_build_object('byteStart',cursor_bytes+2,'byteEnd',cursor_bytes+2+octet_length(link)),'features',jsonb_build_array(jsonb_build_object('$type','app.bsky.richtext.facet#link','uri',link))));
  post_text:=post_text||E'\n\n'||link;cursor_bytes:=octet_length(post_text);
 end loop;
 expected_record:=jsonb_build_object('$type','app.bsky.feed.post','text',post_text,'facets',facets,'createdAt',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  expected_hash:=encode(sha256(convert_to(post_text,'UTF8')),'hex');
 end if;
 material:=jsonb_build_object('recordDraft',draft,'evidence',selected,'change',public.warpcore_curator_trim(r.editorial->>'change'));
 packet_hash:=encode(sha256(convert_to(public.warpcore_curator_canonical(material),'UTF8')),'hex');
 expected_packet:=material || jsonb_build_object('status','awaiting_review','approved',false,'contentHash',packet_hash);
 if p_packet is distinct from expected_packet then raise exception 'Invalid frozen review';end if;
 if p_job is null or p_job->>'accountDid' is distinct from 'did:plc:pfq2p7n2oiiy2k4pv6xnsgdk' or p_job->>'storyKey' is distinct from r.story_key
 or p_job->>'recordKey' is distinct from public.warpcore_record_tid(r.story_key,r.created_at) or p_job->>'contentHash' is distinct from expected_hash
 or p_job->'record' is distinct from expected_record then raise exception 'Invalid transport binding';end if;
 if not public.warpcore_prepare_publication(p_job->>'accountDid',r.story_key,p_job->>'contentHash',p_job->'record',p_job->>'recordKey') then raise exception 'Publication conflict';end if;
 if not public.warpcore_review_publication(p_job->>'accountDid',r.story_key,p_job->>'contentHash',p_job->'record',true) then raise exception 'Approval conflict';end if;
 update public.warpcore_curator_inbox set state='processed',packet=p_packet,job=p_job,completed_at=now(),reason=null where id=p_id;return true;
end;$fn$;
create or replace function public.warpcore_mark_published(p_account text,p_story text,p_hash text,p_record jsonb,p_uri text)
returns boolean language plpgsql security invoker set search_path='' as $fn$
begin
 update public.warpcore_publications set state='published',remote_uri=p_uri
 where account_did=p_account and story_key=p_story and content_hash=p_hash
 and record_payload=p_record and state in ('sending','uncertain')
 and p_record->>'$type' in ('app.bsky.feed.post','app.bsky.feed.repost')
 and p_uri='at://' || account_did || '/' || (p_record->>'$type') || '/' || record_key;
 return found;
end;
$fn$;
