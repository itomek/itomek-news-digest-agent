-- Append-only private recovery audit schema. Does NOT recover, unlock, or alter any publication.
create table public.warpcore_publication_recovery_audit (
 id uuid primary key default gen_random_uuid(),
 operation text not null check(operation='firebase_legacy_tid_recovery'),
 account_did text not null,
 story_key text not null,
 recorded_at timestamptz not null default clock_timestamp(),
 executed_db_role text not null default current_user,
 old_publication jsonb not null,
 new_publication jsonb not null,
 prior_inbox jsonb not null,
 absence_observations jsonb not null,
 publication_slot_before jsonb not null,
 unique(operation,account_did,story_key)
);
alter table public.warpcore_publication_recovery_audit enable row level security;
revoke all on public.warpcore_publication_recovery_audit from public,anon,authenticated,service_role;
create function public.warpcore_recovery_audit_immutable() returns trigger
language plpgsql security invoker set search_path='' as $fn$
begin raise exception 'Recovery audit is append-only';end;$fn$;
create trigger warpcore_recovery_audit_immutable before update or delete on public.warpcore_publication_recovery_audit for each row execute function public.warpcore_recovery_audit_immutable();
revoke all on function public.warpcore_recovery_audit_immutable() from public,anon,authenticated,service_role;
