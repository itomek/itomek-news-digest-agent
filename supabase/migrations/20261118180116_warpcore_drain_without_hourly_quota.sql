begin;
alter table public.warpcore_login_slots drop constraint warpcore_login_slots_attempts_check;
alter table public.warpcore_login_slots alter column attempts type integer;
alter table public.warpcore_login_slots add constraint warpcore_login_slots_attempts_check check(attempts>=1);
alter table public.warpcore_publication_slots drop constraint warpcore_publication_slots_attempts_check;
alter table public.warpcore_publication_slots alter column attempts type integer;
alter table public.warpcore_publication_slots add constraint warpcore_publication_slots_attempts_check check(attempts>=1);
CREATE OR REPLACE FUNCTION public.warpcore_reserve_login(p_account text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 insert into public.warpcore_login_slots(account_did,hour_slot,attempts)
 values(p_account,floor(extract(epoch from clock_timestamp())/3600)::bigint,1)
 on conflict(account_did) do update
 set hour_slot=excluded.hour_slot,
 attempts=case when public.warpcore_login_slots.hour_slot<excluded.hour_slot then 1 else public.warpcore_login_slots.attempts+1 end,
 reserved_at=clock_timestamp()
 where public.warpcore_login_slots.hour_slot<excluded.hour_slot
 or (public.warpcore_login_slots.hour_slot=excluded.hour_slot);
 return found;
end;$function$;
CREATE OR REPLACE FUNCTION public.warpcore_claim_publication(p_account text, p_story text, p_hash text, p_record jsonb)
 RETURNS SETOF public.warpcore_publications
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
 or (public.warpcore_publication_slots.hour_slot=excluded.hour_slot);
 if not found then return;end if;
 -- A failed/uncertain network write retains this attempt. Reconciliation never reclaims it.
 return query update public.warpcore_publications p set state='sending'
 where p.account_did=p_account and p.story_key=p_story returning p.*;
end;$function$;
commit;
