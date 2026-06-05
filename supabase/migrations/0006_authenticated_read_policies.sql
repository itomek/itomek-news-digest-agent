-- Read policies were scoped to the `anon` role (magic-link / public-read era).
-- Since 0005 the app is login-gated (email + password + TOTP MFA), so browser
-- reads run as the `authenticated` role and matched no policy -> 0 rows.
-- Move read access to `authenticated` only (tightest posture: the publishable
-- key ships in the bundle, so anon-read would let anyone bypass the login gate).
-- service_role still bypasses RLS for the agent's writes.

drop policy if exists digest_topics_anon_read on digest_topics;
drop policy if exists digests_anon_read on digests;
drop policy if exists system_logs_anon_read on system_logs;

create policy digest_topics_authenticated_read
  on digest_topics for select
  to authenticated
  using (enabled);

create policy digests_authenticated_read
  on digests for select
  to authenticated
  using (true);

create policy system_logs_authenticated_read
  on system_logs for select
  to authenticated
  using (true);
