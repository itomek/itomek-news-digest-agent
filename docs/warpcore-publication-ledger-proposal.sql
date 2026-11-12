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
-- No claim/send RPC yet: do not confuse this durable uniqueness constraint with
-- a complete exactly-once publisher. Preparation must compare existing hash;
-- a different hash is a review conflict, never an overwrite/repost.
-- A future atomic prepared->sending compare-and-set must commit BEFORE sending.
-- Crashed sending/uncertain rows require remote record reconciliation, not reset.
-- Authorize account+content scope outside untrusted source data before claim.
