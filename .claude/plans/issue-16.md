---
type: plan
source-issue: 16
repo: itomek/itomek-news-digest-agent
title: "Add topic: AI company and product updates (24h) with dedup vs ai_models"
created: 2026-06-03
status: draft
work_type: code-feature
complexity: standard
tdd_required: true
suggested_team_size: 1
estimated_files_changed: 4
test_command: "ssh tomas@t-nx-strx-halo 'bash -lc \"cd ~/src/itomek/itomek-news-digest-agent && git fetch origin && git checkout feat/issue-16-ai-updates-dedup && git pull --ff-only && source .venv/bin/activate && pip install -e .[dev] -q && pytest -m \\\"not integration\\\" -q\"'"
build_command: "ssh tomas@t-nx-strx-halo 'bash -lc \"cd ~/src/itomek/itomek-news-digest-agent && source .venv/bin/activate && python -c \\\"import news_digest.agent\\\"\"'"
lint_command: "ruff check src tests && ruff format --check src tests"
branch: feat/issue-16-ai-updates-dedup
reflection_iterations: 0
agents_used: [planning, execution, validation]
---

# Plan — Issue #16: AI company & product updates topic (`ai_updates`) with dedup

Second topic after `ai_models`. The real work is (a) a new content-fetch tool so the LLM can see a sibling topic's recent digest, (b) a SYSTEM_PROMPT dedup step, and (c) a seed row. Reuses all existing scraping tools.

## Architecture decision (orchestrator) — dedup is a TOOL + PROMPT, not agent.py code
The issue lists `agent.py`, but the agent is intentionally thin and the LLM does all orchestration via tools (see CLAUDE.md "The LLM IS the summarizer / Tools are pure functions"). So do NOT add orchestration code to `agent.py`. Instead:
- Add one pure tool to src/news_digest/tools/publishing.py: `get_recent_digests(topic_slug, limit=1)` returning recent digest *content* (today only `get_last_digest_date` exists — it returns the date, never the text).
- Add a generic dedup step to SYSTEM_PROMPT and a `prompt_hint` for `ai_updates` that names `ai_models` as the sibling to dedup against.
The tool registers automatically (publishing is imported in agent.py), so no agent wiring changes. This same tool is reused by #19 (which stacks on this branch).

## Acceptance criteria -> evidence
- Topic seeded (ai_updates, 24h, sources, prompt_hint) -> migration 0006, applied live (orchestrator).
- Dedup against yesterday's ai_models digest works -> get_recent_digests unit tests + real-world run shows no repeated items.
- Digest distinct from ai_models (business/product, not model releases) -> prompt_hint + human quality rating on host run.
- Scheduled 5:15 AM ET — note: schedule wiring is Epic 4 (scheduler not deployed); record the intended 05:15 ET slot in the seed comment, do not build scheduling here.
- Manual run produces coherent digest -> real-world run on Strix Halo.

## File ownership (strict — do NOT touch files outside this list)
- APPEND to src/news_digest/tools/publishing.py: the get_recent_digests tool. Reuse _client, log, the existing query style. Never raises; returns {"digests": [...]} or {"digests": [], "error": ...}.
- EDIT src/news_digest/prompts.py: add a dedup step to SYSTEM_PROMPT (generic), nothing else. Changing SYSTEM_PROMPT rotates PROMPT_VERSION automatically — update the test_prompts.py assertions accordingly.
- NEW supabase/migrations/0006_seed_ai_updates_topic.sql (number is FIXED at 0006 — siblings own 0007/0008/0009; do not renumber).
- EDIT tests/test_publishing_tools.py (add get_recent_digests cases) and tests/test_prompts.py (system-prompt dedup assertion).
- Do NOT edit agent.py, scraping.py, analysis.py, config.py, tests/test_agent_e2e.py, pyproject.toml.

## Design
get_recent_digests(topic_slug: str, limit: int = 1) -> dict
- Query digests for topic_slug, order("digest_date", desc=True).limit(limit), select "digest_date, content".
- Return {"digests": [{"date": <iso>, "content": <text>}, ...]} (empty list when none). Anon key read. Log one info line; on exception log warn + return {"digests": [], "error": <cls>}. Mirror the never-raises contract of the other publishing tools.
- limit is the forward-compat seam #19 uses (limit=2); keep the param even though #16 only needs 1.

SYSTEM_PROMPT dedup step (insert into the numbered workflow, keep audio-free):
- Add the tool to the tool list and a step like: "If the topic's prompt_hint asks you to avoid repeating another topic's recent coverage, call get_recent_digests for that topic's slug and do not repeat items it already covered."

0006_seed_ai_updates_topic.sql (follow 0002's exact shape; on conflict (slug) do nothing):
- name 'AI company & product updates', slug ai_updates, cadence '24h', enabled true.
- sources (curate; verify each resolves during real-world): TechCrunch, The Verge, company blogs — OpenAI, Anthropic news, Google AI/DeepMind blog, Meta AI, Mistral, AMD. Prefer RSS where it exists; HTML-listing URLs are fine.
- prompt_hint emphasising product launches, partnerships, business moves, funding, GA/availability; de-emphasising opinion/speculation and pure model-release news; and an explicit line: "Deduplicate against the most recent ai_models digest — do not repeat items already covered there."

## TDD (tests FIRST, then green)
Unit (tests/test_publishing_tools.py, reuse the FakeClient/FakeTable harness):
1. get_recent_digests returns most-recent-first, respects limit, shape {date, content}.
2. limit default = 1 returns at most one.
3. no rows -> {"digests": []}.
4. exception -> {"digests": [], "error": ...} and never raises.
tests/test_prompts.py:
5. Update test_system_prompt_describes_workflow_without_audio_layer: assert get_recent_digests (or "deduplicat") appears; keep the no-audio assertions. The PROMPT_VERSION identity test stays valid.
There is no SQL unit-test harness; the seed row is validated in the real-world tier.

## Validation tiers
- Local (teammate): ruff; code-reviewer subagent on the diff (Critical-only, >=80). Build a local 3.12 venv for the red->green loop if possible; otherwise note pytest not run locally.
- Host unit (orchestrator): the test_command above on Strix Halo (authoritative).
- Real-world (orchestrator): apply 0006 to live Supabase; ensure an ai_models digest exists for today (run that topic first if needed); generate the ai_updates digest; verify a digests row + system_logs; human distinct/coherent rating.

## Risks
- Company-blog feeds change/lack RSS — curate generously and let unreachable sources drop. Document any dead source in the PR.
- Dedup quality is prompt-dependent — if the run repeats ai_models items, tighten the prompt_hint (<=2 iterations) before opening the PR.
