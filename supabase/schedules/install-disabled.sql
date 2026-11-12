-- Installation only: commit both new jobs INACTIVE atomically. No HTTP, secrets or extension changes.
-- Deliberately fails on an existing name rather than altering an already configured job.
begin;
do $guard$ begin
 if exists(select 1 from cron.job where jobname in ('warpcore-news-collect-hourly','warpcore-news-publish-hourly')) then
 raise exception 'Warpcore schedules already exist: inspect rather than overwrite';end if;
end;$guard$;
select cron.schedule('warpcore-news-collect-hourly','17 * * * *',$command$do $invoke$
declare gateway text; token text;
begin
 if not exists(select 1 from pg_extension where extname='pg_net') then raise exception 'Warpcore requires reviewed pg_net setup'; end if;
 select decrypted_secret into strict gateway from vault.decrypted_secrets where name='warpcore_gateway_anon_jwt';
 select decrypted_secret into strict token from vault.decrypted_secrets where name='warpcore_collect_cron_token';
 if length(gateway)<32 or length(token)<32 then raise exception 'Warpcore authentication not configured';end if;
 perform net.http_post(url:='https://eedfyviypptfpghyffip.supabase.co/functions/v1/news-collect',
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||gateway,'x-warpcore-token',token),
 body:='{}'::jsonb,timeout_milliseconds:=10000);
end;$invoke$;$command$);
select cron.alter_job((select jobid from cron.job where jobname='warpcore-news-collect-hourly'),active:=false);
select cron.schedule('warpcore-news-publish-hourly','27 * * * *',$command$do $invoke$
declare gateway text; token text;
begin
 if not exists(select 1 from pg_extension where extname='pg_net') then raise exception 'Warpcore requires reviewed pg_net setup'; end if;
 select decrypted_secret into strict gateway from vault.decrypted_secrets where name='warpcore_gateway_anon_jwt';
 select decrypted_secret into strict token from vault.decrypted_secrets where name='warpcore_publish_cron_token';
 if length(gateway)<32 or length(token)<32 then raise exception 'Warpcore authentication not configured';end if;
 perform net.http_post(url:='https://eedfyviypptfpghyffip.supabase.co/functions/v1/news-publish',
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||gateway,'x-warpcore-token',token),
 body:='{}'::jsonb,timeout_milliseconds:=10000);
end;$invoke$;$command$);
select cron.alter_job((select jobid from cron.job where jobname='warpcore-news-publish-hourly'),active:=false);
commit;
