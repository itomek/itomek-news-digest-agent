-- Durable one-attempt-per-UTC-hour reservation. Failed/uncertain logins consume the slot.
create table public.warpcore_login_slots (
 account_did text primary key check(account_did ~ '^did:plc:[a-z2-7]{24}$'),
 hour_slot bigint not null,
 reserved_at timestamptz not null default clock_timestamp()
);
alter table public.warpcore_login_slots enable row level security;
revoke all on public.warpcore_login_slots from public,anon,authenticated;
grant select,insert,update on public.warpcore_login_slots to service_role;
create function public.warpcore_reserve_login(p_account text) returns boolean
language plpgsql security invoker set search_path='' as $fn$
begin
 insert into public.warpcore_login_slots(account_did,hour_slot)
 values(p_account,floor(extract(epoch from clock_timestamp())/3600)::bigint)
 on conflict(account_did) do update set hour_slot=excluded.hour_slot,reserved_at=clock_timestamp()
 where public.warpcore_login_slots.hour_slot<excluded.hour_slot;
 return found;
end;$fn$;
revoke all on function public.warpcore_reserve_login(text) from public,anon,authenticated;
grant execute on function public.warpcore_reserve_login(text) to service_role;
