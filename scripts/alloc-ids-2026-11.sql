-- ============================================================================
--  alloc-ids-2026-11.sql — the 4 digits from เอกสารจัดสรร (step 29).
--
--  Pong, 2026-11-18: each month the hospital sends เอกสารจัดสรร in advance,
--  its list of everyone paid that month. Its No column is
--  "ID-<yy>-<MM>-<4 digits>". The owner or the ผู้จัดทำ uploads it from the
--  month card's ข้อมูล button (ภาพรวม); the app keeps only the 4 digits of each doctor in
--  the month's roster, and the allocation sheet (รายละเอียดการจัดสรรเงิน
--  รายบุคคล) writes them after "ID-<yy>-<MM>-" in its No column.
--
--  What it makes:
--    1. alloc_ids      one row per doctor and month: the 4 digits, and how
--                      they were found (exact name, close spelling, typed);
--    2. alloc_uploads  one row per month: the last upload (file name, rows,
--                      the names it could not place);
--    3. alloc_ids_save (an upload: the month's digits replaced, typed ones
--                      kept for people the new file does not have) and
--       alloc_id_set   (one person's 4 digits typed on the page).
--  The uploaded file itself is never stored (it has the whole hospital).
--  Both tables and both functions are service_role only.
--
--  Needs nothing else. Safe to re-run. No backslashes, so it pastes
--  through chat.
-- ============================================================================

create table if not exists public.alloc_ids (
  month        text not null check (month ~ '^[0-9]{4}_[0-9]{2}$'),
  roster_index uuid not null,
  no4          text not null check (no4 ~ '^[0-9]{4}$'),
  how          text not null check (how in ('exact', 'close', 'manual')),
  updated_at   timestamptz not null default now(),
  updated_by   text not null default '',
  primary key (month, roster_index)
);

create table if not exists public.alloc_uploads (
  month        text primary key check (month ~ '^[0-9]{4}_[0-9]{2}$'),
  file_name    text not null default '' check (char_length(file_name) <= 200),
  sheet_name   text not null default '' check (char_length(sheet_name) <= 100),
  sheet_rows   int  not null check (sheet_rows >= 0),
  roster_rows  int  not null check (roster_rows >= 0),
  close        jsonb not null default '[]'::jsonb,   -- [{index, name, sheetName, no4}]
  missing      jsonb not null default '[]'::jsonb,   -- [{index, name, department, suggest}]
  ambiguous    jsonb not null default '[]'::jsonb,   -- [{index, name, department, nos}]
  uploaded_at  timestamptz not null default now(),
  uploaded_by  text not null default ''
);

alter table public.alloc_ids enable row level security;
alter table public.alloc_uploads enable row level security;
revoke all on table public.alloc_ids from public, anon, authenticated;
revoke all on table public.alloc_uploads from public, anon, authenticated;
grant select, insert, update, delete on table public.alloc_ids to service_role;
grant select, insert, update, delete on table public.alloc_uploads to service_role;

-- An upload. p_rows: [{roster_index, no4, how}], how exact or close. p_upload:
-- {file_name, sheet_name, sheet_rows, roster_rows, close, missing,
-- ambiguous}. The month's digits from the last file are replaced; one typed
-- on the page stays unless the new file has that person by exact name (a
-- close spelling never overwrites what someone typed). The names still
-- without digits are kept for the page, less those typed earlier.
create or replace function public.alloc_ids_save(p_month text, p_rows jsonb, p_upload jsonb, p_actor text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.alloc_uploads;
begin
  if p_month is null or p_month !~ '^[0-9]{4}_[0-9]{2}$' then raise exception 'alloc: bad month'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_typeof(p_upload) is distinct from 'object' then
    raise exception 'alloc: bad rows';
  end if;
  delete from public.alloc_ids where month = p_month and how <> 'manual';
  insert into public.alloc_ids (month, roster_index, no4, how, updated_at, updated_by)
  select p_month, x.roster_index, x.no4, x.how, now(), coalesce(p_actor, '')
    from jsonb_to_recordset(p_rows) as x(roster_index uuid, no4 text, how text)
  on conflict (month, roster_index) do update
     set no4 = excluded.no4, how = excluded.how, updated_at = excluded.updated_at, updated_by = excluded.updated_by
   where excluded.how = 'exact';
  insert into public.alloc_uploads as u (month, file_name, sheet_name, sheet_rows, roster_rows, close, missing, ambiguous, uploaded_at, uploaded_by)
  values (
    p_month,
    left(coalesce(p_upload->>'file_name', ''), 200),
    left(coalesce(p_upload->>'sheet_name', ''), 100),
    coalesce((p_upload->>'sheet_rows')::int, 0),
    coalesce((p_upload->>'roster_rows')::int, 0),
    coalesce(p_upload->'close', '[]'::jsonb),
    coalesce((select jsonb_agg(m) from jsonb_array_elements(coalesce(p_upload->'missing', '[]'::jsonb)) m
               where not exists (select 1 from public.alloc_ids a
                                  where a.month = p_month and a.roster_index::text = m->>'index')), '[]'::jsonb),
    coalesce((select jsonb_agg(m) from jsonb_array_elements(coalesce(p_upload->'ambiguous', '[]'::jsonb)) m
               where not exists (select 1 from public.alloc_ids a
                                  where a.month = p_month and a.roster_index::text = m->>'index')), '[]'::jsonb),
    now(), coalesce(p_actor, ''))
  on conflict (month) do update
     set file_name = excluded.file_name, sheet_name = excluded.sheet_name, sheet_rows = excluded.sheet_rows,
         roster_rows = excluded.roster_rows, close = excluded.close, missing = excluded.missing,
         ambiguous = excluded.ambiguous, uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by
  returning * into v;
  return to_jsonb(v) || jsonb_build_object('count', (select count(*) from public.alloc_ids where month = p_month));
end;
$$;
revoke all on function public.alloc_ids_save(text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.alloc_ids_save(text, jsonb, jsonb, text) to service_role;

-- One person's 4 digits typed on the page (someone the file did not place).
-- They leave the page's lists of names still without digits.
create or replace function public.alloc_id_set(p_month text, p_index uuid, p_no4 text, p_actor text)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  if p_month is null or p_month !~ '^[0-9]{4}_[0-9]{2}$' then raise exception 'alloc: bad month'; end if;
  if p_no4 is null or p_no4 !~ '^[0-9]{4}$' then raise exception 'alloc: bad digits'; end if;
  if p_index is null then raise exception 'alloc: bad index'; end if;
  insert into public.alloc_ids (month, roster_index, no4, how, updated_at, updated_by)
  values (p_month, p_index, p_no4, 'manual', now(), coalesce(p_actor, ''))
  on conflict (month, roster_index) do update
     set no4 = excluded.no4, how = 'manual', updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  update public.alloc_uploads
     set missing = coalesce((select jsonb_agg(m) from jsonb_array_elements(missing) m where m->>'index' <> p_index::text), '[]'::jsonb),
         ambiguous = coalesce((select jsonb_agg(m) from jsonb_array_elements(ambiguous) m where m->>'index' <> p_index::text), '[]'::jsonb)
   where month = p_month;
  return jsonb_build_object('index', p_index, 'no4', p_no4, 'count', (select count(*) from public.alloc_ids where month = p_month));
end;
$$;
revoke all on function public.alloc_id_set(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.alloc_id_set(text, uuid, text, text) to service_role;

-- Check: tables_2 = 2, functions_2 = 2, anon_0 = 0.
select
  (select count(*) from pg_tables where schemaname = 'public' and tablename in ('alloc_ids', 'alloc_uploads')) as tables_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('alloc_ids_save', 'alloc_id_set')) as functions_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('alloc_ids_save', 'alloc_id_set')
      and has_function_privilege('anon', p.oid, 'execute'))
  + (select count(*) from pg_tables where schemaname = 'public' and tablename in ('alloc_ids', 'alloc_uploads')
      and has_table_privilege('anon', 'public.' || tablename, 'select')) as anon_0;
