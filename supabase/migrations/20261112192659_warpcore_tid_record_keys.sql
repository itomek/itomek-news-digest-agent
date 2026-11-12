-- Additive correction: app.bsky.feed.post lexicon requires a TID record key.
-- No existing publication/inbox/slot state is modified, including uncertain records.
-- TID bits: canonical milliseconds*1000 microseconds, then ten FIRST story-hash bits.
create function public.warpcore_record_tid(p_story text,p_created_at timestamptz) returns text
language plpgsql immutable security invoker set search_path='' as $fn$
declare micros numeric;value bigint;clock_id integer;result text:='';alphabet constant text:='234567abcdefghijklmnopqrstuvwxyz';
begin
 if p_story is null or p_story !~ '^[a-f0-9]{64}$' or p_created_at is null or not isfinite(p_created_at) then raise exception 'Valid story and preparation timestamp required';end if;
 micros:=floor(extract(epoch from p_created_at)*1000)*1000;
 if micros<0 or micros>=9007199254740992 then raise exception 'TID timestamp out of range';end if;
 clock_id:=(('x'||substr(p_story,1,3))::bit(12)::integer)>>2;
 value:=micros::bigint*1024+clock_id;
 for i in 1..13 loop result:=substr(alphabet,(value & 31)::integer+1,1)||result;value:=value>>5;end loop;
 return result;
end;$fn$;
revoke all on function public.warpcore_record_tid(text,timestamptz) from public,anon,authenticated;
grant execute on function public.warpcore_record_tid(text,timestamptz) to service_role;

create or replace function public.warpcore_curator_finalize(p_id uuid,p_lease_token uuid,p_packet jsonb,p_job jsonb) returns boolean
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
 or p_job->>'recordKey' is distinct from public.warpcore_record_tid(r.story_key,r.created_at) or p_job->>'contentHash' is distinct from encode(sha256(convert_to(post_text,'UTF8')),'hex')
 or p_job->'record' is distinct from expected_record then raise exception 'Invalid transport binding';end if;
 if not public.warpcore_prepare_publication(p_job->>'accountDid',r.story_key,p_job->>'contentHash',p_job->'record',p_job->>'recordKey') then raise exception 'Publication conflict';end if;
 if not public.warpcore_review_publication(p_job->>'accountDid',r.story_key,p_job->>'contentHash',p_job->'record',true) then raise exception 'Approval conflict';end if;
 update public.warpcore_curator_inbox set state='processed',packet=p_packet,job=p_job,completed_at=now(),reason=null where id=p_id;return true;
end;$fn$;
