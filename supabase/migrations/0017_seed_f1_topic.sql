-- 0017_seed_f1_topic.sql — Formula 1 digest topic (general F1 with mandatory
-- Haas + Cadillac team focus).
--
-- Sources chosen (all RSS, HTTP 200 verified 2026-06-27):
--   BBC Sport F1        — https://feeds.bbci.co.uk/sport/formula1/rss.xml
--   Motorsport.com F1   — https://www.motorsport.com/rss/f1/news/
--   The Race            — https://www.the-race.com/feed/
--   RaceFans            — https://www.racefans.net/feed/
--   Autosport F1        — https://www.autosport.com/rss/f1/news/
--
-- PlanetF1 (https://www.planetf1.com/feed) returned 404 during verification and
-- was omitted; the five feeds above cover both general F1 and team-specific news.
--
-- Single topic by design (not three): general Formula 1 coverage, with the
-- prompt_hint steering mandatory explicit attention to two teams — Haas and the
-- new GM/Cadillac entry — woven into the one digest. Team items are flagged via
-- the generic items[].tags array ("haas" / "cadillac"); no new schema or web
-- renderer change is required.
--
-- Idempotent: on conflict (slug) do nothing, matching the other seed migrations.

insert into digest_topics (name, slug, cadence, sources, prompt_hint, enabled)
values (
  'Formula 1',
  'f1',
  '24h',
  '[
    {"type": "rss", "url": "https://feeds.bbci.co.uk/sport/formula1/rss.xml"},
    {"type": "rss", "url": "https://www.motorsport.com/rss/f1/news/"},
    {"type": "rss", "url": "https://www.the-race.com/feed/"},
    {"type": "rss", "url": "https://www.racefans.net/feed/"},
    {"type": "rss", "url": "https://www.autosport.com/rss/f1/news/"}
  ]'::jsonb,
  'Summarise the most significant Formula 1 stories from the last 24 hours: race weekends and results with their championship implications, driver and team line-up moves, car and technical-regulation developments, and major business or political developments in the sport.

Source window: when calling fetch_rss, pass since_hours=24 for each source to collect the last day''s article pool.

Deduplication: before composing the digest, call get_recent_digests with slug "f1" and limit=2 to retrieve the two most recent f1 digests. Do not repeat stories already covered there.

Mandatory team focus — Haas and Cadillac: in addition to general F1 coverage, always give explicit attention to two teams — the Haas F1 Team (MoneyGram Haas) and the Cadillac F1 Team (the new General Motors / Cadillac entry joining the grid). Whenever the gathered sources contain any news touching either team — results, driver line-up, sponsorship, leadership, car or power-unit development, or regulatory and entry news — surface it as its own ranked item and add the tag "haas" or "cadillac" (lowercase) to that item''s tags array. If the window contains no material news for a team, do not invent any and do not pad with generic background; simply omit it.

Editorial focus: prioritise concrete developments over speculation and rumour. Live lap-by-lap timing minutiae are not needed — focus on outcomes and why they matter.',
  true
)
on conflict (slug) do nothing;
