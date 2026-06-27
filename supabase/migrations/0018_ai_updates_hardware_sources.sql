-- 0018_ai_updates_hardware_sources.sql — broaden ai_updates hardware + AI-company coverage.
--
-- The ai_updates topic's `sources` jsonb is the live source of truth and is
-- edited directly in Supabase (CLAUDE.md). The original seed (0006) shipped a
-- dead AMD URL (www.amd.com, Akamai bot-blocked) that was removed live, and the
-- topic lacked dedicated silicon/accelerator feeds. This migration records the
-- finalized list so a fresh DB rebuild ends in the correct state (it runs after
-- 0006 and overwrites it) and never serves the dead AMD URL.
--
-- Every added feed was validated through the project's real scraping tools
-- (`python -m news_digest.tools.scraping <url> {24,168}`) on host t-nx-strx-halo
-- on 2026-06-27 — each returns real, on-topic content in the 168h window.
-- Dropped on re-validation: newsroom.intel.com/feed (0 items at both 24h and
-- 168h — Intel posts ~biweekly and had nothing in window).
--
-- The prompt_hint gains an explicit hardware/semiconductor clause: the prior
-- hint de-emphasised "benchmarks and architectural novelty", which suppressed
-- chip news; the new clause makes silicon news explicitly wanted while keeping
-- the dedup-against-ai_models clause.
--
-- Deterministic final state: both `sources` and `prompt_hint` are set to their
-- final merged values, so re-running this migration is a no-op (idempotent,
-- re-run safety contract per supabase/README.md).

update digest_topics
set sources = '[
  {"url": "https://techcrunch.com/feed/", "type": "rss"},
  {"url": "https://www.theverge.com/rss/index.xml", "type": "rss"},
  {"url": "https://openai.com/news/rss.xml", "type": "rss"},
  {"url": "https://www.anthropic.com/news", "type": "html"},
  {"url": "https://blog.google/technology/ai/rss/", "type": "rss"},
  {"url": "https://ai.meta.com/blog/", "type": "html"},
  {"url": "https://mistral.ai/news/", "type": "html"},
  {"url": "https://rocm.blogs.amd.com/blog/atom.xml", "type": "rss"},
  {"url": "https://developer.nvidia.com/blog/feed/", "type": "rss"},
  {"url": "https://www.nextplatform.com/feed/", "type": "rss"},
  {"url": "https://newsletter.semianalysis.com/feed", "type": "rss"},
  {"url": "https://azure.microsoft.com/en-us/blog/feed/?tags=azure-ai-services", "type": "rss"},
  {"url": "https://deepmind.google/blog/rss.xml", "type": "rss"},
  {"url": "https://machinelearning.apple.com/rss.xml", "type": "rss"},
  {"url": "https://news.google.com/rss/search?q=%22qualcomm.com%22+ai+OR+snapdragon+OR+hexagon&hl=en-US&gl=US&ceid=US:en", "type": "rss"}
]'::jsonb,
    prompt_hint = 'Focus on product launches, GA releases, partnerships, funding rounds, pricing changes, and availability announcements from AI companies. Cover business and strategic moves — acquisitions, leadership changes, enterprise deals. De-emphasise pure opinion, speculation, and research-only papers. De-emphasise benchmarks and architectural novelty unless they accompany a released product. Also actively cover AI hardware and semiconductor news — especially AMD (Instinct, ROCm, Ryzen AI), and also NVIDIA, Intel, Apple Silicon, Qualcomm, Google TPU, and AI-accelerator companies: new GPUs, accelerators, and AI chips; data-center and AI-server platforms; inference/training performance and software stacks (ROCm, CUDA); foundry, packaging, and major supply or partnership deals (e.g. large hyperscaler or model-lab chip purchases); and earnings only where they signal AI demand or capacity. Treat a new chip, accelerator, or inference stack as a released product. Avoid raw spec-sheet number dumps — explain why a hardware development matters. Deduplicate against the most recent ai_models digest — do not repeat items already covered there.'
where slug = 'ai_updates'
  and sources::text not like '%developer.nvidia.com%';
