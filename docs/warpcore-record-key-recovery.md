# Post record keys and guarded recovery

Bluesky posts require collection-specific TID record keys, not merely the generic
AT Protocol record-key syntax. The old `story-<sha256>` key passed our generic
adapter mocks but is not a valid `app.bsky.feed.post` key. Keep `validate: true`;
do not bypass the protocol validator.

The corrected key derives from the **persisted** post `createdAt`, normalized to
millisecond ISO precision, and the first ten bits of the story hash. Encode
`(epochMilliseconds * 1000 << 10) | clockId` as thirteen characters using
`234567abcdefghijklmnopqrstuvwxyz`. All arithmetic after timestamp parsing is
integer/BigInt. The database checks the same derivation. Account/story uniqueness
remains the primary idempotency boundary; account/key uniqueness rejects a rare
same-millisecond/clock collision rather than overwriting another story.

## Existing uncertain attempts

A code fix does not authorize a resend or identity reset. Keep the existing
uncertain row, immutable payload, prior record key, and consumed hourly slot.

Before a separately reviewed recovery:
1. Read the exact legacy key from the authoritative PDS identified by the DID
   document. An AppView feed or search omission is not sufficient evidence.
2. If the exact record exists, compare the full record and reconcile its existing
   URI. Do not change the key or publish again.
3. If the authoritative PDS returns `RecordNotFound`, record that evidence and
   the time, inspect the matching stored payload, and review a narrowly scoped
   recovery preserving the old key and outcome in audit history.
4. Deploy and verify the protocol fix before any recovered job becomes eligible.
   Preserve login/send-hour reservations. Do not reset guards for convenience.
5. Recheck absence immediately before recovery. Never re-key an already published
   record or infer absence from a network error.

The first trial's publisher returned `uncertain`; its generic error handling did
not retain the original remote error. The invalid TID is a verified defect, not a
captured server-error attribution. No automatic retry is introduced by this fix.
