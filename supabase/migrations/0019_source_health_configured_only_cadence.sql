-- 0019_source_health_configured_only_cadence.sql
--
-- Extends mv_source_health with two improvements:
--
--   1. Configured-only filter: only URLs present in digest_topics.sources appear
--      in the matview. One-off article fetches, test artifacts, and removed sources
--      are excluded automatically (they simply have no matching configured URL).
--
--   2. cadence_hours column: carries the most lenient cadence across all topics
--      that reference a given URL (24 for '24h', 168 for '7d', NULL for unknown).
--      The frontend uses this to compute the staleness threshold per-source.
--
-- URL normalization: trailing slashes are stripped before joining so that
-- "https://example.com/feed/" and "https://example.com/feed" match.
--
-- Per-source enabled flag: sources with enabled=false (added in 0016_source_curation)
-- are excluded — they are configured but intentionally not fetched.
--
-- Grants: authenticated SELECT only (mirrors 0013 + 0015; anon was never granted).
--
-- Idempotent: DROP IF EXISTS before recreating, UNIQUE INDEX IF NOT EXISTS.
-- The hourly pg_cron job 'news_digest_refresh_source_health' (0013) references
-- mv_source_health by name and continues to work unchanged.
-- Rollback: re-apply 0015_source_health_scope_to_sources.sql (idempotent).

-- ── mv_source_health ──────────────────────────────────────────────────────────
-- Must DROP + recreate because the column set changes (cadence_hours added).
-- The UNIQUE index and grants are re-created below.

drop materialized view if exists mv_source_health;

create materialized view mv_source_health as
with cfg as (
  -- One row per distinct configured source URL (trailing-slash-normalized).
  -- cadence_hours: most lenient across all topics that reference this URL;
  --   24h → 24, 7d → 168, anything else → NULL (surfaces as unknown, not mis-bucketed).
  -- enabled filter: skip sources explicitly disabled via the per-source enabled flag.
  select
    rtrim(s->>'url', '/')                                      as url,
    max(
      case dt.cadence
        when '24h' then 24
        when '7d'  then 168
        else            null
      end
    )                                                          as cadence_hours
  from digest_topics dt,
       lateral jsonb_array_elements(dt.sources) s
  where coalesce((s->>'enabled')::boolean, true)
  group by rtrim(s->>'url', '/')
),
scrape as (
  select
    timestamp,
    message,
    metadata ->> 'url'                                         as source_url,
    (level = 'info' and metadata ? 'duration_ms')             as is_success,
    (
      level = 'warn'
      and not metadata ? 'bozo_exception'
      and not metadata ? 'truncated_chars'
    )                                                          as is_failure
  from system_logs
  where
    category = 'scrape'
    and metadata ->> 'url' is not null
    and (message like 'fetch_rss:%' or message like 'fetch_html:%')
    and timestamp >= now() - interval '7 days'
)
select
  s.source_url,
  count(*) filter (where s.is_success)                        as success_7d,
  count(*) filter (where s.is_failure)                        as failure_7d,
  count(*) filter (where s.is_success or s.is_failure)        as total_7d,
  round(
    count(*) filter (where s.is_success)::numeric
    / nullif(count(*) filter (where s.is_success or s.is_failure), 0) * 100,
    1
  )                                                            as success_pct_7d,
  max(s.timestamp) filter (where s.is_success)                as last_success_at,
  max(s.timestamp) filter (where s.is_failure)                as last_error_at,
  max(s.timestamp)                                             as last_fetch_at,
  (
    select s2.message
    from scrape s2
    where s2.source_url = s.source_url and s2.is_failure
    order by s2.timestamp desc
    limit 1
  )                                                            as last_error,
  cfg.cadence_hours
from scrape s
join cfg on cfg.url = rtrim(s.source_url, '/')
group by s.source_url, cfg.cadence_hours
with data;

-- Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY (hourly cron).
create unique index if not exists mv_source_health_url_idx
  on mv_source_health (source_url);

grant select on mv_source_health to authenticated;

-- ── Guard: assert the unique index exists ─────────────────────────────────────
-- A missing index makes REFRESH … CONCURRENTLY silently fail forever.
do $$ begin
  if not exists (
    select 1 from pg_indexes
    where tablename  = 'mv_source_health'
      and indexname  = 'mv_source_health_url_idx'
      and indexdef   ilike '%unique%'
  ) then
    raise exception
      'mv_source_health_url_idx (UNIQUE) missing — CONCURRENTLY refresh would fail';
  end if;
end $$;
