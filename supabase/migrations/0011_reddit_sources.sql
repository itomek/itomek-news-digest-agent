-- 0011_reddit_sources.sql — add Reddit (PRAW) as supplementary social signal
-- source for the ai_models topic (issue #21).
--
-- Subreddits chosen:
--   r/LocalLLaMA   — practitioner community; surfaces model releases and
--                    real-world capability reports faster than RSS feeds.
--   r/MachineLearning — academic/research-oriented; covers papers, benchmarks,
--                       and significant architectural announcements.
--
-- Integration pattern: Reddit results carry source_type="social_signal" and are
-- SECONDARY context only. The prompt_hint instructs the agent to use them to
-- surface stories primary sources missed, or to add community reaction context.
-- Posts must NOT be quoted directly; community signal folds into an item's
-- `detail` field (e.g. a brief note on community reception). No new top-level
-- Reddit section is added to the digest.
--
-- The existing prompt_hint is preserved verbatim; the Reddit guidance is appended
-- as an additional paragraph so it does not break any prompt already in use.
--
-- Idempotent: the `not (sources @> ...)` guard makes re-running a no-op. Both
-- appends always apply together, so the single combined guard protects sources
-- AND prompt_hint (re-run safety contract, supabase/README.md).

update digest_topics
set sources = sources || '[
  {"type": "reddit", "subreddit": "LocalLLaMA",       "sort": "hot",  "limit": 25, "min_score": 50, "time_filter": "day"},
  {"type": "reddit", "subreddit": "MachineLearning",  "sort": "hot",  "limit": 25, "min_score": 50, "time_filter": "day"}
]'::jsonb,
prompt_hint = prompt_hint || '

Reddit social signal (secondary context only): two subreddits are provided as
supplementary sources — r/LocalLLaMA and r/MachineLearning. Fetch them with the
fetch_reddit tool. Their posts carry source_type="social_signal". Use them ONLY
to surface model-release stories or capability reports that the primary RSS
sources missed, or to add a brief note on community reception inside an item''s
detail field. Do not create a separate Reddit section, do not quote Reddit
posts, and do not elevate community opinion to a primary claim. A
community-signal note should be one sentence at most, e.g.: "Community
discussion on r/LocalLLaMA highlights strong interest in its coding benchmark
results."'
where slug = 'ai_models'
  and not (sources @> '[{"type": "reddit"}]'::jsonb);
