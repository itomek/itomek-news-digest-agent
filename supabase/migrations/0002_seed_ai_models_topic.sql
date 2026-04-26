-- 0002_seed_ai_models_topic.sql — first topic row for the ai_models digest.
-- Refine `sources` and `prompt_hint` in issues #7 (prompts) and #9 (E2E run).

insert into digest_topics (name, slug, cadence, sources, prompt_hint, enabled)
values (
  'AI model releases',
  'ai_models',
  '24h',
  '[
    {"type": "rss", "url": "https://huggingface.co/blog/feed.xml"},
    {"type": "rss", "url": "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"},
    {"type": "rss", "url": "https://techcrunch.com/category/artificial-intelligence/feed/"}
  ]'::jsonb,
  'Focus on new model releases, capability benchmarks, and significant architectural changes. De-emphasize funding, hiring, and corporate announcements unless they ship a model.',
  true
)
on conflict (slug) do nothing;
