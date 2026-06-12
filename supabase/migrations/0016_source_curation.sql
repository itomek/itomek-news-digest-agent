-- 0016_source_curation.sql
-- Autonomous source curation (issue #98).
-- NOTE: migration prefixes 0006 and 0015 are each duplicated in history; 0016 is the next free number.
-- digest_topics.sources jsonb gains optional per-source keys (no DDL — schemaless):
--   enabled(bool, default true), disabled_reason(text), disabled_at(ts),
--   added_by('human'|'curator'|'human-approved'), replaces(url), discovered_at(ts).

create table if not exists source_candidates (
  id              uuid primary key default gen_random_uuid(),
  topic_slug      text not null,
  url             text not null,
  type            text not null check (type in ('rss','html')),
  replaces_url    text,
  failure_class   text check (failure_class in ('dead','blocked')),
  relevance_score numeric,
  validation      jsonb,
  status          text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz
);

-- at most one pending candidate per (topic, url)
create unique index if not exists source_candidates_pending_uq
  on source_candidates (topic_slug, url) where status = 'pending';
create index if not exists source_candidates_status_idx
  on source_candidates (status, created_at desc);

alter table source_candidates enable row level security;

-- authenticated SELECT (mirrors 0006 read policies); no direct write policy
create policy source_candidates_authenticated_read
  on source_candidates for select to authenticated using (true);

-- Approve: append candidate to the topic's sources (enabled, provenance) + mark approved.
create or replace function public.approve_source_candidate(candidate_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare cand source_candidates%rowtype; new_source jsonb;
begin
  select * into cand from source_candidates where id = candidate_id and status = 'pending';
  if not found then raise exception 'candidate % not found or not pending', candidate_id; end if;

  -- idempotency: only append if the url isn't already present in sources
  if not exists (
    select 1 from digest_topics t,
      lateral jsonb_array_elements(t.sources) s
     where t.slug = cand.topic_slug and s->>'url' = cand.url
  ) then
    new_source := jsonb_build_object(
      'type', cand.type, 'url', cand.url, 'enabled', true,
      'added_by', 'human-approved', 'replaces', cand.replaces_url,
      'discovered_at', to_char(cand.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    update digest_topics set sources = sources || jsonb_build_array(new_source)
     where slug = cand.topic_slug;
  end if;

  update source_candidates set status = 'approved', decided_at = now() where id = candidate_id;
end; $$;

-- Reject: mark rejected; failing source stays quarantined; slot re-discoverable after cooldown.
create or replace function public.reject_source_candidate(candidate_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update source_candidates set status = 'rejected', decided_at = now()
   where id = candidate_id and status = 'pending';
  if not found then raise exception 'candidate % not found or not pending', candidate_id; end if;
end; $$;

revoke execute on function public.approve_source_candidate(uuid) from anon, public;
revoke execute on function public.reject_source_candidate(uuid) from anon, public;
grant  execute on function public.approve_source_candidate(uuid) to authenticated;
grant  execute on function public.reject_source_candidate(uuid)  to authenticated;
