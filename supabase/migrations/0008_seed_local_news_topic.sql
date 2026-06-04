-- 0008_seed_local_news_topic.sql — local_news topic row (Bucks County / Quakertown, 7d).
-- Sources: mix of RSS, HTML scraped pages, and PDF meeting-minutes URLs.
-- Coverage is intentionally thin — the agent is instructed to say so rather than pad.

insert into digest_topics (name, slug, cadence, sources, prompt_hint, enabled)
values (
  'Bucks County / Quakertown local news',
  'local_news',
  '7d',
  '[
    {"type": "rss",  "url": "https://www.buckscountycouriertimes.com/arcio/rss/category/news/local/"},
    {"type": "html", "url": "https://www.buckscountyherald.com/news/"},
    {"type": "html", "url": "https://www.thefreepresspa.com/"},
    {"type": "html", "url": "https://www.richlandtownship.org/meetings"},
    {"type": "html", "url": "https://www.quakertownpa.gov/news"},
    {"type": "html", "url": "https://www.centennialsd.org/news"},
    {"type": "html", "url": "https://www.buckscountycouriertimes.com/news/local/"}
  ]'::jsonb,
  'Summarise local news and government activity for Bucks County and Quakertown, PA. Focus on: zoning changes and planning commission decisions, school-board votes and policy changes (Centennial SD), township/borough council meeting outcomes (Richland Township, Quakertown Borough), local business openings/closings, community events, and crime or public-safety notices. When township meeting materials (agendas, minutes) are available as PDFs, read them with fetch_pdf_text and surface key votes and decisions. Coverage may be thin; if sources were unavailable, returned no content, or produced nothing newsworthy, say so plainly rather than padding the digest.',
  true
)
on conflict (slug) do nothing;
