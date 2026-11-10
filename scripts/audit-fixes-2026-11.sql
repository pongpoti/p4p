-- ============================================================================
--  audit-fixes-2026-11.sql — database half of the 2026-11-10 code audit
--  (findings F01).
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


-- Checks to run by hand afterwards:
--   select email, full_name, created_at from public.physicians
--    where source = 'matched_sender' order by created_at desc;
--   -- rows the old trigger added by itself: confirm each address really
--   -- belongs to that physician, set active = false for any that does not
