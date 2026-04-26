-- 0001_init.sql — News Digest Agent schema + RLS.
-- Source of truth: docs/architecture.md §3.1.

create table digest_topics (
  id serial primary key,
  name text not null,
  slug text not null unique,
  cadence text not null check (cadence in ('24h', '7d')),
  sources jsonb not null,
  prompt_hint text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table digests (
  id uuid primary key default gen_random_uuid(),
  topic_slug text not null references digest_topics(slug),
  content text not null,
  cadence text not null,
  digest_date date not null,
  sources_used jsonb not null,
  token_count integer,
  prompt_version text not null,
  created_at timestamptz not null default now(),
  unique (topic_slug, digest_date)
);

create index digests_topic_date_idx on digests (topic_slug, digest_date desc);

create table system_logs (
  id uuid primary key default gen_random_uuid(),
  timestamp timestamptz not null default now(),
  level text not null check (level in ('info', 'warn', 'error')),
  category text not null,
  topic_slug text,
  message text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index system_logs_created_category_idx
  on system_logs (created_at desc, category);

-- Row-level security.
-- anon: read-only on digests, enabled topics, and logs.
-- service_role: full access (used only by the agent process).

alter table digest_topics enable row level security;
alter table digests enable row level security;
alter table system_logs enable row level security;

create policy digest_topics_anon_read
  on digest_topics for select
  to anon
  using (enabled);

create policy digests_anon_read
  on digests for select
  to anon
  using (true);

create policy system_logs_anon_read
  on system_logs for select
  to anon
  using (true);

-- service_role bypasses RLS automatically in Supabase, so no explicit policy
-- is needed for it. No INSERT/UPDATE/DELETE policies for anon by design.
