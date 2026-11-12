# Small sequential hourly batches

The owner's feed is a sequence of short, attributed story posts, not one giant
digest and not one story per hour. Each hourly check can publish several worthwhile
stories. Initially the application processes at most five approved stories per
run, sequentially; extra vetted backlog waits for a later check.

The chosen safety bound is five new publication attempts per account per UTC
hour, matching the five-item runtime queue and one session-initialization budget
per hour. This is an initial runaway safeguard, not a target or quota. Quiet hours
with no meaningful stories produce no posts. Each story still requires dot
verification and its exact approved payload. Source content cannot approve itself.

Private curation claims at most five queued decisions, then verifies and finalizes
each sequentially. The publisher likewise awaits each separate record operation.
The durable account/story identity, valid persisted TID, exact payload comparison,
create-only write, and remote reconciliation protections remain unchanged.
Unknown/failed writes consume an attempt; previously published records are excluded;
uncertain records are reconciled, never blindly sent again. Invalid or duplicate
claims do not consume another attempt. Concurrent distinct claims serialize on the
account budget row and cannot exceed five. Existing consumed reservations are kept.

Normal schedule: collect at :17, dot selection around :20, private curation drain
at :23, publication at :27. Supabase executes the collection/drain/publication;
dot's own durable automation performs editorial source verification without a new
paid inference API. Late editorial decisions can wait for the next run. Do not
activate the publisher schedule until deployment and the durable dot automation
are verified. GitHub Actions is CI only for this setup.
