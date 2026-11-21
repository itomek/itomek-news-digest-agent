# Guarded publication failure and contention evidence — November 21

Follow-up to #163 and #195. Tests exercise actual PostgreSQL 17.6 and PostgREST
12.2.3 with a controlled AT Protocol remote. No production mutation, paid inference
or live send is involved. Source fixtures and model judgments are fabricated.

## Results

| Check | Executed evidence |
|---|---|
| Combined pending-five under contention | `shared-admission-concurrency.mjs` uses independent sessions, observes actual row-lock inversion and tests immediate SQLSTATE 55P03, post-commit visibility, transfer at capacity and rollback. Its tables are deliberately minimal fixtures. |
| Identity migration preservation | `identity-leases-postgres.mjs` installs historical TID/native/agent identity changes on actual PostgreSQL. Historical uncertain payload/key and consumed accounting survive; existing Dot identity remains unchanged when agent columns are added. SQL/JS TID parity and denied public roles are checked. |
| Expired lease and stale completion | The identity/lease test holds a replacement lease transaction open while another PostgreSQL session claims. The competitor receives 55P03 under the current admission guard; after commit there is no second lease. Old tokens cannot finalize or reject; the replacement finalizes exactly once. |
| Authenticated duplicate submissions | `current-recovery-postgrest.mjs` submits each receipt concurrently four times over HTTP, accepts only the same inbox ID or explicit 55P03 deferral, and verifies exactly one persisted inbox row. |
| Lost committed curator response | The real curator service calls real PostgREST; the response is dropped after successful finalization. It reports `finalization_uncertain`; a subsequent drain is empty, and the database retains one processed truthful-agent submission and one publication. |
| Lost remote send response | The real sender and real database/API persist uncertainty before a controlled remote commits and throws. A second send cannot claim. Exact collection-aware readback reconciles to published; only one remote write occurred. |
| Native mismatches | Changed native-subject verification and changed readback subject CID each lead to durable manual review without another write. |
| Current quota policy and retained capacity | At least six claims and six login reservations succeed within one actual hour. The test repeats its bounded batch if the hour changes. Two manual-review plus three prepared stories occupy all five pending slots; a sixth pending admission fails. |

The recovery test passed with 88 counted direct RPCs plus concurrent duplicate and
curator-service HTTP calls, one controlled remote write, and zero live sends. The
identity/lease and admission tests also passed. The initial identity test assumed
the competing current claim would return no row; running it exposed the intentional
fail-fast 55P03 contract. The final test holds the winner transaction open and asserts
that refusal explicitly.

The complete embedded integration command (`npm test --prefix integration-tests`)
passed. All 583 JavaScript unit/mock tests from the validation workflow passed with
`umask 022`, matching the ordinary CI file-creation environment. An initial run
under this workspace's `umask 077` failed the existing pilot-ledger test that requests
a public 0755 directory: the mask made it private 0700, so its expected refusal did
not occur. No ledger implementation or test was changed. After incorporating #194, the unit/mock
suite was rerun and passed 593/593 tests; the publication SQL exercised here is unchanged.

## Reproduction

All scripts require disposable loopback databases named `warpcore_test`. The identity
and recovery tests refuse an existing publication schema and leave their fixture for
inspection. Never point these at a production database. CI provisions separate
services in `.github/workflows/warpcore-validation.yml`:

```sh
WARPCORE_TEST_DATABASE_URL=postgres://postgres:disposable-ci-only@127.0.0.1:5433/warpcore_test \
  npm run test:shared-admission-concurrency --prefix integration-tests
WARPCORE_TEST_DATABASE_URL=postgres://postgres:disposable-ci-only@127.0.0.1:5433/warpcore_test \
  npm run test:identity-leases-postgres --prefix integration-tests
WARPCORE_TEST_DATABASE_URL=postgres://postgres:disposable-ci-only@127.0.0.1:5434/warpcore_test \
WARPCORE_TEST_POSTGREST_URL=http://127.0.0.1:3004 \
WARPCORE_TEST_JWT_SECRET=disposable-ci-jwt-secret-never-production-2026 \
  npm run test:current-recovery-postgrest --prefix integration-tests
```

Local execution used ports 55433 for admission/identity and 55434/3004 for recovery.
The admission fixture removes its tables/schema and leaves roles; the identity test
accepts those roles before installing its own fresh schema. Recovery uses a separate
database. The application guard SQL is loaded from the repository, including native
reposts, shared admission, agent verification, and the later removal of hourly quotas.

## Limits and remaining evidence

This is the explicit receipt/sender migration subset listed in the tests, **not a
complete replay of every production migration or all installed shadow-agent SQL**.
It does not exercise real provider billing, all discovery/workflow recovery, hosted
network faults or browser rendering. A controlled remote isolates the lost-response
boundary without production test posts. Full installation parity remains distinct
from proving these guarded publication contracts.

Fresh read-only deployment and public record observations are in
[the companion report](2026-11-21-deployment-readback.md). They confirm exact retained
post/repost CIDs and five deployed SQL definitions/private permissions, while recording
actual bundled-file differences. They do not establish complete deployed/source parity.
