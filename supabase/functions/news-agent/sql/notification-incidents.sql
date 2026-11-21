-- Optional reviewed install extension. No credentials or provider text is stored.
-- Defaults: reminder 24h, failed/uncertain retry 15m, claim lease 1m.
begin;
create schema if not exists warpcore_private;
revoke all on schema warpcore_private from public,anon,authenticated;
create table if not exists warpcore_private.notification_incidents (
 id bigint generated always as identity primary key,
 domain text not null check(domain in ('source','verification','discovery','worker')),
 entity text not null check(entity ~ '^[A-Za-z0-9_:-]{1,128}$'),
 configuration text not null check(configuration ~ '^[A-Za-z0-9_:-]{1,96}$'),
 class text not null check(class ~ '^[a-z][a-z0-9_]{0,63}$'),
 generation bigint not null default 1, active boolean not null default true,
 first_observed_at timestamptz not null default now(),last_observed_at timestamptz not null default now(), recovered_at timestamptz,
 event text not null default 'opened' check(event in ('opened','reminder','recovered')),
 last_sent_at timestamptz,next_attempt_at timestamptz not null default now(),
 claim_token uuid,claim_until timestamptz,
 unique(domain,entity,configuration,class)
);
alter table warpcore_private.notification_incidents enable row level security;
revoke all on warpcore_private.notification_incidents from public,anon,authenticated,service_role;
create or replace function public.warpcore_notification_observe(p_domain text,p_entity text,p_configuration text,p_classes jsonb,p_resolved jsonb default '[]') returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare c text;
begin
 if p_domain not in ('source','verification','discovery','worker') or p_entity !~ '^[A-Za-z0-9_:-]{1,128}$' or p_configuration !~ '^[A-Za-z0-9_:-]{1,96}$' or jsonb_typeof(p_classes) is distinct from 'array' or jsonb_typeof(p_resolved) is distinct from 'array' or jsonb_array_length(p_classes)>32 or jsonb_array_length(p_resolved)>32 then raise exception 'Invalid observation';end if;
 for c in select jsonb_array_elements_text(p_classes || p_resolved) loop
 if c !~ '^(source_http_error|source_http_[1-5][0-9]{2}|source_timeout|source_network|source_content_type|source_body_limit|source_parse_failed|source_or_persistence_failed|malformed_source_dates|source_head_stale|invalid_configuration|claim_unavailable|invalid_claim|handoff_deferred|handoff_unconfirmed|invalid_handoff_claim|finish_unconfirmed|history_lock_contention|evidence_or_history_unavailable|reservation_unconfirmed|dispatch_unconfirmed|settlement_unconfirmed|billed_invalid_completion|paid_outcome_unknown|receipt_unconfirmed|verification_quote_missing|verification_source_hash_mismatch|verification_date_invalid|verification_claim_coverage_missing|verification_post_unpublishable|agent_run_failed|hosted_agent_unavailable)$' then raise exception 'Invalid class';end if;
 end loop;
 -- Keep admission bounded, without deleting active or uncertain records.
 perform pg_advisory_xact_lock(165194);
 delete from warpcore_private.notification_incidents where not active and (claim_until is null or claim_until<now()) and recovered_at<now()-interval '90 days';
 if (select count(*) from warpcore_private.notification_incidents)+(select count(distinct x.c) from jsonb_array_elements_text(p_classes) x(c) where not exists(select 1 from warpcore_private.notification_incidents i where i.domain=p_domain and i.entity=p_entity and i.configuration=p_configuration and i.class=x.c))>10000 then raise exception 'Notification capacity reached';end if;
 -- Explicitly scoped successes only; an absent source/class is never recovery.
 update warpcore_private.notification_incidents set active=false,recovered_at=now(),last_observed_at=now(),event='recovered',next_attempt_at=now(),claim_token=null,claim_until=null
 where domain=p_domain and entity=p_entity and configuration=p_configuration and active and p_resolved ? class and not(p_classes ? class);
 for c in select jsonb_array_elements_text(p_classes) loop
 insert into warpcore_private.notification_incidents(domain,entity,configuration,class) values(p_domain,p_entity,p_configuration,c)
 on conflict(domain,entity,configuration,class) do update set
 last_observed_at=now(),active=true,
 generation=notification_incidents.generation+case when notification_incidents.active then 0 else 1 end,
 first_observed_at=case when notification_incidents.active then notification_incidents.first_observed_at else now() end,
 recovered_at=null,event=case when notification_incidents.active then notification_incidents.event else 'opened' end,
 last_sent_at=case when notification_incidents.active then notification_incidents.last_sent_at else null end,
 next_attempt_at=case when notification_incidents.active then notification_incidents.next_attempt_at else now() end,
 claim_token=case when notification_incidents.active then notification_incidents.claim_token else null end,
 claim_until=case when notification_incidents.active then notification_incidents.claim_until else null end;
 end loop;
 return true;
end $$;
create or replace function public.warpcore_notification_observe_batch(p_observations jsonb) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare o jsonb;
begin
 if jsonb_typeof(p_observations) is distinct from 'array' or jsonb_array_length(p_observations)>96 or octet_length(p_observations::text)>100000 then raise exception 'Invalid observation batch';end if;
 for o in select jsonb_array_elements(p_observations) loop
  if jsonb_typeof(o) is distinct from 'object' or (select count(*) from jsonb_object_keys(o))<>5 then raise exception 'Invalid observation';end if;
  perform public.warpcore_notification_observe(o->>'domain',o->>'entity',o->>'configuration',o->'classes',o->'resolved');
 end loop;
 return true;
end $$;
revoke all on function public.warpcore_notification_observe_batch(jsonb) from public,anon,authenticated;
grant execute on function public.warpcore_notification_observe_batch(jsonb) to service_role;
create or replace function public.warpcore_notification_claim() returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare r warpcore_private.notification_incidents; token uuid:=gen_random_uuid();
begin
 select * into r from warpcore_private.notification_incidents where next_attempt_at<=now() and (claim_until is null or claim_until<=now()) order by next_attempt_at,id for update skip locked limit 1;
 if not found then return null;end if;
 update warpcore_private.notification_incidents set claim_token=token,claim_until=now()+interval '1 minute',next_attempt_at=now()+interval '15 minutes' where id=r.id;
 return jsonb_build_object('id',r.id,'token',token,'domain',r.domain,'entity',r.entity,'class',r.class,'event',r.event,'generation',r.generation);
end $$;
create or replace function public.warpcore_notification_ack(p_id bigint,p_token uuid,p_status text) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if p_status not in ('sent','failed','timeout') then raise exception 'Invalid acknowledgment';end if;
 update warpcore_private.notification_incidents set claim_token=null,claim_until=null,
 last_sent_at=case when p_status='sent' then now() else last_sent_at end,
 next_attempt_at=case when p_status='sent' then case when active then now()+interval '24 hours' else 'infinity'::timestamptz end else now()+interval '15 minutes' end,
 event=case when p_status='sent' and active then 'reminder' else event end
 where id=p_id and claim_token=p_token and claim_until>now();
 return found;
end $$;
revoke all on function public.warpcore_notification_observe(text,text,text,jsonb,jsonb),public.warpcore_notification_claim(),public.warpcore_notification_ack(bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.warpcore_notification_observe(text,text,text,jsonb,jsonb),public.warpcore_notification_claim(),public.warpcore_notification_ack(bigint,uuid,text) to service_role;
commit;
