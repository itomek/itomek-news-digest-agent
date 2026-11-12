# Scheduled dot-curation drain (locked off)

This worker drains at most one audited dot submission from the server-owned inbox.
It has no model API, source fetches, Bluesky password/session or public posting
transport. It does not impersonate an owner review or require owner approval per
story: decisions are the authorized dot's facts/meaningful-change/scope attestations.

`index.ts` hardcodes `WARPCORE_CURATE_ENABLED: 'false'`. Platform `verify_jwt=true`
and the existing `WARPCORE_PUBLISH_CRON_TOKEN` are both required. Request bodies
cannot supply editorial content, identities, enable flags or configuration.

A reviewed launch must configure `WARPCORE_CURATOR_DOT_ID` to the actual submitter's
dot identity and `BLUESKY_ACCOUNT_DID` to the pinned posting account. Database URL
and server key are built-in Edge runtime configuration, not credentials to collect
from the owner. No IDs or secrets are created by this module.

The worker claims one five-minute lease, validates dot/run identity and explicit
attestations, obtains the current SQL evidence snapshot, compares its opaque SQL
hash and canonical JSON evidence, then uses the existing curation and transport
formatters. The saved submission timestamp makes the record stable on retries.
SQL finalize must atomically recheck lease, current evidence and frozen content
before preparing/approving the existing outbox, preserving dot/run audit.

A response state `approved` means accepted into that outbox, never publicly posted.
The response explicitly says `publishing_enabled:false`. Finalize network failure
is `finalization_uncertain`: this invocation does not retry or mark the submission
failed. Snapshot outages leave the lease to expire; only known invalid submissions
are rejected. Reasons are fixed labels, not source text or raw exceptions.

Unit/adapter tests use mocked database responses only. Actual migration and
PostgREST integration must pass before deployment or any activation.

Persisted evidence URLs (including native and source links) must already be exact
HTTPS URL serializations without credentials. Legacy/manual noncanonical values
are rejected with `noncanonical_evidence`, never silently normalized before the
SQL snapshot comparison or treated as uncertain publication. Repair/recurate
such evidence explicitly. Normal ingestion already canonicalizes these fields.
