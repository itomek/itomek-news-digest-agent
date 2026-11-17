-- Administrative, manually reviewed installer. Never part of normal migrations.
-- Requires already reviewed extensions; does not install extensions or budgets.
begin;
do $$
begin
 if (select count(*) from pg_catalog.pg_extension where extname in ('pg_cron','pg_net','supabase_vault')) <> 3 then
  raise exception 'Reviewed scheduler extensions required';
 end if;
 if to_regclass('shadow_agent.producer_settings') is null or
    to_regclass('shadow_agent.ranking_runs') is null or
    to_regclass('shadow_agent.selection_items') is null then
  raise exception 'Installed shadow ranking/producer contracts required';
 end if;
 if exists(select 1 from cron.job where jobname='warpcore-news-agent-continuation') then
  raise exception 'Continuation schedule already installed';
 end if;
 -- Managed Supabase grants service_role Vault access and PUBLIC cron EXECUTE.
 -- service_role is trusted server code, never an unprivileged/model identity.
 -- Preserve vendor ACLs; reject effective client access and worker cron access.
 if exists(select 1 from pg_roles r where
   (r.rolname in ('anon','authenticated') and
    has_schema_privilege(r.rolname,'vault','usage') and
    has_table_privilege(r.rolname,'vault.decrypted_secrets','select')) or
   (r.rolname in ('anon','authenticated','service_role') and
    has_schema_privilege(r.rolname,'cron','usage') and
    (has_table_privilege(r.rolname,'cron.job','update') or
     has_function_privilege(r.rolname,'cron.schedule(text,text,text)','execute')))) then
  raise exception 'Scheduler administrative privileges require review';
 end if;
end $$;
create table shadow_agent.scheduler_settings(
 singleton boolean primary key default true check(singleton),
 approved_project_origin text check(approved_project_origin ~ '^https://[a-z0-9]+[.]supabase[.]co$')
);
insert into shadow_agent.scheduler_settings(singleton) values(true);
alter table shadow_agent.scheduler_settings enable row level security;
revoke all on shadow_agent.scheduler_settings from public,anon,authenticated,service_role;
create function shadow_agent.enqueue_continuation() returns bigint
language plpgsql security definer set search_path='' as $$
declare origin text; approved text; gateway text; token text; n int;
begin
 if not coalesce((select enabled from shadow_agent.producer_settings where singleton),false) then return null; end if;
 select approved_project_origin into approved from shadow_agent.scheduler_settings where singleton;
 if approved is null then raise exception 'Invalid scheduler configuration'; end if;
 select count(*),min(decrypted_secret) into n,origin from vault.decrypted_secrets where name='warpcore_agent_project_url';
 if n<>1 or origin is distinct from approved or origin !~ '^https://[a-z0-9]+[.]supabase[.]co$' then raise exception 'Invalid scheduler configuration'; end if;
 select count(*),min(decrypted_secret) into n,gateway from vault.decrypted_secrets where name='warpcore_agent_gateway_anon_jwt';
 if n<>1 or gateway is null or length(gateway)<32 or length(gateway)>4096 or gateway ~ '[[:space:]]' then raise exception 'Invalid scheduler configuration'; end if;
 select count(*),min(decrypted_secret) into n,token from vault.decrypted_secrets where name='warpcore_agent_cron_token';
 if n<>1 or token is null or length(token)<32 or length(token)>4096 or token ~ '[[:space:]]' or token=gateway then raise exception 'Invalid scheduler configuration'; end if;
 return net.http_post(url:=origin||'/functions/v1/news-agent',body:='{}'::jsonb,params:='{}'::jsonb,
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||gateway,'x-warpcore-agent-token',token),timeout_milliseconds:=120000);
end $$;
revoke all on function shadow_agent.enqueue_continuation() from public,anon,authenticated,service_role;
do $$
declare installed_job_id bigint;
begin
 installed_job_id:=cron.schedule('warpcore-news-agent-continuation','* * * * *','select shadow_agent.enqueue_continuation();');
 perform cron.alter_job(installed_job_id,active:=false);
 if not exists(select 1 from cron.job where jobid=installed_job_id and jobname='warpcore-news-agent-continuation' and active=false) then raise exception 'Scheduler installation failed'; end if;
end $$;
commit;
