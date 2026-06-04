-- 0007_seed_penguins_topic.sql — seed row for the Pittsburgh Penguins non-score news digest.
-- Refine `sources` and `prompt_hint` in follow-up issues after first real-world run.

insert into digest_topics (name, slug, cadence, sources, prompt_hint, enabled)
values (
  'Pittsburgh Penguins',
  'penguins',
  '7d',
  '[
    {"type": "rss", "url": "https://www.pensburgh.com/rss/index.xml"},
    {"type": "rss", "url": "https://www.post-gazette.com/rss/sports/penguins"},
    {"type": "rss", "url": "https://pittsburghhockeynow.com/feed/"}
  ]'::jsonb,
  'Summarize Pittsburgh Penguins team news from roughly the last 7 days. Focus on: trades, signings, contract extensions, roster moves, injury reports, coaching and front-office decisions, prospect development, and notable off-ice stories. Never include game scores, final results, play-by-play, or game recaps — if a source item is primarily a game recap or score summary, skip it entirely. Omit standings, fantasy projections, and betting statistics.',
  true
)
on conflict (slug) do nothing;
