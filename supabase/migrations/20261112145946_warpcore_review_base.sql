-- Tested review base. New objects only; RLS/server-only privileges. No fixtures, secrets or schedules.
-- PROPOSAL ONLY: fresh schema, not applied. CLI-generated migration required.
-- Story grouping is separate from evidence: multiple sources must not be lost.
create table public.warpcore_stories (
 story_key text primary key,
 status text not null default 'unverified_review_required'
 check(status in ('unverified_review_required','approved','rejected','publishing_uncertain','published')),
 collected_at timestamptz not null default now(),
 published_uri text
);
create table public.warpcore_candidates (
 uri text primary key,
 story_key text not null references public.warpcore_stories(story_key),
 source_type text not null,
 source_id text not null,
 actor text not null,
 text text not null,
 source_created_at timestamptz not null,
 source_url text,
 collected_at timestamptz not null default now()
);
create index warpcore_candidates_story on public.warpcore_candidates(story_key);
alter table public.warpcore_stories enable row level security;
alter table public.warpcore_candidates enable row level security;
revoke all on public.warpcore_stories,public.warpcore_candidates from public,anon,authenticated;
grant select,insert,update on public.warpcore_stories,public.warpcore_candidates to service_role;
create function public.warpcore_ingest(items jsonb) returns void
language plpgsql security invoker set search_path = '' as $fn$
begin
 if jsonb_typeof(items) <> 'array' or jsonb_array_length(items)>5000 then
   raise exception 'invalid ingest batch';
 end if;
 insert into public.warpcore_stories(story_key)
 select distinct x.story_key from jsonb_to_recordset(items) as x(story_key text)
 order by x.story_key on conflict do nothing;
 insert into public.warpcore_candidates(uri,story_key,source_type,source_id,actor,text,source_created_at,source_url)
 select uri,story_key,source_type,source_id,actor,text,source_created_at,source_url
 from jsonb_to_recordset(items) as x(uri text,story_key text,source_type text,source_id text,actor text,text text,source_created_at timestamptz,source_url text)
 order by uri on conflict do nothing;
end;
$fn$;
revoke all on function public.warpcore_ingest(jsonb) from public,anon,authenticated;
grant execute on function public.warpcore_ingest(jsonb) to service_role;
-- One RPC transaction creates story + evidence atomically, never changes editorial status.
-- No publisher or anonymous access. Hosted/Postgres integration testing remains required.

-- PROPOSAL ONLY, NOT APPLIED. Depends on source-neutral schema proposal.
-- Account identity is part of the key. Future publishing must pin verified account DID.
create table public.warpcore_publications (
 account_did text not null,
 story_key text not null references public.warpcore_stories(story_key),
 record_key text not null,
 content_hash text not null,
 state text not null default 'prepared' check(state in ('prepared','sending','uncertain','published','rejected','manual_review')),
 approved_at timestamptz, -- exact persisted record approval, never source-provided
 last_checked_at timestamptz,
 prepared_at timestamptz not null default now(),
 remote_uri text,
 primary key(account_did,story_key),
 unique(account_did,record_key)
);
alter table public.warpcore_publications enable row level security;
revoke all on public.warpcore_publications from public,anon,authenticated;
grant select,insert,update on public.warpcore_publications to service_role;
-- Claim RPC proposed below, no send RPC: do not confuse durable uniqueness with
-- a complete exactly-once publisher. Preparation must compare existing hash;
-- a different hash is a review conflict, never an overwrite/repost.
-- A future atomic prepared->sending compare-and-set must commit BEFORE sending.
-- Crashed sending/uncertain rows require remote record reconciliation, not reset.
-- Authorize account+content scope outside untrusted source data before claim.


-- Persist exact record before claiming, including facets and timestamp.
alter table public.warpcore_publications add column record_payload jsonb not null;

-- Future authenticated server-only claim. Returns no row on replay/hash conflict,
-- non-approved story, or any sending/uncertain/published state. No stale reset.
-- Caller must persist the exact record (including prepared_at) before this call.
create function public.warpcore_claim_publication(p_account text,p_story text,p_hash text,p_record jsonb)
returns setof public.warpcore_publications language plpgsql security invoker set search_path='' as $fn$
begin
 return query update public.warpcore_publications p set state='sending'
 where p.account_did=p_account and p.story_key=p_story
 and p.content_hash=p_hash and p.record_payload=p_record and p.state='prepared' and p.approved_at is not null
 and exists(select 1 from public.warpcore_stories s where s.story_key=p_story and s.status='approved') returning p.*;
end;
$fn$;
revoke all on function public.warpcore_claim_publication(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.warpcore_claim_publication(text,text,text,jsonb) to service_role;
-- Concurrent UPDATE lock recheck allows only one caller to change prepared->sending.
-- This SQL is not a grant of publishing authorization. Integration/concurrency tests
-- must pass before use; caller must separately enforce current scope/account approval.

create function public.warpcore_mark_uncertain(p_account text,p_story text,p_hash text,p_record jsonb)
returns boolean language plpgsql security invoker set search_path='' as $fn$
begin
 update public.warpcore_publications set state='uncertain'
 where account_did=p_account and story_key=p_story and content_hash=p_hash
 and record_payload=p_record and state='sending';
 return found;
end;
$fn$;
create function public.warpcore_mark_published(p_account text,p_story text,p_hash text,p_record jsonb,p_uri text)
returns boolean language plpgsql security invoker set search_path='' as $fn$
begin
 update public.warpcore_publications set state='published',remote_uri=p_uri
 where account_did=p_account and story_key=p_story and content_hash=p_hash
 and record_payload=p_record and state in ('sending','uncertain')
 and p_uri='at://' || account_did || '/app.bsky.feed.post/' || record_key;
 return found;
end;
$fn$;
revoke all on function public.warpcore_mark_uncertain(text,text,text,jsonb),public.warpcore_mark_published(text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.warpcore_mark_uncertain(text,text,text,jsonb),public.warpcore_mark_published(text,text,text,jsonb,text) to service_role;

create function public.warpcore_prepare_publication(p_account text,p_story text,p_hash text,p_record jsonb,p_key text)
returns boolean language plpgsql security invoker set search_path='' as $fn$
begin
 insert into public.warpcore_publications(account_did,story_key,content_hash,record_payload,record_key)
 values(p_account,p_story,p_hash,p_record,p_key)
 on conflict do nothing;
 return exists(select 1 from public.warpcore_publications
 where account_did=p_account and story_key=p_story and content_hash=p_hash
 and record_payload=p_record and record_key=p_key and state='prepared');
end;
$fn$;
revoke all on function public.warpcore_prepare_publication(text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.warpcore_prepare_publication(text,text,text,jsonb,text) to service_role;

create function public.warpcore_immutable_record() returns trigger
language plpgsql security invoker set search_path='' as $fn$
begin
 if new.record_payload is distinct from old.record_payload or new.content_hash is distinct from old.content_hash
 or new.record_key is distinct from old.record_key or new.account_did is distinct from old.account_did
 or new.story_key is distinct from old.story_key then raise exception 'Prepared publication identity/content is immutable'; end if;
 return new;
end;
$fn$;
create trigger warpcore_immutable_record before update on public.warpcore_publications
for each row execute function public.warpcore_immutable_record();
revoke all on function public.warpcore_immutable_record() from public,anon,authenticated;
create function public.warpcore_mark_checked(p_account text,p_story text,p_hash text,p_record jsonb)
returns boolean language plpgsql security invoker set search_path='' as $fn$
begin
 update public.warpcore_publications set last_checked_at=now()
 where account_did=p_account and story_key=p_story and content_hash=p_hash and record_payload=p_record and state in ('sending','uncertain');
 return found;
end;
$fn$;
create function public.warpcore_mark_manual_review(p_account text,p_story text,p_hash text,p_record jsonb)
returns boolean language plpgsql security invoker set search_path='' as $fn$
begin
 update public.warpcore_publications set state='manual_review'
 where account_did=p_account and story_key=p_story and content_hash=p_hash and record_payload=p_record and state in ('sending','uncertain');
 return found;
end;
$fn$;
revoke all on function public.warpcore_mark_checked(text,text,text,jsonb),public.warpcore_mark_manual_review(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.warpcore_mark_checked(text,text,text,jsonb),public.warpcore_mark_manual_review(text,text,text,jsonb) to service_role;

-- Trusted editorial review only. Never called by the scheduler or source adapters.
create function public.warpcore_review_publication(p_account text,p_story text,p_hash text,p_record jsonb,p_approve boolean)
returns boolean language plpgsql security invoker set search_path='' as $fn$
declare matched boolean;
begin
 if p_approve is null then return false; end if;
 update public.warpcore_publications
 set approved_at=case when p_approve then now() else null end,
 state=case when p_approve then 'prepared' else 'rejected' end
 where account_did=p_account and story_key=p_story and content_hash=p_hash
 and record_payload=p_record and state='prepared';
 matched := found;
 if matched and p_approve then
  update public.warpcore_stories set status='approved' where story_key=p_story;
 end if;
 return matched;
end;
$fn$;
revoke all on function public.warpcore_review_publication(text,text,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.warpcore_review_publication(text,text,text,jsonb,boolean) to service_role;
