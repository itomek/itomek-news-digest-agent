-- Server-only frozen review snapshots. No operator identities or sources seeded.
create table public.warpcore_reviews (
 id uuid primary key default gen_random_uuid(),
 content_hash text not null,
 packet jsonb not null,
 job jsonb not null,
 state text not null default 'pending' check(state in ('pending','approved','rejected')),
 revision integer not null default 0,
 created_at timestamptz not null default now(),
 reviewer_id uuid,
 reviewed_at timestamptz
);
create unique index warpcore_one_pending_review on public.warpcore_reviews ((job->>'accountDid'),(job->>'storyKey')) where state='pending';
alter table public.warpcore_reviews enable row level security;
revoke all on public.warpcore_reviews from public,anon,authenticated;
grant select,insert,update on public.warpcore_reviews to service_role;
create function public.warpcore_review_snapshot_immutable() returns trigger
language plpgsql security invoker set search_path='' as $fn$
begin
 if new.packet is distinct from old.packet or new.job is distinct from old.job or new.content_hash is distinct from old.content_hash
 then raise exception 'Review snapshot is immutable';end if;
 return new;
end;
$fn$;
create trigger warpcore_review_snapshot_immutable before update on public.warpcore_reviews
for each row execute function public.warpcore_review_snapshot_immutable();
revoke all on function public.warpcore_review_snapshot_immutable() from public,anon,authenticated;
create function public.warpcore_decide_review(p_id uuid,p_hash text,p_revision integer,p_reviewer uuid,p_approve boolean)
returns boolean language plpgsql security invoker set search_path='' as $fn$
declare r public.warpcore_reviews;
begin
 if p_reviewer is null or p_approve is null then return false;end if;
 update public.warpcore_reviews set state=case when p_approve then 'approved' else 'rejected' end,
 revision=revision+1,reviewer_id=p_reviewer,reviewed_at=now()
 where id=p_id and content_hash=p_hash and revision=p_revision and state='pending'
 returning * into r;
 if not found then return false;end if;
 if p_approve then
  if not public.warpcore_prepare_publication(r.job->>'accountDid',r.job->>'storyKey',r.job->>'contentHash',r.job->'record',r.job->>'recordKey') then raise exception 'Publication preparation conflict';end if;
  if not public.warpcore_review_publication(r.job->>'accountDid',r.job->>'storyKey',r.job->>'contentHash',r.job->'record',true) then raise exception 'Publication approval conflict';end if;
 end if;
 return true;
end;
$fn$;
revoke all on function public.warpcore_decide_review(uuid,text,integer,uuid,boolean) from public,anon,authenticated;
grant execute on function public.warpcore_decide_review(uuid,text,integer,uuid,boolean) to service_role;
