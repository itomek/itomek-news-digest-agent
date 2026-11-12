-- Read-only prerequisite audit. No secret values or request/response content.
-- pg_net installation/hardening requires a separate approved change.
select extname,extversion from pg_extension where extname in ('pg_net','pg_cron','supabase_vault');
select r.rolname,n.nspname,has_schema_privilege(r.oid,n.oid,'USAGE') as schema_usage
from pg_roles r cross join pg_namespace n
where r.rolname in ('anon','authenticated','service_role') and n.nspname in ('net','vault','cron');
select r.rolname,n.nspname,c.relname,has_table_privilege(r.oid,c.oid,'SELECT') as can_select,
has_table_privilege(r.oid,c.oid,'INSERT') as can_insert,has_table_privilege(r.oid,c.oid,'UPDATE') as can_update,
c.relrowsecurity
from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r
where r.rolname in ('anon','authenticated','service_role') and
((n.nspname='net' and c.relname in ('http_request_queue','_http_response')) or
(n.nspname='vault' and c.relname in ('secrets','decrypted_secrets')) or
(n.nspname='cron' and c.relname='job'));
select r.rolname,p.oid::regprocedure as function,has_function_privilege(r.oid,p.oid,'EXECUTE') as can_execute,p.prosecdef
from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r
where n.nspname='net' and r.rolname in ('anon','authenticated','service_role');
