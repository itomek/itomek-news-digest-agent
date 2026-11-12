# Offline curation/publishing boundary

This is a tested interface foundation, NOT a functioning publisher or automatic curator.

`_shared/publishing.mjs` accepts reviewer-authored original summary, significance, public source links, story key and explicit verified/approved attestations. Those flags must come from trusted editorial state, never directly from source posts or a model's self-assessment. It enforces Bluesky text limits and rejects incomplete drafts; it never silently truncates evidence. It cannot establish truth, relevance or originality itself. Political-topic exclusion and meaningful-change selection still need editorial rules and evaluation after scope is settled.

Output is always `dry_run`, `publishable:false`. There is no sender, password, network call or enable flag. Stable per-story record key plus text hash distinguish replay from changed-content conflicts. `nextAction` requires reconciliation for sending/uncertain states; only a verified matching remote record can suggest marking published. A missing/different record is manual review, not permission to blindly retry.

The accompanying publication-ledger SQL proposal adds account-scoped durable uniqueness and content hashes. It is not applied or integration-tested. Atomic publication claims, remote read/write verification, content facets/link cards, account DID pinning and transport are future work. These boundaries deliberately prevent this draft from becoming an accidental repost bot.

No real stories are selected or generated. Use synthetic fixtures for tests. Existing audio remains unchanged.

## Transport preview and claim proposal
A credential-free transport preview now builds a deterministic-key Bluesky record with UTF-8 link facets and a supplied persisted timestamp. It returns request:null and has no send API. Pinning a DID requires separate real account verification; syntactic validation alone is not verification. The ledger proposal now includes an atomic prepared-to-sending SQL compare-and-set, guarded by matching hash and approved story. It is not applied or database-tested. Deno, PostgreSQL and Docker binaries are unavailable in this runtime; Node tests cover pure modules only. No hosted changes were made merely to claim integration coverage.

## Mock-tested send orchestration
`sender.mjs` now implements dependency-injected claim -> durable uncertain -> single put -> exact-record readback -> published flow. It is not wired to HTTP or deployed endpoints. Explicit enable plus matching pinned account is required. Failed/ambiguous writes are never repeated automatically; a separate reconcile performs read-only verification. Mismatched records require manual review. Database claim must compare the stored full record as well as content hash; schema/claim proposal now includes that comparison. No database or Bluesky transport adapters are provided yet, and no hosted integration result is claimed. All sender tests use synthetic records and in-memory test doubles.

Independent review prompted additional safeguards: claim returns the immutable persisted row, and sender uses that record rather than the caller's copy. Put requires create-only `swapRecord:null`, never overwrite. Published transition must return true only after a matching sending/uncertain ledger compare-and-set; otherwise result is manual_review. Database adapter must map SQL row fields to the sender contract. These adapter obligations remain unimplemented and require integration tests before live use.
