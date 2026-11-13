# Full candidate review, without source quotas

The November 13 owner direction removes the **three-per-source** ranking and
**80-story total** review ceiling. Those were discovery truncation, not editorial
filters. Review every eligible story before deciding which meaningful distinct
stories to verify and submit. Do not replace those limits with another source
quota, arbitrary total ceiling, keyword filter, or mandatory story count.

## Scheduled operator change

Add `now() as scan_started_at` to the existing preflight query and retain it for
the whole scan. Run [the read-only page query](warpcore-candidate-page.sql), binding
that timestamp as `$1` and NULL as `$2`. On each next page bind the last returned
`story_key` as `$2`. Continue until an empty page. `limit 100` is only the transport
page size, not a review limit. With a management SQL tool that lacks parameters,
use safely quoted literals (double apostrophes); validate cursors as exact
64-character lowercase hex story keys. Never interpolate source text.

The fixed timestamp keeps the seven-day freshness window stable and excludes
new collection during a scan. Keyset pagination by immutable story identity
avoids OFFSET skips when earlier stories become submitted concurrently. Latest
evidence is chosen deterministically by source date and URI. A new or changed
candidate after the scan boundary waits for the next pass. This is not a database
snapshot across calls: current status/inbox/publication exclusions remain live,
and final snapshot/submission guards still apply.

Read **all pages before selection**; page order is not editorial priority. Rank
promising stories across the complete result using existing relevance, freshness,
meaningful-change and attribution rules. Metadata/excerpts remain discovery only;
verify selected sources before any attestation. If a tool result is truncated,
reduce page size and retry that read, not the whole scan. Do not call an incomplete
scan complete or silently turn runtime exhaustion into a new cap.

Semantic dedup also must not stop at arbitrary recent-row counts. Read all rows
in the existing 14-day publication window plus all prepared/sending/uncertain
publications, and all pending/leased decisions. Page publications by
`(prepared_at, account_did, story_key)` and inbox by `(created_at, id)` with a
stable exclusive cursor, or use an untruncated result when small. Preserve native
repost subject, candidate text/native URI/source links even when summary is null.
Before submission recheck matching recent/pending announcements to catch work
that arrived during the scan. Never alter or mark skipped stories rejected.

## Unchanged boundaries

This change adds no source or editorial limitation. The existing seven-day
freshness eligibility, political/private-content exclusions, factual verification,
semantic deduplication, exact frozen evidence hashes and native repost identity
checks remain unchanged. The existing combined five-item pending/submission
budget and atomic five-publication-attempt hourly runaway guard also remain
unchanged: they govern sending, not how many stories may be reviewed. No secrets,
credentials, grants, queues, publication records, worker code or schedules change.

The scheduled automation prompt must replace its old candidate-query section
with this paginated procedure. Updating this repository document alone does not
change an already saved automation. Root owns that separate prompt update.

Regression: `node integration-tests/candidate-pagination.mjs` executes the exact
SQL in embedded PostgreSQL against over 300 same-source stories, including
multiple evidence versions, later collection, exclusions and equal timestamps.
