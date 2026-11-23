# Warp Core source links implementation plan

**Goal:** Publish in-scope, previously unseen stories as attributed headlines with their original links when full-page acquisition isn't needed for the content we send. Do not add a second publisher.

**Architecture:** The regular ranked queue chooses relevance. Add a separately typed source-link decision and provenance record, derived only from the current public collector snapshot. Keep the present approval, admission, curator and Bluesky publisher chain. Source-link provenance does not mean claims were verified. The existing full-proof path remains for added editorial claims, and native reposts retain exact original identity.

## Constraints

- Use only current in-scope, configured public RSS and official HTML publisher inputs with a known title-first collector format as the first supported slice. Require known publisher and canonical captured destination; never substitute a different URL or use private/community snippets or untrusted freeform input as headline authority.
- Render exactly the captured headline under an explicit headline attribution and the single source link. No generated summary, additional claims or false fact-verification stamp. Leave old deferrals unchanged on rollout.
- Preserve exact evidence binding, account identity, URL checks, semantic/event dedup plus a transaction-bound last duplicate check, lease and maximum pending protections, authoritative readback, bytes and grapheme limits, and no blind replay after uncertainty.
- No feature enable, weakened access control, service or credential change, or synthetic post to the real feed as part of this draft.

## Tasks

- [x] `supabase/functions/_shared/source-link-draft.mjs`: pure formatter with an exact headline and URL, byte-based facet, explicit false `factsVerified`, same platform limits and no network. Test correct text, skipped description, Unicode facet, long headline, unhandled source types and malformed URL/text.
- [ ] `supabase/functions/news-agent/sql/verification-jobs.sql` and a forward migration: write an isolated integration fixture proving typed link admission uses a selected ranked story, a current public collector snapshot and an exact configured publisher binding. Add durable source-link provenance distinguished from full verification. Prevent issuance to skipped, changed, duplicate, out-of-scope, stale or already published items; do not mint full-proof receipts. Run the migration against both a clean and upgraded disposable database. Keep feature off by default.
- [ ] `supabase/functions/news-agent/verification-runtime.mjs`: choose link-only output for cases with sufficient headline metadata under the approved policy. Test that it avoids full-page fetch and paid verification, persists the explicit mode, and uses the protected queue. If policy requires a claim beyond the headline, preserve the current verification path. Never run both as parallel publishers.
- [ ] `supabase/functions/news-curate/services.mjs`, shared curation and transport, and the SQL finalize boundary: add exact source-link packet reconstruction and content hash checking without marking claims verified. Test forged headline, destination or receipt mismatch, source follow-up vs duplicate, concurrent admission, grapheme limits, native repost and full-proof regression, and uncertain publication state.
- [ ] Run the existing backend, SQL/PostgREST and Deno checks. Dry-run a recent public example that missed the full-page check and an unwanted story rejected by the unchanged editorial criteria. Confirm no actual Bluesky writes in validation. Review the migration/worker rollout order and prove feature-off rollback without dropping pending stories or changing prior verification status.
