-- ============================================================================
--  dashboard-users-2026-11.sql — who may use /dashboard/, and what each one sees.
--
--  Pong, 2026-11-18: "Go QR". The owner adds a dashboard user with a QR:
--  each click on เพิ่มผู้ใช้ด้วย QR makes a fresh QR that works once and
--  expires in 10 minutes. The newcomer scans it with the LINE app, signs in
--  with LINE on the phone (the dashboard's own LINE Login), and the phone
--  shows a 4-digit code. The owner types that code on the computer, ticks
--  the tabs the person may see, and approves.
--
--  PART 1 dashboard_users: one row per dashboard user (not the owner, who
--         stays in ADMIN_LINE_USER_ID). perms holds the tabs granted:
--           followup.view   ตามส่ง, read
--           followup.edit   ตามส่ง, add and delete notes (implies view)
--           roster.view     รายชื่อ, read (editing stays with the owner)
--           staffing.view   อัตรากำลัง, read (editing stays with the owner)
--           review.auditee  ตรวจสอบ, the ผู้จัดทำ side
--         A row always beats DASHBOARD_LINE_USER_IDS, so a suspension
--         (active = false) works without a redeploy. A user listed only in
--         that env var is moved in here, with the rights they have today,
--         the next time they sign in (dashboard_user_import).
--  PART 2 dashboard_invites: one row per QR. Only the sha256 of the QR's
--         token is kept, never the token. 10 minutes to scan, then 24 hours
--         for the owner to decide.
--  PART 3 the functions the Vercel app calls (service role only).
--
--  No LINE ID, name or picture is written by this file: rows come only from
--  the app. Run in the Supabase SQL editor; the PARTs in order (each can be
--  pasted on its own). Safe to re-run. No backslashes, so it pastes through
--  chat. Needs nothing but dashboard-audit-log-2026-10.sql (step 22), which
--  the app writes the matching history rows to.
--
--  Emergency stop for one user:
--    update public.dashboard_users set active = false where display_name = '...';
-- ============================================================================

-- ── PART 1: dashboard_users ────────────────────────────────────────────────

create table if not exists public.dashboard_users (
  line_user_id text primary key check (line_user_id ~ '^U[0-9a-f]{32}$'),
  line_name    text not null default '' check (char_length(line_name) <= 100),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  perms        text[] not null default '{}'
               check (perms <@ array['followup.view','followup.edit','roster.view','staffing.view','review.auditee']::text[]),
  active       boolean not null default true,
  source       text not null default 'qr' check (source in ('qr', 'env')),
  added_by     text not null,
  added_at     timestamptz not null default now(),
  updated_by   text,
  updated_at   timestamptz,
  suspended_by text,
  suspended_at timestamptz
);

-- Service role only, and no delete: the history is kept.
alter table public.dashboard_users enable row level security;
revoke all on table public.dashboard_users from public, anon, authenticated;
grant select, insert, update on table public.dashboard_users to service_role;


-- ── PART 2: dashboard_invites ──────────────────────────────────────────────

create table if not exists public.dashboard_invites (
  id              uuid primary key default gen_random_uuid(),
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by      text not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  status          text not null default 'open'
                  check (status in ('open','scanned','approved','rejected','cancelled','expired','locked')),
  claimed_sub     text check (claimed_sub ~ '^U[0-9a-f]{32}$'),
  claimed_name    text check (char_length(claimed_name) <= 100),
  claimed_picture text check (claimed_picture is null or claimed_picture like 'https://profile.line-scdn.net/%'),
  claimed_at      timestamptz,
  confirm_code    text check (confirm_code ~ '^[0-9]{4}$'),
  code_tries      int not null default 0,
  decided_by      text,
  decided_at      timestamptz,
  perms           text[]
);

-- One open QR per owner; a new one cancels the last.
create unique index if not exists dashboard_invites_one_open
  on public.dashboard_invites (created_by) where status = 'open';
create index if not exists dashboard_invites_status_created
  on public.dashboard_invites (status, created_at desc);

alter table public.dashboard_invites enable row level security;
revoke all on table public.dashboard_invites from public, anon, authenticated;
grant select, insert, update on table public.dashboard_invites to service_role;


-- ── PART 3: the functions ──────────────────────────────────────────────────
-- Every one takes the same lock, checks its input, and first marks a QR that
-- ran out of time (open or scanned) as expired, so no cron is needed.

create or replace function public.dashboard_invites_sweep()
returns void
language sql
set search_path = ''
as $$
  update public.dashboard_invites set status = 'expired'
   where status in ('open', 'scanned') and expires_at <= now();
$$;
revoke all on function public.dashboard_invites_sweep() from public, anon, authenticated;
grant execute on function public.dashboard_invites_sweep() to service_role;

-- The rights as stored: known keys only, followup.edit brings followup.view,
-- sorted, no repeats. Refuses an unknown key.
create or replace function public.dashboard_perms_clean(p_perms text[])
returns text[]
language plpgsql
set search_path = ''
as $$
declare
  v text[] := coalesce(p_perms, '{}');
begin
  if not (v <@ array['followup.view','followup.edit','roster.view','staffing.view','review.auditee']::text[]) then
    raise exception 'dashboard: bad perms';
  end if;
  if 'followup.edit' = any (v) then v := v || 'followup.view'::text; end if;
  return array(select distinct x from unnest(v) as x order by 1);
end;
$$;
revoke all on function public.dashboard_perms_clean(text[]) from public, anon, authenticated;
grant execute on function public.dashboard_perms_clean(text[]) to service_role;

-- A new QR for p_actor (the owner): at most 10 an hour; cancels the open one.
create or replace function public.dashboard_invite_create(p_actor text, p_token_hash text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_n   int;
  v_row public.dashboard_invites;
begin
  perform pg_advisory_xact_lock(hashtext('dashboard_users'));
  if p_actor is null or p_actor !~ '^U[0-9a-f]{32}$' then raise exception 'dashboard: bad actor'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'dashboard: bad token'; end if;
  perform public.dashboard_invites_sweep();
  select count(*) into v_n from public.dashboard_invites
   where created_by = p_actor and created_at > now() - interval '1 hour';
  if v_n >= 10 then raise exception 'dashboard: rate_limited'; end if;
  update public.dashboard_invites set status = 'cancelled', decided_by = p_actor, decided_at = now()
   where created_by = p_actor and status = 'open';
  insert into public.dashboard_invites (token_hash, created_by, expires_at)
  values (p_token_hash, p_actor, now() + interval '10 minutes')
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'expires_at', v_row.expires_at);
end;
$$;
revoke all on function public.dashboard_invite_create(text, text) from public, anon, authenticated;
grant execute on function public.dashboard_invite_create(text, text) to service_role;

-- The phone's landing page: is this QR still open? Reads only, so a link
-- preview cannot use it up.
create or replace function public.dashboard_invite_peek(p_token_hash text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v public.dashboard_invites;
begin
  select * into v from public.dashboard_invites where token_hash = p_token_hash;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if v.status = 'open' and v.expires_at > now() then return jsonb_build_object('status', 'open'); end if;
  if v.status in ('open', 'expired', 'cancelled') then return jsonb_build_object('status', 'expired'); end if;
  return jsonb_build_object('status', 'used');
end;
$$;
revoke all on function public.dashboard_invite_peek(text) from public, anon, authenticated;
grant execute on function public.dashboard_invite_peek(text) to service_role;

-- The scan, after LINE verified who it is: the first account wins. Keeps the
-- code shown on that phone and gives the owner 24 hours to decide.
create or replace function public.dashboard_invite_claim(p_token_hash text, p_sub text, p_name text,
                                                         p_picture text, p_code text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.dashboard_invites;
begin
  perform pg_advisory_xact_lock(hashtext('dashboard_users'));
  if p_sub is null or p_sub !~ '^U[0-9a-f]{32}$' then raise exception 'dashboard: bad sub'; end if;
  if p_code is null or p_code !~ '^[0-9]{4}$' then raise exception 'dashboard: bad code'; end if;
  perform public.dashboard_invites_sweep();
  select * into v from public.dashboard_invites where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('result', 'invalid'); end if;
  if exists (select 1 from public.dashboard_users where line_user_id = p_sub and active) then
    return jsonb_build_object('result', 'already', 'id', v.id);
  end if;
  if v.status = 'open' and v.expires_at > now() then
    update public.dashboard_invites
       set status = 'scanned', claimed_sub = p_sub, claimed_name = left(coalesce(p_name, ''), 100),
           claimed_picture = case when p_picture like 'https://profile.line-scdn.net/%' then left(p_picture, 500) end,
           claimed_at = now(), confirm_code = p_code, code_tries = 0, expires_at = now() + interval '24 hours'
     where id = v.id;
    return jsonb_build_object('result', 'ok', 'id', v.id);
  end if;
  if v.status in ('expired', 'cancelled') then return jsonb_build_object('result', 'expired', 'id', v.id); end if;
  return jsonb_build_object('result', 'used', 'id', v.id);
end;
$$;
revoke all on function public.dashboard_invite_claim(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.dashboard_invite_claim(text, text, text, text, text) to service_role;

-- The phone's wait page: only the account that scanned sees its request,
-- and the code only while it waits.
create or replace function public.dashboard_invite_status(p_id uuid, p_sub text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.dashboard_invites;
begin
  perform public.dashboard_invites_sweep();
  select * into v from public.dashboard_invites where id = p_id and claimed_sub = p_sub;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  return jsonb_build_object(
    'status', v.status,
    'code', case when v.status = 'scanned' then v.confirm_code end,
    'name', v.claimed_name,
    'perms', to_jsonb(coalesce(v.perms, '{}')));
end;
$$;
revoke all on function public.dashboard_invite_status(uuid, text) from public, anon, authenticated;
grant execute on function public.dashboard_invite_status(uuid, text) to service_role;

-- The owner's decision on a scanned QR. Approve needs the code from the
-- phone: a wrong one counts, and the third locks the request. The LINE ID
-- approved is the one LINE verified at the scan, never one sent in.
create or replace function public.dashboard_invite_decide(p_actor text, p_id uuid, p_decision text, p_code text,
                                                          p_perms text[], p_display_name text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v       public.dashboard_invites;
  v_perms text[];
  v_name  text;
  v_tries int;
  v_old   public.dashboard_users;
  v_user  public.dashboard_users;
begin
  perform pg_advisory_xact_lock(hashtext('dashboard_users'));
  if p_decision is null or p_decision not in ('approve', 'reject') then raise exception 'dashboard: bad decision'; end if;
  perform public.dashboard_invites_sweep();
  select * into v from public.dashboard_invites where id = p_id and created_by = p_actor for update;
  if not found or v.status <> 'scanned' then return jsonb_build_object('result', 'not_pending'); end if;
  if p_decision = 'reject' then
    update public.dashboard_invites set status = 'rejected', decided_by = p_actor, decided_at = now() where id = v.id;
    return jsonb_build_object('result', 'ok', 'sub', v.claimed_sub, 'name', v.claimed_name);
  end if;
  if p_code is null or p_code !~ '^[0-9]{4}$' or p_code <> v.confirm_code then
    v_tries := v.code_tries + 1;
    update public.dashboard_invites
       set code_tries = v_tries,
           status = case when v_tries >= 3 then 'locked' else status end,
           decided_by = case when v_tries >= 3 then p_actor else decided_by end,
           decided_at = case when v_tries >= 3 then now() else decided_at end
     where id = v.id;
    return jsonb_build_object('result', case when v_tries >= 3 then 'locked' else 'bad_code' end,
                              'tries_left', greatest(0, 3 - v_tries));
  end if;
  v_perms := public.dashboard_perms_clean(p_perms);
  v_name := btrim(coalesce(p_display_name, ''));
  if char_length(v_name) < 1 or char_length(v_name) > 60 then raise exception 'dashboard: bad name'; end if;
  if (select count(*) from public.dashboard_users where active and line_user_id <> v.claimed_sub) >= 20 then
    return jsonb_build_object('result', 'too_many');
  end if;
  select * into v_old from public.dashboard_users where line_user_id = v.claimed_sub;
  insert into public.dashboard_users as u (line_user_id, line_name, display_name, perms, active, source, added_by)
  values (v.claimed_sub, coalesce(v.claimed_name, ''), v_name, v_perms, true, 'qr', p_actor)
  on conflict (line_user_id) do update
     set line_name = excluded.line_name, display_name = excluded.display_name, perms = excluded.perms,
         active = true, updated_by = p_actor, updated_at = now(), suspended_by = null, suspended_at = null
  returning * into v_user;
  update public.dashboard_invites set status = 'approved', decided_by = p_actor, decided_at = now(), perms = v_perms
   where id = v.id;
  return jsonb_build_object('result', 'ok',
    'before', case when v_old.line_user_id is null then null else to_jsonb(v_old) end,
    'after', to_jsonb(v_user));
end;
$$;
revoke all on function public.dashboard_invite_decide(text, uuid, text, text, text[], text) from public, anon, authenticated;
grant execute on function public.dashboard_invite_decide(text, uuid, text, text, text[], text) to service_role;

-- The owner closed the QR before anyone scanned it (p_id null: every open
-- one of theirs, as on sign-out). A scanned request stays for 24 hours.
create or replace function public.dashboard_invite_cancel(p_actor text, p_id uuid default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  perform pg_advisory_xact_lock(hashtext('dashboard_users'));
  perform public.dashboard_invites_sweep();
  update public.dashboard_invites set status = 'cancelled', decided_by = p_actor, decided_at = now()
   where created_by = p_actor and status = 'open' and (p_id is null or id = p_id);
  get diagnostics v_n = row_count;
  return jsonb_build_object('cancelled', v_n);
end;
$$;
revoke all on function public.dashboard_invite_cancel(text, uuid) from public, anon, authenticated;
grant execute on function public.dashboard_invite_cancel(text, uuid) to service_role;

-- The owner edits a user's rights, name, or suspends / re-enables them.
create or replace function public.dashboard_user_save(p_actor text, p_sub text, p_perms text[], p_display_name text,
                                                      p_active boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_old   public.dashboard_users;
  v_user  public.dashboard_users;
  v_perms text[];
  v_name  text;
begin
  perform pg_advisory_xact_lock(hashtext('dashboard_users'));
  if p_active is null then raise exception 'dashboard: bad active'; end if;
  select * into v_old from public.dashboard_users where line_user_id = p_sub for update;
  if not found then raise exception 'dashboard: not_found'; end if;
  v_perms := public.dashboard_perms_clean(p_perms);
  v_name := btrim(coalesce(p_display_name, ''));
  if char_length(v_name) < 1 or char_length(v_name) > 60 then raise exception 'dashboard: bad name'; end if;
  if p_active and not v_old.active
     and (select count(*) from public.dashboard_users where active) >= 20 then
    raise exception 'dashboard: too_many';
  end if;
  update public.dashboard_users
     set perms = v_perms, display_name = v_name, active = p_active, updated_by = p_actor, updated_at = now(),
         suspended_by = case when p_active then null when v_old.active then p_actor else v_old.suspended_by end,
         suspended_at = case when p_active then null when v_old.active then now() else v_old.suspended_at end
   where line_user_id = p_sub
  returning * into v_user;
  return jsonb_build_object('before', to_jsonb(v_old), 'after', to_jsonb(v_user));
end;
$$;
revoke all on function public.dashboard_user_save(text, text, text[], text, boolean) from public, anon, authenticated;
grant execute on function public.dashboard_user_save(text, text, text[], text, boolean) to service_role;

-- A user from DASHBOARD_LINE_USER_IDS signed in: their row, with the rights
-- they had from the env var (the ผู้จัดทำ set). Never changes a row.
create or replace function public.dashboard_user_import(p_sub text, p_line_name text, p_display_name text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  perform pg_advisory_xact_lock(hashtext('dashboard_users'));
  if p_sub is null or p_sub !~ '^U[0-9a-f]{32}$' then raise exception 'dashboard: bad sub'; end if;
  insert into public.dashboard_users (line_user_id, line_name, display_name, perms, active, source, added_by)
  values (p_sub, left(coalesce(p_line_name, ''), 100),
          coalesce(nullif(btrim(left(coalesce(p_display_name, ''), 60)), ''), 'ผู้ใช้แดชบอร์ด'),
          array['followup.edit','followup.view','review.auditee','roster.view','staffing.view']::text[],
          true, 'env', p_sub)
  on conflict (line_user_id) do nothing;
  get diagnostics v_n = row_count;
  return jsonb_build_object('inserted', v_n > 0);
end;
$$;
revoke all on function public.dashboard_user_import(text, text, text) from public, anon, authenticated;
grant execute on function public.dashboard_user_import(text, text, text) to service_role;

-- Check: tables_2 = 2, functions_10 = 10, anon_0 = 0.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name in ('dashboard_users', 'dashboard_invites')) as tables_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('dashboard_invites_sweep', 'dashboard_perms_clean',
      'dashboard_invite_create', 'dashboard_invite_peek', 'dashboard_invite_claim', 'dashboard_invite_status',
      'dashboard_invite_decide', 'dashboard_invite_cancel', 'dashboard_user_save', 'dashboard_user_import')) as functions_10,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'dashboard_invite%' and has_function_privilege('anon', p.oid, 'execute')) as anon_0;
