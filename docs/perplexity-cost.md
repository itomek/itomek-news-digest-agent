# Perplexity API — Usage & Cost

Perplexity is **not** part of the digest pipeline. It is only called by the
**source curator** ([`src/news_digest/curator.py`](../src/news_digest/curator.py))
to discover replacement feeds when a configured source has been persistently
failing. See [architecture.md](architecture.md) for where it sits.

## Bottom line

- **Total spend to date: ~$0.01 (about one cent).** Two API calls, both on a
  single dev/test run on 2026-06-12.
- **Recurring production cost today: $0/month.** The scheduled 04:00 curator job
  runs daily but skips Perplexity entirely because `PERPLEXITY_API_KEY` is not
  set in production — every run logs `PERPLEXITY_API_KEY not set — source
  curation skipped`.
- **If enabled, worst-case is ~$1.65/month**, and realistically near-zero most
  days (see [Projection](#projection-if-enabled)).

## Measured usage

Each Perplexity call is preceded by a `system_logs` row with
`metadata->>'action' = 'search'`, so call count is directly auditable.

| Metric | Value | Source |
|---|---|---|
| Real API calls, all-time | **2** | `system_logs`, measured |
| Dates with calls | 2026-06-12 only | measured |
| Model used | `sonar` | config default ([config.py](../src/news_digest/config.py)) |
| Search context size | `low` | hardcoded ([search.py](../src/news_digest/search.py), `web_search_options`) |
| Output token cap | 512 | hardcoded (`max_tokens`, [search.py](../src/news_digest/search.py)) |
| Scheduled prod runs since | skipped (key unset) | measured (`no_op` logs) |

Both calls were for topic `ai_updates`, searching for alternates to
`https://www.amd.com/en/blogs.html`.

## Pricing reference

From the official Perplexity pricing docs (<https://docs.perplexity.ai/guides/pricing>),
**as of 2026-06-19**. Re-verify before relying on these — Perplexity changes pricing.

> Total cost per query = token costs + a per-request fee that varies by
> `search_context_size`.

| Model | Input ($/1M tok) | Output ($/1M tok) | Request fee — low / med / high (per 1k req) |
|---|---|---|---|
| `sonar` (what we use) | $1 | $1 | $5 / $8 / $12 |
| `sonar-pro` | $3 | $15 | $6 / $10 / $14 |

## Cost model for one curator search

With our config (`sonar`, `search_context_size: low`, `max_tokens: 512`):

| Component | Amount | Cost |
|---|---|---|
| Request fee (low context) | 1 request | **$0.0050** (exact — fee is fixed per request) |
| Input tokens | ~25 tok (short system + query prompt) | ~$0.00003 (estimated) |
| Output tokens | ≤512 tok cap | ≤$0.00051 (estimated) |
| **Per call** | | **≈ $0.0055** |

The request fee dominates; token cost is rounding error at $1/1M. Two calls ≈
**$0.011**.

> Classification: call count is *measured* (from logs); the request fee is
> *deterministic* (fixed per request at our context size); token costs are
> *estimated* — token counts are not currently logged.

## Projection if enabled

Per daily curator run, searches are bounded by the churn caps in
[`curator.py`](../src/news_digest/curator.py):

- `MAX_SOURCES_PER_RUN = 10` → at most ~10 searches/day → **~$0.055/day ≈
  $1.65/month** absolute worst case (every cap maxed, every day).
- Realistic cost is far lower: a search only fires for a *persistently* failing
  source (≥3 attempts in 7d AND <50% success or no success in 72h), there is a
  7-day per-URL cooldown, and `MAX_AUTO_ADDS_PER_RUN = 3`. On a healthy source
  list most runs make **zero** calls.

## How to re-measure

```sql
-- Real Perplexity calls (each 'search' action == one API call)
SELECT count(*)            AS calls,
       min(timestamp)      AS first_call,
       max(timestamp)      AS last_call,
       count(DISTINCT date_trunc('day', timestamp)) AS days_with_calls
FROM system_logs
WHERE category = 'curator'
  AND metadata->>'action' = 'search';
```

For authoritative billed spend (including exact token counts, which we do not
log), check the Perplexity account dashboard at <https://www.perplexity.ai/settings/api>.
