---
type: plan
source-issue: 12
repo: itomek/itomek-news-digest-agent
title: "Implement digest history view and navigation"
created: 2026-06-01
status: in-progress
work_type: code-feature
complexity: standard
tdd_required: true
suggested_team_size: 2
estimated_files_changed: 6
test_command: "ssh tomas@t-nx-radeon 'bash -lc \"cd ~/ndw-issue12 && npm run test:unit && npm run test:e2e\"'"
build_command: "ssh tomas@t-nx-radeon 'bash -lc \"cd ~/ndw-issue12 && npm run build\"'"
lint_command: "ssh tomas@t-nx-radeon 'bash -lc \"cd ~/ndw-issue12 && npm run lint\"'"
branch: feat/issue-12-history
reflection_iterations: 1
agents_used: [planning, execution, validation]
---

# Issue #12 — Digest history view and navigation

Stacks on `feat/issue-10-web-app`. Vanilla TS + Vite, hash router, Supabase anon
reads (RLS-gated). Mobile-first (390x844).

## Acceptance criteria
1. Past digests browsable by date, grouped descending (default: last 7 days).
2. Topic filter works; URL state reflects selection (`?topic=ai_models&date=2026-04-10`,
   shareable/bookmarkable).
3. Client-side search returns relevant results across digest content.
4. Performance acceptable with 150+ rows (5 topics x 30 days).
Plus per-digest metadata: date, topic, sources used, word count.

## File ownership (strict)
- FILL `web/src/pages/history.ts` (`renderHistory(root, client)`), and export the
  pure helpers it uses so unit tests import them from here (avoids new lib files
  that could collide with #11's lane).
- APPEND to `web/src/lib/supabase.ts` below the marker: `fetchAllDigests(client)`
  (fetch full history; 150 rows is trivial) reusing `digestsQuery`.
- New tests under `web/tests/unit/` and `web/tests/e2e/`.
- Do NOT edit main.ts/router.ts/tts.ts/playback.ts/digest-card.ts.

## Design
- **URL state lives in `window.location.search`** (`?topic=&date=`), NOT the hash.
  The router keys only on `window.location.hash` (`#/history`), so search params
  survive routing untouched and are shareable/bookmarkable. Changing a filter uses
  `history.replaceState` + re-render; it does NOT touch the hash, so no re-route.
- Pure helpers (exported from history.ts, DOM-free, unit-tested):
  - `parseHistoryState(search): { topic: string|null, date: string|null, q: string }`
  - `serializeHistoryState(state): string` (round-trips with parse)
  - `filterDigests(digests, state): Digest[]` (topic + date + search-by-content)
  - `searchDigests(digests, q): Digest[]` (case-insensitive substring across content;
    relevance = match count, ties by date desc)
  - `wordCount(content): number`
  - `digestMeta(digest, topics): { date, topicName, sources: string[], words }`
  - `withinLastDays(digests, n)` default-7-day window when no date filter set
- Render: reuse `groupDigestsByTopicAndDate` for the descending grouped layout and
  `renderDigestCard` for each card (keeps #11's playback slot working). Add a
  filter bar (topic `<select>`, search `<input>`, optional date) and a per-card
  metadata line (date, topic, sources, word count) appended to the card wrapper
  in history.ts (NOT inside digest-card.ts).

## Perf / 150-row seeding (no mocks of Supabase, per convention)
- Live Supabase has only 4 digest rows and anon cannot INSERT (RLS). So for the
  150-row perf + filter/search e2e, generate a **deterministic in-app fixture**
  gated to test mode: `renderHistory` checks `?fixture=150` (only honored when a
  valid session is present) and, if set, uses a seeded generator (5 topics x 30
  days = 150 rows) instead of the network. Documented in history.ts. Real network
  path is the default and is covered by an e2e against live data too.
- e2e measures time from navigation to grouped content visible and asserts < 1s.

## TDD breakdown (tests first, then green)
Unit (Vitest, tests/unit/history.test.ts):
- parse/serialize round-trip for `?topic=&date=&q=`.
- filterDigests narrows by topic, by date, by both.
- searchDigests relevance ordering + case-insensitivity + empty query passthrough.
- wordCount + digestMeta derivation (sources array, topic name fallback).
- withinLastDays default-7-day window.
- fixture generator yields 150 rows, 5 topics x 30 days, deterministic.

E2E (Playwright chromium 390x844, tests/e2e/history.spec.ts):
- history route renders grouped by date desc (live data).
- `?fixture=150`: renders, 150 rows, filter narrows, search narrows.
- `?topic=ai_models` yields filtered view (shareable URL) + URL reflects selection.
- 150-row render-to-interactive < 1s budget.

## Validation
- Build + lint + unit + e2e on radeon (~/ndw-issue12). Code-reviewer subagent,
  Critical-only fixes, max 3 iterations.
