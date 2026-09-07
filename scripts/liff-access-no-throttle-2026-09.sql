-- ============================================================================
--  P4P — stop throttling status/list/ranking's access alert
-- ============================================================================
--  Run AFTER scripts/liff-access-server-side-2026-08.sql.
--
--  Why
--  ---
--  Explicit product decision (2026-09): status/list/ranking should alert on
--  EVERY open, matching the unthrottled page-open notification main.js sends
--  for /upload/ (lib/telegram-notify.js's formatPageOpenMessage()). The
--  10-minute dedup window that file's own header documents — added
--  specifically so "a physician tapping the menu a few times in a row
--  doesn't flood the chat" — is a deliberate tradeoff this decision accepts
--  the other side of: every repeat open now alerts too.
--
--  verify/ keeps its throttle, unchanged. It is reached by a FAILED or
--  expired rich-menu tap, and a broken session can bounce a physician back
--  there repeatedly in a way a normal page open never does — that is exactly
--  the failure mode a dedup window exists to absorb, and nothing in this
--  decision is about verify/.
--
--  What this incidentally explains, not fixes
--  --------------------------------------------
--  Querying liff_access_log turned up five cases (2026-09-02/03) of the same
--  throttle_key + page producing two rows 1-95ms apart — four of them the
--  same physician, all on 'status'. That is too fast to be a human re-tap
--  and too slow to be a SQL-transaction race (log_liff_access() is a single
--  statement per call; there is no window between a check and an insert for
--  two calls to race inside). The two inserts are two genuinely separate
--  RPC calls arriving back-to-back — i.e., the PAGE loaded and ran its
--  scripts twice for one visit, most likely a duplicate top-level navigation
--  fired by LINE's client or a flaky connection retrying it, concentrated on
--  'status' because reaching it costs an extra LIFF hop (main menu ->
--  richmenuswitch to the month-picker -> a month cell's own uri action) that
--  list/ranking's direct uri taps don't have. Nothing in this codebase
--  issues a second request — no duplicate <script> tag (checked
--  status/index.html), no client-side redirect or reload (checked
--  status/app.js and assets/liff-access-log.js) — so there is no code-level
--  fix available here. Removing the throttle below does not fix this; it
--  makes it moot for status/list/ranking, since every open (single or
--  duplicated) now alerts on its own terms rather than racing a dedup check.
-- ============================================================================

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

  if v_email is not null then
    select p.full_name, p.department, p.line_user_id, p.line_display_name
      into v_full_name, v_department, v_stored_line_id, v_stored_line_name
    from public.physicians p
    where p.email = lower(v_email) and p.active;
    v_auth_pass := found;
  end if;

  v_line_id   := coalesce(p_line_user_id, v_stored_line_id);
  v_line_name := coalesce(p_line_display_name, v_stored_line_name);

  -- Still computed and stored for every row (useful for a "how many times
  -- did X open this" query later) — just no longer a gate, except on verify/.
  v_throttle_key := coalesce(v_line_id, v_email);

  if p_page = 'verify' and v_throttle_key is not null and exists (
    select 1 from public.liff_access_log
    where throttle_key = v_throttle_key
      and page = p_page
      and accessed_at > now() - interval '10 minutes'
  ) then
    return; -- throttled — no row, no alert (verify/ only)
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
