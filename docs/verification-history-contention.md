# Publication history contention

Publication history remains mandatory. Evidence ingestion can hold a story row
while `agent_verification.lock_history` attempts `FOR UPDATE NOWAIT`; PostgreSQL
reports SQLSTATE `55P03`. Admission advisory-lock contention reports the same code.

Only the read-only `warpcore_agent_history` RPC retries this structured error:
three attempts per page, with 100 ms and 200 ms waits. Retries retain the cursor,
original acquisition deadline, complete-history validation, and snapshot hash.
Other failures and mutating RPCs do not retry. Error responses are bounded to
32 KiB and only the recognized code survives transport sanitization.

A recovered retry proceeds through ordinary verification and produces no failure
alert. Exhaustion finishes the item with `history_lock_contention`, before source
fetches, reservations, or model requests, and sends the distinct persistent-busy
alert when notifications are configured. This uses the existing terminal deferral
semantics; it does not automatically requeue the story. Queue leases, receipt
currentness, and idempotent submission checks still apply.

Run `npm run test:verification-history-concurrency --prefix integration-tests`
with `WARPCORE_TEST_DATABASE_URL` pointing to a disposable loopback PostgreSQL
database named `warpcore_test`. The test resets its fixture schemas. It uses two
independent sessions to reproduce the candidate-write row conflict, recover a
history read, exhaust bounded retries, and check receipt/submission idempotency
and stale-evidence rejection. No live source, model, or publisher is called.
