-- 0005_drop_allowlist_single_user.sql — simplify to a single-user app (#10 follow-up).
--
-- The app is for one user. New signups are disabled at the Supabase project level
-- (Authentication → Sign In / Providers → Email → "Allow new users to sign up" = off),
-- so only the one pre-existing account can ever log in. That makes the email allowlist
-- (table + Before-User-Created hook from 0003/0004) entirely redundant — remove it.
--
-- Login remains passwordless magic link; the disabled-signups toggle is the boundary.

drop function if exists public.hook_restrict_signup(jsonb);
drop function if exists public.is_email_allowlisted(text);
drop table if exists public.digest_allowlist;
