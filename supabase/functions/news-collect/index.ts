import nodemailer from 'npm:nodemailer@10.6.0';
import {createHostedIncidentNotifier} from '../news-agent/notification-incidents.mjs';
import {createGmailFailureNotifier} from '../news-agent/gmail-alerts.mjs';
import {handle} from './handler.mjs';
import {registry} from './adapters.mjs';
// Deployment must require verify_jwt=true in addition to the dedicated token.
Deno.serve((req: Request)=>handle(req,{
 WARPCORE_CRON_TOKEN:Deno.env.get('WARPCORE_CRON_TOKEN'),
 NEWS_SOURCE_CONFIG:'[]', // Deployment safety lock: source selection is deferred.,
 SUPABASE_URL:Deno.env.get('SUPABASE_URL'),
 SUPABASE_SERVICE_ROLE_KEY:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
},registry,{notifyFailure:async (report:unknown)=>createHostedIncidentNotifier({projectUrl:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),createTransport:nodemailer.createTransport,account:Deno.env.get('WARPCORE_ALERT_GMAIL_USERNAME'),password:Deno.env.get('WARPCORE_ALERT_GMAIL_APP_PASSWORD')},createGmailFailureNotifier)(report)}));
