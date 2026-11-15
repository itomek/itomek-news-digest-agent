# Isolated hosted spike target

Prepared after PR #167 merge, November 15, 2026. Proposed new project: warpcore-agent-shadow, organization itomek (piarenlzteswrwwlhnew), us-east-2. Supabase quoted project cost: 0/month; organization is free plan. Existing free-project quota may prevent creation; no paid upgrade/branch is authorized.

The current News Digest production ref eedfyviypptfpghyffip has eight active functions and no news-agent. No shadow migrations appear in its recorded migration list; a read-only namespace query also confirmed shadow_agent is absent on November 15. Do not overwrite those functions, provision a model key there, or change production cron.

Prepare fixture.sql, then shadow-state.sql, shadow-paged.sql, shadow-audit.sql, shadow-producer.sql in a new isolated database only. Fixture preconditions reject existing pipeline tables/schema. Seed only synthetic candidates; retain empty publication/inbox tables with no publishing routes.

Deploy news-agent-spike using a dedicated producer token plus platform JWT. The spike requires its explicit project ref, rejects the production ref, forwards only pinned Supabase RPCs and fabricates all model responses locally. Never fetch OpenRouter or source URLs. Use one page/batch per invocation and record exact deployedcommit, auth denials, 405-candidate coverage, overlap, leases, ledger and zero publishing rows.

Separate approval remains needed for target provisioning/deployment under the recorded gate. Existing proposed $2/24-call real-model pilot remains unapproved; no charge or account topup is authorized by this file.

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
