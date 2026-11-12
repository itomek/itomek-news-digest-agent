# Offline curation/publishing boundary

This is a tested interface foundation, NOT a functioning publisher or automatic curator.

`_shared/publishing.mjs` accepts reviewer-authored original summary, significance, public source links, story key and explicit verified/approved attestations. Those flags must come from trusted editorial state, never directly from source posts or a model's self-assessment. It enforces Bluesky text limits and rejects incomplete drafts; it never silently truncates evidence. It cannot establish truth, relevance or originality itself. Political-topic exclusion and meaningful-change selection still need editorial rules and evaluation after scope is settled.

Output is always `dry_run`, `publishable:false`. There is no sender, password, network call or enable flag. Stable per-story record key plus text hash distinguish replay from changed-content conflicts. `nextAction` requires reconciliation for sending/uncertain states; only a verified matching remote record can suggest marking published. A missing/different record is manual review, not permission to blindly retry.

The accompanying publication-ledger SQL proposal adds account-scoped durable uniqueness and content hashes. It is not applied or integration-tested. Atomic publication claims, remote read/write verification, content facets/link cards, account DID pinning and transport are future work. These boundaries deliberately prevent this draft from becoming an accidental repost bot.

No real stories are selected or generated. Use synthetic fixtures for tests. Existing audio remains unchanged.
