-- 0015_source_health_scope_to_sources.sql — Scope source-health views to
-- *configured-source reachability* fetches only.
--
-- Problem: mv_source_health / v_source_success_rate (0013) aggregate EVERY
-- scrape row by metadata->>'url'. That conflates two populations:
--   (a) configured feed/page fetches — fetch_rss / fetch_html — keyed on a
--       digest_topics source URL. These are what "source health" means.
--   (b) per-article full-text fetches — parse_article / fetch_pdf_text — keyed
--       on individual discovered article URLs. Paywalled / bot-blocked sites
--       (nytimes.com, openai.com/index/*) routinely 403 these. They are not
--       sources, are one-shot, and the headline+summary was already obtained
--       from the working feed — so they should NOT count as a "stale source".
--
-- Fix: restrict both views to fetch_rss / fetch_html rows. Every scrape log
-- message is prefixed with its tool name (scraping.py: fetch_rss:280+,
-- fetch_html:480+, parse_article:565+, fetch_pdf_text), so a message-prefix
-- predicate is an exact, source-introspected filter.
--
-- Outcome classification is unchanged from 0013 (see that header). Idempotent.

-- ── v_source_success_rate ─────────────────────────────────────────────────────
create or replace view v_source_success_rate as
with scrape as (
  select
    timestamp,
    metadata ->> 'url' as source_url,
    (level = 'info' and metadata ? 'duration_ms')          as is_success,
    (
      level = 'warn'
      and not metadata ? 'bozo_exception'
      and not metadata ? 'truncated_chars'
    )                                                       as is_failure
  from system_logs
  where
    category = 'scrape'
    and metadata ->> 'url' is not null
    and (message like 'fetch_rss:%' or message like 'fetch_html:%')
    and timestamp >= now() - interval '7 days'
)
select
  source_url,
  count(*) filter (where is_success)                       as success_count,
  count(*) filter (where is_failure)                       as failure_count,
  count(*) filter (where is_success or is_failure)         as total_count,
  round(
    count(*) filter (where is_success)::numeric
    / nullif(count(*) filter (where is_success or is_failure), 0) * 100,
    1
  )                                                         as success_pct,
  max(timestamp) filter (where is_success)                 as last_success_at,
  max(timestamp) filter (where is_failure)                 as last_error_at
from scrape
group by source_url;

grant select on v_source_success_rate to authenticated;

-- ── mv_source_health ──────────────────────────────────────────────────────────
-- Materialized view definition can't be altered in place; drop + recreate.
-- The hourly pg_cron refresh job (0013) references it by name and survives.
drop materialized view if exists mv_source_health;

create materialized view mv_source_health as
with scrape as (
  select
    timestamp,
    message,
    metadata ->> 'url' as source_url,
    (level = 'info' and metadata ? 'duration_ms')          as is_success,
    (
      level = 'warn'
      and not metadata ? 'bozo_exception'
      and not metadata ? 'truncated_chars'
    )                                                       as is_failure
  from system_logs
  where
    category = 'scrape'
    and metadata ->> 'url' is not null
    and (message like 'fetch_rss:%' or message like 'fetch_html:%')
    and timestamp >= now() - interval '7 days'
)
select
  s.source_url,
  count(*) filter (where s.is_success)                     as success_7d,
  count(*) filter (where s.is_failure)                     as failure_7d,
  count(*) filter (where s.is_success or s.is_failure)     as total_7d,
  round(
    count(*) filter (where s.is_success)::numeric
    / nullif(count(*) filter (where s.is_success or s.is_failure), 0) * 100,
    1
  )                                                         as success_pct_7d,
  max(s.timestamp) filter (where s.is_success)             as last_success_at,
  max(s.timestamp) filter (where s.is_failure)             as last_error_at,
  max(s.timestamp)                                          as last_fetch_at,
  (
    select s2.message
    from scrape s2
    where s2.source_url = s.source_url and s2.is_failure
    order by s2.timestamp desc
    limit 1
  )                                                         as last_error
from scrape s
group by s.source_url
with data;

create unique index if not exists mv_source_health_url_idx
  on mv_source_health (source_url);

grant select on mv_source_health to authenticated;
