-- Audited dot-authored curation inbox. No credentials, sources, schedules or activation.
-- Submission uses existing management connector authority; service_role can only drain.
create table public.warpcore_curator_inbox (
 id uuid primary key default gen_random_uuid(),
 story_key text not null references public.warpcore_stories(story_key),
 evidence_hash text not null check(evidence_hash ~ '^[a-f0-9]{64}$'),
 evidence jsonb not null,
 editorial jsonb not null,
 attestations jsonb not null,
 submitted_db_role text not null default current_user,
 actor_kind text not null default 'dot' check(actor_kind='dot'),
 dot_id text not null check(length(dot_id) between 1 and 128),
 run_id uuid not null,
 state text not null default 'pending' check(state in ('pending','leased','processed','rejected')),
 created_at timestamptz not null default now(),
 lease_token uuid, lease_expires_at timestamptz,
 attempts integer not null default 0,
 completed_at timestamptz, reason text,
 packet jsonb, job jsonb,
 unique(dot_id,run_id,story_key)
);
create unique index warpcore_curator_one_live_story on public.warpcore_curator_inbox(story_key) where state in ('pending','leased');
alter table public.warpcore_curator_inbox enable row level security;
revoke all on public.warpcore_curator_inbox from public,anon,authenticated,service_role;
grant select,update on public.warpcore_curator_inbox to service_role;

-- Serialize evidence writes with finalization; existing ingestion inserts remain supported.
create function public.warpcore_curator_evidence_lock() returns trigger
language plpgsql security invoker set search_path='' as $fn$
begin
 if tg_op='UPDATE' and new.story_key is distinct from old.story_key then raise exception 'Evidence story identity immutable'; end if;
 perform 1 from public.warpcore_stories where story_key=case when tg_op='DELETE' then old.story_key else new.story_key end for update;
 if tg_op='DELETE' then return old; end if; return new;
end;$fn$;
create trigger warpcore_curator_evidence_lock before insert or update or delete on public.warpcore_candidates for each row execute function public.warpcore_curator_evidence_lock();
revoke all on function public.warpcore_curator_evidence_lock() from public,anon,authenticated;

create function public.warpcore_curator_snapshot(p_story text) returns jsonb
language sql security invoker set search_path='' as $fn$
 with e as (
 select coalesce(jsonb_agg(jsonb_build_object('id',uri,'url',source_url,'text',text,'sourceType',source_type,'visibility','public','sourceLinks',source_links,'nativeUri',native_uri,'nativeUrl',native_url) order by uri),'[]'::jsonb) as evidence
 from public.warpcore_candidates where story_key=p_story
 ) select jsonb_build_object('story_key',p_story,'evidence',evidence,'evidence_hash',encode(sha256(convert_to(evidence::text,'UTF8')),'hex')) from e;
$fn$;
revoke all on function public.warpcore_curator_snapshot(text) from public,anon,authenticated;
grant execute on function public.warpcore_curator_snapshot(text) to service_role;

-- ECMAScript String.trim whitespace, matching the shared JS editorial formatter.
create function public.warpcore_curator_trim(p_text text) returns text
language sql immutable security invoker set search_path='' as $fn$
 select btrim(p_text,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279));
$fn$;
revoke all on function public.warpcore_curator_trim(text) from public,anon,authenticated;
grant execute on function public.warpcore_curator_trim(text) to service_role;
create function public.warpcore_curator_submit(p_story text,p_evidence_hash text,p_editorial jsonb,p_attestations jsonb,p_dot_id text,p_run_id uuid) returns uuid
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
 if exists(select 1 from unnest(array['summary','whyItMatters','change']) k where jsonb_typeof(p_editorial->k) is distinct from 'string' or length(public.warpcore_curator_trim(p_editorial->>k)) not between 1 and 3000) then raise exception 'Original editorial text required'; end if;
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
-- Management connector postgres owns this function; no public or worker submission.
revoke all on function public.warpcore_curator_submit(text,text,jsonb,jsonb,text,uuid) from public,anon,authenticated,service_role;

create function public.warpcore_curator_claim(p_limit integer default 5) returns setof public.warpcore_curator_inbox
language plpgsql security invoker set search_path='' as $fn$
begin
 if p_limit is null or p_limit not between 1 and 5 then raise exception 'Invalid batch'; end if;
 update public.warpcore_curator_inbox set state='rejected',completed_at=now(),reason='expired_or_attempt_limit' where (state='pending' or (state='leased' and lease_expires_at<=now())) and (created_at<now()-interval '24 hours' or attempts>=3);
 return query with chosen as (select id from public.warpcore_curator_inbox where state='pending' or (state='leased' and lease_expires_at<=now()) order by created_at,id limit p_limit for update skip locked)
 update public.warpcore_curator_inbox i set state='leased',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',attempts=attempts+1 from chosen c where i.id=c.id returning i.*;
end;$fn$;
create function public.warpcore_curator_fail(p_id uuid,p_lease_token uuid,p_reason text) returns boolean
language plpgsql security invoker set search_path='' as $fn$
begin
 update public.warpcore_curator_inbox set state='rejected',reason=left(coalesce(p_reason,'validation_failed'),200),completed_at=now() where id=p_id and state='leased' and lease_token=p_lease_token and lease_expires_at>now();return found;
end;$fn$;
-- Compact sorted JSON matches the existing canonical JS packet hash (known ASCII keys).
create function public.warpcore_curator_canonical(p_value jsonb) returns text
language plpgsql immutable security invoker set search_path='' as $fn$
declare result text;
begin
 case jsonb_typeof(p_value)
 when 'object' then select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.warpcore_curator_canonical(value),',' order by key collate "C"),'')||'}' into result from jsonb_each(p_value);
 when 'array' then select '['||coalesce(string_agg(public.warpcore_curator_canonical(value),',' order by ord),'')||']' into result from jsonb_array_elements(p_value) with ordinality e(value,ord);
 else result:=p_value::text;end case;return result;
end;$fn$;
revoke all on function public.warpcore_curator_canonical(jsonb) from public,anon,authenticated;
grant execute on function public.warpcore_curator_canonical(jsonb) to service_role;
create function public.warpcore_curator_finalize(p_id uuid,p_lease_token uuid,p_packet jsonb,p_job jsonb) returns boolean
language plpgsql security invoker set search_path='' as $fn$
declare r public.warpcore_curator_inbox;s jsonb;selected jsonb;links jsonb;draft jsonb;material jsonb;expected_packet jsonb;expected_record jsonb;facets jsonb:='[]'::jsonb;post_text text;link text;cursor_bytes integer;packet_hash text;
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
 select jsonb_agg(v order by first_ord) into links from (
 select v,min(ord*100+lord) first_ord from jsonb_array_elements(selected) with ordinality x(e,ord),jsonb_array_elements(e->'sourceLinks') with ordinality y(v,lord) group by v) d;
 if selected is null or links is null or jsonb_array_length(links) not between 1 and 3 then raise exception 'Invalid attribution';end if;
 draft:=jsonb_build_object('storyKey',r.story_key,'summary',public.warpcore_curator_trim(r.editorial->>'summary'),'whyItMatters',public.warpcore_curator_trim(r.editorial->>'whyItMatters'),'links',links);
 material:=jsonb_build_object('recordDraft',draft,'evidence',selected,'change',public.warpcore_curator_trim(r.editorial->>'change'));
 packet_hash:=encode(sha256(convert_to(public.warpcore_curator_canonical(material),'UTF8')),'hex');
 expected_packet:=material || jsonb_build_object('status','awaiting_review','approved',false,'contentHash',packet_hash);
 if p_packet is distinct from expected_packet then raise exception 'Invalid frozen review';end if;
 post_text:=(draft->>'summary')||E'\n\n'||(draft->>'whyItMatters');
 cursor_bytes:=octet_length(post_text);
 for link in select jsonb_array_elements_text(links) loop
  facets:=facets||jsonb_build_array(jsonb_build_object('index',jsonb_build_object('byteStart',cursor_bytes+2,'byteEnd',cursor_bytes+2+octet_length(link)),'features',jsonb_build_array(jsonb_build_object('$type','app.bsky.richtext.facet#link','uri',link))));
  post_text:=post_text||E'\n\n'||link;cursor_bytes:=octet_length(post_text);
 end loop;
 expected_record:=jsonb_build_object('$type','app.bsky.feed.post','text',post_text,'facets',facets,'createdAt',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 if p_job is null or p_job->>'accountDid' is distinct from 'did:plc:pfq2p7n2oiiy2k4pv6xnsgdk' or p_job->>'storyKey' is distinct from r.story_key
 or p_job->>'recordKey' is distinct from 'story-'||r.story_key or p_job->>'contentHash' is distinct from encode(sha256(convert_to(post_text,'UTF8')),'hex')
 or p_job->'record' is distinct from expected_record then raise exception 'Invalid transport binding';end if;
 if not public.warpcore_prepare_publication(p_job->>'accountDid',r.story_key,p_job->>'contentHash',p_job->'record',p_job->>'recordKey') then raise exception 'Publication conflict';end if;
 if not public.warpcore_review_publication(p_job->>'accountDid',r.story_key,p_job->>'contentHash',p_job->'record',true) then raise exception 'Approval conflict';end if;
 update public.warpcore_curator_inbox set state='processed',packet=p_packet,job=p_job,completed_at=now(),reason=null where id=p_id;return true;
end;$fn$;
revoke all on function public.warpcore_curator_claim(integer),public.warpcore_curator_fail(uuid,uuid,text),public.warpcore_curator_finalize(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.warpcore_curator_claim(integer),public.warpcore_curator_fail(uuid,uuid,text),public.warpcore_curator_finalize(uuid,uuid,jsonb,jsonb) to service_role;

create function public.warpcore_curator_immutable() returns trigger language plpgsql security invoker set search_path='' as $fn$
begin
 if row(new.id,new.story_key,new.evidence_hash,new.evidence,new.editorial,new.attestations,new.submitted_db_role,new.actor_kind,new.dot_id,new.run_id,new.created_at) is distinct from row(old.id,old.story_key,old.evidence_hash,old.evidence,old.editorial,old.attestations,old.submitted_db_role,old.actor_kind,old.dot_id,old.run_id,old.created_at) then raise exception 'Curator submission immutable';end if;
 if old.state in ('processed','rejected') then raise exception 'Curator outcome immutable';end if;return new;
end;$fn$;
create trigger warpcore_curator_immutable before update on public.warpcore_curator_inbox for each row execute function public.warpcore_curator_immutable();
revoke all on function public.warpcore_curator_immutable() from public,anon,authenticated;
