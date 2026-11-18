begin;
CREATE OR REPLACE FUNCTION shadow_agent.pipeline_enqueue(p_stage text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 bucket:=(case when p_stage='collect' then date_trunc('hour',stamp at time zone 'utc')+floor(extract(minute from stamp at time zone 'utc')/30)*interval '30 minutes' else date_trunc('minute',stamp at time zone 'utc') end) at time zone 'utc';
 if exists(select 1 from shadow_agent.pipeline_dispatch_slots s where s.stage=p_stage and s.slot>=bucket
  and not (p_stage='agent' and exists(select 1 from net._http_response r where r.id=s.request_id and r.status_code is not null and not coalesce(r.timed_out,false))
   and exists(select 1 from shadow_agent.pipeline_dispatch_slots c where c.stage='collect' and c.completed_at>s.queued_at))
   and not (p_stage in ('curate','publish') and exists(select 1 from net._http_response r where r.id=s.request_id
    and r.status_code is not null and not coalesce(r.timed_out,false)))) then return null;end if;
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
 on conflict(stage) do update set slot=excluded.slot,queued_at=excluded.queued_at,request_id=excluded.request_id,legacy_job_id=null,legacy_run_id=null,completed_at=null;
 return request_id;
exception when others then
 -- No SQLERRM/body/credential logging; next tick sees the original durable queue.
 return null;
end $function$

commit;
