// Emit a forward-only SQL artifact for review; never connects to a database.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function extractFunction(source, name) {
 const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const matches=[...source.matchAll(new RegExp(`create(?: or replace)? function ${escaped}\\(\\)[\\s\\S]*?\\$\\$;`,'gi'))];
 if(matches.length!==1) throw new Error(`Expected exactly one canonical function: ${name}`);
 return matches[0][0].replace(/^create(?: or replace)? function/i,'create or replace function');
}
export function prepareReliabilityUpgrade({operations,alerts,dashboard}) {
 const block=operations.match(/-- BEGIN RELIABILITY HEALTH PROGRESS\n([\s\S]*?)-- END RELIABILITY HEALTH PROGRESS/g);
 if(block?.length!==1) throw new Error('Expected one canonical health progress block');
 const codes=[...alerts.matchAll(/code text primary key check\(code in \(([^\n]+)\)\),/g)];
 if(codes.length!==1||!/^'[a-z_]+'(?:,'[a-z_]+')*$/.test(codes[0][1])) throw new Error('Invalid canonical alert code constraint');
 return `-- Generated from canonical operations.sql and agent-alerts.sql. Review before application.
-- Requires existing operations/alerts and separately installed source-health.sql.
begin;
do $upgrade$ begin
 if to_regprocedure('public.warpcore_agent_health()') is null
 or to_regprocedure('shadow_agent.track_run_progress()') is null
 or to_regprocedure('shadow_agent.refresh_alerts()') is null
 or to_regprocedure('shadow_agent.budgeted_enqueue()') is null
 or to_regclass('shadow_agent.alert_state') is null
 or to_regclass('shadow_agent.alert_settings') is null
 or to_regclass('shadow_agent.alert_requests') is null
 or to_regprocedure('shadow_agent.active_runtime_model()') is null
 or to_regclass('shadow_agent.budgets') is null
 or to_regclass('shadow_agent.ranking_runs') is null
 or to_regclass('shadow_agent.attempts') is null
 or to_regclass('shadow_agent.verification_settings') is null
 or to_regclass('shadow_agent.producer_settings') is null
 or to_regclass('shadow_agent.spending_policy') is null
 or to_regclass('shadow_agent.runs') is null
 or to_regclass('shadow_agent.verification_jobs') is null
 or to_regclass('public.warpcore_curator_inbox') is null
 or to_regclass('public.warpcore_publications') is null
 or to_regclass('public.warpcore_configured_source_health') is null
 or to_regclass('public.system_logs') is null then
 raise exception 'Reliability upgrade requires installed operations, alerts, and source-health stack';end if;
 if not exists(select 1 from pg_trigger where tgrelid='shadow_agent.runs'::regclass and tgname='warpcore_run_progress' and not tgisinternal)
 then raise exception 'Existing run progress trigger required';end if;
end $upgrade$;
${block[0]}
${extractFunction(operations,'public.warpcore_agent_health')}
${extractFunction(alerts,'shadow_agent.track_run_progress')}
${extractFunction(alerts,'shadow_agent.refresh_alerts')}
${dashboard ? `do $optional$ begin
 if to_regprocedure('public.warpcore_agent_active_alerts()') is not null then
 execute $dashboard$${extractFunction(dashboard,'public.warpcore_agent_active_alerts')}$dashboard$;
 end if;
end $optional$;` : ''}
-- Replace only the code-domain check, leaving other constraints and rows intact.
do $upgrade$ declare constraint_name text; matches integer; begin
 select count(*),min(c.conname) into matches,constraint_name from pg_constraint c
 where c.conrelid='shadow_agent.alert_state'::regclass and c.contype='c'
 and c.conkey=array[(select attnum from pg_attribute where attrelid=c.conrelid and attname='code')]::smallint[];
 if matches<>1 then raise exception 'Expected exactly one existing alert code check';end if;
 execute format('alter table shadow_agent.alert_state drop constraint %I',constraint_name);
 alter table shadow_agent.alert_state add constraint alert_state_code_check check(code in (${codes[0][1]}));
end $upgrade$;
-- CREATE OR REPLACE retains existing owners and EXECUTE grants. No gate changes.
commit;
`;
}
export async function loadReliabilityUpgrade() {
 const base=new URL('../supabase/functions/news-agent/sql/',import.meta.url);
 const [operations,alerts,dashboard]=await Promise.all(['operations.sql','agent-alerts.sql','dashboard-alerts.sql'].map(x=>readFile(new URL(x,base),'utf8')));
 return prepareReliabilityUpgrade({operations,alerts,dashboard});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) process.stdout.write(await loadReliabilityUpgrade());
