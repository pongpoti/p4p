-- ============================================================================
--  P4P — re-enable status/list/ranking access alerts WITHOUT the LIFF SDK
-- ============================================================================
--  Run AFTER scripts/liff-access-alert-2026-08.sql.
--
--  THE PROBLEM THIS FIXES
--  -----------------------
--  liff-access-alert-2026-08.sql's first version had status/list/ranking
--  call liff.init() + liff.getProfile() client-side to capture a live LINE
--  identity for every tap. Those 3 pages had never called liff.init()
--  before, and the first-ever LIFF login handshake caused a visible double
--  page-reload in production — reverted same-day (see git history for
--  assets/liff-access-log.js). Only verify/app.js's beacon (which already
--  had a working LIFF app before any of this) was left in place.
--
--  THE FIX — still the current, live state
--  -----------------------------------------
--  status/list/ranking's beacon sends only p_page — no LIFF SDK, no
--  liff.init(), nothing that can cause a reload. log_liff_access() derives
--  the physician's LINE identity itself, from whatever
--  physicians.line_user_id/line_display_name was captured the last time they
--  actually logged in and bound LINE — the same "traceability, not security,
--  last-write-wins" data this schema already relies on elsewhere (see
--  SUPABASE_TABLES.md's `physicians` section). verify/app.js is unchanged:
--  it always captured live via its own LIFF app (there's no session yet to
--  look anything up by), and its p_line_user_id/p_line_display_name still
--  take priority when supplied — this file's function body already handled
--  that case correctly, which is why it needed no changes on the second
--  revert below.
--
--  UPDATE (2026-08-18): a single-page trial on ranking/ alone seemed to
--  confirm the reload was a one-time per-device handshake (settled after one
--  tap), so live capture was briefly restored to status/list/ranking too —
--  see git history for assets/liff-access-log.js. Broader testing
--  immediately after showed it reloading on EVERY tap instead, on every
--  page including ranking/, so it was reverted a second time, same day,
--  back to the design this file describes. Root cause unconfirmed (leading
--  theory: the `profile` scope was never actually verified enabled on those
--  3 LIFF apps' channels) — do not re-attempt live capture there without
--  real diagnostics first; it has failed twice.
--
--  Also fixes a throttle gap: the original throttle key was line_user_id
--  alone, so a physician who never completed a LINE bind (line_user_id
--  stays null) would never throttle at all — every repeat page view/refresh
--  would alert. The key is now coalesce(line_user_id, email); every
--  authenticated call has an email, so this population throttles correctly
--  too. verify/'s anonymous calls are unaffected when both are null (a LIFF
--  failure with no session) — those still alert every time, same as before.
-- ============================================================================

alter table public.liff_access_log add column if not exists throttle_key text;

drop index if exists public.liff_access_log_throttle_idx;
create index if not exists liff_access_log_throttle_idx
  on public.liff_access_log (throttle_key, page, accessed_at desc);

create or replace function public.log_liff_access(
  p_page               text,
  p_line_user_id       text default null,
  p_line_display_name  text default null,
  p_client_error       text default null,
  p_bounce_reason      text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email            text := auth.jwt() ->> 'email';
  v_auth_pass        boolean := false;
  v_full_name        text;
  v_department       text;
  v_stored_line_id   text;
  v_stored_line_name text;
  v_line_id          text;
  v_line_name        text;
  v_throttle_key     text;
begin
  if p_page not in ('status', 'list', 'ranking', 'verify') then
    raise exception 'log_liff_access: unknown page %', p_page;
  end if;

  -- status/list/ranking (authenticated calls, via P4P.db's server-injected
  -- access token) send no LINE identity at all anymore — it comes from here
  -- instead. verify/app.js (anonymous, no session yet) still sends its own
  -- live-captured p_line_user_id/p_line_display_name, which win via coalesce
  -- below when present.
  if v_email is not null then
    select p.full_name, p.department, p.line_user_id, p.line_display_name
      into v_full_name, v_department, v_stored_line_id, v_stored_line_name
    from public.physicians p
    where p.email = lower(v_email) and p.active;
    v_auth_pass := found;
  end if;

  v_line_id   := coalesce(p_line_user_id, v_stored_line_id);
  v_line_name := coalesce(p_line_display_name, v_stored_line_name);

  -- Falls back to email so an authenticated physician who never bound LINE
  -- (v_line_id stays null) still throttles correctly. verify/'s anonymous
  -- calls with neither available are simply never throttled, as before.
  v_throttle_key := coalesce(v_line_id, v_email);

  if v_throttle_key is not null and exists (
    select 1 from public.liff_access_log
    where throttle_key = v_throttle_key
      and page = p_page
      and accessed_at > now() - interval '10 minutes'
  ) then
    return; -- throttled — no row, no alert
  end if;

  insert into public.liff_access_log (
    page, line_user_id, line_display_name, auth_pass,
    matched_email, matched_full_name, matched_department,
    bounce_reason, client_error, throttle_key
  ) values (
    p_page, v_line_id, nullif(trim(v_line_name), ''), v_auth_pass,
    case when v_auth_pass then lower(v_email) end, v_full_name, v_department,
    nullif(trim(p_bounce_reason), ''), nullif(trim(p_client_error), ''), v_throttle_key
  );
end;
$$;

revoke all on function public.log_liff_access(text, text, text, text, text) from public;
grant execute on function public.log_liff_access(text, text, text, text, text) to anon, authenticated;
