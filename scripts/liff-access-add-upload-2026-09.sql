-- ============================================================================
--  P4P — add /upload/ to the shared LIFF access alert
-- ============================================================================
--  Run AFTER scripts/liff-access-no-throttle-2026-09.sql.
--
--  Why
--  ---
--  /upload/ had its own, separate page-open Telegram notification
--  (lib/telegram-notify.js's formatPageOpenMessage(), sent server-side from
--  main.js's servePage()) — a one-off built before this file existed, giving
--  a plainer message ("👤 Account: email" only) through a different code
--  path than status/list/ranking's alert. Explicit decision: make it the
--  same mechanism instead of a fourth parallel one — 'upload' becomes a
--  fifth value of the same `page` column, gets the same richer message
--  (auth pass/fail, matched name/department, LINE display name/ID), and
--  main.js's bespoke send is deleted (see that commit). The client-side
--  beacon (assets/liff-access-log.js) already added '/upload/' to its PAGES
--  list, and upload/index.html now loads that script exactly like the other
--  three pages do — see those diffs for the non-SQL half of this change.
--
--  Falls under the SAME "no throttle" decision as status/list/ranking
--  (scripts/liff-access-no-throttle-2026-09.sql's `if p_page = 'verify'`
--  gate already means every OTHER page, 'upload' included, alerts
--  unconditionally — no further change needed there).
-- ============================================================================

alter table public.liff_access_log drop constraint if exists liff_access_log_page_check;
alter table public.liff_access_log add constraint liff_access_log_page_check
  check (page in ('status', 'list', 'ranking', 'verify', 'upload'));

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
  if p_page not in ('status', 'list', 'ranking', 'verify', 'upload') then
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

  v_throttle_key := coalesce(v_line_id, v_email);

  if p_page = 'verify' and v_throttle_key is not null and exists (
    select 1 from public.liff_access_log
    where throttle_key = v_throttle_key
      and page = p_page
      and accessed_at > now() - interval '10 minutes'
  ) then
    return;
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
    when 'upload'  then 'ส่งไฟล์ P4P'
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
  raise warning 'notify_liff_access failed: %', sqlerrm;
  return new;
end;
$$;
