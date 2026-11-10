-- ============================================================================
--  audit-fixes-2026-11.sql — database half of the 2026-11-10 code audit
--  (findings F13, F09, F17, F10; F01 is left as it is, by the owner's choice).
--
--  Paste into the Supabase SQL editor after SUPABASE_MIGRATIONS.md steps
--  14, 15 and 18 (it needs physicians, access_requests.department and
--  p4p_upload_queue); it is step 24. Safe to paste again. Each PART has its own
--  begin/commit, so if the editor refuses the whole file, paste it one PART
--  at a time, in order.
--
--  The functions below are defined only here now. The older scripts that
--  used to define them no longer do, so pasting one of those again cannot
--  bring the old behaviour back.
-- ============================================================================


-- PART 1 — F13: log_access_request (anon, called by /verify/ before login).
--   It takes any address, so it must not let a caller rename someone
--   else's open request: an open request keeps its name and department
--   (only requested_at and request_count move), and an active physician
--   gets no request at all. A resolved request (rejected, or approved and
--   later deactivated) is opened again as a new one, with the name and
--   department given now, so that person can still ask again. Input is
--   cleaned as the 2026-08-07 live hardening did (security-hardening
--   Appendix B): control characters out, whitespace collapsed, name and
--   department capped at 100, a blank name or a malformed address writes
--   nothing.
begin;

alter table public.access_requests add column if not exists department text;

-- Shared cleaning for self-reported text: control characters, line and
-- paragraph separators become spaces, zero-width and bidi marks go, runs of
-- whitespace collapse to one space, the result is trimmed and capped.
-- Written with chr() so the file has no backslash escapes.
create or replace function public.clean_request_text(p text, p_max integer)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(trim(left(trim(regexp_replace(
    translate(translate(coalesce(p, ''), chr(8232) || chr(8233), '  '),
              chr(8203) || chr(8204) || chr(8205) || chr(8206) || chr(8207)
              || chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238)
              || chr(8294) || chr(8295) || chr(8296) || chr(8297) || chr(65279), ''),
    '[[:space:][:cntrl:]]+', ' ', 'g')), p_max)), '');
$$;
revoke all on function public.clean_request_text(text, integer) from public, anon, authenticated;


drop function if exists public.log_access_request(text);
drop function if exists public.log_access_request(text, text);

create or replace function public.log_access_request(
  p_email      text,
  p_name       text default null,
  p_department text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name  text := public.clean_request_text(p_name, 100);
  v_dept  text := public.clean_request_text(p_department, 100);
begin
  -- Basic shape, no backslashes: an address like name@example.com, plain ASCII.
  if length(v_email) > 254
     or v_email !~ '^[a-z0-9._%+-]+@[a-z0-9-]+([.][a-z0-9-]+)+$' then
    return;
  end if;
  if v_name is null then
    return;
  end if;
  if exists (select 1 from public.physicians p where p.email = v_email and p.active) then
    return;
  end if;
  insert into public.access_requests (email, name, department, requested_at, request_count, resolved)
  values (v_email, v_name, v_dept, now(), 1, false)
  on conflict (email) do update
    set requested_at  = now(),
        request_count = public.access_requests.request_count + 1,
        name          = case when public.access_requests.resolved
                             then excluded.name
                             else public.access_requests.name end,
        department    = case when public.access_requests.resolved
                             then excluded.department
                             else public.access_requests.department end,
        resolved      = false;
end;
$$;
revoke all on function public.log_access_request(text, text, text) from public;
grant execute on function public.log_access_request(text, text, text) to anon, authenticated;

commit;


-- PART 2 — F09: reclaim upload-queue rows a dead runner left in 'processing'.
--   The drain sets 'processing' when it claims a row. If the runner dies
--   before it writes the outcome, the row used to stay 'processing' for
--   good, and p4p_upload_queue_one_inflight then refused every new upload
--   for that physician and month. Now a row claimed more than 30 minutes ago
--   is claimed again while it has attempts left (the same 3 as before); with
--   none left it becomes 'failed' (error_type 'stuck_processing'), which
--   frees the month for a new upload and shows up for the admin.
--   A row put back to 'pending' after a failed attempt waits 5 minutes per
--   attempt so far before it is claimed again, so a Drive or database blip
--   of a few minutes does not use up all 3 attempts within seconds.
begin;

create or replace function public.claim_p4p_score_fallback()
returns setof public.p4p_upload_queue
language plpgsql
set search_path = public
as $$
begin
  update public.p4p_upload_queue
     set status       = 'failed',
         error_type   = 'stuck_processing',
         error_detail = 'ระบบประมวลผลไฟล์นี้ไม่เสร็จ กรุณาส่งไฟล์อีกครั้ง',
         finished_at  = now()
   where status = 'processing'
     and attempts >= 3
     and coalesce(claimed_at, received_at) < now() - interval '30 minutes';

  -- The 30-second clause gives /upload/score its head start on rows it has
  -- not looked at yet (see line-upload-2026-09.sql PART 5).
  return query
  update public.p4p_upload_queue q
     set status = 'processing', attempts = q.attempts + 1, claimed_at = now()
   where q.id = (
     select id from public.p4p_upload_queue
      where attempts < 3
        and ((status = 'pending'
              and (score_method is not null
                   or received_at < now() - interval '30 seconds')
              and (claimed_at is null
                   or claimed_at < now() - attempts * interval '5 minutes'))
          or (status = 'processing'
              and coalesce(claimed_at, received_at) < now() - interval '30 minutes'))
      order by received_at
      limit 1
      for update skip locked)
  returning q.*;
end;
$$;
revoke all on function public.claim_p4p_score_fallback() from public, anon, authenticated;
grant execute on function public.claim_p4p_score_fallback() to service_role;

commit;


-- PART 3 — F17: an older upload never overwrites a newer one in Drive.
--   Drive keeps one file per physician and month, replaced by name. An
--   older row whose archive failed and is backing off must not be archived
--   once a newer upload for the same email and month is scored or archived:
--   it gets archive_status 'superseded' instead (a new value, added to the
--   check constraint here) and is never claimed again.
--   Such a row's uploaded workbook, and that of a row PART 2 failed as
--   'stuck_processing', would otherwise stay in the p4p-uploads bucket for
--   good: nothing claims them again. The drain deletes those objects
--   (drain-uploads.ts sweepLeftoverObjects) and stamps the new column
--   object_deleted_at, so each row is done once.
begin;

alter table public.p4p_upload_queue add column if not exists object_deleted_at timestamptz;

do $$
declare r record;
begin
  for r in
    select c.conname from pg_constraint c
     where c.conrelid = 'public.p4p_upload_queue'::regclass and c.contype = 'c'
       and pg_get_constraintdef(c.oid) like '%archive_status%'
       and pg_get_constraintdef(c.oid) not like '%superseded%'
  loop
    execute format('alter table public.p4p_upload_queue drop constraint %I', r.conname);
  end loop;
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.p4p_upload_queue'::regclass and c.contype = 'c'
       and pg_get_constraintdef(c.oid) like '%archive_status%'
  ) then
    alter table public.p4p_upload_queue add constraint p4p_upload_queue_archive_status_check
      check (archive_status in ('archive_pending', 'archived', 'superseded'));
  end if;
end $$;

create or replace function public.claim_p4p_archive()
returns setof public.p4p_upload_queue
language plpgsql
set search_path = public
as $$
begin
  update public.p4p_upload_queue o
     set archive_status = 'superseded'
   where o.id in (
     select o2.id from public.p4p_upload_queue o2
      where o2.archive_status = 'archive_pending'
        and exists (
          select 1 from public.p4p_upload_queue n
           where n.email = o2.email
             and n.month_key = o2.month_key
             and n.received_at > o2.received_at
             and (n.status = 'done' or n.archive_status = 'archived'))
      for update of o2 skip locked);

  -- Backoff 1h, 2h, 4h ... capped at 24h (line-upload-2026-09.sql PART 5).
  return query
  update public.p4p_upload_queue q
     set archive_attempts = q.archive_attempts + 1,
         archive_last_attempt_at = now()
   where q.id = (
     select id from public.p4p_upload_queue
      where archive_status = 'archive_pending'
        and (archive_last_attempt_at is null
             or archive_last_attempt_at
                < now() - make_interval(hours => least(24, 2 ^ greatest(0, archive_attempts - 1))::int))
      order by received_at
      limit 1
      for update skip locked)
  returning q.*;
end;
$$;
revoke all on function public.claim_p4p_archive() from public, anon, authenticated;
grant execute on function public.claim_p4p_archive() to service_role;

commit;


-- PART 4 — F10: drop the retired anon-reachable functions for good.
--   list_all_physicians() returned every roster name to anon;
--   get_line_bind_gate_status(text) and bind_line_user_id(text, text) are
--   the retired LINE-bind gate. DATA_EXPOSURE_ANALYSIS.md section 5 records
--   all three as already gone from the live project; this makes that true
--   for any project built from these scripts too. If something still
--   depends on one, it stays, but with no grants left.
begin;

do $$
declare f text;
begin
  foreach f in array array['public.list_all_physicians()',
                           'public.get_line_bind_gate_status(text)',
                           'public.bind_line_user_id(text, text)'] loop
    if to_regprocedure(f) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', f);
      begin
        execute format('drop function %s', f);
      exception when dependent_objects_still_exist then
        raise warning 'kept % because something depends on it; nobody can call it: %', f, sqlerrm;
      end;
    end if;
  end loop;
end $$;

commit;


-- Checks to run by hand afterwards:
--   select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
--    order by 1;
--   -- expect no list_all_physicians, get_line_bind_gate_status, bind_line_user_id
