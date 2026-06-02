-- 0004_auth_allowlist_hook.sql — fix the email-allowlist enforcement (#10 follow-up).
--
-- 0003 used an `after insert on auth.users` trigger that DELETED any non-allowlisted
-- user. That breaks Supabase Auth: GoTrue creates the user and reads it back within the
-- same flow, but the trigger had already deleted the row — surfacing to the client as
-- "Database error loading user after sign-up". It also rejected ungracefully (no message).
--
-- Replace it with the supported "Before User Created" auth hook
-- (https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook): a function
-- that runs BEFORE insertion and returns `{}` to allow or `{error:{...}}` to reject. No
-- row is created for a rejected signup, so the auth flow is never corrupted, and the
-- client receives a clean 403 message.
--
-- ENABLE (one-time, dashboard): Authentication → Hooks → "Before User Created" →
-- select the Postgres function `public.hook_restrict_signup`. Seed your email into
-- public.digest_allowlist BEFORE enabling, or you will lock yourself out.

drop trigger if exists trg_enforce_auth_allowlist on auth.users;
drop function if exists public.enforce_auth_allowlist();

create or replace function public.hook_restrict_signup(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  candidate text;
begin
  candidate := event->'user'->>'email';
  if public.is_email_allowlisted(candidate) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'This email is not authorized to access this app.'
    )
  );
end;
$$;

-- The auth server invokes the hook as the supabase_auth_admin role.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_restrict_signup(jsonb) to supabase_auth_admin;
grant execute on function public.is_email_allowlisted(text) to supabase_auth_admin;
revoke execute on function public.hook_restrict_signup(jsonb) from authenticated, anon, public;
