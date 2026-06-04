-- 0006_seed_ai_updates_topic.sql — second 24h topic: AI company & product updates.
-- Intended schedule: 5:15 AM ET daily (Epic 4 — scheduler wiring deferred).
-- Deduplicates against the ai_models digest via get_recent_digests tool +
-- prompt_hint instruction; avoids repeating model-release coverage already
-- handled by that topic.

insert into digest_topics (name, slug, cadence, sources, prompt_hint, enabled)
values (
  'AI company & product updates',
  'ai_updates',
  '24h',
  '[
    {"type": "rss", "url": "https://techcrunch.com/feed/"},
    {"type": "rss", "url": "https://www.theverge.com/rss/index.xml"},
    {"type": "rss", "url": "https://openai.com/news/rss.xml"},
    {"type": "rss", "url": "https://www.anthropic.com/rss.xml"},
    {"type": "rss", "url": "https://blog.google/technology/ai/rss/"},
    {"type": "rss", "url": "https://ai.meta.com/blog/rss/"},
    {"type": "html", "url": "https://mistral.ai/news/"},
    {"type": "html", "url": "https://www.amd.com/en/blogs/ai.html"}
  ]'::jsonb,
  'Focus on product launches, GA releases, partnerships, funding rounds, pricing changes, and availability announcements from AI companies. Cover business and strategic moves — acquisitions, leadership changes, enterprise deals. De-emphasise pure opinion, speculation, and research-only papers. De-emphasise benchmarks and architectural novelty unless they accompany a released product. Deduplicate against the most recent ai_models digest — do not repeat items already covered there.',
  true
)
on conflict (slug) do nothing;
