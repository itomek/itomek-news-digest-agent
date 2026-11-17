-- SHADOW ONLY, outside migrations; load state and paged contracts first.
-- Audit is narrow structured accounting, never prompts, bodies, keys or headers.
begin;
create table shadow_agent.run_config(run_id uuid primary key references shadow_agent.runs(id), config jsonb not null);
create table shadow_agent.attempt_audit(attempt_id uuid not null references shadow_agent.attempts(id),
 status text not null check(status in ('uncertain','settled')),audit jsonb not null,
 primary key(attempt_id,status));
create table shadow_agent.deferrals(run_id uuid not null references shadow_agent.runs(id),checkpoint_revision bigint not null,
 reason text not null check(reason in ('insufficient_budget','missing_daily_budget','spending_blocked')),
 primary key(run_id,checkpoint_revision));
alter table shadow_agent.run_config enable row level security;
alter table shadow_agent.attempt_audit enable row level security;
alter table shadow_agent.deferrals enable row level security;
revoke all on shadow_agent.run_config,shadow_agent.attempt_audit,shadow_agent.deferrals from public,anon,authenticated,service_role;
-- Human provider identities use the same trim/control rules as the transport.
create function shadow_agent.valid_provider_name(p_name text) returns boolean
language sql immutable set search_path='' as $$
 select p_name is not null and length(p_name) between 1 and 128
 and p_name=btrim(p_name,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
 and p_name !~ U&'[\0001-\001F\007F-\009F]'
$$;
create or replace function shadow_agent.paged_bind_config(p_run uuid,p_lease uuid,p_config jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare r shadow_agent.runs; existing jsonb; k text; profile jsonb; provider jsonb; prices jsonb;
begin
 select * into r from shadow_agent.runs where id=p_run for update;
 if not found or p_lease is null or r.lease_token is distinct from p_lease or r.lease_until<=clock_timestamp() then return false; end if;
 if r.state->>'storageKind' is distinct from 'paged-v1' or p_config is null or jsonb_typeof(p_config)<>'object' or octet_length(p_config::text)>8192
 or (p_config-'model'-'maxOutputTokens'-'maxCostCredits'-'timeoutMs'-'maxResponseBytes'-'policyVersion'-'routing'-'requestProfile'-'expectedProvider'-'reviewBatchSize')<>'{}'::jsonb
 or jsonb_typeof(p_config->'model') is distinct from 'string' or p_config->>'model' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
 or p_config->'policyVersion' is distinct from r.state->'policyVersion'
 or p_config->'routing' is distinct from '"openrouter-no-fallback"'::jsonb then raise exception 'Invalid runtime config'; end if;
 if p_config ? 'expectedProvider' and (jsonb_typeof(p_config->'expectedProvider') is distinct from 'string'
 or not shadow_agent.valid_provider_name(p_config->>'expectedProvider')) then raise exception 'Invalid expected provider'; end if;
 if p_config ? 'reviewBatchSize' then
  if jsonb_typeof(p_config->'reviewBatchSize') is distinct from 'number' or p_config->>'reviewBatchSize' !~ '^[0-9]+$'
  then raise exception 'Invalid review batch size'; end if;
  if (p_config->>'reviewBatchSize')::numeric not between 1 and 100 then raise exception 'Invalid review batch size'; end if;
 end if;
 foreach k in array array['maxOutputTokens','timeoutMs','maxResponseBytes'] loop
  if jsonb_typeof(p_config->k) is distinct from 'number' or p_config->>k !~ '^[0-9]+$' then raise exception 'Invalid runtime config'; end if;
 end loop;
 if (p_config->>'maxOutputTokens')::numeric not between 1 and 16384
 or (p_config->>'timeoutMs')::numeric not between 1 and 60000
 or (p_config->>'maxResponseBytes')::numeric not between 1 and 200000
 or jsonb_typeof(p_config->'maxCostCredits') is distinct from 'number' then raise exception 'Invalid runtime config'; end if;
 if not((p_config->>'maxCostCredits')::numeric>0 and (p_config->>'maxCostCredits')::numeric<1000000) then raise exception 'Invalid runtime config'; end if;
 if p_config->>'model' in ('nvidia/nemotron-3.5-super-vl','nvidia/nemotron-3-super-120b-a12b','meta-llama/llama-4-maverick','google/gemma-4-26b-a4b-it') and not(p_config ? 'requestProfile') then raise exception 'Invalid approved runtime profile';end if;
 -- Optional immutable routing/structured-output profile. Keep only the
 -- reviewed public contract, never arbitrary transport parameters or secrets.
 if p_config ? 'requestProfile' then
  profile:=p_config->'requestProfile';
  if (p_config->>'model'='nvidia/nemotron-3.5-super-vl' and profile->>'version' not in ('2026-11-17.1','2026-11-17.3','2026-11-17.4','2026-11-17.5')) or (p_config->>'model'='nvidia/nemotron-3-super-120b-a12b' and profile->>'version'<>'2026-11-17.2') or (p_config->>'model'='meta-llama/llama-4-maverick' and profile->>'version' is distinct from '2026-11-17.7') then raise exception 'Invalid approved runtime profile';end if;
  if jsonb_typeof(profile) is distinct from 'object'
  or (profile-'version'-'provider'-'responseFormat'-'reasoning'-'rankingRubricVersion'-'temperature')<>'{}'::jsonb
  or jsonb_typeof(profile->'version') is distinct from 'string'
  or profile->>'version' !~ '^[A-Za-z0-9._-]{1,64}$'
  or not coalesce((profile->>'responseFormat'='discovery-json-schema-v1' and profile->>'version' not in ('2026-11-16.3','2026-11-16.4','2026-11-17.1','2026-11-17.2','2026-11-17.3','2026-11-17.4','2026-11-17.5','2026-11-17.6','2026-11-17.7','2026-11-17.8') and not(profile ? 'rankingRubricVersion') or profile->>'responseFormat'='discovery-ranked-json-schema-v2' and profile->>'version'='2026-11-16.3' and profile->>'rankingRubricVersion'='2026-11-16.1' or profile->>'responseFormat'='discovery-keyed-ranked-json-schema-v3' and profile->>'version' in ('2026-11-16.4','2026-11-17.1','2026-11-17.2','2026-11-17.3') and profile->>'rankingRubricVersion'='2026-11-16.1' or profile->>'responseFormat'='discovery-keyed-coded-ranking-json-schema-v4' and profile->>'version' in ('2026-11-17.4','2026-11-17.5','2026-11-17.6','2026-11-17.7','2026-11-17.8') and profile->>'rankingRubricVersion'='2026-11-16.1'),false)
  or jsonb_typeof(profile->'provider') is distinct from 'object'
  then raise exception 'Invalid request profile'; end if;
  if (profile->>'version' in ('2026-11-16.2','2026-11-16.3','2026-11-16.4','2026-11-17.6') and profile->'reasoning' is distinct from '{"effort":"low"}'::jsonb)
  or (profile->>'version'='2026-11-16.1' and profile->'reasoning' is distinct from '{"effort":"none"}'::jsonb)
  or (profile->>'version' not in ('2026-11-16.1','2026-11-16.2','2026-11-16.3','2026-11-16.4','2026-11-17.6') and profile ? 'reasoning' and profile->'reasoning' is distinct from '{"effort":"none"}'::jsonb)
  then raise exception 'Invalid request profile reasoning'; end if;
  if (profile->>'version'='2026-11-17.7' and (profile ? 'reasoning' or profile->'temperature' is distinct from '0'::jsonb))
  or (profile->>'version' is distinct from '2026-11-17.7' and profile ? 'temperature') then raise exception 'Invalid approved runtime controls';end if;
  provider:=profile->'provider';
  if (provider-'only'-'order'-'allow_fallbacks'-'require_parameters'-'max_price'-'zdr')<>'{}'::jsonb
  or jsonb_typeof(provider->'only') is distinct from 'array'
  or provider->'order' is distinct from provider->'only'
  or provider->'allow_fallbacks' is distinct from 'false'::jsonb
  or provider->'require_parameters' is distinct from 'true'::jsonb
  or jsonb_typeof(provider->'max_price') is distinct from 'object'
  then raise exception 'Invalid request profile'; end if;
  -- Match the request contract: a supplied ZDR control is literal true,
  -- required in v16.1/v16.2 and forbidden in historical code-owned v15.2.
  -- Existing bound configuration remains immutable across lease/resume.
  if (provider ? 'zdr' and provider->'zdr' is distinct from 'true'::jsonb)
  or (profile->>'version' in ('2026-11-16.1','2026-11-16.2','2026-11-16.3','2026-11-16.4','2026-11-17.1','2026-11-17.2','2026-11-17.3','2026-11-17.4','2026-11-17.5','2026-11-17.6','2026-11-17.7','2026-11-17.8') and provider->'zdr' is distinct from 'true'::jsonb)
  or (profile->>'version'='2026-11-15.2' and provider ? 'zdr')
  then raise exception 'Invalid request profile ZDR policy'; end if;
  if jsonb_array_length(provider->'only')<>1
  or jsonb_typeof(provider->'only'->0) is distinct from 'string'
  or provider->'only'->>0 !~ '^[a-z0-9][a-z0-9._/-]{0,127}$'
  then raise exception 'Invalid request profile'; end if;
  if profile->>'version' in ('2026-11-17.1','2026-11-17.2','2026-11-17.3','2026-11-17.4','2026-11-17.5') and (profile->'reasoning' is distinct from '{"effort":"none"}'::jsonb or p_config->'maxOutputTokens' is distinct from '4096'::jsonb or p_config->'reviewBatchSize' is distinct from '16'::jsonb or not coalesce(
   (profile->>'version' in ('2026-11-17.1','2026-11-17.3','2026-11-17.4') and p_config->>'model'='nvidia/nemotron-3.5-super-vl' and p_config->>'expectedProvider'='DeepInfra' and provider->'only'='["deepinfra/fp4"]'::jsonb and provider->'max_price'='{"prompt":0.15,"completion":0.50,"request":0}'::jsonb and p_config->'maxCostCredits'='0.157287'::jsonb)
   or (profile->>'version'='2026-11-17.5' and p_config->>'model'='nvidia/nemotron-3.5-super-vl' and p_config->>'expectedProvider'='Together' and provider->'only'='["together"]'::jsonb and provider->'max_price'='{"prompt":0.15,"completion":0.50,"request":0}'::jsonb and p_config->'maxCostCredits'='0.157287'::jsonb)
   or (profile->>'version'='2026-11-17.2' and p_config->>'model'='nvidia/nemotron-3-super-120b-a12b' and p_config->>'expectedProvider'='DeepInfra' and provider->'only'='["deepinfra/bf16"]'::jsonb and provider->'max_price'='{"prompt":0.075,"completion":0.40,"request":0}'::jsonb and p_config->'maxCostCredits'='0.026215'::jsonb),false)) then raise exception 'Invalid approved runtime profile';end if;
  if profile->>'version'='2026-11-17.6' and not coalesce(p_config->>'model'='openai/gpt-oss-120b'
   and p_config->>'expectedProvider'='Cerebras' and provider->'only'='["cerebras/fp16"]'::jsonb
   and provider->'max_price'='{"prompt":0.35,"completion":0.75,"request":0}'::jsonb
   and p_config->'maxCostCredits'='0.076596'::jsonb and p_config->'maxOutputTokens'='8192'::jsonb
   and p_config->'reviewBatchSize'='16'::jsonb,false) then raise exception 'Invalid approved runtime profile';end if;
  if profile->>'version'='2026-11-17.7' and not coalesce(p_config->>'model'='meta-llama/llama-4-maverick'
   and p_config->>'expectedProvider'='Parasail' and provider->'only'='["parasail/fp8"]'::jsonb
   and provider->'max_price'='{"prompt":0.35,"completion":1,"request":0}'::jsonb
   and p_config->'maxCostCredits'='0.216269'::jsonb and p_config->'maxOutputTokens'='4096'::jsonb
   and p_config->'reviewBatchSize'='16'::jsonb,false) then raise exception 'Invalid approved runtime profile';end if;
  if profile->>'version'='2026-11-17.8' and not coalesce(p_config->>'model'='google/gemma-4-26b-a4b-it'
   and p_config->>'expectedProvider'='PrimeIntellect' and provider->'only'='["primeintellect/bf16"]'::jsonb
   and provider->'max_price'='{"prompt":0.10,"completion":0.30,"request":0}'::jsonb
   and profile->'reasoning'='{"effort":"none"}'::jsonb
   and p_config->'maxCostCredits'='0.036045'::jsonb and p_config->'maxOutputTokens'='4096'::jsonb
   and p_config->'reviewBatchSize'='16'::jsonb,false) then raise exception 'Invalid approved runtime profile';end if;
  prices:=provider->'max_price';
  if (prices-'prompt'-'completion'-'request')<>'{}'::jsonb
  or jsonb_typeof(prices->'prompt') is distinct from 'number'
  or jsonb_typeof(prices->'completion') is distinct from 'number'
  or prices->'request' is distinct from '0'::jsonb then raise exception 'Invalid request profile'; end if;
  if (prices->>'prompt')::numeric<=0 or (prices->>'completion')::numeric<=0 then raise exception 'Invalid request profile'; end if;
 end if;
 if profile->>'responseFormat' in ('discovery-ranked-json-schema-v2','discovery-keyed-ranked-json-schema-v3','discovery-keyed-coded-ranking-json-schema-v4') and to_regprocedure('shadow_agent.ranking_bind(uuid)') is null then raise exception 'Ranking contract required'; end if;
 select config into existing from shadow_agent.run_config where run_id=p_run;
 if found then
  if existing is distinct from p_config then raise exception 'Immutable runtime config'; end if;
  return true;
 end if;
 if r.lease_until<=clock_timestamp() then return false; end if;
 insert into shadow_agent.run_config(run_id,config) values(p_run,p_config);
 if profile->>'responseFormat' in ('discovery-ranked-json-schema-v2','discovery-keyed-ranked-json-schema-v3','discovery-keyed-coded-ranking-json-schema-v4') then perform shadow_agent.ranking_bind(p_run); end if;
 if r.lease_until<=clock_timestamp() then raise exception 'Lease lost during config binding'; end if;
 return true;
end $$;
create function shadow_agent.paged_reserve(p_run uuid,p_lease uuid,p_revision bigint,p_hash text,p_max numeric) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r shadow_agent.runs; attempt uuid; cfg jsonb; reason text; next_state jsonb;
 day_start date:=(clock_timestamp() at time zone 'utc')::date;
begin
 -- Preserve the global budget -> run -> attempt lock order used by accounting.
 -- The <=300-second lease can cross midnight. Lock tomorrow too, in date
 -- order, before the run so reserve's own date calculation cannot invert locks.
 perform 1 from shadow_agent.budgets where day in (day_start,day_start+1) order by day for update;
 r:=shadow_agent.paged_lock(p_run,p_lease,p_revision,'reviewing');
 if r.id is null then raise exception 'Lease or checkpoint revision lost'; end if;
 select config into cfg from shadow_agent.run_config where run_id=p_run;
 if not found or p_max is distinct from (cfg->>'maxCostCredits')::numeric then raise exception 'Invalid bound reservation config'; end if;
 begin
  attempt:=shadow_agent.reserve(p_run,p_lease,p_hash,p_max);
  return jsonb_build_object('status','reserved','attemptId',attempt);
 exception when sqlstate 'P0001' then
  -- Only these exact database-origin outcomes prove no provider dispatch began.
  reason:=case SQLERRM when 'Insufficient budget' then 'insufficient_budget'
   when 'Missing daily budget' then 'missing_daily_budget' when 'Spending blocked' then 'spending_blocked' else null end;
  if reason is null then raise; end if;
 end;
 -- The failed reservation subtransaction has rolled back. Verify the same
 -- checkpoint still has no attempt before reopening precisely this batch.
 r:=shadow_agent.paged_lock(p_run,p_lease,p_revision,'reviewing');
 if r.id is null or exists(select 1 from shadow_agent.attempts where run_id=p_run and checkpoint_revision=p_revision)
 then raise exception 'Attempted checkpoint cannot defer'; end if;
 next_state:=shadow_agent.paged_write(p_run,p_lease,p_revision,r.state||jsonb_build_object('revision',p_revision+1,'phase','review','activeBatch','null'::jsonb));
 insert into shadow_agent.deferrals(run_id,checkpoint_revision,reason) values(p_run,p_revision,reason);
 return jsonb_build_object('status','deferred','state',next_state,'reason',reason);
end $$;
create or replace function shadow_agent.paged_settle(p_attempt uuid,p_lease uuid,p_status text,p_cost numeric,p_audit jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare a shadow_agent.attempts; cfg jsonb; u jsonb; k text; prior jsonb; ok boolean; d jsonb;
begin
 select * into a from shadow_agent.attempts where id=p_attempt;
 if not found then return false; end if;
 select config into cfg from shadow_agent.run_config where run_id=a.run_id;
 if not found or p_audit is null or jsonb_typeof(p_audit)<>'object' or octet_length(p_audit::text)>4000
 or (p_audit-'model'-'generationId'-'usage'-'errorCode'-'provider'-'diagnostic')<>'{}'::jsonb
 then raise exception 'Invalid settlement audit'; end if;
 if p_audit ? 'errorCode' then
  if jsonb_typeof(p_audit->'errorCode') is distinct from 'string' or p_audit->>'errorCode' not in
  ('disabled','invalid_transport_configuration','missing_cost_reservation','unsupported_request','invalid_model_or_budget','invalid_messages','invalid_candidates','empty_response','response_too_large','timeout','invalid_json','missing_or_invalid_usage','reservation_exceeded','invalid_completion','invalid_decision_json','incomplete_decisions','invalid_decisions','invalid_limits','http_failure','transport_failure','unknown_failure')
  or p_audit ? 'model' or p_audit ? 'generationId' or p_audit ? 'provider' then raise exception 'Invalid settlement audit'; end if;
  if p_audit ? 'diagnostic' then
   d:=p_audit->'diagnostic';
   if jsonb_typeof(d) is distinct from 'object' or d='{}'::jsonb or octet_length(d::text)>2048
   or (d-'generationId'-'model'-'provider'-'httpStatus'-'validationIssue'-'decisionIndex'-'providerErrorCode'-'providerErrorType'-'errorProvider'-'limitSource'-'retryAfterSeconds'-'requestId'-'cloudflareRay')<>'{}'::jsonb then raise exception 'Invalid error diagnostic';end if;
  if d ? 'providerErrorCode' and not coalesce((jsonb_typeof(d->'providerErrorCode')='number' and d->>'providerErrorCode' in ('400','401','402','403','404','408','409','413','422','429','500','502','503','504','529')) or (jsonb_typeof(d->'providerErrorCode')='string' and d->>'providerErrorCode' in ('rate_limit_exceeded','insufficient_quota','invalid_request_error','authentication_error','permission_error','not_found_error','overloaded_error','api_error','context_length_exceeded','unsupported_parameter','rate_limited','rate_limit_error','quota_exceeded','too_many_requests','RESOURCE_EXHAUSTED','engine_overloaded')),false) then raise exception 'Invalid error diagnostic';end if;
  if d ? 'providerErrorType' and (jsonb_typeof(d->'providerErrorType') is distinct from 'string' or not coalesce(d->>'providerErrorType' in ('invalid_request_error','authentication_error','permission_error','not_found_error','rate_limit_error','overloaded_error','api_error','server_error','insufficient_quota','context_length_exceeded','rate_limit_exceeded','provider_overloaded','provider_unavailable','timeout','server','authentication','permission_denied','payment_required','invalid_request','content_policy_violation','refusal','unmapped'),false)) then raise exception 'Invalid error diagnostic';end if;
  if d ? 'errorProvider' and (jsonb_typeof(d->'errorProvider') is distinct from 'string' or not coalesce(d->>'errorProvider' in ('DeepInfra','Together','Cerebras','Parasail','Groq','Anthropic','OpenAI','PrimeIntellect','Google AI Studio'),false)) then raise exception 'Invalid error diagnostic';end if;
  if d ? 'limitSource' and (jsonb_typeof(d->'limitSource') is distinct from 'string' or not coalesce(d->>'limitSource' in ('upstream_provider_shared_pool','openrouter_in_flight_budget','openrouter_key_limit','openrouter_credits','openrouter_guardrail_budget','openrouter_workspace_budget'),false)) then raise exception 'Invalid error diagnostic';end if;
  if d ? 'retryAfterSeconds' and (jsonb_typeof(d->'retryAfterSeconds') is distinct from 'number' or coalesce(d->>'retryAfterSeconds','') !~ '^[0-9]{1,5}$' or (d->>'retryAfterSeconds')::numeric not between 0 and 86400) then raise exception 'Invalid error diagnostic';end if;
  if d ? 'requestId' and (jsonb_typeof(d->'requestId') is distinct from 'string' or length(d->>'requestId')>128 or d->>'requestId' !~ '^(req[-_]|gen-)[A-Za-z0-9_-]{1,124}$' or d->>'requestId' ~ U&'[\0001-\001F\007F-\009F]') then raise exception 'Invalid error diagnostic';end if;
  if d ? 'cloudflareRay' and (jsonb_typeof(d->'cloudflareRay') is distinct from 'string' or d->>'cloudflareRay' !~ '^[a-f0-9]{16}-[A-Z]{3}$' or d->>'cloudflareRay' ~ U&'[\0001-\001F\007F-\009F]') then raise exception 'Invalid error diagnostic';end if;

   foreach k in array array['generationId','model','provider'] loop
    if d ? k then
     if jsonb_typeof(d->k) is distinct from 'string' or length(d->>k) not between 1 and (case when k='generationId' then 256 else 128 end)
     or d->>k<>btrim(d->>k,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') or d->>k ~ U&'[\0001-\001F\007F-\009F]' then raise exception 'Invalid error diagnostic';end if;
    end if;
   end loop;
   if d ? 'httpStatus' and (jsonb_typeof(d->'httpStatus') is distinct from 'number' or coalesce(d->>'httpStatus','') !~ '^[0-9]{3}$' or (d->>'httpStatus')::numeric not between 100 and 599) then raise exception 'Invalid error diagnostic';end if;
   if d ? 'decisionIndex' and (jsonb_typeof(d->'decisionIndex') is distinct from 'number' or coalesce(d->>'decisionIndex','') !~ '^[0-9]{1,2}$' or (d->>'decisionIndex')::numeric not between 0 and 99) then raise exception 'Invalid error diagnostic';end if;
   if d ? 'validationIssue' and (jsonb_typeof(d->'validationIssue') is distinct from 'string' or not coalesce(d->>'validationIssue' in ('invalid_shape','unexpected_fields','unknown_id','duplicate_id','invalid_action','invalid_reason','invalid_scores'),false)) then raise exception 'Invalid error diagnostic';end if;
  end if;
 else
  if p_audit ? 'diagnostic' then raise exception 'Error diagnostic requires errorCode';end if;
  if (p_audit ? 'provider' and (jsonb_typeof(p_audit->'provider') is distinct from 'string' or not shadow_agent.valid_provider_name(p_audit->>'provider')))
  or (cfg ? 'expectedProvider' and p_audit->'provider' is distinct from cfg->'expectedProvider')
  then raise exception 'Invalid settlement provider'; end if;
  if p_audit->'model' is distinct from cfg->'model' or jsonb_typeof(p_audit->'generationId') is distinct from 'string'
  or length(p_audit->>'generationId') not between 1 and 256 or p_audit->>'generationId' ~ '[[:cntrl:]]'
  then raise exception 'Invalid settlement audit'; end if;
 end if;
 if p_status='settled' then
  u:=p_audit->'usage';
  if jsonb_typeof(u) is distinct from 'object' or (u-'promptTokens'-'completionTokens'-'totalTokens'-'costCredits')<>'{}'::jsonb then raise exception 'Invalid settlement audit'; end if;
  foreach k in array array['promptTokens','completionTokens','totalTokens'] loop
   if jsonb_typeof(u->k) is distinct from 'number' or u->>k !~ '^[0-9]+$' then raise exception 'Invalid settlement audit'; end if;
   if (u->>k)::numeric>9007199254740991 then raise exception 'Invalid settlement audit'; end if;
  end loop;
  if (u->>'promptTokens')::numeric+(u->>'completionTokens')::numeric<>(u->>'totalTokens')::numeric
  or jsonb_typeof(u->'costCredits') is distinct from 'number' then raise exception 'Invalid settlement audit'; end if;
  if (u->>'costCredits')::numeric is distinct from p_cost then raise exception 'Invalid settlement audit'; end if;
 elsif p_status='uncertain' then
  if not(p_audit ? 'errorCode') or p_audit ? 'usage' or p_cost is not null then raise exception 'Invalid settlement audit'; end if;
 else raise exception 'Invalid settlement audit'; end if;
 -- settle locks budget/run/attempt in the existing order and fences original
 -- token, accounting only once. Audit insertion occurs in this same transaction.
 ok:=shadow_agent.settle(p_attempt,p_lease,p_status,p_cost);
 if not ok then return false; end if;
 select audit into prior from shadow_agent.attempt_audit where attempt_id=p_attempt and status=p_status;
 if found then
  if prior is distinct from p_audit then raise exception 'Immutable settlement audit'; end if;
  return true;
 end if;
 insert into shadow_agent.attempt_audit(attempt_id,status,audit) values(p_attempt,p_status,p_audit);
 return true;
end $$;
-- Once the audited extension is installed, legacy settlement alone cannot
-- authorize a normalized review completion. Historical audit events are immutable.
create function shadow_agent.paged_require_audit() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from shadow_agent.runs r join shadow_agent.attempts a on a.run_id=r.id and a.checkpoint_revision=r.revision
 join shadow_agent.attempt_audit x on x.attempt_id=a.id and x.status='settled'
 where r.id=new.run_id and a.status='settled') then raise exception 'Settled attempt audit required'; end if;
 return new;
end $$;
create trigger paged_require_audit before insert on shadow_agent.decisions for each row execute function shadow_agent.paged_require_audit();
revoke all on function shadow_agent.valid_provider_name(text),shadow_agent.paged_bind_config(uuid,uuid,jsonb),shadow_agent.paged_reserve(uuid,uuid,bigint,text,numeric),
 shadow_agent.paged_settle(uuid,uuid,text,numeric,jsonb),shadow_agent.paged_require_audit() from public,anon,authenticated,service_role;
grant execute on function shadow_agent.paged_bind_config(uuid,uuid,jsonb),shadow_agent.paged_reserve(uuid,uuid,bigint,text,numeric),
 shadow_agent.paged_settle(uuid,uuid,text,numeric,jsonb) to service_role;
commit;
