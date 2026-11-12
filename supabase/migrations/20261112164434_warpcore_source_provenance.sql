-- Additive attribution metadata; existing access controls/RLS remain unchanged.
alter table public.warpcore_candidates
 add column source_links jsonb not null default '[]'::jsonb
 check(jsonb_typeof(source_links)='array' and jsonb_array_length(source_links)<=20),
 add column native_uri text check(native_uri is null or length(native_uri) between 1 and 2048),
 add column native_url text;
update public.warpcore_candidates set source_links=jsonb_build_array(source_url) where source_url is not null;
create or replace function public.warpcore_ingest(items jsonb) returns void
language plpgsql security invoker set search_path='' as $fn$
begin
 if jsonb_typeof(items)<>'array' or jsonb_array_length(items)>5000 then raise exception 'invalid ingest batch';end if;
 insert into public.warpcore_stories(story_key)
 select distinct x.story_key from jsonb_to_recordset(items) as x(story_key text)
 order by x.story_key on conflict do nothing;
 insert into public.warpcore_candidates(uri,story_key,source_type,source_id,actor,text,source_created_at,source_url,source_links,native_uri,native_url)
 select uri,story_key,source_type,source_id,actor,text,source_created_at,source_url,
 coalesce(source_links,case when source_url is null then '[]'::jsonb else jsonb_build_array(source_url) end),native_uri,native_url
 from jsonb_to_recordset(items) as x(uri text,story_key text,source_type text,source_id text,actor text,text text,source_created_at timestamptz,source_url text,source_links jsonb,native_uri text,native_url text)
 order by uri on conflict do nothing;
end;$fn$;
revoke all on function public.warpcore_ingest(jsonb) from public,anon,authenticated;
grant execute on function public.warpcore_ingest(jsonb) to service_role;
