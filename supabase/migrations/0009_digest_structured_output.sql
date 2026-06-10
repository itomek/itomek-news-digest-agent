-- Structured digest output: summary + ranked items (issue #58)
-- Adds two nullable columns to digests.  Pre-#58 rows keep content and leave
-- these null; new rows carry summary + items while content is derived from them
-- via flatten_digest() (docs/architecture.md §7.1).  No RLS changes: the
-- existing authenticated-read policy (migration 0006) already covers new
-- columns, and service_role bypasses RLS for agent writes.

alter table digests add column summary text;   -- short top-level overview; null on pre-#58 rows
alter table digests add column items jsonb;     -- ranked items (see docs/architecture.md §7.1)
