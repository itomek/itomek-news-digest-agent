-- 0012_feedback_rls.sql — Allow authenticated users to INSERT feedback rows.
-- The web app talks to Supabase as the `authenticated` role (email+TOTP MFA).
-- system_logs currently only has a SELECT policy for authenticated (#0006).
-- This migration adds the narrowest possible INSERT policy: authenticated users
-- may insert rows with category='feedback' and level='info' only, so a browser
-- client can never write level='error' rows that pollute error monitoring.
-- No UPDATE/DELETE is granted. service_role still bypasses RLS for agent writes.

drop policy if exists system_logs_feedback_insert on system_logs;

create policy system_logs_feedback_insert
  on system_logs for insert
  to authenticated
  with check (category = 'feedback' and level = 'info');
