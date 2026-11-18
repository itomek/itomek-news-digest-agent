-- Server-issued model-supported verification receipts. Not mathematical proof.
-- Install after native-reposts and shared-admission; no enablement or credentials.
begin;
create schema agent_verification;
revoke all on schema agent_verification from public,anon,authenticated,service_role;
create table agent_verification.receipts(
 id uuid primary key default gen_random_uuid(),
 material jsonb not null check(octet_length(material::text)<=2000000),
 evidence jsonb not null,
 receipt_hash text not null check(receipt_hash ~ '^[a-f0-9]{64}$'),
 issued_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 check(expires_at>issued_at and expires_at<=issued_at+interval '1 hour')
);
create unique index agent_receipt_request on agent_verification.receipts((material->>'agentId'),(material->>'runId'),(material->>'storyKey'),(material->>'requestSha256'));
alter table agent_verification.receipts enable row level security;
revoke all on agent_verification.receipts from public,anon,authenticated,service_role;
create function agent_verification.immutable_receipt() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Verification receipt immutable'; end $$;
create trigger immutable_receipt before update or delete on agent_verification.receipts for each row execute function agent_verification.immutable_receipt();
alter table public.warpcore_curator_inbox drop constraint warpcore_curator_inbox_actor_kind_check;
alter table public.warpcore_curator_inbox alter column dot_id drop not null;
alter table public.warpcore_curator_inbox add column agent_id text,add column verification_receipt_id uuid unique references agent_verification.receipts(id);
alter table public.warpcore_curator_inbox add constraint warpcore_curator_actor_identity check(
 (actor_kind='dot' and dot_id is not null and agent_id is null and verification_receipt_id is null)
 or (actor_kind='agent' and dot_id is null and agent_id='warpcore-news-agent-v1' and agent_id is not null and verification_receipt_id is not null));
create or replace function public.warpcore_curator_immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if row(new.id,new.story_key,new.evidence_hash,new.evidence,new.editorial,new.attestations,new.submitted_db_role,new.actor_kind,new.dot_id,new.agent_id,new.verification_receipt_id,new.run_id,new.created_at)
 is distinct from row(old.id,old.story_key,old.evidence_hash,old.evidence,old.editorial,old.attestations,old.submitted_db_role,old.actor_kind,old.dot_id,old.agent_id,old.verification_receipt_id,old.run_id,old.created_at)
 then raise exception 'Curator submission immutable'; end if;
 if old.state in ('processed','rejected') then raise exception 'Curator outcome immutable'; end if;return new;
end $$;
-- History is complete across accounts. Mutable leases and claim counters are not
-- editorial changes. Stable cursor keys refer only to frozen identity/material.
create function agent_verification.lock_history(p_own_story text default null) returns void
language plpgsql security definer set search_path='' as $$
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Verification requires READ COMMITTED';end if;
 if not pg_try_advisory_xact_lock(hashtextextended('warpcore_shared_admission_v1',0)) then raise exception 'Admission busy' using errcode='55P03';end if;
 -- Evidence-writer triggers lock these same story rows. Acquire in one sorted
 -- order before reading context, so candidate changes cannot race a history check.
 perform 1 from public.warpcore_stories s where s.story_key=p_own_story or s.story_key in (
  select i.story_key from public.warpcore_curator_inbox i where i.state in ('pending','leased')
  union select p.story_key from public.warpcore_publications p where p.state in ('prepared','sending','uncertain','manual_review','published')
 ) order by s.story_key for update nowait;
end $$;
create function agent_verification.history_rows(p_exclude_story text default null)
returns table(key text,item jsonb) language sql security definer set search_path='' as $$
 with relevant as (
 select 'i:'||i.id::text as key,i.story_key,
 jsonb_build_object('kind','inbox','storyKey',i.story_key,'editorial',i.editorial,'createdAt',i.created_at) as item
 from public.warpcore_curator_inbox i where i.state in ('pending','leased') and i.story_key is distinct from p_exclude_story
 union all
 select 'p:'||p.account_did||':'||p.story_key,p.story_key,
 jsonb_build_object('kind','publication','storyKey',p.story_key,'accountDid',p.account_did,'record',p.record_payload,'preparedAt',p.prepared_at)
 from public.warpcore_publications p where p.story_key is distinct from p_exclude_story
 and p.state in ('prepared','sending','uncertain','manual_review','published')
 ) select r.key,r.item||jsonb_build_object('candidateContext',coalesce((select jsonb_agg(x.item order by x.uri) from (
 select c.uri,jsonb_build_object('id',c.uri,'text',left(c.text,800),'url',c.source_url,'sourceType',c.source_type,'nativeUri',c.native_uri,'nativeCid',c.native_cid,'sourceCreatedAt',c.source_created_at) as item
 from public.warpcore_candidates c where c.story_key=r.story_key order by c.uri limit 20) x),'[]'::jsonb))
 from relevant r
$$;
create function agent_verification.history_hash(p_exclude_story text default null) returns text
language sql security definer set search_path='' as $$
 select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('key',key,'item',item) order by key),'[]'::jsonb)::text,'UTF8')),'hex') from agent_verification.history_rows(p_exclude_story)
$$;
create function public.warpcore_agent_history(p_cursor text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare items jsonb;cursor text;n integer;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('warpcore_shared_admission_v1',0)) then raise exception 'Admission busy' using errcode='55P03';end if;
 perform agent_verification.lock_history();
 if p_cursor is not null and (length(p_cursor)>512 or p_cursor !~ '^[ip]:') then raise exception 'Invalid history cursor'; end if;
 select coalesce(jsonb_agg(item||jsonb_build_object('historyKey',key) order by key),'[]'::jsonb),max(key),count(*) into items,cursor,n
 from (select key,item from agent_verification.history_rows() where p_cursor is null or key>p_cursor order by key limit 50) page;
 return jsonb_build_object('snapshotHash',agent_verification.history_hash(),'historyCoverageMode','all-published-plus-unresolved-v1','cursor',cursor,'items',items,'complete',not exists(select 1 from agent_verification.history_rows() where cursor is not null and key>cursor));
end $$;
-- Material is accepted only from authenticated server code. The model has no
-- database tools/credentials. Its judgment remains honestly labelled as such.
create function agent_verification.native_public_json(value jsonb,depth integer default 0) returns boolean
language plpgsql immutable set search_path='' as $$
declare entry record;child jsonb;
begin
 if depth>40 then return false;end if;
 if jsonb_typeof(value)='object' then
  for entry in select * from jsonb_each(value) loop
   if entry.key='labels' and not coalesce((entry.value='[]'::jsonb or jsonb_typeof(entry.value)='object' and entry.value->'values'='[]'::jsonb),false) then return false;end if;
   if entry.key in ('blocked','blockedBy','blocking','notFound','private','muted') and entry.value not in ('false'::jsonb,'null'::jsonb) then return false;end if;
   if not agent_verification.native_public_json(entry.value,depth+1) then return false;end if;
  end loop;
 elsif jsonb_typeof(value)='array' then
  for child in select * from jsonb_array_elements(value) loop if not agent_verification.native_public_json(child,depth+1) then return false;end if;end loop;
 end if;
 return true;
end $$;
create function public.warpcore_agent_issue_receipt(p_material jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare m jsonb:=p_material;j jsonb;s jsonb;source jsonb;claim jsonb;k text;existing agent_verification.receipts;expiry timestamptz;rid uuid;body text;captured jsonb;native boolean;github boolean;original jsonb;release_path text[];published timestamptz;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('warpcore_shared_admission_v1',0)) then raise exception 'Admission busy' using errcode='55P03';end if;
 if m is null or jsonb_typeof(m) is distinct from 'object' or octet_length(m::text)>2000000
 or (m-'version'-'agentId'-'runId'-'storyKey'-'evidenceHash'-'editorial'-'model'-'policyVersion'-'requestProfileVersion'-'requestSha256'-'judgment'-'sources')<>'{}'::jsonb
 or m->>'version' is distinct from 'agent-verification-v1' or m->>'agentId' is distinct from 'warpcore-news-agent-v1'
 or coalesce(m->>'runId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 then raise exception 'Invalid verification material'; end if;
 foreach k in array array['storyKey','evidenceHash','requestSha256'] loop
  if jsonb_typeof(m->k) is distinct from 'string' or m->>k !~ '^[a-f0-9]{64}$' then raise exception 'Invalid verification hash'; end if;
 end loop;
 foreach k in array array['model','policyVersion','requestProfileVersion'] loop
  if jsonb_typeof(m->k) is distinct from 'string' or length(btrim(m->>k)) not between 1 and 200 or m->>k ~ '[[:cntrl:]]' then raise exception 'Invalid verification provenance'; end if;
 end loop;
 perform agent_verification.lock_history(m->>'storyKey');
 select * into existing from agent_verification.receipts where material->>'agentId'=m->>'agentId' and material->>'runId'=m->>'runId' and material->>'storyKey'=m->>'storyKey' and material->>'requestSha256'=m->>'requestSha256';
 if found then if existing.material is distinct from m then raise exception 'Immutable verification request'; end if;return existing.id;end if;
 perform 1 from public.warpcore_stories where story_key=m->>'storyKey' and status='unverified_review_required' for update;
 if not found then raise exception 'Story unavailable'; end if;
 s:=public.warpcore_curator_snapshot(m->>'storyKey');
 if s->>'evidence_hash' is distinct from m->>'evidenceHash' or jsonb_array_length(s->'evidence') not between 1 and 20 or octet_length((s->'evidence')::text)>200000 then raise exception 'Stale verification evidence'; end if;
 j:=m->'judgment';
 if jsonb_typeof(j) is distinct from 'object'
 or (j-'method'-'factsSupported'-'scopeApproved'-'meaningfulChange'-'dedupClear'-'checkedAt'-'claims'-'publicationDate'-'scopeReason'-'changeReason'-'dedupReason'-'historyHash')<>'{}'::jsonb
 or j->>'method' is distinct from 'model-supported-primary-evidence'
 or j->'factsSupported' is distinct from 'true'::jsonb or j->'scopeApproved' is distinct from 'true'::jsonb
 or j->'meaningfulChange' is distinct from 'true'::jsonb or j->'dedupClear' is distinct from 'true'::jsonb
 or jsonb_typeof(j->'historyHash') is distinct from 'string' or j->>'historyHash' !~ '^[a-f0-9]{64}$'
 or j->>'historyHash' is distinct from agent_verification.history_hash(m->>'storyKey')
 or jsonb_typeof(j->'checkedAt') is distinct from 'string' or (j->>'checkedAt')::timestamptz not between clock_timestamp()-interval '1 hour' and clock_timestamp()+interval '5 minutes'
 or jsonb_typeof(j->'publicationDate') is distinct from 'string' or j->>'publicationDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
 or (j->>'publicationDate')::date not between current_date-7 and current_date
 or jsonb_typeof(j->'claims') is distinct from 'array' or jsonb_array_length(j->'claims') not between 1 and 30
 or jsonb_typeof(m->'sources') is distinct from 'array' or jsonb_array_length(m->'sources') not between 1 and 20
 then raise exception 'Invalid or stale verification judgment'; end if;
 foreach k in array array['scopeReason','changeReason','dedupReason'] loop
  if jsonb_typeof(j->k) is distinct from 'string' or length(btrim(j->>k)) not between 1 and 1000 then raise exception 'Invalid verification reasoning'; end if;
 end loop;
 expiry:=least(clock_timestamp()+interval '1 hour',(j->>'checkedAt')::timestamptz+interval '1 hour');
 for source in select value from jsonb_array_elements(m->'sources') loop
  select e into captured from jsonb_array_elements(s->'evidence') e where e->>'id'=source->>'evidenceId';
  native:=coalesce(captured->>'sourceType'='bluesky',false);
  github:=not native and coalesce(source->>'captureKind'='github-release-v1',false);
  if jsonb_typeof(source) is distinct from 'object' or (case when native then source-'fetchedUrl'-'nativeUri'-'nativeCid'-'nativeAuthorDid' when github then source-'captureKind'-'fetchedUrl' else source end-'evidenceId'-'url'-'contentSha256'-'fetchedAt'-'body')<>'{}'::jsonb
  or jsonb_typeof(source->'body') is distinct from 'string' or octet_length(source->>'body') not between 1 and 200000
  or jsonb_typeof(source->'evidenceId') is distinct from 'string' or jsonb_typeof(source->'url') is distinct from 'string'
  or source->>'url' !~ '^https://[^/@[:space:]]+([/?#]|$)'
  or source->>'contentSha256' is distinct from encode(sha256(convert_to(source->>'body','UTF8')),'hex')
  or jsonb_typeof(source->'fetchedAt') is distinct from 'string' or (source->>'fetchedAt')::timestamptz not between clock_timestamp()-interval '1 hour' and clock_timestamp()+interval '5 minutes'
  or not exists(select 1 from jsonb_array_elements(s->'evidence') e where e->>'id'=source->>'evidenceId' and (e->>'url'=source->>'url' or e->>'nativeUrl'=source->>'url' or e->'sourceLinks' ? (source->>'url')))
  then raise exception 'Invalid captured source'; end if;
  if native then
   if source->>'nativeUri' is distinct from captured->>'nativeUri' or source->>'nativeCid' is distinct from captured->>'nativeCid'
   or source->>'nativeAuthorDid' is distinct from captured->>'nativeAuthorDid' or not public.warpcore_valid_repost_evidence(captured)
   or source->>'url' is distinct from coalesce(captured->>'nativeUrl',captured->>'url')
   or source->>'fetchedUrl' is distinct from 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris='||replace(replace(captured->>'nativeUri',':','%3A'),'/','%2F')
   then raise exception 'Invalid native capture binding';end if;
   original:=(source->>'body')::jsonb;
   if jsonb_typeof(original) is distinct from 'object' or (original-'posts')<>'{}'::jsonb or jsonb_typeof(original->'posts') is distinct from 'array' or jsonb_array_length(original->'posts')<>1
   then raise exception 'Invalid native public response';end if;
   original:=original->'posts'->0;
   if original->>'uri' is distinct from captured->>'nativeUri' or original->>'cid' is distinct from captured->>'nativeCid' or original->'author'->>'did' is distinct from captured->>'nativeAuthorDid'
   or (original ? '$type' and original->>'$type' is distinct from 'app.bsky.feed.defs#postView')
   or original->'record'->>'$type' is distinct from 'app.bsky.feed.post' or jsonb_typeof(original->'record'->'text') is distinct from 'string' or length(btrim(original->'record'->>'text')) not between 1 and 3000
   or jsonb_typeof(original->'record'->'createdAt') is distinct from 'string' or (original->'record'->>'createdAt')::timestamptz not between clock_timestamp()-interval '7 days' and clock_timestamp()+interval '5 minutes'
   or not agent_verification.native_public_json(original)
   then raise exception 'Invalid native original identity';end if;
   if m->'editorial'->>'mode'='repost' and m->'editorial'->'evidenceIds' ? (source->>'evidenceId') and ((original->'record'->>'createdAt')::timestamptz at time zone 'UTC')::date is distinct from (j->>'publicationDate')::date then raise exception 'Invalid native publication date';end if;
  end if;
  if github then
   release_path:=regexp_match(source->>'url','^https://github[.]com/(amd/gaia|lemonade-sdk/lemonade|ROCm/TheRock|ggml-org/llama[.]cpp|vllm-project/vllm|ollama/ollama|ml-explore/mlx|anthropics/claude-code)/releases/tag/([A-Za-z0-9._+~-]+)$');
   if release_path is null or release_path[2] in ('.','..') or source->>'url' ~ U&'[\0001-\001F\007F-\009F]'
   or octet_length(source->>'body')>100000 or source->>'fetchedUrl' is distinct from 'https://api.github.com/repos/'||release_path[1]||'/releases/tags/'||release_path[2]
   then raise exception 'Invalid GitHub capture binding';end if;
   original:=(source->>'body')::jsonb;
   if jsonb_typeof(original) is distinct from 'object' or original->>'html_url' is distinct from source->>'url'
   or original->>'tag_name' is distinct from release_path[2] or original->'draft' is distinct from 'false'::jsonb
   or jsonb_typeof(original->'prerelease') is distinct from 'boolean' or jsonb_typeof(original->'body') is distinct from 'string'
   or jsonb_typeof(original->'published_at') is distinct from 'string'
   or original->>'published_at' ~ '[[:cntrl:]]'
   or original->>'published_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
   then raise exception 'Invalid GitHub release identity';end if;
   if substring(original->>'published_at' from 12 for 2)::integer>23 or substring(original->>'published_at' from 15 for 2)::integer>59
   or substring(original->>'published_at' from 18 for 2)::integer>59 then raise exception 'Invalid GitHub publication time';end if;
   -- Match JavaScript Date's millisecond precision before UTC-day binding.
   published:=regexp_replace(original->>'published_at','([.][0-9]{3})[0-9]+Z$','\1Z')::timestamptz;
   if published not between clock_timestamp()-interval '7 days' and clock_timestamp()+interval '5 minutes'
   or (published at time zone 'UTC')::date is distinct from substring(original->>'published_at' from 1 for 10)::date
   then raise exception 'Invalid GitHub publication time';end if;
   if m->'editorial'->'evidenceIds' ? (source->>'evidenceId') and (published at time zone 'UTC')::date is distinct from (j->>'publicationDate')::date
   then raise exception 'Invalid GitHub publication date';end if;
  end if;
  expiry:=least(expiry,(source->>'fetchedAt')::timestamptz+interval '1 hour');
 end loop;
 for claim in select value from jsonb_array_elements(j->'claims') loop
  select e into captured from jsonb_array_elements(s->'evidence') e where e->>'id'=claim->>'evidenceId';
  native:=coalesce(captured->>'sourceType'='bluesky',false);
  if jsonb_typeof(claim) is distinct from 'object' or (case when native then claim-'originalQuote' else claim end-'claim'-'evidenceId'-'url'-'contentSha256'-'quote'-'quoteStart'-'quoteEnd')<>'{}'::jsonb
  or jsonb_typeof(claim->'claim') is distinct from 'string' or length(btrim(claim->>'claim')) not between 1 and 3000
  or jsonb_typeof(claim->'quote') is distinct from 'string' or length(claim->>'quote') not between 1 and (case when native then 18000 else 3000 end)
  or jsonb_typeof(claim->'quoteStart') is distinct from 'number' or coalesce(claim->>'quoteStart','') !~ '^[0-9]{1,6}$'
  or jsonb_typeof(claim->'quoteEnd') is distinct from 'number' or coalesce(claim->>'quoteEnd','') !~ '^[0-9]{1,6}$'
  then raise exception 'Invalid verification claim'; end if;
  select x->>'body' into body from jsonb_array_elements(m->'sources') x where x->>'evidenceId'=claim->>'evidenceId' and x->>'url'=claim->>'url' and x->>'contentSha256'=claim->>'contentSha256';
  if not coalesce(m->'editorial'->'evidenceIds' ? (claim->>'evidenceId'),false) then raise exception 'Unselected verification claim';end if;
  if body is null or (claim->>'quoteEnd')::integer<=(claim->>'quoteStart')::integer
  or (claim->>'quoteEnd')::integer>length(body)
  or substring(body from (claim->>'quoteStart')::integer+1 for (claim->>'quoteEnd')::integer-(claim->>'quoteStart')::integer) is distinct from claim->>'quote'
  then raise exception 'Unsupported verification quote'; end if;
  select e into captured from jsonb_array_elements(s->'evidence') e where e->>'id'=claim->>'evidenceId';
  if captured->>'sourceType'='bluesky' then
   original:=body::jsonb->'posts'->0->'record';
   if jsonb_typeof(claim->'originalQuote') is distinct from 'string' or length(claim->>'originalQuote') not between 1 and 3000
   or claim->>'quote' is distinct from substring(to_json(claim->>'originalQuote')::text from 2 for length(to_json(claim->>'originalQuote')::text)-2)
   or (position(claim->>'originalQuote' in original->>'text')=0 and position(claim->>'originalQuote' in original->>'createdAt')=0)
   then raise exception 'Native quote outside original record';end if;
  end if;
 end loop;
 if jsonb_typeof(m->'editorial') is distinct from 'object' or octet_length((m->'editorial')::text)>16000 then raise exception 'Invalid receipt editorial'; end if;
 insert into agent_verification.receipts(material,evidence,receipt_hash,expires_at)
 values(m,s->'evidence',encode(sha256(convert_to(jsonb_build_object('material',m,'evidence',s->'evidence')::text,'UTF8')),'hex'),expiry) returning id into rid;
 return rid;
end $$;
create function agent_verification.receipt_current(p_receipt uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare r agent_verification.receipts;s jsonb;
begin
 select * into r from agent_verification.receipts where id=p_receipt;
 if not found or r.expires_at<=clock_timestamp() then return false;end if;
 perform agent_verification.lock_history(r.material->>'storyKey');
 s:=public.warpcore_curator_snapshot(r.material->>'storyKey');
 return s->>'evidence_hash'=r.material->>'evidenceHash' and s->'evidence'=r.evidence
 and r.material->'judgment'->>'historyHash'=agent_verification.history_hash(r.material->>'storyKey');
end $$;
create function public.warpcore_agent_receipt(p_receipt uuid) returns jsonb
language sql security definer set search_path='' as $$
 select jsonb_build_object('id',id,'receiptHash',receipt_hash,'issuedAt',issued_at,'expiresAt',expires_at,
 'material',material,'evidence',evidence,'current',agent_verification.receipt_current(id)) from agent_verification.receipts where id=p_receipt
$$;
create function public.warpcore_agent_submit(p_receipt uuid) returns uuid
language plpgsql security definer set search_path='' as $fn$
declare s jsonb;r public.warpcore_curator_inbox;status text;receipt agent_verification.receipts;
 p_story text;p_evidence_hash text;p_editorial jsonb;p_attestations jsonb:='{"factsVerified":true,"meaningfulChange":true,"scopeApproved":true}'::jsonb;p_run_id uuid;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('warpcore_shared_admission_v1',0)) then raise exception 'Admission busy' using errcode='55P03';end if;
 select * into r from public.warpcore_curator_inbox where verification_receipt_id=p_receipt;
 if found then return r.id;end if;
 select * into receipt from agent_verification.receipts where id=p_receipt;
 if not found or not agent_verification.receipt_current(p_receipt) then raise exception 'Stale verification receipt';end if;
 p_story:=receipt.material->>'storyKey';p_evidence_hash:=receipt.material->>'evidenceHash';
 p_editorial:=receipt.material->'editorial';p_run_id:=(receipt.material->>'runId')::uuid;
 update public.warpcore_curator_inbox set state='rejected',completed_at=now(),reason='expired_or_attempt_limit' where (state='pending' or (state='leased' and lease_expires_at<=now())) and (created_at<now()-interval '24 hours' or attempts>=3);
 if (select count(*) from public.warpcore_curator_inbox where state in ('pending','leased'))>=24 then raise exception 'Curator backlog limit';end if;
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
 insert into public.warpcore_curator_inbox(story_key,evidence_hash,evidence,editorial,attestations,actor_kind,agent_id,verification_receipt_id,run_id) values(p_story,p_evidence_hash,s->'evidence',p_editorial,p_attestations,'agent','warpcore-news-agent-v1',p_receipt,p_run_id) returning id into r.id;
 return r.id;
end;$fn$;
-- Keep the reviewed native post/repost implementation as the private core.
alter function public.warpcore_curator_finalize(uuid,uuid,jsonb,jsonb) set schema agent_verification;
revoke all on function agent_verification.warpcore_curator_finalize(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.warpcore_curator_finalize(p_id uuid,p_lease_token uuid,p_packet jsonb,p_job jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare r public.warpcore_curator_inbox;receipt agent_verification.receipts;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('warpcore_shared_admission_v1',0)) then raise exception 'Admission busy' using errcode='55P03';end if;
 select * into r from public.warpcore_curator_inbox where id=p_id for update;
 if not found or r.state<>'leased' or r.lease_token is distinct from p_lease_token or r.lease_expires_at<=now() then return false;end if;
 if r.actor_kind='agent' then
  select * into receipt from agent_verification.receipts where id=r.verification_receipt_id;
  if not found or r.agent_id is distinct from 'warpcore-news-agent-v1'
  or receipt.material->>'runId' is distinct from r.run_id::text or receipt.material->>'storyKey' is distinct from r.story_key
  or receipt.material->>'evidenceHash' is distinct from r.evidence_hash or receipt.evidence is distinct from r.evidence
  or receipt.material->'editorial' is distinct from r.editorial or not agent_verification.receipt_current(r.verification_receipt_id)
  then update public.warpcore_curator_inbox set state='rejected',reason='stale_verification_receipt',completed_at=now() where id=p_id;return false;end if;
 end if;
 return agent_verification.warpcore_curator_finalize(p_id,p_lease_token,p_packet,p_job);
end $$;
revoke all on all functions in schema agent_verification from public,anon,authenticated,service_role;
revoke all on function public.warpcore_agent_history(text),public.warpcore_agent_issue_receipt(jsonb),public.warpcore_agent_submit(uuid),public.warpcore_agent_receipt(uuid),public.warpcore_curator_finalize(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_agent_history(text),public.warpcore_agent_issue_receipt(jsonb),public.warpcore_agent_submit(uuid),public.warpcore_agent_receipt(uuid),public.warpcore_curator_finalize(uuid,uuid,jsonb,jsonb) to service_role;
commit;
