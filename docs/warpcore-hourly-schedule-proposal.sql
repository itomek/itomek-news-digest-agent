-- PROPOSAL ONLY. Not executed; secrets must be authorized and installed first.
-- Enable pg_net through an approved migration; preserve existing cron jobs.
-- Store new random token only in Vault and matching Edge Function secret
-- WARPCORE_CRON_TOKEN. Store existing legacy anon JWT in Vault for gateway JWT
-- validation; it is NOT the authority to run this worker by itself.
-- Required Vault names: warpcore_cron_token, warpcore_anon_jwt, warpcore_project_url.
-- Function deployment must retain verify_jwt=true AND enforce x-warpcore-token.
select cron.schedule('warpcore-hourly-collect','17 * * * *',$job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='warpcore_project_url') || '/functions/v1/news-collect',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='warpcore_anon_jwt'),
      'x-warpcore-token',(select decrypted_secret from vault.decrypted_secrets where name='warpcore_cron_token')
    ), body := '{}'::jsonb, timeout_milliseconds := 75000
  );
$job$);
-- Verify job_run_details AND net._http_response; cron success alone only means
-- HTTP was queued, not that collection succeeded. Alert on repeated failed/missed
-- runs using a separate health check once its delivery destination is authorized.
