# Local news review preparation

This credential-free Node tool makes a review packet from **explicit human editorial text and public evidence**. It does not collect news, select sources/topics, call a model, fetch links, approve content, access Supabase, or post anything. The included example is synthetic, not a recommendation or live story.

## Try the shape

With Node 22 or newer, from the repository root:

```sh
node tools/prepare_review.mjs --input examples/review/synthetic-draft.json --output /tmp/warpcore-example-review.json
node --test review_tests/*.test.mjs
```

Choose a fresh output filename on each run. Existing files are never overwritten; new output is mode 0600. Input must be a regular JSON file no larger than 512 KiB. The tool prints status, not the evidence text. It requires no package installation beyond the existing repository files.

## Prepare a real local draft later

Use the supplied example as a schema, not a source roster. Provide:

- `storyKey`: the existing story's 64-character lowercase hex key. Do not fabricate a key for an existing database story.
- `evidence`: public evidence items, each with `id`, `url`, `sourceType`, `visibility: "public"`, and actual source `text`. Optional `sourceLinks`, `nativeUri`, and `nativeUrl` preserve original Bluesky/HN attribution alongside an article. Do not supply email/private content, credentials or secrets.
- `editorial`: your original `summary`, brief `whyItMatters`, specific meaningful `change`, selected `evidenceIds`, and explicit `political: false`. Unclassified/political items are held, not silently included.
- `attributionChecks`: exactly one `{ "evidenceId": "...", "checked": true }` for every selected evidence item. Set this only after personally checking the publisher/source and the linked attribution. The tool cannot perform this verification for you.

The packet retains source provenance and a content hash. It includes a readable preview with links, enforces the complete Bluesky length limit, and refuses to silently drop attribution to make a post fit. More than three distinct links requires narrowing the selected evidence. It does not generate a native repost.

## What the result means

Output is always `local_review_only`, `publishable: false`, `packet.approved: false`, and `awaiting_review`. The attribution label is explicitly `operator_attested_not_independently_verified`. This is **not** an assertion that the story is true, a signed authorization, or a publish-ready queue job.

The existing operator API still needs its own server-owned evidence lookup, frozen preview, authenticated operator decision and exact-record approval. A local packet cannot bypass those gates, and this tool cannot import or approve a packet on that API. Compare the local draft with the later server preview; preserve the final server review ID/hash/version for that workflow. Sources, operator identities, scheduler and publishing remain separately disabled until authorized.
