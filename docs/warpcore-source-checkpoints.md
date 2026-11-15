# Source acquisition checkpoints

Source acquisition state is separate from editorial-review progress (#161). Collection only adds unverified evidence; catch-up never approves publication or changes freshness, exclusion, or hourly publishing guards.

## Persistence and recovery

Each configured adapter/source ID has durable sync state and an attempt history. A run claims a fenced lease, fixes its collection upper boundary, and resumes any unfinished window/cursor. Candidate ingestion and page progress commit in one database transaction. A failed write rolls back both. Retrying an ambiguous response is safe: a stale lease cannot commit, and origin/story deduplication preserves existing evidence and publication history.

Only an adapter's complete traversal can advance successful coverage. A complete empty traversal is distinct from failure. Partial work retains its cursor and fixed window for the next invocation. Expired attempts are recoverable after lease expiry; concurrent invocations cannot both own a source. Successful sources progress independently.

A timestamp is not proof of upstream completeness. RSS, official HTML indexes, and HN top-story snapshots expose finite history: their available evidence is persisted with an explicit coverage-gap outcome and earliest available timestamp. They do not advance the completeness boundary. A repeated gap remains visible; operators must not relabel it as successful catch-up merely because HTTP returned 200.

## Boundaries and identity

The bootstrap lower boundary is seven days before the first invocation. Subsequent windows overlap successful coverage by 24 hours; timestamp comparisons include ties. The page APIs retain all available evidence at or before the fixed upper boundary, including older late arrivals, rather than filtering by the lower timestamp or assuming publication dates prove ordering. Bluesky traverses author-feed cursors to exhaustion, one 100-post page per invocation; HN traverses a frozen top-story ID snapshot, 20 IDs per invocation. RSS and HTML scan the bounded publisher response. Items disappearing before retrieval cannot be guaranteed; finite history is reported as a gap rather than silently claimed complete. Changed publication/update dates do not replace origin identity. Retained snapshots up to 5,000 candidates are normalized in chunks of 500 and committed atomically; the 1 MB upstream response cap remains. A response exceeding evidence/parser limits fails explicitly and preserves progress; it is never silently truncated.

Source identity includes adapter and configured source ID. Configuration changes invalidate continuation state and start a new generation; existing candidates, provenance, and publishing records remain intact. Changing a URL, author DID, or relevance terms must not reuse a cursor for the previous configuration. Renaming an ID creates a new source identity and bootstraps independently.

## Verified pre-rollout provenance

On November 15, 2026, News Digest project `eedfyviypptfpghyffip` served collector version 13 with JWT verification enabled and 43 configured sources. Every dependency and the roster matched baseline commit `32327dc87ff87a31a67887521807708b950325c1`; only the approved roster-loading entrypoint differed. The deployed schema includes the native-repost migration; shadow-producer migrations remain undeployed. Pre-rollout counts were 528 candidates, 527 stories, and 50 publication records. These are a point-in-time baseline, not a health verdict.

## Rollout

1. Confirm the News Digest project, deployed collector bundle, source roster, JWT setting, schema, and active schedules before applying changes.
2. Apply the reviewed checkpoint migration before deploying the collector. Do not apply unrelated migrations or enable inactive producers.
3. Preserve the approved live roster and `verify_jwt=true`. The tracked default entrypoint remains locked to an empty roster; the approved production bundle loads `initial-sources.json`.
4. Invoke review-only collection and compare candidate counts, attempt outcomes, cursors, and coverage boundaries before and after. Repeat collection to verify deduplication/resumption. Do not change schedules or delete production data.
5. Query the service-only `warpcore_source_sync_health` view and `warpcore_source_sync_attempts` history for lag, incomplete catch-up, coverage gaps, and sanitized error codes. Never expose credentials or raw upstream failures in operations output.

Rollback the collector bundle if needed; retain checkpoint tables and evidence. Never roll back by deleting acquisition or publication history.

## Targeted recovery

An authenticated POST may provide `{"source_ids":["hn_discovery"]}` to narrow collection to existing configured IDs. Empty requests retain scheduled full-roster behavior. Unknown IDs, arbitrary configuration, duplicate IDs, and bodies over 4 KB are rejected. Each invocation retains the same per-source lease, fixed window, atomic ingestion, and cursor protocol. Repeat only sources whose outcome remains `partial`; a completed finite snapshot still reports `gap`, not complete historical coverage.

Failures distinguish sanitized HTTP status, content type, timeout/network, body limit, and parser categories. Raw source responses, error messages, URLs, and secrets never enter attempt errors.
