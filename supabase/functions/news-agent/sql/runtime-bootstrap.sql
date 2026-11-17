-- Server-only bootstrap. service_role is the existing trusted server boundary.
-- The model receives evidence data, never RPC authority, API keys or configuration.
-- No secrets/budgets/extensions/jobs created; no existing Vault privileges changed.
begin;
do $$begin
 if to_regclass('shadow_agent.producer_settings') is null then raise exception 'Producer contract required';end if;
end $$;
create table shadow_agent.runtime_settings(
 singleton boolean primary key default true check(singleton),
 model text not null default 'openai/gpt-oss-120b' check(model='openai/gpt-oss-120b'),
 allowed_source_hosts text[] not null default '{}'::text[]
);
insert into shadow_agent.runtime_settings(singleton) values(true);
alter table shadow_agent.runtime_settings enable row level security;
revoke all on shadow_agent.runtime_settings from public,anon,authenticated,service_role;
create function public.warpcore_agent_authorization() returns jsonb
language plpgsql security definer set search_path='' as $$
declare token text;n bigint;
begin
 if not coalesce((select enabled from shadow_agent.producer_settings where singleton),false) then return jsonb_build_object('enabled',false);end if;
 select count(*),min(decrypted_secret) into n,token from vault.decrypted_secrets where name='warpcore_agent_cron_token';
 if n<>1 or token is null or length(token) not between 32 and 4096 or token ~ '[[:space:][:cntrl:]]' then raise exception 'Invalid agent authorization configuration';end if;
 return jsonb_build_object('enabled',true,'producerToken',token);
exception when others then raise exception 'Invalid agent authorization configuration';
end $$;
create function public.warpcore_agent_runtime_config() returns jsonb
language plpgsql security definer set search_path='' as $$
declare cfg shadow_agent.runtime_settings;api_key text;n bigint;host text;
begin
 if not coalesce((select enabled from shadow_agent.producer_settings where singleton),false) then return jsonb_build_object('enabled',false);end if;
 select * into cfg from shadow_agent.runtime_settings where singleton;
 if not found or cfg.model is distinct from 'openai/gpt-oss-120b' or cardinality(cfg.allowed_source_hosts) not between 1 and 128
 or array_ndims(cfg.allowed_source_hosts)<>1 or array_position(cfg.allowed_source_hosts,null) is not null
 or (select count(*)<>count(distinct value) from unnest(cfg.allowed_source_hosts) value) then raise exception 'Invalid agent runtime configuration';end if;
 foreach host in array cfg.allowed_source_hosts loop
  if host<>lower(host) or length(host)>253 or host ~ '^[0-9.]+$'
  or host !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  or host ~ '(^|\.)(localhost|local|localdomain|internal|test|invalid|home|lan)$' then raise exception 'Invalid agent runtime configuration';end if;
 end loop;
 select count(*),min(decrypted_secret) into n,api_key from vault.decrypted_secrets where name='warpcore_agent_openrouter_key';
 if n<>1 or api_key is null or length(api_key) not between 16 and 4096 or api_key ~ '[[:space:][:cntrl:]]' then raise exception 'Invalid agent runtime configuration';end if;
 return jsonb_build_object('model',cfg.model,'apiKey',api_key,'maxOutputTokens',4096,'maxCostCredits',0.058983,'allowedSourceHosts',to_jsonb(cfg.allowed_source_hosts));
exception when others then raise exception 'Invalid agent runtime configuration';
end $$;
revoke all on function public.warpcore_agent_authorization(),public.warpcore_agent_runtime_config() from public,anon,authenticated,service_role;
grant execute on function public.warpcore_agent_authorization(),public.warpcore_agent_runtime_config() to service_role;
commit;
