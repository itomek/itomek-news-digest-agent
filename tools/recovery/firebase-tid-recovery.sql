-- ONE-TIME ARTIFACT ONLY. Execution requires explicit approval for temporarily disabling
-- the immutable-record trigger. Do not invoke without authoritative current PDS checks.
-- SQL records trusted operator observations; it does not independently verify remote absence.
-- psql inputs: expected_publication = exact current row JSON; absence_observations =
-- {"old":{"uri":"at://.../app.bsky.feed.post/story-...","error":"RecordNotFound","checkedAt":"ISO","pds":"https://verified-pds"},"new":{"uri":"at://.../app.bsky.feed.post/3n256uxsaokol","error":"RecordNotFound","checkedAt":"ISO","pds":"https://same-verified-pds"}}
-- No posts, HTTP calls, approval edits, slot resets, or login operations occur here.
\set ON_ERROR_STOP on
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';
lock table public.warpcore_publications in access exclusive mode;
lock table public.warpcore_publication_slots in share mode;
create temporary table warpcore_recovery_input(expected jsonb,observations jsonb) on commit drop;
insert into warpcore_recovery_input values (:'expected_publication'::jsonb,:'absence_observations'::jsonb);
do $recovery$
declare
 expected jsonb;observations jsonb;old_row jsonb;new_row jsonb;inbox_rows jsonb;slot_before jsonb;slot_after jsonb;changed integer;observation jsonb;kind text;
 account constant text:='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk';
 story constant text:='a44802c82c053c5d5044a1ca0ea8f60799b4878e97da25cb6ce9afd266e4c223';
 corrected constant text:='3n256uxsaokol';
begin
 if current_user<>'postgres' then raise exception 'Management role required';end if;
 select i.expected,i.observations into strict expected,observations from warpcore_recovery_input i;
 select to_jsonb(p) into strict old_row from public.warpcore_publications p where p.account_did=account and p.story_key=story;
 if old_row is distinct from expected then raise exception 'Publication changed since inspection';end if;
 if old_row->>'state'<>'uncertain' or old_row->>'record_key'<>'story-'||story or old_row->>'remote_uri' is not null or old_row->>'approved_at' is null
 or old_row->'record_payload'->>'createdAt' is distinct from '2026-11-12T19:20:54.330Z'
 or public.warpcore_record_tid(story,(old_row->'record_payload'->>'createdAt')::timestamptz)<>corrected then raise exception 'Ineligible legacy publication';end if;
 if not exists(select 1 from pg_trigger where tgrelid='public.warpcore_publications'::regclass and tgname='warpcore_immutable_record' and tgenabled='O') then raise exception 'Expected immutable trigger not enabled';end if;
 foreach kind in array array['old','new'] loop
  observation:=observations->kind;
  if jsonb_typeof(observation) is distinct from 'object' or observation->>'error' is distinct from 'RecordNotFound'
  or observation->>'uri' is distinct from ('at://'||account||'/app.bsky.feed.post/'||(case when kind='old' then 'story-'||story else corrected end))
  or jsonb_typeof(observation->'checkedAt') is distinct from 'string'
  or (observation->>'checkedAt')::timestamptz not between clock_timestamp()-interval '5 minutes' and clock_timestamp()+interval '5 seconds'
  or observation->>'pds' is null or observation->>'pds' !~ '^https://[a-z0-9.-]+/?$' then raise exception 'Fresh exact absent-record observations required';end if;
 end loop;
 if observations->'old'->>'pds' is distinct from observations->'new'->>'pds' then raise exception 'Verified PDS must match';end if;
 select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at,i.id),'[]'::jsonb) into inbox_rows from public.warpcore_curator_inbox i where i.story_key=story;
 select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) into slot_before from public.warpcore_publication_slots s where s.account_did=account;
 new_row:=old_row||jsonb_build_object('record_key',corrected,'state','prepared');
 insert into public.warpcore_publication_recovery_audit(operation,account_did,story_key,old_publication,new_publication,prior_inbox,absence_observations,publication_slot_before)
 values('firebase_legacy_tid_recovery',account,story,old_row,new_row,inbox_rows,observations,slot_before);
 -- ACCESS EXCLUSIVE table lock remains until commit/rollback. Only this named trigger is disabled.
 alter table public.warpcore_publications disable trigger warpcore_immutable_record;
 update public.warpcore_publications p set record_key=corrected,state='prepared' where p.account_did=account and p.story_key=story and to_jsonb(p)=old_row;
 get diagnostics changed=row_count;
 alter table public.warpcore_publications enable trigger warpcore_immutable_record;
 if changed<>1 then raise exception 'Recovery update count mismatch';end if;
 if (select to_jsonb(p) from public.warpcore_publications p where p.account_did=account and p.story_key=story) is distinct from new_row then raise exception 'Unexpected publication mutation';end if;
 select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) into slot_after from public.warpcore_publication_slots s where s.account_did=account;
 if slot_after is distinct from slot_before then raise exception 'Publication slot changed';end if;
 if not exists(select 1 from pg_trigger where tgrelid='public.warpcore_publications'::regclass and tgname='warpcore_immutable_record' and tgenabled='O') then raise exception 'Immutable trigger not restored';end if;
end;$recovery$;
commit;
