# Supabase migrations & functions

Schema and seed SQL for the News Digest Agent's Supabase project, plus Edge Functions. The schema lives in `docs/architecture.md §3.1`; this directory exists so it can be applied repeatably and tracked in git.

## Files

- `migrations/0001_init.sql` — `digest_topics`, `digests`, `system_logs`, indexes, and RLS.
- `migrations/0002_seed_ai_models_topic.sql` — first row of `digest_topics` (`ai_models`).
- `functions/tts/` — Edge Function proxying Google Cloud TTS behind an OpenAI-style speech API for digest playback (#63). Deploy with `supabase functions deploy tts` (JWT verification on, the default) and set the secret: `supabase secrets set GOOGLE_TTS_API_KEY=...` — the key is never committed. Point the web app at it via `VITE_TTS_NEURAL_URL=https://<project>.supabase.co/functions/v1/tts`.

## Applying via the dashboard SQL editor

Quickest path for a fresh project:

1. Open the Supabase project dashboard.
2. SQL editor → new query → paste `0001_init.sql` → run.
3. Repeat for `0002_seed_ai_models_topic.sql`.
4. Verify the row exists: `select slug, cadence, enabled from digest_topics;`.

## Applying via the Supabase CLI

If you have the [Supabase CLI](https://supabase.com/docs/guides/cli) installed and the project linked:

```bash
supabase db push
```

This applies every file in `migrations/` in lexical order. Re-running is safe — `0002` is `on conflict do nothing`.

## Smoke verifying RLS and the logging path

Once `.env` has the project credentials, the already-implemented logging envelope is the simplest end-to-end check:

```bash
python -c "from news_digest.logging import log; log('info', 'system', 'supabase smoke')"
```

Then in the SQL editor:

```sql
select created_at, category, message
from system_logs
where category = 'system'
order by created_at desc
limit 5;
```

A row in the last few seconds confirms the service-role key, network path, and table all work.
