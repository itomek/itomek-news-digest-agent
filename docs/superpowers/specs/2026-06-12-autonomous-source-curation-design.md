# Autonomous Source Curation — Design

- **Date:** 2026-06-12
- **Status:** Approved (2026-06-12) — in-app approval UI confirmed
- **Owner:** @itomek

## Problem

The Source Health dashboard flags "stale sources" — configured feed/page sources
that consistently fail to fetch. Investigation of the motivating case revealed two
distinct failure modes that look identical on the dashboard but need opposite fixes:

1. **Blocked-but-alive.** The content exists and a browser loads it fine, but the
   site's bot mitigation rejects the agent. Confirmed for `amd.com`: AMD fronts
   their site with Akamai, which accepts the TLS handshake then **resets the HTTP/2
   stream** for the agent's honest, self-identifying User-Agent
   (`news-digest-agent/0.1 (+github…)`, see `src/news_digest/tools/scraping.py:72`).
   The agent's `httpx` client surfaces this as a `ReadTimeout` after retries.
   Evidence: the same URL returns `200` with a browser User-Agent and `000`
   (curl exit 92, HTTP/2 stream reset) with the agent's UA.

2. **Genuinely dead.** The content is gone — DNS no longer resolves
   (`quakertownpa.gov`, `thefreepresspa.com`), or the URL 404s permanently
   (`richlandtownship.org/meetings`). A replacement is the only fix.

Today, neither mode is remediated automatically. A human must notice the stale
entry and hand-edit `digest_topics.sources`.

## Policy decisions

Settled during brainstorming (2026-06-12):

| Decision | Choice |
| --- | --- |
| **Remediation** | Autonomously **discover new sources** (not just alert, not just fail over to existing). |
| **Blocks policy** | **Route around, never evade.** Keep the honest bot User-Agent. A persistent block is treated as "this site doesn't want bots" → find an alternate source covering the same information. We do **not** spoof a browser UA. |
| **Approval gate** | **Auto-use only if high-confidence.** Strong discoveries go live automatically; borderline ones are held as candidates for human approval. |
| **Discovery method** | **Web search + validate.** Search for candidate feeds/pages, then validate each. |
| **Architecture** | **Separate "source curator" job**, independent of digest generation. |

### Goals

- Detect persistently-failing configured sources from existing telemetry.
- For each, discover a validated alternate source covering the same topic.
- Auto-adopt high-confidence discoveries; queue borderline ones for approval.
- Quarantine the failing source so it stops wasting fetches and nagging the dashboard.
- Never degrade a topic below one working source without alerting.
- Keep the honest User-Agent; never evade bot mitigation.

### Non-goals

- No browser-UA spoofing or anti-bot evasion.
- No change to digest-generation logic or the digest LLM loop.
- No removal of the existing daily missed-digest check or source-health views.
- Not a general web-crawler; discovery is scoped to replacing a specific failing source.

## Architecture

A **deterministic Python pipeline** — `src/news_digest/curator.py` — *not* the
digest agent's autonomous LLM loop. It calls the LLM (via `LemonadeClient`) for
exactly two narrow jobs: crafting search queries and judging topic relevance.
Everything else is plain, unit-testable code. It reuses `scraping.py` for
validation fetches and a research/search MCP tool for discovery.

```
curator (scheduled, daily) ──>
  1. DETECT    read mv_source_health → sources persistently failing
  2. CLASSIFY  label dead (DNS/404) vs blocked (403/429/timeout)   [label only]
  3. DISCOVER  formulate query (LLM) → web search → candidate URLs
  4. VALIDATE  fetch w/ honest UA + parse + recency + dedup/diversity
  5. JUDGE     LLM relevance score (0–1) → confidence tier
  6. APPLY     quarantine failing source;
               high-confidence → add to digest_topics.sources (live);
               borderline      → source_candidates table (await approval)
  + LOG every action to system_logs (category 'curator')
```

Digest runs are untouched; the curator only mutates the source list that digests
later consume.

### 1. Detection

Pure read of existing telemetry (`mv_source_health` / the same outcome
classification used by the dashboard). A source becomes a **remediation
candidate** when **all** hold:

- Stale by the existing dashboard rule: `<50%` success over 7d **OR** `>72h`
  since last success.
- **≥3** fetch attempts recorded (avoid acting on a single blip).
- Not in **cooldown**: not processed within the last *N* days (default 7) and has
  no `pending` candidate already awaiting approval.

For 7-day-cadence topics (few fetches per week), detection leans on
"days since last success" rather than the 7d percentage alone.

### 2. Classification (label only)

Read from `last_error` / status codes:

- **dead** — DNS failure (`NXDOMAIN`, "blocked unsafe url: DNS error"), persistent
  404/410.
- **blocked** — 403, 429, connection reset, read timeout (Akamai-style).

Because the policy routes around *both*, classification does **not** branch
behavior — it only drives logging and the dashboard message
("AMD blocked → replaced with X").

### 3. Discovery

For each failing source:

1. **Formulate query (LLM).** From the topic's `name` + `prompt_hint` (and the
   failing source's subject), the LLM produces 1–2 targeted search queries, e.g.
   *"AMD AI announcements RSS feed"* or *"Quakertown PA local news RSS"*.
2. **Search.** Run the query via the research/search MCP tool (Perplexity/Brave).
   Collect candidate feed and page URLs (cap candidates per failing source, e.g. 8).

### 4. Validation (the gate)

Each candidate must pass **all** checks — implemented as plain code reusing
`scraping.py`:

1. **Fetchable with the honest UA.** Fetch using the unchanged
   `news-digest-agent` User-Agent. A candidate that *itself* blocks the bot is
   **rejected** — we never trade one AMD for another.
2. **Parseable.** RSS → `feedparser` yields ≥ *K* entries (default 3); HTML →
   readable items extractable.
3. **Recent.** Has items within the topic's cadence window (24h topics: items in
   last few days; 7d topics: last ~2 weeks).
4. **Distinct.** Not already configured for the topic; prefer a **different
   domain** than existing sources (diversity).

### 5. Confidence scoring & gating

Combine validation outcome with an **LLM relevance judgment**: sample a few items
from the validated candidate, the LLM scores on-topic relevance `0–1` against the
topic definition.

| Tier | Criteria | Action |
| --- | --- | --- |
| **High-confidence** | passes all validation + relevance ≥ 0.8 | **auto-use**: add to `digest_topics.sources` (live) |
| **Borderline** | passes validation + 0.5 ≤ relevance < 0.8 | **candidate**: insert into `source_candidates` (await approval) |
| **Reject** | fails validation, or itself blocked, or relevance < 0.5 | discard (logged) |

Thresholds (`0.8`, `0.5`, `K`, candidate cap, cooldown days) are module constants,
tunable without schema change.

### 6. Applying results

- **Quarantine the failing source.** Mark it `"enabled": false` with
  `"disabled_reason"` + timestamp in the `digest_topics.sources` jsonb (the
  scraper skips disabled sources). Disable rather than delete — preserves
  provenance and allows un-disabling.
- **High-confidence discovery** → append to `digest_topics.sources` with
  provenance (`"added_by": "curator"`, `"replaces": "<old url>"`,
  `"discovered_at": <ts>`), enabled.
- **Borderline discovery** → insert into `source_candidates` (status `pending`).
  Not added to live config until approved.
- **Caps:** at most **1** auto-used addition per failing source per run; a global
  per-run cap on auto-additions to limit churn.

## Data model changes

1. **`digest_topics.sources` jsonb** — source objects gain optional fields
   (all default to "enabled, human-added" semantics when absent):
   - `enabled` (bool, default `true`) — scraper skips `false`.
   - `disabled_reason` (string), `disabled_at` (ts).
   - `added_by` (`"human"` | `"curator"`), `replaces` (url), `discovered_at` (ts).

2. **New table `source_candidates`** (borderline discoveries awaiting approval):

   | column | type | notes |
   | --- | --- | --- |
   | `id` | uuid pk | |
   | `topic_slug` | text | FK-ish to digest_topics.slug |
   | `url` | text | candidate source URL |
   | `type` | text | `rss` / `html` |
   | `replaces_url` | text | the failing source it would replace |
   | `failure_class` | text | `dead` / `blocked` (label) |
   | `relevance_score` | numeric | LLM relevance 0–1 |
   | `validation` | jsonb | {fetch_ok, item_count, newest_item_at, distinct_domain} |
   | `status` | text | `pending` / `approved` / `rejected` |
   | `created_at` | timestamptz | |
   | `decided_at` | timestamptz | null until approved/rejected |

   **RLS:** `authenticated` SELECT (matches existing read policies). Approve/reject
   via a `security definer` RPC callable by `authenticated` — there is precedent
   for authenticated writes (the feedback buttons write to `system_logs`).

## Approval workflow & dashboard

- The **Source Health** page gains a **"Candidate sources"** section listing
  `pending` rows: topic, candidate URL, what it replaces, relevance score, a short
  why, and **Approve** / **Reject** buttons.
- **Approve** (RPC) → moves the candidate into `digest_topics.sources` (enabled,
  `added_by: "human-approved"`), sets `status=approved`, `decided_at=now()`.
- **Reject** (RPC) → sets `status=rejected`. The failing source stays quarantined;
  the slot can be re-discovered on a later run (after cooldown).
- Additive to the web app; no change to existing pages beyond the new section.

## Scraper change

- Wherever `digest_topics.sources` is iterated, **skip** sources with
  `enabled == false`. Minimal, backward-compatible (absent `enabled` ⇒ true).
- **User-Agent unchanged** — the honest bot UA stays, per the route-around policy.

## Scheduling

- New APScheduler job in `src/news_digest/scheduler.py`, daily (separate from
  digest cron). Same systemd service on the Strix Halo host. Cadence is a config
  constant; daily is the default (source rot is slow).

## Error handling & safety

- **No good candidate found** → log, leave the source quarantined, surface on the
  dashboard as "needs manual attention." Never crash the job.
- **Search / LLM / network errors** → caught per-source, logged; the job continues
  to the next failing source.
- **Idempotent / cooldown** → never reprocess a source that has a `pending`
  candidate or was processed within the cooldown window.
- **Polite throttling** → reuse `scraping.py`'s per-domain rate limit for
  validation fetches; cap search calls per run.
- **Never strand a topic** → guard so the curator never disables a topic's *last*
  enabled source. If the only remaining source fails and discovery finds nothing,
  it alerts (system_logs warn) instead of disabling, leaving the source active.
- **Churn cap** → bounded auto-additions per run.

## Testing strategy

- **Unit (hermetic):** detection threshold logic; classification from `last_error`;
  confidence tiering; dedup/diversity; "keep ≥1 source" guard; jsonb mutation
  (quarantine / add). Mock health data, search, fetch, and LLM judge.
- **Validation pipeline fixtures:** good feed, bot-blocked feed, off-topic feed,
  stale (no recent items) feed, duplicate-domain candidate — assert correct tier.
- **Web unit tests:** candidates list render; approve/reject RPC happy-path + auth.
- **Real-world gate (per project convention):** run the curator against the actual
  `amd.com` failure on the Strix Halo host; confirm it discovers + validates a real
  alternate (auto-used or proposed as candidate), with logs and the resulting
  `digest_topics.sources` / `source_candidates` change as evidence.

## Open questions / future

- **Un-quarantine:** should the curator periodically re-test quarantined sources in
  case a block/outage was temporary? (Deferred; manual un-disable for now.)
- **Search provider:** Perplexity vs Brave vs WebSearch fallback ordering — pick
  during implementation based on result quality for feed discovery.
- **Relevance model:** uses the same Lemonade model as digests; revisit if judgments
  are noisy.
