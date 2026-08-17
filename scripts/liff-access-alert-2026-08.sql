-- ============================================================================
--  P4P — Telegram alert every time a physician opens a rich-menu LIFF page
-- ============================================================================
--  ⚠️  VERIFY BEFORE ENABLING, same caveat as notify-access-request.sql: needs
--      the pg_net extension and Supabase Vault, and makes a real outbound HTTP
--      call — none of that can be exercised in a plain Postgres. Test on a
--      staging project first.
--
--  Why
--  ---
--  verify/ (the bounce target for a failed/expired/blocked session — the only
--  page a FAILED rich-menu tap ever reaches) reports one "I was opened" beacon
--  per page load — see verify/app.js. This file is that beacon's landing
--  spot: a table for the audit trail, plus a trigger that turns each row into
--  a Telegram message. Reuses the same bot/chat as notify_access_request()
--  (Database → Vault secrets: telegram_bot_token, telegram_chat_id) — no new
--  bot to set up.
--
--  status/list/ranking do NOT call this yet. A first pass added the LIFF SDK
--  + a matching beacon (assets/liff-access-log.js) to those 3 pages too, but
--  they had never called liff.init() before, and the first-ever handshake
--  caused a visible double page-reload for every physician tapping the rich
--  menu — reverted (see git history for assets/liff-access-log.js) until the
--  `profile` scope is confirmed on those 3 LIFF apps and the reload is
--  understood. The table/RPC/trigger below are unchanged and still needed
--  for verify/'s beacon.
--
--  Trust model
--  -----------
--  Only line_user_id / line_display_name / client_error are taken from the
--  caller (best-effort LIFF SDK output — there is nothing to verify them
--  against server-side, same "traceability, not security" posture as
--  physicians.line_user_id elsewhere in this schema). auth_pass and the
--  matched_* columns are derived by log_liff_access() itself from auth.jwt(),
--  exactly like is_current_user_allowlisted() — never from a client-supplied
--  flag, so a forged RPC call can't fabricate a fake "auth passed, matched
--  Dr. X" alert.
--
--  Setup
--  -----
--    1. Run this file (creates the table, the RPC, and the trigger).
--    2. Test: force an expired/blocked session (or just don't log in) and tap
--       a rich-menu button; confirm the auth_pass=false alert on /verify/.
--
--  Re-enabling status/list/ranking later needs, at minimum: confirming the
--  `profile` scope on the 3 rich-menu LIFF apps (2008561527-a0xP1XmY /
--  status, 2008561527-wyje9amz / list, 2008561527-BXrxUUDb / ranking) in the
--  LINE Developers console, AND understanding why liff.init() caused a
--  double reload there before trying again.
-- ============================================================================

create table if not exists public.liff_access_log (
  id                 bigint generated always as identity primary key,
  accessed_at        timestamptz not null default now(),
  page               text not null check (page in ('status', 'list', 'ranking', 'verify')),
  line_user_id       text,
  line_display_name  text,
  auth_pass          boolean not null,
  matched_email      text,
  matched_full_name  text,
  matched_department text,
  bounce_reason      text,
  client_error       text
);

-- Backs both the throttle lookup in log_liff_access() and any future "who
-- opened what, when" query over the audit trail.
create index if not exists liff_access_log_throttle_idx
  on public.liff_access_log (line_user_id, page, accessed_at desc);

alter table public.liff_access_log enable row level security;
-- No anon/authenticated policies at all — same posture as access_requests
-- and physicians. Reachable only through log_liff_access() (SECURITY
-- DEFINER) below, never a direct table read/write from the browser.

-- ----------------------------------------------------------------------------
-- log_liff_access — called once per page load from the browser
-- (assets/liff-access-log.js on status/list/ranking, verify/app.js on
-- /verify/).
--
-- Throttled per (line_user_id, page): a repeat open inside the window is
-- dropped silently (no row inserted, so no trigger fire) so a physician
-- tapping the menu a few times in a row doesn't flood the chat. Never
-- throttled when line_user_id is null (a LIFF init/profile failure, or a
-- visitor who isn't logged into LIFF at all) — those are rarer and worth
-- seeing every time.
-- ----------------------------------------------------------------------------
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
  v_email      text := auth.jwt() ->> 'email';
  v_auth_pass  boolean := false;
  v_full_name  text;
  v_department text;
begin
  if p_page not in ('status', 'list', 'ranking', 'verify') then
    raise exception 'log_liff_access: unknown page %', p_page;
  end if;

  if p_line_user_id is not null and exists (
    select 1 from public.liff_access_log
    where line_user_id = p_line_user_id
      and page = p_page
      and accessed_at > now() - interval '10 minutes'
  ) then
    return; -- throttled — no row, no alert
  end if;

  -- Derived here, never trusted from the caller: status/list/ranking always
  -- call this authenticated (P4P.db on those pages carries the access token
  -- main.js already injected after gating the request through
  -- is_current_user_allowlisted()), so a JWT email present here means auth
  -- genuinely passed. verify/app.js calls this with the anon key, before any
  -- login exists, so v_email is null there and auth_pass stays false —
  -- p_bounce_reason (no_session / expired / blocked) carries why.
  if v_email is not null then
    select p.full_name, p.department into v_full_name, v_department
    from public.physicians p
    where p.email = lower(v_email) and p.active;
    v_auth_pass := found;
  end if;

  insert into public.liff_access_log (
    page, line_user_id, line_display_name, auth_pass,
    matched_email, matched_full_name, matched_department,
    bounce_reason, client_error
  ) values (
    p_page, p_line_user_id, nullif(trim(p_line_display_name), ''), v_auth_pass,
    case when v_auth_pass then lower(v_email) end, v_full_name, v_department,
    nullif(trim(p_bounce_reason), ''), nullif(trim(p_client_error), '')
  );
end;
$$;

revoke all on function public.log_liff_access(text, text, text, text, text) from public;
grant execute on function public.log_liff_access(text, text, text, text, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- notify_liff_access — one Telegram message per (non-throttled) row. Same
-- shape as notify_access_request(): reads Vault, sends via pg_net, never lets
-- a notification failure fail the insert that triggered it.
-- ----------------------------------------------------------------------------
create or replace function public.notify_liff_access()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token      text;
  v_chat       text;
  v_text       text;
  v_page_label text;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';
  select decrypted_secret into v_chat  from vault.decrypted_secrets where name = 'telegram_chat_id';
  if v_token is null or v_chat is null then
    raise warning 'notify_liff_access: telegram secrets missing in Vault';
    return new;
  end if;

  v_page_label := case new.page
    when 'status'  then 'สถานะการส่ง'
    when 'list'    then 'รายชื่อแพทย์'
    when 'ranking' then 'อันดับการส่ง'
    when 'verify'  then 'ยืนยันตัวตน'
    else new.page
  end;

  v_text := '🔔 เข้าใช้งาน P4P ผ่าน LINE' || E'\n'
         || '👤 ชื่อ LINE : ' || coalesce(new.line_display_name, '—') || E'\n'
         || '🆔 LINE ID   : ' || coalesce(new.line_user_id, '—') || E'\n'
         || '🕐 เวลา      : ' || to_char(new.accessed_at at time zone 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') || ' น.' || E'\n'
         || '📄 ฟังก์ชัน  : ' || v_page_label || E'\n'
         || case
              when new.auth_pass then
                '✅ ยืนยันตัวตน: ผ่าน (' || coalesce(new.matched_full_name, '—') || ' / '
                  || coalesce(new.matched_department, '—') || ' / ' || coalesce(new.matched_email, '—') || ')'
              else
                '⛔ ยืนยันตัวตน: ไม่ผ่าน' ||
                  case when new.bounce_reason is not null then ' (' || new.bounce_reason || ')' else '' end
            end
         || case when new.client_error is not null then E'\n' || '❌ ข้อผิดพลาด: ' || new.client_error else '' end;

  perform net.http_post(
    url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body    := jsonb_build_object('chat_id', v_chat, 'text', v_text),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  return new;
exception when others then
  -- Never let a notification failure block the beacon insert.
  raise warning 'notify_liff_access failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists trg_notify_liff_access on public.liff_access_log;
create trigger trg_notify_liff_access
  after insert on public.liff_access_log
  for each row execute function public.notify_liff_access();
