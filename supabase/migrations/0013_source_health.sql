-- 0013_source_health.sql — Source health view, aggregate views, missed-digest
-- detection, and token-usage view for the observability dashboard (issue #20).
--
-- Metadata shapes scraped from agent source code:
--   scrape rows:     metadata->>'url', metadata->>'status_code', metadata->>'duration_ms'
--                    level='info' = success, level='warn'/'error' = failure
--   summarize rows:  metadata->>'model_id', metadata->>'input_tokens',
--                    metadata->>'output_tokens', metadata->>'total_tokens',
--                    metadata->>'duration_s'
--   publish rows:    metadata->>'topic_slug', metadata->>'digest_date'
--
-- All views are SELECT-only; authenticated role is granted SELECT.
-- pg_cron schedules are prefixed 'news_digest_' for namespace isolation.
-- This migration is idempotent: all objects use CREATE OR REPLACE / IF NOT EXISTS.

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

-- Per-source success rate (scrape rows only, last 7 days)
-- A scrape row is a success when level='info' and category='scrape' and
-- metadata->>'url' is present.  Warn/error scrape rows are failures.
create or replace view v_source_success_rate as
select
  metadata ->> 'url'                                            as source_url,
  count(*) filter (where level = 'info')                       as success_count,
  count(*) filter (where level in ('warn', 'error'))           as failure_count,
  count(*)                                                      as total_count,
  round(
    count(*) filter (where level = 'info')::numeric
    / nullif(count(*), 0) * 100,
    1
  )                                                             as success_pct,
  max(timestamp) filter (where level = 'info')                 as last_success_at,
  max(timestamp) filter (where level in ('warn', 'error'))     as last_error_at
from system_logs
where
  category = 'scrape'
  and metadata ->> 'url' is not null
  and timestamp >= now() - interval '7 days'
group by 1;

grant select on v_source_success_rate to authenticated;

-- Average run duration per topic/model from summarize rows
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
-- Materialised for fast load on the /source-health page (scrape table grows fast).
-- Manually refreshed here; pg_cron refreshes hourly (see below).
-- Stale threshold: <50% success over 7d OR >72h since last successful fetch.

create materialized view if not exists mv_source_health as
select
  metadata ->> 'url'                                                as source_url,
  count(*) filter (where level = 'info')                           as success_7d,
  count(*) filter (where level in ('warn', 'error'))               as failure_7d,
  count(*)                                                          as total_7d,
  round(
    count(*) filter (where level = 'info')::numeric
    / nullif(count(*), 0) * 100,
    1
  )                                                                 as success_pct_7d,
  max(timestamp) filter (where level = 'info')                     as last_success_at,
  max(timestamp) filter (where level in ('warn', 'error'))         as last_error_at,
  max(timestamp)                                                    as last_fetch_at,
  -- last error message: message from the most recent warn/error scrape row
  (
    select s2.message
    from system_logs s2
    where
      s2.category = 'scrape'
      and s2.level in ('warn', 'error')
      and s2.metadata ->> 'url' = (system_logs.metadata ->> 'url')
    order by s2.timestamp desc
    limit 1
  )                                                                 as last_error
from system_logs
where
  category = 'scrape'
  and metadata ->> 'url' is not null
  and timestamp >= now() - interval '7 days'
group by 1
with data;

create unique index if not exists mv_source_health_url_idx
  on mv_source_health (source_url);

grant select on mv_source_health to authenticated;

-- ── 4. pg_cron: refresh source health hourly ─────────────────────────────────

create extension if not exists pg_cron;

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
