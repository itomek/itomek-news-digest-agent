-- 0014_world_news_concise_hint.sql — bound the world_news digest size.
--
-- The first scheduled world_news runs (2026-06-12) failed to publish 3/3
-- attempts: the topic's unbounded item list produced a final-answer JSON
-- larger than the completion budget, truncating it mid-stream (parse_error).
-- The primary fix raises the agent's max_tokens (src/news_digest/agent.py);
-- this hint is defense-in-depth: it bounds the answer size so the heaviest
-- topic stays comfortably inside the budget, and enforces editorial focus.
--
-- Idempotent: the `not like` guard makes re-running a no-op (re-run safety
-- contract, supabase/README.md).

update digest_topics
set prompt_hint = prompt_hint || '

Digest size limit (mandatory): select the 5 most significant stories only.
Keep each item''s detail under 2 sentences. Concise output.'
where slug = 'world_news'
  and prompt_hint not like '%5 most significant stories%';
