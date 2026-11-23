-- Let the current and prior Edge versions share the same queue during rollout.
-- Requires the discovery decision, history check, and shared admission lock
-- in the same transaction. Does not create a fact-verification receipt.
begin;
create or replace function shadow_agent.admit_source_link(p_run uuid,p_story text,p_at timestamptz,p_transport jsonb)
returns boolean language plpgsql security invoker set search_path='' as $fn$
declare s jsonb; proof jsonb; captured jsonb; title text; url text; prefix text; submitted text; excerpt text; rendered text; record jsonb; digest text; tid text;
 account constant text:='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk';
begin
 perform 1 from public.warpcore_stories where story_key=p_story and status='unverified_review_required' for update nowait;
 if not found then return false;end if;
 s:=public.warpcore_curator_snapshot(p_story);
 proof:=shadow_agent.source_link_capture(p_run,p_story,s->>'evidence_hash');
 if proof is null then return false;end if;
 captured:=proof->'evidence';
 title:=public.warpcore_curator_trim(split_part(captured->>'text',chr(10),1));
 url:=captured->>'url';
 if title is null or title='' or title ~ '[<>[:cntrl:]]' or title ~ U&'[\061C\200E\200F\202A-\202E\2066-\2069]' or title ~* '(https?://|www\.)'
 or url !~ '^https://[^/@[:space:]#:]+([/?]|$)' or url ~ '[#[:space:]]' then return false;end if;
 submitted:=p_transport->'record'->>'text';
 prefix:=title||E'\n\n';
 if submitted='Headline: '||prefix||url then
  -- Keep in-flight or rolled-back v40 workers compatible. New workers omit it.
  prefix:='Headline: '||prefix;
 elsif submitted is distinct from prefix||url then
  excerpt:=split_part(submitted,E'\n\n',2);
  if excerpt is null or length(excerpt) not between 36 and 180 or excerpt<>btrim(excerpt)
   or cardinality(string_to_array(excerpt,' '))>25 or excerpt ~ '[<>[:cntrl:]]'
   or excerpt ~ U&'[\061C\200E\200F\202A-\202E\2066-\2069]' or excerpt ~* '(https?://|www\.)' then return false;end if;
  prefix:=prefix||excerpt||E'\n\n';
 end if;
 rendered:=prefix||url;
 if octet_length(rendered)>3000 then return false;end if;
 record:=jsonb_build_object('$type','app.bsky.feed.post','text',rendered,'createdAt',to_char(p_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'facets',jsonb_build_array(jsonb_build_object('index',jsonb_build_object('byteStart',octet_length(prefix),'byteEnd',octet_length(rendered)),
 'features',jsonb_build_array(jsonb_build_object('$type','app.bsky.richtext.facet#link','uri',url)))));
 digest:=encode(sha256(convert_to(rendered,'UTF8')),'hex');
 tid:=public.warpcore_record_tid(p_story,p_at);
 if p_transport is distinct from jsonb_build_object('storyKey',p_story,'record',record,'recordKey',tid,'contentHash',digest) then return false;end if;
 if not public.warpcore_prepare_publication(account,p_story,digest,record,tid) then raise exception 'Source-link preparation conflict';end if;
 if not public.warpcore_review_publication(account,p_story,digest,record,true) then raise exception 'Source-link queue conflict';end if;
 return true;
end $fn$;
revoke all on function shadow_agent.admit_source_link(uuid,text,timestamptz,jsonb) from public,anon,authenticated,service_role;
commit;
