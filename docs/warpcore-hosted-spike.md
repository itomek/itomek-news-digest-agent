# Isolated hosted spike target

Prepared after PR #167 merge, November 15, 2026. Proposed new project: warpcore-agent-shadow, organization itomek (piarenlzteswrwwlhnew), us-east-2. Supabase quoted project cost: 0/month; organization is free plan. Existing free-project quota may prevent creation; no paid upgrade/branch is authorized.

The current News Digest production ref eedfyviypptfpghyffip has eight active functions and no news-agent. No shadow migrations appear in its recorded migration list; a read-only namespace query also confirmed shadow_agent is absent on November 15. Do not overwrite those functions, provision a model key there, or change production cron.

Prepare fixture.sql, then shadow-state.sql, shadow-paged.sql, shadow-audit.sql, shadow-producer.sql in a new isolated database only. Fixture preconditions reject existing pipeline tables/schema. Seed only synthetic candidates; retain empty publication/inbox tables with no publishing routes.

Deploy news-agent-spike using a dedicated producer token plus platform JWT. The spike requires its explicit project ref, rejects the production ref, forwards only pinned Supabase RPCs and fabricates all model responses locally. Never fetch OpenRouter or source URLs. Use one page/batch per invocation and record exact deployedcommit, auth denials, 405-candidate coverage, overlap, leases, ledger and zero publishing rows.

The owner approved the isolated free project/deployment and the $2-total/24-call pilot on November 15. No paid upgrade or account topup is authorized. Creation was attempted at the refreshed zero-monthly-cost quote and refused because the account already has two active free projects. No existing project was paused or changed. A separate decision is pending on freeing a slot.

## Prepared artifacts and checks

`supabase/functions/news-agent-spike/index.ts` stays disabled unless its dedicated
isolated environment flag is explicitly enabled. `spike.mjs` rejects the known
production reference and fabricates zero-cost model completions in process.
`fixture.sql` refuses an existing pipeline; inbox/publication stand-ins enforce
emptiness. The fixture never installs budgets or enables the selector.

A reviewed setup in a newly approved isolated project must install the fixture
and shadow contracts in order, provision a dedicated token, then administratively
enable the selector with a synthetic run/day ledger. No real OpenRouter key is
needed. Only that isolated setup may turn on the spike environment flag. The
normal `news-agent` entrypoint remains hardcoded disabled.

Local checks: 262 JavaScript tests, Deno checks for both entrypoints and the
embedded fixture tests pass; independent spike review has no outstanding findings.
These are preparation results, not deployed or unattended-operation evidence.

## Approved attempt checkpoint — November 15

The isolated project was not created: Supabase reported the account-wide free
project quota. Only the itomek organization is available. News Digest and
cyberai-staging-bridge remain active and untouched. The owner is deciding whether
to pause the staging bridge temporarily or retain both active projects. No paid
upgrade or reuse of an unrelated project is permitted by the current approval.

A credential-presence preflight found no OpenRouter key in this shell or the known
workspace environment files; no secret value was printed. A dedicated capped
pilot credential must be provisioned before actual model testing. No model call,
charge or deployment occurred. The [attempt record](evidence/2026-11-15-hosted-spike/attempt.json)
keeps the approved limits separate from actions actually performed.

## November 16: Strix Halo replaces the new cloud project

The owner chose the Strix Halo if feasible and otherwise asked to skip the
project. A live probe found Docker 29.10.0 running, despite an older inventory
entry saying no daemon was installed. The machine was reserved before use.
No Supabase project, paid upgrade, production schema or service was changed.

A private Docker stack on the Halo completed the synthetic campaign over real
HTTP/PostgREST/PostgreSQL: 405 captured candidates, 405 unique decisions, 24
naturally leased advances and 17 settled/audited fabricated model batches. It
finished in 255,344 ms using ten-second test leases and eleven-second cadence,
without administrative lease expiry. Deno was restarted at 75 decisions and
resumed the same run at 100. The terminal empty-page gate, final candidate, ten
negative request/auth checks and five overlapping triggers were checked.

A second test dropped settlement before the database. One new synthetic run
remained uncertain with one dispatched attempt and its 0.01 synthetic-credit
hold. Repeated requests, including after natural lease expiry, stayed idle
without replay; the completed 405-story history remained intact. This models
unconfirmed settlement, not an actual provider timeout or billed inference.
Publication/inbox stand-ins remained empty. Actual spend and paid calls are zero.

Docker 29 suppressed host publishing on an internal-only network. A separate
loopback ingress network fixed access at 127.0.0.1:58089; database ports stayed
private, and Deno's destination allowlist still excluded model/source HTTP.
GET without authentication returned 405; POST without authentication returned 401.

[Execution manifest](evidence/2026-11-16-strix-halo-shadow/execution.json),
[full campaign](evidence/2026-11-16-strix-halo-shadow/result.json), and
[failure hold](evidence/2026-11-16-strix-halo-shadow/fault-result.json) record exact
source commits and image digests. Both JSON artifacts were hash-checked after
transfer. Owned containers, networks, database volume and disposable secrets
were removed; the reservation was released and status confirmed FREE. This was
a temporary test deployment, not a persistent service left on the shared host.

The self-hosted testbed is feasible, so a new Supabase cloud project is no longer
needed for this spike. It does not establish Supabase cloud Edge behavior, real
OpenRouter/provider billing or editorial quality. The approved 2-dollar/24-call
pilot remains unused and still needs a dedicated credential and its remaining
billing preflight before actual inference. Production remains unchanged.


## November 16 paid shared-runtime checkpoint

The model-independent SQL integration and a one-shot Deno CLI were exercised on
Strix Halo with four prepared public development candidates. GPT-oss-120B/Groq
completed one paid request through private PostgREST/PostgreSQL; actual provider,
model, usage and 0.00049965 USD cost settled durably. A concurrent invocation made
zero model calls, and a completion invocation after natural 120-second lease expiry
also made zero. Producer selection remained disabled and publication tables empty.

A preceding Gemma call timed out and its uncertainty was archived without inventing
native usage. The parent used refreshed authenticated Logs and unchanged key usage
to reconcile zero reported charge. Its canonical campaign ledger was never reset.
All disposable stacks, volumes, runtime credentials and the machine reservation were
cleaned up. See `docs/evidence/2026-11-16-strix-halo-paid/` for source, image hashes,
parent-owned budget enforcement, actual results and remaining acceptance limits.

This is shared-runtime CLI evidence on self-hosted Deno/PostgREST/PostgreSQL. It does
not activate the scheduled producer or publisher, prove Supabase cloud behavior,
or establish editorial quality from the small development sample.
