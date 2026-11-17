-- Separate administrative installation. No queue cleanup, actor migration or activation.
-- Live work is one distinct story across both tables, globally across accounts.
-- Inbox pending/leased + publication prepared/sending/uncertain/manual_review.
-- Native reposts and posts share this bound. Terminal history consumes no slot.
begin;
lock table public.warpcore_curator_inbox,public.warpcore_publications in share row exclusive mode;
do $$
declare pending_count bigint;
begin
 select count(*) into pending_count from (
  select story_key from public.warpcore_curator_inbox where state in ('pending','leased')
  union
  select story_key from public.warpcore_publications where state in ('prepared','sending','uncertain','manual_review')
 ) pending;
 if pending_count>5 then raise exception 'Cannot install admission: existing combined pending count % exceeds 5; reconcile historical work before activation',pending_count; end if;
end $$;
create schema warpcore_admission;
revoke all on schema warpcore_admission from public,anon,authenticated,service_role;
create function warpcore_admission.lock_writes() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Some legacy RPCs already hold row locks. Waiting for this advisory lock could
 -- invert that order: refuse immediately instead. A refused transaction has no
 -- admitted work; external send/finalization uncertainty still needs reconciliation.
 if current_setting('transaction_isolation') <> 'read committed' then
  raise exception 'Shared admission requires READ COMMITTED';
 end if;
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('warpcore_shared_admission_v1',0)) then
  raise exception using errcode='55P03',message='Shared admission busy; transaction refused';
 end if;
 return null;
end $$;
create function warpcore_admission.assert_limit() returns trigger
language plpgsql security definer set search_path='' as $$
declare pending_count bigint;
begin
 -- UNION is intentional: finalize inserts a publication before marking its
 -- leased inbox row processed. That transient same-story overlap is one slot.
 select count(*) into pending_count from (
  select story_key from public.warpcore_curator_inbox where state in ('pending','leased')
  union
  select story_key from public.warpcore_publications where state in ('prepared','sending','uncertain','manual_review')
 ) pending;
 if pending_count>5 then raise exception 'Combined pending limit 5 exceeded (count %)',pending_count; end if;
 return null;
end $$;
revoke all on function warpcore_admission.lock_writes(),warpcore_admission.assert_limit() from public,anon,authenticated,service_role;
create trigger warpcore_shared_admission_lock before insert or update or delete on public.warpcore_curator_inbox
 for each statement execute function warpcore_admission.lock_writes();
create trigger warpcore_shared_admission_limit after insert or update or delete on public.warpcore_curator_inbox
 for each statement execute function warpcore_admission.assert_limit();
create trigger warpcore_shared_admission_lock before insert or update or delete on public.warpcore_publications
 for each statement execute function warpcore_admission.lock_writes();
create trigger warpcore_shared_admission_limit after insert or update or delete on public.warpcore_publications
 for each statement execute function warpcore_admission.assert_limit();
commit;
