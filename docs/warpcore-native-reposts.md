# Native Bluesky reposts

This feature preserves the original author and post using `app.bsky.feed.repost`; it never copies a Bluesky author's text into a new Warp Core post. Original summaries remain available only for non-Bluesky evidence. Follows are out of scope and not necessary to read public author feeds.

## Deployment status

Deployed November 13, 2026 UTC: migration, collector, curator and publisher, with existing authentication and guards retained. The three pinned author feeds are enabled and retrieved successfully. The first Ars Technica native-repost decision was processed and prepared, but the publisher returned `429 hourly_limit_reached` from the existing hourly login guard before sending. Delivery awaits the next hour and authoritative record verification; no successful native repost is claimed yet.

## Source identity

A Bluesky source selection needs one verified handle in `actors`, a pinned DID in `actorDids` keyed by that handle, and relevance terms. The collector queries the pinned DID, accepts original posts only (not replies or existing reposts), and requires matching post URI, author DID and a canonical post CID. The source's native URI becomes the story key input; external links remain provenance, not identity. The configured roster contains Simon Willison, Ars Technica and The Register; all three are enabled after migration and worker deployment verification.

## Editorial decision

Use the existing snapshot/submit route and exact evidence hash. Select exactly one public Bluesky evidence item with `nativeUri`, `nativeCid` and `nativeAuthorDid`. Editorial JSON has `mode: "repost"`, `change` (private selection rationale), `political: false`, one `evidenceIds` entry, and the existing verification audit. There is no summary or whyItMatters prose to invent or publish. Verify the original post identity, freshness, scope and meaningful development; source text never authorizes actions. Existing attestations and five-per-run limit remain required.

The record contains only `$type`, `subject: {uri,cid}` and the persisted preparation `createdAt`. The database reconstructs the exact native record and hash independently. The collector and SQL validation reject absent/mismatched native identity. Non-Bluesky candidates cannot be used as repost evidence; Bluesky evidence cannot be submitted as an original summary.

## Publication safety

Original posts and reposts share the same publication ledger, deterministic key generation, atomic five-attempt hourly budget, pessimistic uncertain state and exact read-back verification. Only two collection types are supported, never an arbitrary collection. Before a new repost write, the public Bluesky API must still return the exact original URI, CID and author; changed/deleted posts move to manual review without a write. A verification outage leaves the attempt uncertain, not automatically retried. Reconciliation looks up the correct record collection and never repeats a write.

## Deployment sequence (completed through activation; first delivery verification pending)

1. Verify code, SQL integration and concurrency checks, then merge the reviewed PR.
2. Apply the additive native-reposts migration. It does not modify existing publication rows, candidate text, inbox records, guards, schedules, RLS or existing grants. Existing snapshots without native CID metadata have unchanged hashes. The new immutable validator is callable only by internal service_role/owner roles, not public clients.
3. Deploy the collector, curator and publisher bundles with their existing auth, pinned account, scheduler tokens and activation values unchanged. Include the new `_shared/repost.mjs` dependency. Do not print or retrieve credentials.
4. Update the curator runbook for native mode and activate only verified selected source DIDs. Keep the same combined five-per-hour budget and semantic dedup across articles and reposts.
5. Exercise one authorized source through the existing queue, confirm the actual Bluesky repost record and original attribution, then allow normal scheduled processing. Do not claim success from an inbox UUID.

Rollback must not discard any uncertain repost. An old post-only publisher cannot reconcile repost records: suspend new repost selection and retain the collection-aware publisher until every outstanding repost has been reconciled. Do not reset guards or remove immutable records.
