---
type: plan
source-issue: 17
repo: itomek/itomek-news-digest-agent
title: "Add topic: Pittsburgh Penguins non-score news (7d)"
created: 2026-06-03
status: draft
work_type: config/infra
complexity: trivial
tdd_required: false
suggested_team_size: 1
estimated_files_changed: 1
test_command: "ssh tomas@t-nx-strx-halo 'bash -lc \"cd ~/src/itomek/itomek-news-digest-agent && git fetch origin && git checkout feat/issue-17-penguins && git pull --ff-only && source .venv/bin/activate && pytest -m \\\"not integration\\\" -q\"'"
build_command: ""
lint_command: ""
branch: feat/issue-17-penguins
reflection_iterations: 0
agents_used: [planning, execution, validation]
---

# Plan — Issue #17: Pittsburgh Penguins non-score news (`penguins`, 7d)

Pure configuration. No Python changes — the existing RSS/HTML tools and the generic SYSTEM_PROMPT already cover this; all topic-specific behaviour lives in the seed row's prompt_hint. The real engineering is source curation and a prompt_hint that reliably excludes scores / play-by-play.

## Why no TDD
There is no SQL unit-test harness in this repo and no application code changes, so there is nothing to unit-test (stated explicitly, not skipped). The pass gate is the real-world run on the host: the produced digest must contain team news and no scores or game recaps. pytest -m "not integration" is still run on the host as a regression guard (must stay green — the seed must not break existing tests).

## Acceptance criteria -> evidence
- Topic seeded (penguins, 7d, sources, prompt_hint) -> migration 0007, applied live (orchestrator).
- Digest excludes game scores and recaps -> prompt_hint exclusions + human check on the host run after a known game day.
- Digest focuses on team/off-ice news -> prompt_hint inclusions + human rating.
- Manual run produces a coherent weekly summary -> real-world run on Strix Halo.

## File ownership (strict)
- NEW supabase/migrations/0007_seed_penguins_topic.sql ONLY. Number is FIXED at 0007.
- Do NOT touch any src/, tests/, or pyproject.toml.

## Design — 0007_seed_penguins_topic.sql
Follow 0002's exact shape: insert into digest_topics (...) values (...) on conflict (slug) do nothing;
- name 'Pittsburgh Penguins', slug penguins, cadence '7d', enabled true.
- sources (curate; verify each resolves in real-world): PensBurgh (SB Nation) RSS https://www.pensburgh.com/rss/index.xml ; NHL.com Penguins news; Pittsburgh Post-Gazette Penguins section; Trib/Athletic if a feed exists. Prefer RSS; HTML-listing URLs acceptable.
- r/penguins is explicitly OUT (Reddit lands in Epic 6 — do not add it).
- prompt_hint (the load-bearing part):
  - INCLUDE: trades, signings, roster moves, injury reports, front-office/coaching news, prospects, off-ice & fan stories.
  - EXCLUDE — state firmly: game scores, final results, play-by-play, game recaps, box scores, standings, fantasy/betting stats. e.g. "Never include game scores, final results, play-by-play, or recaps; if a source item is primarily a game recap, skip it. Summarize only team news and off-ice stories from roughly the last 7 days."
  - Add a 7-day window cue (the LLM passes since_hours=168 to fetch_rss).

## Validation tiers
- Local (teammate): the migration is the only artifact; validate the SQL is well-formed and mirrors 0002 (valid JSON in sources, cadence '7d' satisfies the CHECK). No ruff/pytest applies locally.
- Host regression (orchestrator): test_command — existing suite stays green.
- Real-world (orchestrator): apply 0007; generate the Penguins weekly digest; verify digests row + logs; human verifies no scores and good off-ice coverage, ideally after a recent game day.

## Risks
- Penguins RSS endpoints may differ from the guesses above — curate from working feeds; document any dead source in the PR. Thin coverage is acceptable (log unavailable sources), but scores must never appear.
- Score-exclusion is prompt-only; if a recap slips through on the host run, tighten the prompt_hint (<=2 iterations) before the PR.
