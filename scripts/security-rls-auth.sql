-- ============================================================================
--  P4P — RLS upgrade: anon-read  ->  authenticated + allow-listed read
-- ============================================================================
--  Context
--  -------
--  scripts/security-rls.sql previously let the PUBLIC anon key READ the roster
--  tables and p4p_submissions. That made the email-verification page cosmetic:
--  anyone with the (public) anon key could query Supabase directly and read the
--  same data without ever verifying.
--
--  This script closes that hole. After it runs:
--    • the roster tables (YYYY_MM) + p4p_submissions can only be READ by an
--      AUTHENTICATED session whose email is present in sender_physician_match;
--    • the anon role can no longer read any of that data;
--    • writes still require the service_role key (unchanged).
--
--  The front-end obtains a session via Supabase Auth email OTP on /verify/
--  (see verify/index.html + assets/auth-guard.js).
--
--  Supabase dashboard steps (do these BEFORE relying on the gate)
--  --------------------------------------------------------------
--    1. Authentication → Providers → Email: ENABLE. Turn OFF "Confirm email"
--       is not required for OTP; keep "Enable email provider" ON.
--    2. Authentication → Email Templates → "Magic Link": make sure the body
--       includes the numeric token, e.g.  {{ .Token }}  — otherwise Supabase
--       sends only a magic link and the 6-digit code box can't be used.
--    3. Keep "Allow new users to sign up" ON. The verify page uses
--       signInWithOtp(shouldCreateUser:true) so a newly-added physician can get
--       a session on first login; disabling signups would lock them out. RLS
--       below is what actually restricts data — not the signup toggle.
--    4. Configure SMTP (Authentication → SMTP) so OTP emails actually send in
--       production. The default Supabase mailer is rate-limited to a few/hour.
--    5. HARDENING (recommended):
--       • Auth → Sessions/Providers: shorten the Email OTP expiry (e.g. 300s).
--         A 6-digit code is only ~1e6 combinations; a long window widens brute
--         force. Also keep Supabase's built-in auth rate limits enabled.
--       • Auth → Providers: turn OFF "Anonymous sign-ins" — an anonymous JWT has
--         no email, so is_current_user_allowlisted() denies it (fails closed),
--         but there's no reason to allow minting such tokens at all.
--       • Anyone with the public key can trigger signInWithOtp for ANY address
--         (OTP email spam) and can call is_sender_allowlisted (a yes/no oracle
--         on whether an email is a physician). Neither exposes data — RLS still
--         gates that — but consider Supabase Auth rate limits / CAPTCHA if abuse
--         is seen.
--
--  Rollout order
--  -------------
--    1. Do the dashboard steps above and confirm you can receive an OTP.
--    2. Deploy the front-end (verify page + auth-guard + gated pages).
--    3. Run THIS file in the Supabase SQL editor to lock reads to authenticated
--       + allow-listed. (Running it before step 2 would lock out the live site.)
--
--  Onboarding new physicians (who haven't submitted P4P yet)
--  ----------------------------------------------------------
--  The allow-list is  physician_directory  UNION  sender_physician_match. A new
--  physician has no row in sender_physician_match until their first submission,
--  so add them to physician_directory (Supabase Table Editor → new row: email,
--  full_name, department) and they can verify immediately. If a physician tries
--  an email that isn't allow-listed, /verify/ asks for their name and records it
--  in access_requests (email + name) — check that table (resolved = false) to see
--  who still needs adding. OPTIONAL: scripts/notify-access-request.sql sends a
--  Telegram alert on each new request so an admin doesn't have to poll the table.
--
--  Revoking access: add the email to blocked_emails (Table Editor). It overrides
--  BOTH allow-list branches, so it revokes a matched sender or a directory entry
--  without deleting their data. To restore, delete the blocked_emails row.
--
--  OPTIONAL server-side signup enforcement: scripts/auth-hook-restrict-signups.sql
--  is a (verify-before-enabling) template for a Supabase "Before User Created"
--  hook that rejects non-allow-listed emails at signup, stopping OTP spam and
--  auth.users pollution. RLS already protects the DATA; that hook is hardening.
--
--  Verify (with the PUBLIC key, i.e. anon — everything should now be denied):
--    curl '.../rest/v1/2569_06?select=firstname'  -H "apikey:<pub>"   # -> [] / error
--  With a valid user JWT in Authorization: Bearer <jwt>, the same query returns
--  rows only if that user's email is in physician_directory or
--  sender_physician_match.
--
--  All blocks are idempotent.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Block 0a — physician directory + access requests
--
--   physician_directory is an ADMIN-MAINTAINED allow-list, independent of who
--   has emailed. New physicians are added here (one row, via the Supabase Table
--   Editor) so they can verify BEFORE their first P4P submission. It is a
--   standalone table — NOT a column on the YYYY_MM roster tables, which are
--   recreated every month and would lose the emails on each import.
--
--   The effective allow-list is:  physician_directory  UNION  sender_physician_match
--   so everyone who has already emailed keeps working with no migration.
--
--   access_requests logs verify attempts from emails that are NOT allow-listed,
--   so admins can see who tried and needs adding. It is NOT an approval gate —
--   just visibility, so a real physician is never silently stuck.
--
--   Both tables hold email addresses, so they are locked down completely: no
--   anon/authenticated SELECT. They are only reachable via the SECURITY DEFINER
--   functions below (and the service_role key in the dashboard).
-- ----------------------------------------------------------------------------
create table if not exists public.physician_directory (
  email       text primary key,
  full_name   text,
  department  text,
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.access_requests (
  email          text primary key,
  name           text,   -- self-reported name so an admin knows who to add
  requested_at   timestamptz not null default now(),
  request_count  integer     not null default 1,
  resolved       boolean     not null default false
);
-- If the table pre-dates the name column, add it.
alter table public.access_requests add column if not exists name text;

-- Denylist / revocation. Directory rows can be disabled via active=false, but a
-- MATCHED sender (in sender_physician_match) has no such switch — deleting their
-- row would lose data. Add an email here to revoke access for ANY email, matched
-- sender or directory entry alike; it overrides both allow-list branches.
create table if not exists public.blocked_emails (
  email       text primary key,
  reason      text,
  blocked_at  timestamptz not null default now()
);

alter table public.physician_directory enable row level security;
alter table public.access_requests     enable row level security;
alter table public.blocked_emails       enable row level security;
revoke all on public.physician_directory from anon, authenticated;
revoke all on public.access_requests     from anon, authenticated;
revoke all on public.blocked_emails       from anon, authenticated;

-- CRITICAL — lock the tables the allow-list is built from.
--   sender_physician_match holds physician emails+names and, because the
--   allow-list is (physician_directory UNION sender_physician_match), any row an
--   attacker could INSERT here would grant them access. It was never RLS-locked,
--   so with Supabase's default table grants the public/anon key could read the
--   whole email list AND potentially write to it (= allow-list tampering / auth
--   bypass). dept_heads similarly leaks head emails. Enable RLS with NO policy so
--   both are default-deny for anon/authenticated; the SECURITY DEFINER functions
--   (table owner) and the service_role key still reach them, so nothing breaks.
alter table public.sender_physician_match enable row level security;
revoke all on public.sender_physician_match from anon, authenticated;
do $$
begin
  if to_regclass('public.dept_heads') is not null then
    execute 'alter table public.dept_heads enable row level security';
    execute 'revoke all on public.dept_heads from anon, authenticated';
  end if;
end $$;

-- One-time seed: pull every email we already know from past senders so the
-- directory isn't empty on day one. Only MATCHED senders (matched = true) are
-- seeded — an unmatched sender is just someone who emailed the P4P inbox and
-- could not be tied to a physician, so they must not be auto-allow-listed.
-- Idempotent (on conflict do nothing).
insert into public.physician_directory (email, full_name, department)
select distinct lower(m.sender_email), m.matched_physician, m.department
from public.sender_physician_match m
where m.sender_email is not null and m.matched
on conflict (email) do nothing;


-- ----------------------------------------------------------------------------
-- Block 0b — allow-list helpers (SECURITY DEFINER so they can read the
--           directory + sender_physician_match without granting SELECT on them).
-- ----------------------------------------------------------------------------

-- Used by /verify/ BEFORE login: "is this email allowed to request a code?"
-- Returns only a boolean, so the email list is never exposed to the client.
create or replace function public.is_sender_allowlisted(p_email text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  -- Denylist wins over everything (revocation).
  select not exists (
    select 1 from public.blocked_emails b
    where lower(b.email) = lower(p_email)
  ) and (
    exists (
      select 1 from public.physician_directory d
      where lower(d.email) = lower(p_email) and d.active
    ) or exists (
      -- MATCHED senders only: an unmatched sender is a stranger who emailed the
      -- P4P inbox, not a verified physician, and must not be allow-listed.
      select 1 from public.sender_physician_match m
      where lower(m.sender_email) = lower(p_email) and m.matched
    )
  );
$$;

-- Used by the RLS policies AFTER login: "is the current session's email allowed?"
create or replace function public.is_current_user_allowlisted()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_sender_allowlisted(auth.jwt() ->> 'email');
$$;

-- log_access_request: /verify/ calls it when an email is NOT allow-listed, to
-- record the attempt so an admin knows WHO to add. The 2-argument version
-- this file used to create let any anon caller rename or reopen anyone's
-- request (audit finding F13, 2026-11); the only version now is the
-- 3-argument one in scripts/audit-fixes-2026-11.sql PART 1.
drop function if exists public.log_access_request(text);
drop function if exists public.log_access_request(text, text);

revoke all on function public.is_sender_allowlisted(text)   from public;
revoke all on function public.is_current_user_allowlisted() from public;
grant execute on function public.is_sender_allowlisted(text) to anon, authenticated;
grant execute on function public.is_current_user_allowlisted() to authenticated;


-- ----------------------------------------------------------------------------
-- Block 1 — p4p_submissions : authenticated + allow-listed read only
-- ----------------------------------------------------------------------------
alter table public.p4p_submissions enable row level security;

drop policy if exists "anon read submissions" on public.p4p_submissions;
drop policy if exists "verified read submissions" on public.p4p_submissions;
create policy "verified read submissions"
  on public.p4p_submissions for select to authenticated
  using (public.is_current_user_allowlisted());

revoke all on public.p4p_submissions from anon, authenticated;
grant select (physician_name, department, work_month, submitted_at)
  on public.p4p_submissions to authenticated;


-- ----------------------------------------------------------------------------
-- Block 2 — every existing monthly roster table named YYYY_MM
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public'
      and tablename ~ '^[0-9]{4}_[0-9]{2}$'
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('alter table public.%I add column if not exists submitted_at timestamptz;', t);
    execute format('drop policy if exists "anon read roster" on public.%I;', t);
    execute format('drop policy if exists "verified read roster" on public.%I;', t);
    execute format('create policy "verified read roster" on public.%I for select to authenticated using (public.is_current_user_allowlisted());', t);
    execute format('revoke all on public.%I from anon, authenticated;', t);
    execute format('grant select (firstname, lastname, department, submitted_at) on public.%I to authenticated;', t);
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- Block 3 — auto-secure every NEW YYYY_MM table on creation, using the same
--           authenticated + allow-listed policy as Block 2.
-- ----------------------------------------------------------------------------
create or replace function public.secure_new_roster()
returns event_trigger language plpgsql as $$
declare r record; nm text;
begin
  for r in select objid from pg_event_trigger_ddl_commands() where command_tag = 'CREATE TABLE' loop
    select c.relname into nm from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.oid = r.objid and n.nspname = 'public';
    if nm ~ '^[0-9]{4}_[0-9]{2}$' then
      begin
        execute format('alter table public.%I enable row level security;', nm);
        execute format('alter table public.%I add column if not exists submitted_at timestamptz;', nm);
        execute format('drop policy if exists "anon read roster" on public.%I;', nm);
        execute format('drop policy if exists "verified read roster" on public.%I;', nm);
        execute format('create policy "verified read roster" on public.%I for select to authenticated using (public.is_current_user_allowlisted());', nm);
        execute format('revoke all on public.%I from anon, authenticated;', nm);
        execute format('grant select (firstname, lastname, department, submitted_at) on public.%I to authenticated;', nm);
      exception when others then
        raise warning 'secure_new_roster failed for %: %', nm, sqlerrm;
      end;
    end if;
  end loop;
end $$;

drop event trigger if exists trg_secure_new_roster;
create event trigger trg_secure_new_roster on ddl_command_end
  when tag in ('CREATE TABLE') execute function public.secure_new_roster();
