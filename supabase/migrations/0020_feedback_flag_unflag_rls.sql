-- 0020_feedback_flag_unflag_rls.sql — Allow authenticated users to DELETE their own flag rows.
--
-- Hard-delete chosen: single-user app, no audit requirement for flag removal.
--
-- No SELECT policy added here: migration 0006 already defines
-- system_logs_authenticated_read (using true), which grants authenticated full
-- SELECT on system_logs. fetchFlaggedState reads work under that existing policy.
--
-- The DELETE policy is triple-scoped to prevent an authenticated browser client
-- from deleting any non-feedback system_logs rows (scrape/agent/digest logs):
--   category = 'feedback'      — only feedback rows
--   level    = 'info'          — only info-level rows (not error rows)
--   metadata->>'feedback_type' in ('source_flag','item_flag')
--                              — only flag rows, not signals/comments

drop policy if exists system_logs_feedback_flag_delete on system_logs;

create policy system_logs_feedback_flag_delete
  on system_logs for delete
  to authenticated
  using (
    category = 'feedback'
    and level = 'info'
    and metadata->>'feedback_type' in ('source_flag', 'item_flag')
  );
