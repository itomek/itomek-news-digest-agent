# Latest validation results

Supersedes earlier notes that PostgREST or real multi-session validation was unavailable.

Commit tested: `c419956e14d6eb7100dd90c64f978d304bda8c85`.
Run: https://github.com/itomek/itomek-news-digest-agent/actions/runs/43242316376

All passed on standard public-repository ubuntu-24.04 CI:
- 58 Node tests, with mocked external API transport.
- PGlite schema/approval/dedup/access integration.
- Real PostgreSQL 17.6 independent-session row-lock contention: exactly one claimant.
- Real PostgREST 12.2.3: RPC input/output mapping, embedded relationship/approved queue filters, exact-record approval, atomic claims, guarded state transitions, and anonymous table/approval denial.
- Disposable service containers stopped successfully.

Earlier Deno tests and checks passed locally. Legacy Python lint/format/unit CI passed on the earlier implementation; the concurrent legacy run for this exact commit was still installing dependencies when this report was recorded.

CI contains only disposable fixture passwords/JWT signing material, no Supabase or Bluesky credentials. No publisher runs against real services. Supabase remains the intended application runtime, not GitHub Actions. The live Supabase project is unchanged except for the previously verified permanently inert smoke endpoint. TTS and existing schedules remain unchanged.

This validates a functional review/publishing base, not a deployed news service. Production migrations/deployment, secure session provisioning, operator approval access, source/editorial scope, additional adapters and any automated summarization remain separate launch steps. No sources, topics or model have been selected and no public posts have been made.
