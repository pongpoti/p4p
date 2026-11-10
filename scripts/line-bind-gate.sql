-- ============================================================================
--  P4P — Hard requirement: know every physician's LINE userId on first verify
-- ============================================================================
--  Run scripts/bind-line-user.sql and scripts/line-user-id-columns.sql FIRST.
--
--  Context: bind_line_user_id() was previously best-effort — any failure
--  (LIFF scope, network, etc.) was silently swallowed and login proceeded
--  with no binding recorded. The business rule is now: we MUST know every
--  physician's LINE userId as of their first verification. This adds:
--
--    1. line_bind_attempts — counts failed bind attempts per email (separate
--       from line_user_bindings, which only ever holds SUCCESSFUL binds).
--    2. record_bind_failure() — called by the client when a bind attempt
--       fails. After 3 failed attempts, fires one Telegram alert (same Vault
--       secrets as notify_access_request()) and never repeats it, so an
--       admin can manually follow up instead of the physician being blocked
--       forever over a device/permission issue outside their control.
--    3. get_line_bind_gate_status(email) — single-round-trip status check
--       used by main.js on every gated-page request: is this email blocked,
--       is it already bound, and how many failed attempts so far. Callable
--       by anon (same posture as is_sender_allowlisted — a yes/no/count
--       oracle, never exposes the underlying rows).
--
--  bind_line_user_id() is also updated to clear out any attempts row once a
--  bind actually succeeds (tidy-up; the gate stops mattering for that email
--  the moment line_user_bindings has a row for it regardless).
-- ============================================================================

create table if not exists public.line_bind_attempts (
  email            text primary key,
  attempts         integer not null default 0,
  last_attempt_at  timestamptz not null default now(),
  admin_notified   boolean not null default false
);

alter table public.line_bind_attempts enable row level security;
revoke all on public.line_bind_attempts from anon, authenticated;
grant select, insert, update, delete on public.line_bind_attempts to service_role;

create or replace function public.record_bind_failure()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email    text := lower(auth.jwt() ->> 'email');
  v_attempts int;
  v_token    text;
  v_chat     text;
begin
  if v_email is null then
    return 0;
  end if;

  insert into public.line_bind_attempts (email, attempts, last_attempt_at)
  values (v_email, 1, now())
  on conflict (email) do update
    set attempts = public.line_bind_attempts.attempts + 1,
        last_attempt_at = now()
  returning attempts into v_attempts;

  if v_attempts >= 3 then
    -- Atomic "notify exactly once": the UPDATE only touches a row (and
    -- FOUND only becomes true) the FIRST time admin_notified flips from
    -- false to true, so concurrent/retried calls can't double-alert.
    update public.line_bind_attempts
      set admin_notified = true
      where email = v_email and not admin_notified;

    if found then
      select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';
      select decrypted_secret into v_chat  from vault.decrypted_secrets where name = 'telegram_chat_id';
      if v_token is not null and v_chat is not null then
        perform net.http_post(
          url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
          body    := jsonb_build_object(
            'chat_id', v_chat,
            'text', '⚠️ ไม่สามารถผูกบัญชี LINE ให้อีเมล ' || v_email ||
                    E'\nลองแล้ว ' || v_attempts || ' ครั้งไม่สำเร็จ ระบบให้เข้าใช้งานต่อได้ชั่วคราว ' ||
                    E'\nกรุณาตรวจสอบด้วยตนเอง (ดูตาราง line_bind_attempts)'
          ),
          headers := '{"Content-Type": "application/json"}'::jsonb
        );
      end if;
    end if;
  end if;

  return v_attempts;
exception when others then
  raise warning 'record_bind_failure failed: %', sqlerrm;
  return 0;
end;
$$;

revoke all on function public.record_bind_failure() from public;
grant execute on function public.record_bind_failure() to authenticated;

create or replace function public.get_line_bind_gate_status(p_email text)
returns table(is_blocked boolean, is_bound boolean, attempts integer)
language sql
security definer
stable
set search_path = public
as $$
  select
    exists (select 1 from public.blocked_emails b where lower(b.email) = lower(p_email)) as is_blocked,
    exists (select 1 from public.line_user_bindings lb where lb.email = lower(p_email)) as is_bound,
    coalesce((select a.attempts from public.line_bind_attempts a where a.email = lower(p_email)), 0) as attempts;
$$;

-- UPDATE 2026-11 (audit finding F10): retired and dropped (live per
-- DATA_EXPOSURE_ANALYSIS.md section 5, in source by
-- scripts/audit-fixes-2026-11.sql PART 4). The grant that stood here is
-- removed, so pasting this retired file again leaves the function callable
-- by nobody but the owner.
revoke all on function public.get_line_bind_gate_status(text) from public, anon, authenticated;

create or replace function public.bind_line_user_id(p_line_user_id text, p_line_display_name text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
begin
  if v_email is null or p_line_user_id is null or btrim(p_line_user_id) = '' then
    return;
  end if;

  insert into public.line_user_bindings (email, line_user_id, line_display_name, bound_at)
  values (v_email, p_line_user_id, nullif(btrim(coalesce(p_line_display_name, '')), ''), now())
  on conflict (email) do update
    set line_display_name = coalesce(excluded.line_display_name, public.line_user_bindings.line_display_name);

  update public.physician_directory
    set line_user_id = (select lb.line_user_id from public.line_user_bindings lb where lb.email = v_email)
    where lower(email) = v_email;

  update public.sender_physician_match
    set line_user_id = (select lb.line_user_id from public.line_user_bindings lb where lb.email = v_email)
    where lower(sender_email) = v_email;

  -- A success makes the gate irrelevant for this email — tidy up so a stray
  -- old attempts row doesn't confuse anyone reading the table later.
  delete from public.line_bind_attempts where email = v_email;
end;
$$;

-- UPDATE 2026-11 (audit finding F10): retired and dropped (live per
-- DATA_EXPOSURE_ANALYSIS.md section 5, in source by
-- scripts/audit-fixes-2026-11.sql PART 4). Revoked here so that pasting
-- this retired file again leaves the function callable by nobody but the
-- owner.
revoke all on function public.bind_line_user_id(text, text) from public, anon, authenticated;
