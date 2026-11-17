-- Public feedback capture only. No policy, chat, credential or social-write API.
begin;
create schema owner_feedback;
revoke all on schema owner_feedback from public,anon,authenticated,service_role;
create table owner_feedback.settings(
 singleton boolean primary key default true check(singleton),enabled boolean not null default false,
 owner_did text not null default 'did:plc:gbpnjfu6l62bkyeemommtqw4' check(owner_did='did:plc:gbpnjfu6l62bkyeemommtqw4'),
 bot_did text not null default 'did:plc:pfq2p7n2oiiy2k4pv6xnsgdk' check(bot_did='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk')
);
insert into owner_feedback.settings(singleton) values(true);
create table owner_feedback.checkpoint(
 singleton boolean primary key default true check(singleton),revision bigint not null default 0,
 window_id uuid,window_since timestamptz,window_until timestamptz,cursor text,oldest_indexed_at timestamptz,
 coverage text not null default 'pending' check(coverage in ('pending','cutoff_reached','feed_exhausted_before_cutoff')),
 last_window_until timestamptz,last_coverage text
);
insert into owner_feedback.checkpoint(singleton) values(true);
create table owner_feedback.items(
 uri text primary key,cid text not null,author_did text not null,
 root_uri text not null,parent_uri text not null,text text not null,
 created_at timestamptz not null,indexed_at timestamptz not null,fetched_at timestamptz not null,
 first_window_id uuid not null,source_sha256 text not null,
 status text not null default 'recorded' check(status in ('recorded','operator_review'))
);
create table owner_feedback.page_receipts(
 window_id uuid not null,revision bigint not null,request_cursor text not null,window_since timestamptz not null,window_until timestamptz not null,
 fetched_at timestamptz not null,source_sha256 text not null,entry_count int not null,
 coverage text not null,primary key(window_id,revision),unique(window_id,request_cursor)
);
alter table owner_feedback.settings enable row level security;
alter table owner_feedback.checkpoint enable row level security;
alter table owner_feedback.items enable row level security;
alter table owner_feedback.page_receipts enable row level security;
revoke all on all tables in schema owner_feedback from public,anon,authenticated,service_role;
create function owner_feedback.summary() returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('enabled',true,'revision',revision,'windowSince',window_since,'windowUntil',window_until,'cursor',cursor,
 'oldestIndexedAt',oldest_indexed_at,'coverage',coverage,'complete',coverage<>'pending','lastWindowUntil',last_window_until,'lastCoverage',last_coverage)
 from owner_feedback.checkpoint where singleton
$$;
create function public.warpcore_owner_feedback_checkpoint() returns jsonb
language plpgsql security definer set search_path='' as $$
declare c owner_feedback.checkpoint;stamp timestamptz;
begin
 if not coalesce((select enabled from owner_feedback.settings where singleton),false) then return jsonb_build_object('enabled',false);end if;
 select * into c from owner_feedback.checkpoint where singleton for update;
 if c.window_until is null or c.coverage<>'pending' then
  stamp:=clock_timestamp();
  update owner_feedback.checkpoint set revision=revision+1,window_id=gen_random_uuid(),window_since=stamp-interval '7 days',window_until=stamp,
  cursor=null,oldest_indexed_at=null,coverage='pending',last_window_until=c.window_until,
  last_coverage=case when c.window_until is not null then c.coverage else null end where singleton;
 end if;
 return owner_feedback.summary();
end $$;
create function public.warpcore_owner_feedback_record_page(p_revision bigint,p_page jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c owner_feedback.checkpoint;entry jsonb;stamp jsonb;previous timestamptz;indexed timestamptz;expected text;prior owner_feedback.items;new_count int:=0;duplicate_count int:=0;
 owner_pin constant text:='did:plc:gbpnjfu6l62bkyeemommtqw4';bot_pin constant text:='did:plc:pfq2p7n2oiiy2k4pv6xnsgdk';
 uri_pattern constant text:='^at://did:plc:[a-z2-7]{24}/app[.]bsky[.]feed[.]post/[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$';
begin
 if not coalesce((select enabled from owner_feedback.settings where singleton),false) then return null;end if;
 select * into c from owner_feedback.checkpoint where singleton for update;
 if p_revision is null or c.revision is distinct from p_revision or c.window_until is null or c.coverage<>'pending' then return null;end if;
 if p_page is null or jsonb_typeof(p_page) is distinct from 'object' or octet_length(p_page::text)>200000
 or not(p_page ?& array['ownerDid','botDid','windowSince','windowUntil','requestCursor','nextCursor','indexedTimes','entries','coverage','fetchedAt','contentSha256'])
 or (p_page-'ownerDid'-'botDid'-'windowSince'-'windowUntil'-'requestCursor'-'nextCursor'-'indexedTimes'-'entries'-'coverage'-'fetchedAt'-'contentSha256')<>'{}'::jsonb
 or p_page->>'ownerDid' is distinct from owner_pin or p_page->>'botDid' is distinct from bot_pin
 or (p_page->>'windowSince')::timestamptz is distinct from c.window_since or (p_page->>'windowUntil')::timestamptz is distinct from c.window_until
 or p_page->>'requestCursor' is distinct from c.cursor
 or (p_page->>'nextCursor' is not null and (jsonb_typeof(p_page->'nextCursor') is distinct from 'string' or length(p_page->>'nextCursor') not between 1 and 2048 or p_page->>'nextCursor' ~ '[[:cntrl:]]'))
 or jsonb_typeof(p_page->'indexedTimes') is distinct from 'array' or jsonb_array_length(p_page->'indexedTimes')>20
 or jsonb_typeof(p_page->'entries') is distinct from 'array' or jsonb_array_length(p_page->'entries')>jsonb_array_length(p_page->'indexedTimes')
 or jsonb_typeof(p_page->'fetchedAt') is distinct from 'string' or (p_page->>'fetchedAt')::timestamptz not between clock_timestamp()-interval '1 hour' and clock_timestamp()+interval '5 minutes'
 or jsonb_typeof(p_page->'contentSha256') is distinct from 'string' or p_page->>'contentSha256' !~ '^[a-f0-9]{64}$' then raise exception 'Invalid owner feedback page';end if;
 if p_page->>'nextCursor' is not null and (p_page->>'nextCursor'=coalesce(c.cursor,'') or exists(select 1 from owner_feedback.page_receipts where window_id=c.window_id and request_cursor=p_page->>'nextCursor')) then raise exception 'Invalid owner feedback cursor loop';end if;
 previous:=c.oldest_indexed_at;
 for stamp in select value from jsonb_array_elements(p_page->'indexedTimes') loop
  if jsonb_typeof(stamp) is distinct from 'string' then raise exception 'Invalid owner feedback index';end if;
  indexed:=(stamp#>>'{}')::timestamptz;
  if indexed>clock_timestamp()+interval '5 minutes' or previous is not null and indexed>previous then raise exception 'Invalid owner feedback index ordering';end if;
  previous:=indexed;
 end loop;
 if jsonb_array_length(p_page->'indexedTimes')>0 and previous<c.window_since then expected:='cutoff_reached';
 elsif p_page->>'nextCursor' is not null then expected:='pending';else expected:='feed_exhausted_before_cutoff';end if;
 if p_page->>'coverage' is distinct from expected or expected='cutoff_reached' and p_page->>'nextCursor' is not null
 or jsonb_array_length(p_page->'indexedTimes')=0 and p_page->>'nextCursor' is not null then raise exception 'Invalid owner feedback coverage';end if;
 for entry in select value from jsonb_array_elements(p_page->'entries') loop
  if jsonb_typeof(entry) is distinct from 'object' or (entry-'uri'-'cid'-'authorDid'-'rootUri'-'parentUri'-'text'-'createdAt'-'indexedAt'-'untrusted')<>'{}'::jsonb
  or entry->>'authorDid' is distinct from owner_pin or entry->'untrusted' is distinct from 'true'::jsonb
  or coalesce(entry->>'uri','') !~ uri_pattern or split_part(entry->>'uri','/',3)<>owner_pin
  or coalesce(entry->>'cid','') !~ '^bafyre[a-z2-7]{53}$'
  or coalesce(entry->>'rootUri','') !~ uri_pattern or coalesce(entry->>'parentUri','') !~ uri_pattern
  or (split_part(entry->>'rootUri','/',3)<>bot_pin and split_part(entry->>'parentUri','/',3)<>bot_pin)
  or jsonb_typeof(entry->'text') is distinct from 'string' or octet_length(entry->>'text') not between 1 and 3000 or length(btrim(entry->>'text'))=0
  or jsonb_typeof(entry->'createdAt') is distinct from 'string' or (entry->>'createdAt')::timestamptz not between c.window_since and c.window_until
  or jsonb_typeof(entry->'indexedAt') is distinct from 'string' or (entry->>'indexedAt')::timestamptz not between c.window_since and c.window_until
  or not(p_page->'indexedTimes' ? (entry->>'indexedAt')) then raise exception 'Invalid pinned owner feedback entry';end if;
  select * into prior from owner_feedback.items where uri=entry->>'uri';
  if found then
   duplicate_count:=duplicate_count+1;
   if row(prior.cid,prior.author_did,prior.root_uri,prior.parent_uri,prior.text,prior.created_at) is distinct from
   row(entry->>'cid',entry->>'authorDid',entry->>'rootUri',entry->>'parentUri',entry->>'text',(entry->>'createdAt')::timestamptz) then raise exception 'Immutable owner feedback identity conflict';end if;
  else
   new_count:=new_count+1;
   insert into owner_feedback.items(uri,cid,author_did,root_uri,parent_uri,text,created_at,indexed_at,fetched_at,first_window_id,source_sha256)
   values(entry->>'uri',entry->>'cid',owner_pin,entry->>'rootUri',entry->>'parentUri',entry->>'text',(entry->>'createdAt')::timestamptz,(entry->>'indexedAt')::timestamptz,(p_page->>'fetchedAt')::timestamptz,c.window_id,p_page->>'contentSha256');
  end if;
 end loop;
 insert into owner_feedback.page_receipts values(c.window_id,c.revision,coalesce(c.cursor,''),c.window_since,c.window_until,(p_page->>'fetchedAt')::timestamptz,p_page->>'contentSha256',jsonb_array_length(p_page->'entries'),expected);
 update owner_feedback.checkpoint set revision=revision+1,cursor=p_page->>'nextCursor',oldest_indexed_at=previous,coverage=expected where singleton;
 return owner_feedback.summary()||jsonb_build_object('newCount',new_count,'duplicateCount',duplicate_count);
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Invalid owner feedback timestamp';
end $$;
create function owner_feedback.immutable_item() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'Owner feedback immutable';end if;
 if (to_jsonb(new)-'status') is distinct from (to_jsonb(old)-'status') then raise exception 'Owner feedback immutable';end if;
 return new;
end $$;
create trigger immutable_feedback before update or delete on owner_feedback.items for each row execute function owner_feedback.immutable_item();
create function owner_feedback.immutable_page_receipt() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Owner feedback page receipt immutable';end $$;
create trigger immutable_feedback_page before update or delete on owner_feedback.page_receipts for each row execute function owner_feedback.immutable_page_receipt();
revoke all on all functions in schema owner_feedback from public,anon,authenticated,service_role;
revoke all on function public.warpcore_owner_feedback_checkpoint(),public.warpcore_owner_feedback_record_page(bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.warpcore_owner_feedback_checkpoint(),public.warpcore_owner_feedback_record_page(bigint,jsonb) to service_role;
commit;
