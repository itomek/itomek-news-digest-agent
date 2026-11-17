-- Private single-tick dispatcher. No schedules, activation, secrets or budgets created.
-- Required: existing reviewed protected routes, Vault, pg_net and alerting_enqueue.
-- pg_net starts HTTP after transaction commit; safe durable queue writes survive enqueue errors.
begin;
do $$begin
 if (select count(*) from pg_catalog.pg_extension where extname in ('pg_net','supabase_vault')) <> 2
 or to_regprocedure('shadow_agent.alerting_enqueue()') is null
 or to_regclass('shadow_agent.scheduler_settings') is null then raise exception 'Reviewed pipeline prerequisites required';end if;
end $$;
create table shadow_agent.pipeline_dispatch_slots(
 stage text primary key check(stage in ('collect','agent','curate','publish')),
 slot timestamptz not null,queued_at timestamptz not null,request_id bigint,
 -- Owner may seed only a real legacy collector enqueue, never pretend it is coverage.
 legacy_job_id bigint,legacy_run_id bigint,
 check((request_id is not null and legacy_job_id is null and legacy_run_id is null)
  or (stage='collect' and request_id is null and legacy_job_id is not null and legacy_job_id=3 and legacy_run_id is not null)),
 check(slot=date_trunc(case when stage='collect' then 'hour' else 'minute' end,queued_at at time zone 'utc') at time zone 'utc')
);
alter table shadow_agent.pipeline_dispatch_slots enable row level security;
revoke all on shadow_agent.pipeline_dispatch_slots from public,anon,authenticated,service_role;
create function shadow_agent.pipeline_enqueue(p_stage text) returns bigint
language plpgsql security definer set search_path='' as $$
declare stamp timestamptz:=clock_timestamp();bucket timestamptz;origin text;gateway text;token text;secret_name text;route text;n integer;request_id bigint;
begin
 if not coalesce((select enabled from shadow_agent.producer_settings where singleton),false) then return null;end if;
 if p_stage is null or p_stage not in ('collect','agent','curate','publish') then raise exception 'Invalid pipeline stage';end if;
 -- Never wait while a queue writer holds other story/account locks.
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('warpcore_pipeline_'||p_stage,0)) then return null;end if;
 -- Edge/PDS work can outlive a minute or the scheduler's HTTP acknowledgement.
 -- Hold overlap until beyond Edge150s; then normal leased reconciliation may recover.
 if p_stage in ('curate','publish') and exists(
  select 1 from shadow_agent.pipeline_dispatch_slots s left join net._http_response r on r.id=s.request_id
  where s.stage=p_stage and s.queued_at>stamp-interval '180 seconds'
  and (r.id is null or r.timed_out is true or r.status_code is null)
 ) then return null;end if;
 bucket:=date_trunc(case when p_stage='collect' then 'hour' else 'minute' end,stamp at time zone 'utc') at time zone 'utc';
 if exists(select 1 from shadow_agent.pipeline_dispatch_slots where stage=p_stage and slot>=bucket) then return null;end if;
 if p_stage='agent' then
  request_id:=shadow_agent.alerting_enqueue();
 else
  select approved_project_origin into origin from shadow_agent.scheduler_settings where singleton;
  if origin is distinct from 'https://eedfyviypptfpghyffip.supabase.co' then raise exception 'Invalid pipeline configuration';end if;
  select count(*),min(decrypted_secret) into n,gateway from vault.decrypted_secrets where name='warpcore_gateway_anon_jwt';
  if n<>1 or gateway is null or length(gateway) not between 32 and 4096 or gateway ~ '[[:space:]]' then raise exception 'Invalid pipeline configuration';end if;
  secret_name:=case when p_stage='collect' then 'warpcore_collect_cron_token' else 'warpcore_publish_cron_token' end;
  select count(*),min(decrypted_secret) into n,token from vault.decrypted_secrets where name=secret_name;
  if n<>1 or token is null or length(token) not between 32 and 4096 or token ~ '[[:space:]]' or token=gateway then raise exception 'Invalid pipeline configuration';end if;
  route:=case p_stage when 'collect' then 'news-collect' when 'curate' then 'news-curate' when 'publish' then 'news-publish' end;
  request_id:=net.http_post(url:=origin||'/functions/v1/'||route,body:='{}'::jsonb,params:='{}'::jsonb,
   headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||gateway,'x-warpcore-token',token),timeout_milliseconds:=120000);
 end if;
 if request_id is null then return null;end if;
 insert into shadow_agent.pipeline_dispatch_slots(stage,slot,queued_at,request_id) values(p_stage,bucket,stamp,request_id)
 on conflict(stage) do update set slot=excluded.slot,queued_at=excluded.queued_at,request_id=excluded.request_id,legacy_job_id=null,legacy_run_id=null;
 return request_id;
exception when others then
 -- No SQLERRM/body/credential logging; next tick sees the original durable queue.
 return null;
end $$;
create function shadow_agent.pipeline_collection_pending() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from shadow_agent.pipeline_dispatch_slots s where stage='collect' and request_id is not null
 and queued_at<=clock_timestamp() and queued_at>clock_timestamp()-interval '180 seconds'
 and not exists(select 1 from net._http_response r where r.id=s.request_id))
$$;
create function shadow_agent.pipeline_queue_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='warpcore_curator_inbox' then
  if new.actor_kind='agent' and new.state='pending' then perform shadow_agent.pipeline_enqueue('curate');end if;
 elsif new.state='prepared' and new.approved_at is not null and new.account_did='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk' then
  perform shadow_agent.pipeline_enqueue('publish');
 end if;
 return new;
exception when others then return new;
end $$;
create trigger warpcore_pipeline_curate_after_insert after insert on public.warpcore_curator_inbox
 for each row execute function shadow_agent.pipeline_queue_changed();
create trigger warpcore_pipeline_publish_after_approval after insert or update of state,approved_at on public.warpcore_publications
 for each row execute function shadow_agent.pipeline_queue_changed();
create function shadow_agent.pipeline_tick() returns void
language plpgsql security definer set search_path='' as $$
begin
 perform shadow_agent.pipeline_enqueue('collect');
 perform shadow_agent.pipeline_enqueue('agent');
 if exists(select 1 from public.warpcore_curator_inbox where state='pending' or (state='leased' and lease_expires_at<=clock_timestamp())) then
  perform shadow_agent.pipeline_enqueue('curate');end if;
 if exists(select 1 from public.warpcore_publications where account_did='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk' and approved_at is not null and state in ('prepared','sending','uncertain')) then
  perform shadow_agent.pipeline_enqueue('publish');end if;
end $$;
revoke all on function shadow_agent.pipeline_enqueue(text),shadow_agent.pipeline_collection_pending(),shadow_agent.pipeline_queue_changed(),shadow_agent.pipeline_tick() from public,anon,authenticated,service_role;
commit;
