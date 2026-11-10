-- ============================================================================
--  audit-fixes-2026-11.sql — database half of the 2026-11-10 code audit
--  (findings F01, F13, F09).
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


-- PART 1 — F01: an email sender is never added to physicians on its own.
--   bump_sender_match records every sender the email pipeline matched to a
--   roster name, and that name comes from the file, so it proves nothing
--   about who sent it. The old trigger made that address an active
--   physician under the matched name (a login, and the victim's LINE upload
--   identity) and renamed an existing physicians row to the matched name.
--   Now an address with no physicians row gets an open access request
--   (name = matched roster name) for an admin to approve; an address that
--   already has a physicians row, active or not, is left alone; a resolved
--   (approved or rejected) request is never reopened.
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

create or replace function public.sync_physician_from_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(new.sender_email, '')));
  v_name  text := public.clean_request_text(new.matched_physician, 100);
  v_dept  text := public.clean_request_text(new.department, 100);
begin
  if not new.matched or v_email = '' or v_name is null then
    return new;
  end if;
  if exists (select 1 from public.physicians p where p.email = v_email) then
    return new;
  end if;
  insert into public.access_requests (email, name, department, requested_at, request_count, resolved)
  values (v_email, v_name, v_dept, now(), 1, false)
  on conflict (email) do update
    set requested_at  = now(),
        request_count = public.access_requests.request_count + 1
    where not public.access_requests.resolved;
  return new;
end;
$$;
revoke all on function public.sync_physician_from_match() from public, anon, authenticated;

drop trigger if exists trg_sync_physician_from_match on public.sender_physician_match;
create trigger trg_sync_physician_from_match
  after insert or update on public.sender_physician_match
  for each row execute function public.sync_physician_from_match();

commit;


-- PART 2 — F13: log_access_request (anon, called by /verify/ before login).
--   It takes any address, so it must not let a caller rename or reopen
--   someone else's request: an open request keeps its name and department
--   (only requested_at and request_count move), a resolved one is not
--   touched, and an active physician gets no request at all. Input is
--   cleaned as the 2026-08-07 live hardening did (security-hardening
--   Appendix B): control characters out, whitespace collapsed, name and
--   department capped at 100, a blank name or a malformed address writes
--   nothing.
begin;

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
  -- Basic shape, no backslashes: name@domain.tld in plain ASCII.
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
        request_count = public.access_requests.request_count + 1
    where not public.access_requests.resolved;
end;
$$;
revoke all on function public.log_access_request(text, text, text) from public;
grant execute on function public.log_access_request(text, text, text) to anon, authenticated;

commit;


-- PART 3 — F09: reclaim upload-queue rows a dead runner left in 'processing'.
--   The drain sets 'processing' when it claims a row. If the runner dies
--   before it writes the outcome, the row used to stay 'processing' for
--   good, and p4p_upload_queue_one_inflight then refused every new upload
--   for that physician and month. Now a row claimed more than 30 minutes ago
--   is claimed again while it has attempts left (the same 3 as before); with
--   none left it becomes 'failed' (error_type 'stuck_processing'), which
--   frees the month for a new upload and shows up for the admin.
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
                   or received_at < now() - interval '30 seconds'))
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


-- Checks to run by hand afterwards:
--   select email, full_name, created_at from public.physicians
--    where source = 'matched_sender' order by created_at desc;
--   -- rows the old trigger added by itself: confirm each address really
--   -- belongs to that physician, set active = false for any that does not
