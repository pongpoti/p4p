-- ============================================================================
--  P4P — capture department on the access-request form
-- ============================================================================
--  Run AFTER scripts/auth-rewrite-2026-08.sql.
--
--  THE GAP THIS FIXES
--  -------------------
--  A physician approved through the request-access flow (as opposed to
--  auto-provisioned from a matched submission) landed in `physicians` with no
--  department at all — the request-access form only ever asked for a name,
--  so there was nothing to carry over. This predates this rewrite: the old
--  approve_access_request() had the identical gap
--  (`insert into physician_directory (email, full_name) values (...)`, no
--  department). Not a regression, but worth closing while touching this code.
--
--  THE FIX
--  -------
--  access_requests gets a `department` column, log_access_request() takes a
--  third parameter to store it, and main.js's approve handler carries it into
--  the physicians upsert. verify/app.js now asks for department alongside
--  name — a fixed ~19-entry dropdown (assets/shared.js's new P4P.DEPARTMENTS),
--  not free text, so it can't drift from the canonical spelling the rest of
--  the app groups by.
-- ============================================================================

alter table public.access_requests add column if not exists department text;

-- Same signature-replacement pattern as auth-rewrite-2026-08.sql: drop the
-- old 2-arg version explicitly rather than relying on create-or-replace,
-- which would otherwise leave BOTH signatures around as overloads and make
-- PostgREST's rpc/log_access_request ambiguous about which one a 2-key JSON
-- body resolves to.
drop function if exists public.log_access_request(text, text);
create or replace function public.log_access_request(
  p_email      text,
  p_name       text default null,
  p_department text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.access_requests (email, name, department, requested_at, request_count, resolved)
  values (lower(p_email), nullif(trim(p_name), ''), nullif(trim(p_department), ''), now(), 1, false)
  on conflict (email) do update
    set name          = coalesce(nullif(trim(excluded.name), ''), access_requests.name),
        department    = coalesce(nullif(trim(excluded.department), ''), access_requests.department),
        requested_at  = now(),
        request_count = access_requests.request_count + 1,
        resolved      = false;
$$;

revoke all on function public.log_access_request(text, text, text) from public;
grant execute on function public.log_access_request(text, text, text) to anon, authenticated;

-- One-off: nothing to backfill here automatically — a department that was
-- never captured can't be recovered from this table. Already-approved
-- physicians with a null department (per the earlier `select email, full_name,
-- source from physicians where department is null;` check) need a manual
-- update once, same as before this migration.
