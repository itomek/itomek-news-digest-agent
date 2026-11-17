# Isolated self-hosted shadow test

This is a temporary PostgreSQL/PostgREST/Deno testbed, not Supabase cloud or a
production deployment. It fabricates all inference responses in process. No
OpenRouter key, Supabase cloud account, source HTTP or publishing route is used.

Reserve the shared machine first. Use a fresh scratch checkout and a unique
Compose project name; never point this at existing volumes or production data.
Docker and Compose must already be available. The fixture refuses an existing
Warp Core schema, and the application rejects production project identities.

From the scratch checkout:

```sh
HALO_STATE_DIR=$(mktemp -d)
HALO_PROJECT="warpcore161-$(date +%s)-$$"
python3 - "$HALO_STATE_DIR" <<'PY'
import pathlib,secrets,sys
root=pathlib.Path(sys.argv[1]);art=root/'artifacts';art.mkdir(mode=0o700)
p=root/'private.env'
p.write_text('POSTGRES_PASSWORD='+secrets.token_hex(24)+'\nJWT_SECRET='+secrets.token_hex(48)+'\nWARPCORE_AGENT_PRODUCER_TOKEN='+secrets.token_hex(32)+'\nHALO_ARTIFACTS_DIR='+str(art)+'\n')
p.chmod(0o600)
PY
docker run --rm --cpus 2 --memory 512m -v "$PWD:/code" -w /code/integration-tests node:22.23.3-bookworm-slim npm ci --ignore-scripts --no-audit --no-fund
docker compose --env-file "$HALO_STATE_DIR/private.env" -p "$HALO_PROJECT" -f tools/halo-shadow/compose.yml config --quiet
docker compose --env-file "$HALO_STATE_DIR/private.env" -p "$HALO_PROJECT" -f tools/halo-shadow/compose.yml up -d postgres postgrest edge
docker compose --env-file "$HALO_STATE_DIR/private.env" -p "$HALO_PROJECT" -f tools/halo-shadow/compose.yml run --rm --no-deps exercise
```

The natural-expiry campaign takes about four minutes: ten-second test leases,
eleven-second invocation cadence, 405 candidates and 24 successful advances.
It checks authentication, overlap, final-page coverage, audited zero-cost
fabricated attempts and empty publication/inbox tables. Do not shorten this by
rewriting leases and then call the result a natural-expiry test.

The database network is private. Only the edge service is published, at
`127.0.0.1:58089`; a second ingress network is needed for Docker29 port publishing.
Deno still permits outbound fetch only to the fixed internal PostgREST service.
The gateway requires a disposable service-role JWT and dedicated producer token.
It is a self-hosted authentication adapter, not the Supabase cloud gateway.

Optional settlement-failure test after the successful main campaign:

```sh
printf 'HALO_SHADOW_TEST_DROP_SETTLEMENT=true\n' >> "$HALO_STATE_DIR/private.env"
docker compose --env-file "$HALO_STATE_DIR/private.env" -p "$HALO_PROJECT" -f tools/halo-shadow/compose.yml up -d --no-deps edge
docker compose --env-file "$HALO_STATE_DIR/private.env" -p "$HALO_PROJECT" -f tools/halo-shadow/compose.yml run --rm --no-deps exercise node tools/halo-shadow/fault.mjs
```

This adds one separate synthetic run, drops settlement before forwarding, and
checks retained uncertainty/no replay after natural expiry. It does not model a
real provider timeout or real charge. It preserves the main-campaign history.

Results are sanitized JSON in the private artifact directory. Containers write
mode0600 files as root; use the same trusted Node image to read them without
changing broader host permissions:

```sh
docker run --rm --network none -v "$HALO_STATE_DIR/artifacts:/artifacts:ro" node:22.23.3-bookworm-slim cat /artifacts/result.json
```

Always collect evidence and clean up, including when a test fails:

```sh
docker compose --env-file "$HALO_STATE_DIR/private.env" -p "$HALO_PROJECT" -f tools/halo-shadow/compose.yml down --volumes --remove-orphans
rm -- "$HALO_STATE_DIR/private.env"
```

Only these disposable volumes may be removed. Keep sanitized results as needed,
then release the machine reservation. Do not leave this temporary service on a
shared machine after releasing its exclusive lease. No persistent service,
firewall change, global package installation, or cloud project is required.


## Optional actual-model SQL smoke

The separate `paid-smoke-compose.yml` adds a one-shot Deno CLI, not an HTTP
service or scheduler. The original synthetic edge service remains synthetic.
`paid-smoke-prepare.mjs prepare` runs through the existing exercise container
against a fresh disposable database and creates four sorted public development
candidates, a one-second setup lease, a private exact-request plan and service JWT.
Run setup as the host UID/GID so its mode0600 artifacts remain privately readable
by the host's Compose client. Wait for natural setup-lease expiry and PostgREST
schema reload before any paid dispatch.

This child does **not** verify the external campaign ledger. The parent must
independently rebuild/check the plan's exact request hash, refresh pricing/ZDR
and funding, reserve/count that request in the existing shared pilot ledger,
and durably mark it dispatched before launching the child. An attempt-ID string
is correlation, not proof of authorization. Provide only that ID, the fixed
plan/service JWT and API key in a separate mode0600 `HALO_PAID_ENV_FILE`; never
put the key in command arguments, Git, reports or an image. No automatic retry.

Invoke the profile-gated `paid-smoke` service once with both Compose files and
`run --rm --no-deps`; its Deno permissions allow only internal PostgREST and
OpenRouter. The shared producer runtime binds the effective provider identity,
ZDR policy, batch size and transport settings. Exactly four frozen candidates
allow only one paid batch. Repeated triggers remain busy, complete without a
model request, or stop on uncertainty. Inspect through
`paid-smoke-prepare.mjs inspect`; settle the same actual charge in the parent's
ledger only after checking the durable SQL audit. Unknown outcomes keep the
parent hold even if the CLI process exits. Cleanup both private env files, the
owned stack/volume and machine reservation after collecting sanitized evidence.

All examples require fresh disposable runs. Existing experimental runs bound
without the new immutable batch/provider fields intentionally reject an upgraded
binding; this workflow performs no implicit migration or production activation.


November 16 execution: the generic CLI completed a four-candidate paid SQL-backed
smoke with GPT-oss-120B/Groq on source commit `4dfbbf2`. Exactly one model POST and
one SQL attempt settled at 0.00049965 USD, with provider/model/native usage audited.
An overlapping trigger was busy with zero model calls. After the 120-second lease
expired naturally, a completion-only invocation reached complete with zero further
calls. No publication/inbox rows appeared. Both owned test stacks, volumes,
networks and runtime API/JWT env files were removed; the reservation was released.
The preceding Gemma timeout and its retained uncertainty were archived honestly.
See `docs/evidence/2026-11-16-strix-halo-paid/` for sanitized evidence and limits.
