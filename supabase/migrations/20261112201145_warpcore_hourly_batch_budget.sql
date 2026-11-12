-- Bounded batches: at most five approved publication attempts per account/UTC hour.
-- Existing consumed slots start at one; no hour, timestamp, publication or login state reset.
alter table public.warpcore_publication_slots
 add column attempts smallint not null default 1 check(attempts between 1 and 5);

create or replace function public.warpcore_claim_publication(p_account text,p_story text,p_hash text,p_record jsonb)
returns setof public.warpcore_publications language plpgsql security invoker set search_path='' as $fn$
declare candidate public.warpcore_publications%rowtype;slot bigint;
begin
 -- Exact immutable approved record must be eligible before spending any budget.
 select p.* into candidate from public.warpcore_publications p
 where p.account_did=p_account and p.story_key=p_story
 and p.content_hash=p_hash and p.record_payload=p_record and p.state='prepared' and p.approved_at is not null
 and exists(select 1 from public.warpcore_stories s where s.story_key=p_story and s.status='approved')
 for update of p;
 if not found then return;end if;
 slot:=floor(extract(epoch from clock_timestamp())/3600)::bigint;
 -- The account PK conflict lock serializes competing claims for distinct stories.
 insert into public.warpcore_publication_slots(account_did,hour_slot,attempts)
 values(p_account,slot,1)
 on conflict(account_did) do update
 set hour_slot=excluded.hour_slot,
 attempts=case when public.warpcore_publication_slots.hour_slot<excluded.hour_slot then 1 else public.warpcore_publication_slots.attempts+1 end,
 reserved_at=clock_timestamp()
 where public.warpcore_publication_slots.hour_slot<excluded.hour_slot
 or (public.warpcore_publication_slots.hour_slot=excluded.hour_slot and public.warpcore_publication_slots.attempts<5);
 if not found then return;end if;
 -- A failed/uncertain network write retains this attempt. Reconciliation never reclaims it.
 return query update public.warpcore_publications p set state='sending'
 where p.account_did=p_account and p.story_key=p_story returning p.*;
end;$fn$;
revoke all on function public.warpcore_claim_publication(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.warpcore_claim_publication(text,text,text,jsonb) to service_role;
