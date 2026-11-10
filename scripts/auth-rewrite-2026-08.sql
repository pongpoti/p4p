-- ============================================================================
--  P4P — Auth system rewrite: one table, one purpose
-- ============================================================================
--  Run scripts/security-rls-auth.sql and scripts/line-bind-verified.sql FIRST
--  (this migrates data out of the tables they created).
--
--  THE PROBLEM THIS FIXES
--  -----------------------
--  The auth system grew into six tables (physician_directory,
--  sender_physician_match, blocked_emails, line_user_bindings,
--  line_bind_attempts, line_verified_sessions) and a staged-rollout second
--  factor (LINE_BIND_ENFORCE, bind attempts, fail-open, per-session proof)
--  that exists to fight a threat model — a stolen email logging in from a
--  stranger's LINE account — nobody asked this app to defend against. The
--  actual job is two sentences: authenticate someone by proving they control
--  an email address, and remember which LINE account goes with that email so
--  the two can be matched up. Everything else was incident-driven scar
--  tissue around a job that never needed it.
--
--  THE FIX
--  -------
--  One table, `physicians`, replaces physician_directory + the auth-relevant
--  half of sender_physician_match + blocked_emails + line_user_bindings:
--
--    email · full_name · department · line_user_id · line_display_name ·
--    active · source · created_at · updated_at · last_login_at
--
--  `active = false` IS the denylist (no separate blocked_emails table to keep
--  in sync). `line_user_id` is traceability, refreshed on every login that
--  carries a LINE ID token — NOT a security factor, so there is no mismatch
--  state, no attempt counter, no per-session proof table, and no staged
--  enforcement flag. sender_physician_match keeps its own automation
--  bookkeeping (similarity score, name source, email counts) — that is a
--  diagnostic table for the email-matching pipeline, not an auth table.
--  (This file used to add a trigger that copied every matched sender into
--  `physicians` as an active login. That let anyone who emailed a file with
--  a physician's name become that physician — audit finding F01, 2026-11.
--  The trigger now lives in scripts/audit-fixes-2026-11.sql PART 1 and only
--  opens an access request for an admin to approve.)
--
--  line_bind_attempts and line_verified_sessions have no replacement: they
--  existed only to support the fail-open/enforce machinery this migration
--  removes.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Block 1 — the physicians table.
-- ----------------------------------------------------------------------------
create table if not exists public.physicians (
  email              text primary key,
  full_name          text,
  department         text,
  line_user_id       text unique,
  line_display_name  text,
  -- 'directory'      — an admin added this row by hand (manual onboarding,
  --                    or approving an access request).
  -- 'matched_sender' — added by itself by the email-matching pipeline's
  --                    old trigger (removed in 2026-11, see Block 3). No
  --                    new rows get this source; an admin approves instead.
  source             text not null default 'directory'
                       check (source in ('directory', 'matched_sender')),
  active             boolean     not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_login_at      timestamptz
);

alter table public.physicians enable row level security;
-- No anon/authenticated policies — same deny-by-default posture the old
-- tables used. Reachable only through the SECURITY DEFINER functions below
-- and the service_role key (main.js, the admin API, this migration).
revoke all on public.physicians from anon, authenticated;
grant select, insert, update, delete on public.physicians to service_role;

create index if not exists physicians_line_user_id_idx on public.physicians (line_user_id) where line_user_id is not null;


-- ----------------------------------------------------------------------------
-- Block 2 — backfill from the tables physicians.sql replaces.
--
--   Order matters: directory rows first (admin-entered, most authoritative
--   for full_name/department), then matched senders fill in anyone missed
--   (on conflict do nothing — never downgrades a directory row), then LINE
--   bindings and the denylist are layered on top of whichever rows exist.
-- ----------------------------------------------------------------------------
insert into public.physicians (email, full_name, department, active, source, created_at)
select lower(d.email), d.full_name, d.department, d.active, 'directory', d.created_at
from public.physician_directory d
on conflict (email) do update
  set full_name  = coalesce(public.physicians.full_name, excluded.full_name),
      department = coalesce(public.physicians.department, excluded.department);

-- The matched-sender backfill that stood here ran once, in 2026-08. It is
-- left out on purpose: run again, it would make every address in
-- sender_physician_match an active login, including ones no admin ever
-- approved (audit finding F01, 2026-11). A matched sender is not proof of
-- identity; see scripts/audit-fixes-2026-11.sql PART 1.

update public.physicians p
set line_user_id      = b.line_user_id,
    line_display_name = b.line_display_name
from public.line_user_bindings b
where b.email = p.email;

update public.physicians p
set active = false
from public.blocked_emails bl
where lower(bl.email) = p.email;


-- ----------------------------------------------------------------------------
-- Block 3 — REMOVED (audit finding F01, 2026-11).
--
--   This block used to install sync_physician_from_match() and its trigger
--   on sender_physician_match, which inserted every matched email sender
--   into `physicians` as active (and renamed an existing row to the matched
--   roster name). The name it used comes from the submitted file, so any
--   outsider could get a login and another physician's upload identity.
--   The function and trigger are now defined only in
--   scripts/audit-fixes-2026-11.sql PART 1, where a new sender address
--   becomes an open access request instead. Nothing is created here, so
--   pasting this file again cannot bring the old trigger back.
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- Block 4 — allow-list functions, SAME NAMES AND SIGNATURES as before.
--
--   Every roster table's RLS policy, trg_secure_new_roster (which stamps
--   every FUTURE monthly table), and provision_month() all call
--   is_current_user_allowlisted() by name — keeping the name means none of
--   that needs to change. Only the body simplifies: one table, one column,
--   no union, no separate denylist.
-- ----------------------------------------------------------------------------
create or replace function public.is_sender_allowlisted(p_email text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.physicians p
    where p.email = lower(p_email) and p.active
  );
$$;

-- Also treats a revoked/deleted Supabase session as not-allowed: Supabase
-- DELETES the auth.sessions row on sign-out, so a missing row means this
-- access token has outlived its session. Folding it in here (rather than a
-- separate gate field, as the old design had) keeps the call site a single
-- boolean check — main.js gets the same immediate-revocation property for
-- free, with no extra round trip and no extra state to reason about.
create or replace function public.is_current_user_allowlisted()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    public.is_sender_allowlisted(auth.jwt() ->> 'email')
    and exists (
      select 1 from auth.sessions s where s.id::text = (auth.jwt() ->> 'session_id')
    );
$$;

revoke all on function public.is_sender_allowlisted(text)   from public;
revoke all on function public.is_current_user_allowlisted() from public;
grant execute on function public.is_sender_allowlisted(text) to anon, authenticated;
grant execute on function public.is_current_user_allowlisted() to authenticated;

-- log_access_request is still how /verify/ records a name+email for an admin
-- to see when the email isn't allow-listed yet. approve_token generation is
-- dropped: approval now happens in the admin dashboard (authenticated,
-- service_role write), not an anon-callable token-guessing surface. The
-- column is left in place (harmless) rather than risking a DDL error on a
-- column something else might still reference.
--
-- The 2-argument version this block used to create let any anon caller
-- rename or reopen anyone's request (audit finding F13, 2026-11). The only
-- version now is the 3-argument one in scripts/audit-fixes-2026-11.sql
-- PART 2; this just makes sure the old overloads are gone.
drop function if exists public.log_access_request(text);
drop function if exists public.log_access_request(text, text);


-- ----------------------------------------------------------------------------
-- Block 5 — simplify the access-request Telegram notification: informational
--           ping only, no inline Approve/Reject buttons. Approval now happens
--           in the admin dashboard (POST /admin/api/access-requests/:email),
--           which is behind the admin's own authenticated session and writes
--           with the service-role key server-side — not a bearer token
--           travelling through Telegram's callback_data that anyone in the
--           chat (or holding the bot token) could replay directly against
--           Supabase. See SECURITY_ANALYSIS.md §2c for the finding this
--           closes.
-- ----------------------------------------------------------------------------
create or replace function public.notify_access_request()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
  v_chat  text;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';
  select decrypted_secret into v_chat  from vault.decrypted_secrets where name = 'telegram_chat_id';
  if v_token is null or v_chat is null then
    raise warning 'notify_access_request: telegram secrets missing in Vault';
    return new;
  end if;

  perform net.http_post(
    url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body    := jsonb_build_object(
      'chat_id', v_chat,
      'text', '🔔 คำขอเข้าใช้งาน P4P ใหม่' || E'\n' ||
              'ชื่อ: ' || coalesce(new.name, '(ไม่ระบุ)') || E'\n' ||
              'อีเมล: ' || new.email || E'\n' ||
              'เปิดแดชบอร์ดผู้ดูแลเพื่ออนุมัติ'
    ),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  return new;
exception when others then
  raise warning 'notify_access_request failed: %', sqlerrm;
  return new;
end;
$$;
-- Trigger itself (trg_notify_access_request) already exists from
-- notify-access-request.sql and needs no change — CREATE OR REPLACE above
-- is enough to swap the body it calls.


-- ============================================================================
-- Block 6 — POST-DEPLOY ONLY. Run after the new main.js / verify/app.js /
--           admin/app.js are live. Drops everything the new design has no
--           use for. Running this before deploy would break the currently
--           live /verify/ (still calls bind_line_user_id_verified,
--           get_line_bind_gate_status_self) and the Telegram approve buttons.
-- ============================================================================
--
--   -- old LINE-bind-as-second-factor machinery
--   drop function if exists public.bind_line_user_id_verified(text, text, text, text);
--   drop function if exists public.get_line_bind_gate_status_self();
--   drop function if exists public.bind_line_user_id(text, text);
--   drop function if exists public.get_line_bind_gate_status(text);
--   drop function if exists public.record_bind_failure();
--   drop table if exists public.line_verified_sessions;
--   drop table if exists public.line_bind_attempts;
--   drop table if exists public.line_user_bindings;
--
--   -- old Telegram approve/reject (superseded by the admin dashboard)
--   drop function if exists public.approve_access_request(text);
--   drop function if exists public.reject_access_request(text);
--   alter table public.access_requests drop column if exists approve_token;
--
--   -- the PII-leaking dropdown feed — already unused, see
--   -- scripts/list-all-physicians.sql and SECURITY_ANALYSIS.md §2a
--   drop function if exists public.list_all_physicians();
--
--   -- superseded by physicians (data already migrated in Block 2)
--   drop view  if exists public.line_binding_status;
--   drop table if exists public.physician_directory;
--   drop table if exists public.blocked_emails;
--
--   Verify nothing still depends on these before running:
--     select p.proname
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
--     order by p.proname;
--   -- expect exactly: is_sender_allowlisted, log_access_request
--
--   Sanity check the backfill before dropping sources, from the SQL editor:
--     select count(*) from public.physicians;
--     select count(*) from public.physicians where line_user_id is not null;
--     select count(*) from public.physicians where not active;
--   -- compare against physician_directory / line_user_bindings / blocked_emails
--   -- row counts before this migration ran.
-- ============================================================================
