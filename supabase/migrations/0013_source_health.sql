-- 0013_source_health.sql — Source health view, aggregate views, missed-digest
-- detection, and token-usage view for the observability dashboard (issue #20).
--
-- Metadata shapes transcribed from agent source code:
--   scrape rows:     metadata->>'url', metadata->>'duration_ms'
--                    (src/news_digest/tools/scraping.py)
--   summarize rows:  metadata->>'model_id', metadata->>'input_tokens',
--                    metadata->>'output_tokens', metadata->>'total_tokens',
--                    metadata->>'duration_s'  (src/news_digest/agent.py)
--
-- Scrape OUTCOME classification (the level alone is NOT the outcome — a
-- successful fetch of a bozo-but-usable feed logs BOTH a warn and an info row):
--
--   success  = level='info' AND metadata ? 'duration_ms'
--              Every terminal success log carries duration_ms and nothing else
--              does (scraping.py fetch_rss:412, fetch_html:552,
--              parse_article:648, fetch_pdf_text:746).
--   failure  = level='warn' AND NOT metadata ? 'bozo_exception'
--                            AND NOT metadata ? 'truncated_chars'
--              All terminal fetch failures are logged at warn level (unsafe
--              url, non-retryable HTTP, retries exhausted, parse errors).
--              Two warns are ADVISORY, not failures — the fetch still
--              succeeded and logged its own info row:
--                bozo feed        (scraping.py:361, has 'bozo_exception')
--                pdf truncation   (scraping.py:726, has 'truncated_chars')
--   excluded = everything else: advisory warns above, and info rows without
--              duration_ms (parse_article no_content :610, fetch_pdf_text
--              no_text :716 — the fetch succeeded but yielded no content;
--              neither a success nor a reachability failure).
--
--   success_pct = success / (success + failure)  — advisory rows are excluded
--   from the denominator, so one success + one bozo warn = 100%, not 50%.
--
-- All views are SELECT-only; authenticated role is granted SELECT.
-- pg_cron schedules are prefixed 'news_digest_' for namespace isolation.
-- This migration is idempotent: re-applying it is safe.

-- ── 1. Aggregate views ────────────────────────────────────────────────────────

-- Errors per day (across all categories)
create or replace view v_errors_per_day as
select
  date_trunc('day', timestamp)::date as day,
  count(*)                           as error_count
from system_logs
where level = 'error'
group by 1
order by 1 desc;

grant select on v_errors_per_day to authenticated;

-- Per-source success rate (scrape rows only, last 7 days).
-- Outcome classification per the header comment.
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

-- Average run duration per topic/model from summarize rows.
-- duration_s may be 0 when not reported; token counts are often 0 from Lemonade.
create or replace view v_run_duration as
select
  topic_slug,
  (metadata ->> 'model_id')                                          as model_id,
  count(*)                                                            as run_count,
  round(avg((metadata ->> 'duration_s')::numeric), 2)                as avg_duration_s,
  round(avg((metadata ->> 'total_tokens')::numeric), 0)              as avg_total_tokens,
  round(avg((metadata ->> 'input_tokens')::numeric), 0)              as avg_input_tokens,
  round(avg((metadata ->> 'output_tokens')::numeric), 0)             as avg_output_tokens,
  max(timestamp)                                                      as last_run_at
from system_logs
where
  category = 'summarize'
  and level = 'info'
  and metadata ->> 'duration_s' is not null
group by 1, 2
order by last_run_at desc;

grant select on v_run_duration to authenticated;

-- ── 2. Token usage view (by day + topic + model) ─────────────────────────────

create or replace view v_token_usage_by_day as
select
  date_trunc('day', timestamp)::date      as day,
  topic_slug,
  (metadata ->> 'model_id')              as model_id,
  count(*)                               as run_count,
  sum((metadata ->> 'total_tokens')::numeric)   as total_tokens,
  sum((metadata ->> 'input_tokens')::numeric)   as input_tokens,
  sum((metadata ->> 'output_tokens')::numeric)  as output_tokens,
  sum((metadata ->> 'duration_s')::numeric)     as total_duration_s
from system_logs
where
  category = 'summarize'
  and level = 'info'
  and metadata ->> 'duration_s' is not null
group by 1, 2, 3
order by 1 desc, 2, 3;

grant select on v_token_usage_by_day to authenticated;

-- ── 3. Source health materialized view ───────────────────────────────────────
-- Materialised for fast load on the /source-health page (scrape table grows
-- fast). pg_cron refreshes hourly (see below). Uses the same outcome
-- classification as v_source_success_rate (header comment). The scrape CTE is
-- referenced both by the aggregate and by the last_error correlated subquery —
-- the correlation is on source_url, the GROUP BY column, which keeps the
-- subquery valid inside the grouped query (correlating on the raw ungrouped
-- system_logs.metadata is an error: "subquery uses ungrouped column").

create materialized view if not exists mv_source_health as
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
  -- message of the most recent terminal-failure row for this source
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

-- ── 4. pg_cron: refresh source health hourly ─────────────────────────────────
-- Documented Supabase form: extension in pg_catalog + usage grant on cron.

create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;

-- Unschedule first so re-running the migration is idempotent.
do $$
begin
  if exists (
    select 1 from cron.job
    where jobname = 'news_digest_refresh_source_health'
  ) then
    perform cron.unschedule('news_digest_refresh_source_health');
  end if;
end $$;

select cron.schedule(
  'news_digest_refresh_source_health',
  '0 * * * *',   -- every hour on the hour
  $$refresh materialized view concurrently mv_source_health$$
);

-- ── 5. Missed-digest detection function + pg_cron ────────────────────────────
-- Runs daily at 16:00 UTC (~noon ET). For each enabled topic, checks whether
-- a digest is overdue relative to its cadence:
--   24h topics: no digest in the last 26h
--    7d topics: no digest in the last 7d+2h (170h)
-- Inserts a system_logs warn row when a topic is overdue.
-- Idempotent: skips if a missed-digest warn row was already inserted today.

create or replace function fn_check_missed_digests()
returns void
language plpgsql
as $$
declare
  rec record;
  window_hours integer;
  last_digest_date date;
  already_warned boolean;
begin
  for rec in
    select slug, cadence from digest_topics where enabled = true
  loop
    -- Determine the expected cadence window
    if rec.cadence = '24h' then
      window_hours := 26;
    else
      -- 7d + 2h grace
      window_hours := 170;
    end if;

    -- Find the most recent digest for this topic
    select max(digest_date)
    into last_digest_date
    from digests
    where topic_slug = rec.slug;

    -- Check if a digest is overdue
    if last_digest_date is null
       or last_digest_date < (now() - make_interval(hours => window_hours))::date
    then
      -- Avoid inserting duplicate warnings for the same day
      select exists(
        select 1 from system_logs
        where
          category = 'schedule'
          and level = 'warn'
          and topic_slug = rec.slug
          and (metadata ->> 'missed_digest')::boolean = true
          and timestamp >= date_trunc('day', now())
      ) into already_warned;

      if not already_warned then
        insert into system_logs (level, category, topic_slug, message, metadata)
        values (
          'warn',
          'schedule',
          rec.slug,
          'missed digest: ' || rec.slug,
          jsonb_build_object(
            'missed_digest', true,
            'topic_slug',    rec.slug,
            'cadence',       rec.cadence,
            'last_digest_date', last_digest_date,
            'window_hours',  window_hours
          )
        );
      end if;
    end if;
  end loop;
end;
$$;

-- Schedule missed-digest check daily at 16:00 UTC
do $$
begin
  if exists (
    select 1 from cron.job
    where jobname = 'news_digest_check_missed_digests'
  ) then
    perform cron.unschedule('news_digest_check_missed_digests');
  end if;
end $$;

select cron.schedule(
  'news_digest_check_missed_digests',
  '0 16 * * *',
  $$select fn_check_missed_digests()$$
);
