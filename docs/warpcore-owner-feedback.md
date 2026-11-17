# Public owner feedback

The independent agent can record public owner replies for operator review. This
is a separate channel from news evidence and editorial policy. Captured text is
untrusted public content: it cannot change policy, scope, credentials, spending,
destinations or instructions. No model receives this feedback as instructions.
There is no DM access, Dot-chat delivery, automatic chat answer or public reply.

The owner is pinned to `did:plc:gbpnjfu6l62bkyeemommtqw4`; Warp Core is pinned to
`did:plc:pfq2p7n2oiiy2k4pv6xnsgdk`. A qualifying original post must have the owner's
exact author DID and AT-URI authority, a captured native CID, and a reply root or
parent whose exact AT post URI has Warp Core's DID authority. Handles, quoted
posts, unrelated posts and reposts cannot establish owner feedback identity.

`owner-feedback.mjs` reads only
`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed`, with the fixed owner
actor, `posts_with_replies`, `includePins=false` and limit 20. The only variable
request field is the durable public-feed pagination cursor. It uses the existing
public-IP-pinned TLS transport, no authentication or ambient cookies, no
redirects, a 10-second deadline and a 200KB response limit. Public/private warning
states and identity mismatches refuse the page. Source text is never executed.
These request conventions follow the official [author-feed lexicon](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getAuthorFeed.json)
and [feed documentation](https://github.com/bluesky-social/bsky-docs/blob/main/docs/tutorials/viewing-feeds.mdx).

## Storage and coverage

`sql/owner-feedback.sql` is a separate administrator-reviewed installation. Its
private setting defaults disabled. `warpcore_owner_feedback_checkpoint()` and
`warpcore_owner_feedback_record_page(revision,page)` are service-only fixed RPCs;
workers receive no direct table privileges. Installation does not enable polling
or alter existing queues, sources, budgets, credentials or policy.

An enabled first scan freezes a seven-day window. Each invocation fetches and
atomically records at most one page. Revision CAS, bounded cursors and cursor-loop
checks make continuation resumable. The public AppView's observed indexing order
must be nonincreasing across the page boundary; an ordering violation refuses
advancement. Feedback must fall inside both the creation and indexing window.
Only qualifying owner replies persist as text. Immutable page receipts retain
window bounds, retrieval time and source-body hash without copying the whole feed.

Coverage is explicit:

- `pending`: another page remains; the seven-day scan has not reached its cutoff.
- `cutoff_reached`: validated observed feed indexing reached the frozen lower
  bound. This describes the public AppView traversal, not exhaustive AT Protocol
  history or private/deleted content.
- `feed_exhausted_before_cutoff`: the public API stopped before the lower bound;
  this is a coverage gap, never a claim that all seven days were available.

After a finished traversal, the next invocation opens a fresh fixed seven-day
window. Overlap is intentional. URI/CID dedup preserves original captured rows;
changed CID or record material refuses the entire page instead of overwriting
history. A stale CAS also commits no rows. Failures retain the prior cursor and
need operational review if persistent.

## Review boundary

Rows have only `recorded` or `operator_review` status. An administrator can inspect
`owner_feedback.items` and change that review status; the captured identity and
text remain immutable. These statuses do not mean the agent agreed with a request
or changed its policy. No downstream delivery channel or response promise is
implemented. Polling still requires explicit administrator enablement and runtime
wiring; this document does not claim a live deployment or a completed historic
owner-feedback scan.

Synthetic unit and embedded PostgreSQL checks cover fixed public routing, owner
impersonation, unrelated threads, changed identities, immutable duplicates,
checkpoint CAS, page continuation, cutoff/coverage gaps and private permissions.
They establish capture contracts, not live AppView availability or actual receipt
of every owner reply.
