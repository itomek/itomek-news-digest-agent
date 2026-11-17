# Gemma timeout recovery — November 17, 2026

The launch surface check found repeated discovery failures at the runtime's 30-second model-call deadline. Successful calls were recorded through OpenRouter/PrimeIntellect; failed calls retained exact timeout audits and full unknown reservations. Clearing individual stalled cycles did not fix recurrence.

The bounded fix raises the complete model-call deadline to 60 seconds and the hosted workflow lease to 180 seconds. Source-fetch and history limits stay unchanged. The existing scheduled HTTP timeout is already 120 seconds. The model, prompt, provider route, reservation, spending ceilings, queue and publication guards are unchanged.

For an exact recorded Gemma discovery timeout or strictly identified PrimeIntellect shared-pool HTTP 429, trusted scheduling may terminally quarantine the incomplete workflow after its lease expires plus five minutes (or the longer bounded Retry-After for a 429), with at most ten automatic quarantines per UTC day. Existing immutable audits, full unknown holds, known costs and prior candidate decisions survive. The original workflow cannot resume or dispatch again; later hourly scans use fresh checkpoints. Other unknown errors remain explicit stops. This is workflow recovery, never a claim that a timeout was unbilled or a failed scan completed.

Validation is limited to targeted transport/runtime and SQL regressions plus the existing release CI. Tests cover the expanded bound, matching lease/config contracts, automatic recovery cooldown/cap, preserved accounting, old-workflow fences and fresh-slot selection. No formal editorial-quality campaign or synthetic public post is required for this operational fix.

The live follow-up distinguished a newer shared-pool 429 from the earlier timeouts; the first timeout-only recovery correctly left that different error blocked. The final discovery helper handles both approved failure types with one combined ten-per-day cap, including audit entries from the earlier helper name. Unknown billing remains held in both cases.

The normal hourly curator rejected three queued items with stale verification snapshots. Their receipts had not expired; changing history/evidence made the guarded snapshots stale. The existing database-only `news-curate` job now runs every minute instead of once at :23, so fresh agent submissions spend less time waiting while history changes. Its code, validation, queue bounds and the hourly publisher remain unchanged. The rejected items are retained and are not force-published.
