-- 0010_seed_world_news_topic.sql — US/Poland world news with per-item sentiment (issue #19).
--
-- Sources chosen (all RSS, HTTP 200 verified 2026-06-11):
--   US / global:     NYT World, NPR World, BBC World
--   Polish coverage: TVN24 Swiat, Onet Wiadomości, Notes from Poland (English)
--
-- Reuters RSS (feeds.reuters.com) returned connection errors during verification;
-- AP International RSS returned 403 — substituted NYT World and NPR World as
-- reputable US equivalents, with BBC World for global English-language coverage.
-- Gazeta Wyborcza RSS returned 404 for all known paths — substituted TVN24 Swiat
-- (200) as the primary Polish-language source; Onet Wiadomości (200) is retained
-- as the second Polish source (covers both Poland and world events).
--
-- Rolling window: prompt_hint instructs the agent to call fetch_rss with
-- since_hours=72 (3-day pool) and get_recent_digests("world_news", limit=2) for
-- self-dedup against the last two digests.
-- Sentiment: per-item value in items[].metadata.sentiment; one of: positive,
-- negative, neutral, concerning. Contract documented in docs/architecture.md §7.2.

insert into digest_topics (name, slug, cadence, sources, prompt_hint, enabled)
values (
  'US & Poland world news',
  'world_news',
  '24h',
  '[
    {"type": "rss", "url": "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"},
    {"type": "rss", "url": "https://feeds.npr.org/1004/rss.xml"},
    {"type": "rss", "url": "https://feeds.bbci.co.uk/news/world/rss.xml"},
    {"type": "rss", "url": "https://tvn24.pl/swiat.xml"},
    {"type": "rss", "url": "https://wiadomosci.onet.pl/.feed"},
    {"type": "rss", "url": "https://notesfrompoland.com/feed/"}
  ]'::jsonb,
  'Summarise the most significant US and Polish world-news stories from the last 3 days.

Source window: when calling fetch_rss, pass since_hours=72 for each source to collect the full 3-day article pool.

Deduplication: before composing the digest, call get_recent_digests with slug "world_news" and limit=2 to retrieve the two most recent world_news digests. Do not repeat stories already covered in those digests.

Source language: TVN24 Swiat and Onet Wiadomości articles are in Polish. Summarise every item in English regardless of the source language — blurb and detail must be English prose only; never include Polish-language sentences.

Editorial focus: geopolitical developments, diplomatic moves, military or security events, significant elections or referenda, major economic policy decisions, EU affairs, and notable Polish-specific news (politics, EU relations, defence, society). De-emphasise sports, celebrity, weather, and local crime unless the story has clear national or international significance.

Sentiment tagging (mandatory): for every item, set a "sentiment" key inside the item''s metadata object. Choose the single best-fitting value from this set:
  positive   — development generally beneficial or hopeful for people or stability
  negative   — harmful, worsening, or destructive outcome
  neutral    — informational or procedural, no clear valence
  concerning — significant risk or threat that has not yet resolved

Example item metadata: {"sources": [...], "sentiment": "concerning", "tags": ["geopolitics"]}

The sentiment value must appear on every item, exactly one of the four values above, lowercase. Do not put sentiment in the tags array and do not add sentiment to the top-level summary — only to individual items.',
  true
)
on conflict (slug) do nothing;
