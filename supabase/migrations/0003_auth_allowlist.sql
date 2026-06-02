-- 0003_auth_allowlist.sql — email allowlist for Supabase Auth sign-ups (#10).
-- Source of truth: docs/architecture.md §8 ("Auth allowlist").
--
-- A new auth.users row whose email is not present in digest_allowlist is deleted
-- immediately after insert. This is the DB-enforced security boundary; the web
-- app's client-side check (web/src/lib/allowlist.ts) is only a UX nicety.

create table if not exists public.digest_allowlist (
  email text primary key,
  note text,
  created_at timestamptz not null default now()
);

-- Allowlist is sensitive config: lock it down. No anon access; service_role
-- bypasses RLS for administration.
alter table public.digest_allowlist enable row level security;

-- Normalize emails for case-insensitive matching.
create or replace function public.is_email_allowlisted(candidate text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.digest_allowlist
    where lower(email) = lower(trim(candidate))
  );
$$;

-- Trigger function: reject (delete) any newly created user not on the allowlist.
create or replace function public.enforce_auth_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_email_allowlisted(new.email) then
    delete from auth.users where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_auth_allowlist on auth.users;
create trigger trg_enforce_auth_allowlist
  after insert on auth.users
  for each row
  execute function public.enforce_auth_allowlist();
