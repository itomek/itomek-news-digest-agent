-- Actual publication-attempt guard, independent of the session/login budget.
-- One prepared -> sending transition per account per UTC calendar hour.
-- Failed or uncertain sends consume their slot. No-op/replay claims do not.
create table public.warpcore_publication_slots (
 account_did text primary key,
 hour_slot bigint not null,
 reserved_at timestamptz not null default clock_timestamp()
);
alter table public.warpcore_publication_slots enable row level security;
revoke all on public.warpcore_publication_slots from public,anon,authenticated;
grant select,insert,update on public.warpcore_publication_slots to service_role;

create or replace function public.warpcore_claim_publication(p_account text,p_story text,p_hash text,p_record jsonb)
returns setof public.warpcore_publications language plpgsql security invoker set search_path='' as $fn$
declare
 candidate public.warpcore_publications%rowtype;
 slot bigint;
begin
 -- Lock and recheck the exact eligible row before spending an account slot.
 select p.* into candidate from public.warpcore_publications p
 where p.account_did=p_account and p.story_key=p_story
 and p.content_hash=p_hash and p.record_payload=p_record and p.state='prepared' and p.approved_at is not null
 and exists(select 1 from public.warpcore_stories s where s.story_key=p_story and s.status='approved')
 for update of p;
 if not found then return; end if;
 slot := floor(extract(epoch from clock_timestamp())/3600)::bigint;
 -- Unique account row serializes different stories even across worker instances.
 insert into public.warpcore_publication_slots(account_did,hour_slot)
 values(p_account,slot)
 on conflict(account_did) do update set hour_slot=excluded.hour_slot,reserved_at=clock_timestamp()
 where public.warpcore_publication_slots.hour_slot<excluded.hour_slot;
 if not found then return; end if;
 -- Slot reservation and transition commit together before any remote write.
 return query update public.warpcore_publications p set state='sending'
 where p.account_did=p_account and p.story_key=p_story returning p.*;
end;
$fn$;
revoke all on function public.warpcore_claim_publication(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.warpcore_claim_publication(text,text,text,jsonb) to service_role;
