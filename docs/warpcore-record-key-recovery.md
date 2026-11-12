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

## Audited one-time repair artifact

`tools/recovery/firebase-tid-recovery.sql` is a manual, explicitly authorized
repair template, not a migration or scheduler action. It requires fresh exact
old/new-key `RecordNotFound` observations and an exact pre-inspected row snapshot.
It holds an exclusive publication lock, preserves the prior publication/inbox
in a private append-only audit, disables only the immutable-record trigger within
the transaction, changes only key/state, and restores the trigger before commit.
Any failure rolls back the trigger, row and audit together. The template cannot
be reused after the row is repaired. Do not commit live row snapshots or claim
SQL independently verified the supplied remote observations.

The companion audit-schema migration grants no public or service-role access.
The regression test injects a failure after trigger disable and verifies rollback,
then checks successful exact recovery, unchanged slots, and restored service-role
immutability.

Hosted connector migration versions differ from repository filenames:
- TID key correction: hosted `20261112194008`, repo `20261112192659`.
- Private recovery audit: hosted `20261112195037`, repo `20261112193554`.
- The approved data repair is separately audited under hosted `20261112195050`;
  it is not a replayable repository migration.

Do not run blind `db push`, reset, or repair against that migration history.
Reconcile the full existing history and schema first; these mappings alone are
not sufficient to repair earlier legacy migration drift.
