-- At most five login attempts per account/UTC hour. Failed logins consume one.
-- Preserve every already-used hour, account and timestamp as one consumed attempt.
alter table public.warpcore_login_slots
 add column attempts smallint not null default 1 check(attempts between 1 and 5);
create or replace function public.warpcore_reserve_login(p_account text) returns boolean
language plpgsql security invoker set search_path='' as $fn$
begin
 insert into public.warpcore_login_slots(account_did,hour_slot,attempts)
 values(p_account,floor(extract(epoch from clock_timestamp())/3600)::bigint,1)
 on conflict(account_did) do update
 set hour_slot=excluded.hour_slot,
 attempts=case when public.warpcore_login_slots.hour_slot<excluded.hour_slot then 1 else public.warpcore_login_slots.attempts+1 end,
 reserved_at=clock_timestamp()
 where public.warpcore_login_slots.hour_slot<excluded.hour_slot
 or (public.warpcore_login_slots.hour_slot=excluded.hour_slot and public.warpcore_login_slots.attempts<5);
 return found;
end;$fn$;
revoke all on function public.warpcore_reserve_login(text) from public,anon,authenticated;
grant execute on function public.warpcore_reserve_login(text) to service_role;
