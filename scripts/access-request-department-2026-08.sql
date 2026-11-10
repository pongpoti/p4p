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
--  third parameter to store it (that function now lives in
--  scripts/audit-fixes-2026-11.sql), and main.js's approve handler carries it into
--  the physicians upsert. verify/app.js now asks for department alongside
--  name — a fixed ~19-entry dropdown (assets/shared.js's new P4P.DEPARTMENTS),
--  not free text, so it can't drift from the canonical spelling the rest of
--  the app groups by.
-- ============================================================================

alter table public.access_requests add column if not exists department text;

-- Same signature-replacement pattern as auth-rewrite-2026-08.sql: drop the
-- old 2-arg version explicitly, so PostgREST's rpc/log_access_request is never
-- ambiguous about which overload a 2-key JSON body resolves to.
--
-- The 3-argument function this file used to create is now defined only in
-- scripts/audit-fixes-2026-11.sql PART 1 (audit finding F13, 2026-11): this
-- version let any anon caller overwrite the name and department on someone
-- else's request, reopen a resolved one, and store text of any length. Not
-- creating it here means pasting this file again cannot bring that back.
drop function if exists public.log_access_request(text, text);

-- One-off: nothing to backfill here automatically — a department that was
-- never captured can't be recovered from this table. Already-approved
-- physicians with a null department (per the earlier `select email, full_name,
-- source from physicians where department is null;` check) need a manual
-- update once, same as before this migration.
