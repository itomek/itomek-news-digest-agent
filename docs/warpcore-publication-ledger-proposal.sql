-- PROPOSAL ONLY, NOT APPLIED. Depends on source-neutral schema proposal.
-- Account identity is part of the key. Future publishing must pin verified account DID.
create table public.warpcore_publications (
 account_did text not null,
 story_key text not null references public.warpcore_stories(story_key),
 record_key text not null,
 content_hash text not null,
 state text not null default 'prepared' check(state in ('prepared','sending','uncertain','published','rejected')),
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
 and p.content_hash=p_hash and p.record_payload=p_record and p.state='prepared'
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
