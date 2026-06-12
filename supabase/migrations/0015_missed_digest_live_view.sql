-- 0015_missed_digest_live_view.sql — Live missed-digest view.
--
-- The dashboard's "Missed digest alerts" banner previously read append-only
-- warn rows written by fn_check_missed_digests() (0013). Those rows were
-- correct at write time but never reconciled: once a digest published, the
-- warn row lingered and kept the banner lit for its whole 48h read window
-- (e.g. world_news warned at 01:58 UTC, published at 02:12 UTC, yet the banner
-- stayed up). This view computes overdue topics LIVE from current state, so
-- the banner reflects reality in both directions and cannot go stale.
--
-- Window logic mirrors fn_check_missed_digests() exactly:
--   24h topics: overdue if no digest in the last 26h
--    7d topics: overdue if no digest in the last 7d+2h (170h)
-- The daily fn_check_missed_digests() cron is intentionally LEFT in place: its
-- warn rows remain a historical audit trail in system_logs / the Logs page.
--
-- SELECT-only; authenticated role is granted SELECT (matches the 0013 views).
-- Idempotent: re-applying is safe.

create or replace view v_missed_digests as
select
  t.slug                                             as topic_slug,
  t.cadence,
  m.last_digest_date,
  case when t.cadence = '24h' then 26 else 170 end   as window_hours
from digest_topics t
left join (
  select topic_slug, max(digest_date) as last_digest_date
  from digests
  group by topic_slug
) m on m.topic_slug = t.slug
where t.enabled = true
  and (
    m.last_digest_date is null
    or m.last_digest_date
       < (now() - make_interval(hours => case when t.cadence = '24h' then 26 else 170 end))::date
  )
order by t.slug;

grant select on v_missed_digests to authenticated;
