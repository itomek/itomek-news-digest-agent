# Source-neutral curation and approval workflow

No model, topic list or sources are selected by this module. `createReviewPacket` accepts public source evidence plus supplied editorial text, preserving evidence provenance and returning awaiting_review, approved:false. It requires an original summary, significance, a stated meaningful change and valid cited evidence IDs. Literal raw reposts and political/unclassified items are held. No local-political exception is enabled while scope is deferred.

This validates structure, not truth: it is not an automatic curator, fact checker or originality detector. A future human/authorized evaluator must judge accuracy and meaningfulness. No LLM call, provider dependency or model spending exists.

`approveReview` requires matching review-packet hash, verifies packet integrity again, and requires explicit factsVerified, meaningfulChange and scopeApproved attestations from a trusted reviewer. These fields must never come directly from email, posts or an untrusted model self-approval. It returns a draft suitable for offline record preparation; it does not publish or write approval to a database.

Persist the exact prepared record and timestamp once. The server-only `warpcore_review_publication` RPC then approves or rejects only the matching persisted record/hash in prepared state. This updates exact-record approval and, on approval, story status in the same transaction. Caller must display/review the exact final record first. Public/anon/authenticated roles cannot execute this RPC; no public review endpoint or UI was added. The scheduler cannot approve records. Existing immutability prevents approval surviving a payload change.

A safe deployed operator UI/API and identity authorization remain deployment work. No source-driven instruction can grant approval. Future automated editorial policy must be separately authorized, evaluated and bound to these same immutable records.

Verification: Node/Deno module tests; isolated Postgres wrong-hash denial and exact-record approval. Prior standard public CI also passed legacy Python lint, formatting and unit tests. Hosted integration can be avoided by testing PostgREST with the same isolated PostgreSQL service in public CI; this would validate request/relationship mapping without production tables or a paid Supabase branch.
