-- ============================================================================
--  P4P — Security hardening, August 2026  (REVISION 2)
-- ============================================================================
--  ✅ APPLIED to production 2026-08-07 13:42 UTC — Blocks 1, 2, 3, 5, 6, 7.
--     Block 4 (assert_service_role) was deliberately HELD BACK until the
--     automation is confirmed working; see the note on that block.
--     Post-apply verification is recorded under "Applied results" below.
--     Evidence for each block: SECURITY_ANALYSIS.md
--
--  WHY REVISION 2
--  --------------
--  Revision 1 of this file was reviewed and had three defects. They are worth
--  recording, because two of them are the same class of mistake that caused
--  the original incident — assuming a statement did what it looked like it did.
--
--   R1-BUG-1 (would have REDUCED security). It contained
--     `revoke execute on function public.get_line_bind_gate_status(text) from anon;`
--     But main.js:152 calls that RPC with the ANON key as both apikey and
--     Bearer — not with the user's token. Revoking it returns 403, which
--     getLineBindGateStatus() catches and converts to `null` (main.js:155),
--     and main.js:199 `if (gate)` then skips the whole gate — including the
--     `blocked_emails` denylist check. The fail-open is deliberate and
--     documented (main.js:143-146), so this would have silently disabled the
--     ONLY access-revocation mechanism in the system, with no error and no log.
--     => That revoke is REMOVED here. It can only happen after main.js is
--        changed to call the RPC with the user's access token (which it already
--        has in scope as `at`). See Appendix A.
--
--   R1-BUG-2 (incomplete root-cause fix). It ran
--     `alter default privileges in schema public revoke execute on functions
--      from anon, authenticated;`
--     ALTER DEFAULT PRIVILEGES without FOR ROLE only edits the executing role's
--     own entry. This project has TWO entries in schema public — one owned by
--     `postgres`, one by `supabase_admin` — and it also has entries for TABLES
--     and SEQUENCES, which R1 ignored entirely:
--
--       grantor=postgres        objtype=r  anon=Dxtm        (TRUNCATE etc.)
--       grantor=supabase_admin  objtype=r  anon=arwdDxtm    (FULL CRUD)
--       grantor=supabase_admin  objtype=S  anon=rwU
--
--     The supabase_admin entry CANNOT be fixed from the SQL editor: postgres is
--     not a member of supabase_admin (verified against pg_auth_members), so
--     `alter default privileges for role supabase_admin ...` raises
--     "must be member of role". A table created in public by supabase_admin
--     therefore still lands with FULL anon CRUD, and this project creates a new
--     roster table every month.
--     => Block 1 fixes what it can; Block 2 adds an event trigger that closes
--        the rest by construction, for BOTH grantors.
--
--   R1-BUG-3 (operational breakage). It rotated approve_token for every
--     unresolved access request. Those tokens are embedded in Telegram messages
--     ALREADY SENT to the admin. Rotating them makes the ✅/❌ buttons on those
--     messages fail with "not found", so the 4 currently-pending physicians
--     would never get approved and nobody would know why.
--     => Block 7 changes only the DEFAULT for future rows.
--
--   R2-BUG-4 (found by ACTUALLY RUNNING IT — see "Dry-run results" below).
--     Revision 2 revoked `from anon, authenticated`. That is still not enough.
--     PostgreSQL itself grants EXECUTE to **PUBLIC** on every newly created
--     function — nothing to do with Supabase — and `has_function_privilege
--     ('anon', ..., 'EXECUTE')` returns true through PUBLIC. Observed ACL on a
--     freshly created function after revoking from anon+authenticated:
--
--         =X/postgres , postgres=X/postgres , service_role=X/postgres
--          ^^^^^^^^^^ empty grantee = PUBLIC = still reachable by anon
--
--     So there are TWO independent sources of anon EXECUTE, and a correct fix
--     must remove both:
--       (a) Postgres's built-in grant to PUBLIC   -> revoke ... from public
--       (b) Supabase's default privileges to anon -> revoke ... from anon, authenticated
--     The original repo scripts did (a) and missed (b); revision 2 did (b) and
--     missed (a). Every revoke below now does BOTH.
--
--     This also means revision 2's Block 3 would have silently failed for
--     rls_auto_enable, secure_new_roster and notify_access_request, which still
--     carry the PUBLIC grant in production. Verified: with `from public` added,
--     all three now come back false.
--
--  WHAT THIS FILE STILL DOES NOT FIX
--  ---------------------------------
--  The single largest data exposure — list_all_physicians() returning all 250
--  physician names to any unauthenticated caller — is an APPLICATION change,
--  not a grant change. It cannot be revoked, because /verify/ genuinely calls
--  it pre-login. See Appendix B. (UPDATE 2026-11: done — the app no longer
--  calls it and scripts/audit-fixes-2026-11.sql PART 4 drops it.)
--
--  Idempotent. Ordered so nothing is left half-open between blocks.
--
--  DRY-RUN RESULTS (2026-08, against the REAL production schema)
--  -------------------------------------------------------------
--  Supabase branching requires the Pro plan and this org is on Free, so this
--  was executed against production inside an explicit transaction that was
--  guaranteed to roll back (a terminating RAISE, so even a partial failure
--  aborts). Rollback was verified beforehand with a throwaway table, and
--  production was re-checked afterwards: 0 leftover objects, the stale
--  p4p_submissions policies still present, anon grants unchanged. Nothing was
--  applied.
--
--    T1  provision_month          anon EXECUTE ....... false  ✓
--    T2  approve_access_request   anon EXECUTE ....... false  ✓
--    T2b rls_auto_enable          anon EXECUTE ....... false  ✓ (needed `public`)
--    T2c notify_access_request    anon EXECUTE ....... false  ✓ (needed `public`)
--    T3  provision_month     service_role EXECUTE ... true   ✓ automation intact
--    T4  get_line_bind_gate_status anon EXECUTE ..... true   ✓ deliberately kept
--    T4b is_sender_allowlisted   anon EXECUTE ....... true   ✓ login intact
--    T5  NEW function            anon EXECUTE ....... false  ✓ (needed `public`)
--    T6  NEW table               anon SELECT ........ false  ✓
--    T7  new roster table  authenticated SELECT cols  4      ✓ ORDERING OK
--    T8  new roster table        anon SELECT ........ false  ✓
--    T9  new roster table        policies ........... 1      ✓
--    T10 p4p_submissions         policies ........... 1      ✓ stale ones gone
--    T11 assert_service_role, claim role=anon ....... BLOCKED ✓
--    T12 assert_service_role, claim role=service_role ALLOWED ✓
--    T13 assert_service_role, no claim (psql) ....... ALLOWED ✓
--
--  T7 is the regression that matters most: it proves trg_revoke_public_grants
--  strips the new roster table and trg_secure_new_roster then re-grants the
--  four columns, i.e. the alphabetical firing order works and /status /list
--  /ranking will not 401.
--
--  APPLIED RESULTS (production, 2026-08-07 13:42 UTC)
--  ---------------------------------------------------
--    anon-executable SECURITY DEFINER functions: 10 -> 4
--      remaining, all intentional (the pre-login surface):
--        is_sender_allowlisted, log_access_request,
--        get_line_bind_gate_status, list_all_physicians
--      removed: provision_month, approve_access_request,
--        reject_access_request, rls_auto_enable, notify_access_request,
--        bind_line_user_id, record_bind_failure, is_current_user_allowlisted
--    anon/public RLS policies in public ......... 0   (was 3)
--    p4p_submissions policies ................... 1   (was 3)
--    anon table grants .......................... 0
--    anon column grants ......................... 0
--    authenticated SELECT column grants ......... 52  (12 rosters x 4 + 4)
--    anon TRUNCATE on email_sent_log ............ false
--    approve_token default ...................... gen_random_bytes(16) hex
--    default ACL (postgres, functions) .......... postgres, service_role only
--    default ACL (postgres, tables) ............. postgres, service_role only
--
--  Live canary run after the apply (rolled back): a new function, a new plain
--  table and a new roster table all came out with zero anon access, and the
--  roster table still received exactly 4 authenticated column grants with RLS
--  on and 1 policy — i.e. next month's provision_month() run is unaffected.
--
--  Data untouched: physician_directory 207, p4p_submissions 805,
--  2569_08 216 rows, 0 leftover canary objects. Existing approve_tokens were
--  NOT rotated, so Telegram buttons already sent still work.
--
--  STILL UNTESTED HERE: whether auth.role() is populated for this project's
--  NEW-format API keys (sb_publishable_… / sb_secret_…) over a real PostgREST
--  request. T11-T13 simulate the claims with set_config, which is not the same
--  thing. Confirm provision-next-month.mjs still succeeds after applying
--  Block 4, or drop Block 4 and rely on the grants alone.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Block 0 — TEST THIS ON A BRANCH, NOT PRODUCTION.
--
--   Every migration in this project so far went straight to production, which
--   is precisely how the ineffective `revoke ... from public` statements went
--   unnoticed for months: they ran without error and were never verified.
--
--   Supabase branching (or a throwaway project) gives a real check:
--     1. Create a branch of the project.
--     2. Run this file there.
--     3. Run Block 8's verification queries.
--     4. Hit the branch with the PUBLISHABLE key and confirm, over HTTP, that
--        each revoked RPC now returns 401/403 (the catalog says what SHOULD
--        happen; only an HTTP probe proves what DOES). Minimum set:
--          POST /rest/v1/rpc/provision_month          -> expect 401/403
--          POST /rest/v1/rpc/approve_access_request   -> expect 401/403
--          POST /rest/v1/rpc/is_sender_allowlisted    -> expect 200 (still needed)
--          POST /rest/v1/rpc/get_line_bind_gate_status-> expect 200 (still needed)
--     5. Load /status/ against the branch and confirm the pages still render
--        and the bind gate still redirects — that is the regression R1-BUG-1
--        would have caused.
--   Only then apply to production.
-- ----------------------------------------------------------------------------

begin;


-- ----------------------------------------------------------------------------
-- Block 1 — Root cause, part 1: stop auto-granting to anon/authenticated on
--           objects created by `postgres` (the SQL editor's role, and the owner
--           of every object this project has created so far).
--
--   Covers all three object types, not just functions. Note that this changes
--   FUTURE objects only — Blocks 3 and 6 fix the existing ones.
-- ----------------------------------------------------------------------------
-- `public` is NOT redundant here — see R2-BUG-4. Postgres grants EXECUTE to
-- PUBLIC on new functions independently of Supabase's anon/authenticated grants.
alter default privileges in schema public revoke execute on functions  from public, anon, authenticated;
alter default privileges in schema public revoke all     on tables     from public, anon, authenticated;
alter default privileges in schema public revoke all     on sequences  from public, anon, authenticated;

-- The matching `supabase_admin` entries cannot be altered from here (postgres
-- is not a member of that role). Block 2 is what actually covers them.


-- ----------------------------------------------------------------------------
-- Block 2 — Root cause, part 2: an event trigger that strips anon/authenticated
--           privileges from every new table/function in `public`, whoever
--           creates it.
--
--   This is the durable control. Grants are a single point of failure and this
--   project has already had them fail silently once; an event trigger closes
--   the hole by construction for both grantors and for objects created through
--   the dashboard, the SQL editor, or the API.
--
--   NAMING IS LOad-BEARING: event triggers fire in alphabetical order at
--   ddl_command_end. `trg_revoke_public_grants` sorts BEFORE the existing
--   `trg_secure_new_roster`, so this strips everything first and
--   trg_secure_new_roster then re-grants exactly the four roster columns
--   `authenticated` needs. Renaming this trigger to sort after that one would
--   break the /status /list /ranking pages with 401s.
-- ----------------------------------------------------------------------------
create or replace function public.revoke_public_grants()
returns event_trigger
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  for r in
    select * from pg_event_trigger_ddl_commands()
    where schema_name = 'public'
      and command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'CREATE FUNCTION')
  loop
    begin
      -- `public` is load-bearing (R2-BUG-4): without it a new function keeps
      -- Postgres's built-in PUBLIC EXECUTE grant and anon still reaches it.
      if r.command_tag = 'CREATE FUNCTION' then
        execute format('revoke all on function %s from public, anon, authenticated;', r.object_identity);
      else
        execute format('revoke all on table %s from public, anon, authenticated;', r.object_identity);
      end if;
    exception when others then
      -- Never block a DDL statement because of this; surface it instead.
      raise warning 'revoke_public_grants: failed on % (%): %', r.object_identity, r.command_tag, sqlerrm;
    end;
  end loop;
end $$;

drop event trigger if exists trg_revoke_public_grants;
create event trigger trg_revoke_public_grants on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'CREATE FUNCTION')
  execute function public.revoke_public_grants();

-- The trigger cannot protect its OWN function: revoke_public_grants() is
-- created before the event trigger exists, and the Block 1 default-privileges
-- change does not take effect for objects created in the SAME transaction as
-- that change (observed on the live apply — the function came out with
-- `=X/postgres`, i.e. PUBLIC EXECUTE, despite Block 1 running first).
-- Revoke on it explicitly. Not exploitable either way — calling it outside an
-- event-trigger context errors on pg_event_trigger_ddl_commands() — but it
-- would otherwise show up as an anon-executable function in the advisor.
revoke all on function public.revoke_public_grants() from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- Block 3 — Revoke EXECUTE on functions no browser client ever calls.
--
--   Verified callers before revoking (this is the check R1 skipped):
--     provision_month          -> automation/scripts/provision-next-month.mjs,
--                                 which requires SUPABASE_KEY to be the
--                                 service_role key (line 76). SAFE.
--     approve/reject_access_request -> main.js /telegram/webhook, using
--                                 SUPABASE_SERVICE_ROLE_KEY (main.js:316). SAFE.
--     rls_auto_enable, secure_new_roster, notify_access_request
--                              -> event-trigger / trigger bodies, never called
--                                 over HTTP. SAFE.
--
--   NOT revoked, and why:
--     get_line_bind_gate_status -> called by main.js WITH THE ANON KEY. See
--                                  R1-BUG-1 above and Appendix A.
--     is_sender_allowlisted     -> called by verify/app.js:394 pre-login.
--     log_access_request        -> called by verify/app.js:492 pre-login.
--     list_all_physicians       -> called by verify/app.js:254 pre-login.
--                                  This one is a real leak; Appendix B.
--     bind_line_user_id, record_bind_failure, is_current_user_allowlisted
--                               -> harmless to anon (they read
--                                  auth.jwt()->>'email', which is null, and
--                                  return early), but revoked anyway: they are
--                                  only ever called by an authenticated client,
--                                  so anon has no business reaching them.
-- ----------------------------------------------------------------------------
-- NOTE the `public,` prefix on every line (R2-BUG-4). Verified: without it,
-- rls_auto_enable / secure_new_roster / notify_access_request stay anon-callable
-- because they still carry Postgres's built-in PUBLIC EXECUTE grant.
revoke all on function public.provision_month(text, text)          from public, anon, authenticated;
revoke all on function public.approve_access_request(text)         from public, anon, authenticated;
revoke all on function public.reject_access_request(text)          from public, anon, authenticated;
revoke all on function public.rls_auto_enable()                    from public, anon, authenticated;
revoke all on function public.secure_new_roster()                  from public, anon, authenticated;
revoke all on function public.notify_access_request()              from public, anon, authenticated;
revoke all on function public.bind_line_user_id(text, text)        from public, anon;
revoke all on function public.record_bind_failure()                from public, anon;
revoke all on function public.is_current_user_allowlisted()        from public, anon;

-- Re-assert the intended grants (revoking from a role the function was granted
-- to via default privileges does not disturb service_role's own grant, but
-- being explicit makes the intent auditable).
grant execute on function public.provision_month(text, text)   to service_role;
grant execute on function public.approve_access_request(text)  to service_role;
grant execute on function public.reject_access_request(text)   to service_role;
grant execute on function public.record_bind_failure()         to authenticated;

-- The pre-login surface. These MUST keep anon EXECUTE or /verify/ breaks;
-- stated explicitly so the intent survives Block 2's event trigger if any of
-- them is ever recreated with CREATE OR REPLACE.
grant execute on function public.is_sender_allowlisted(text)            to anon, authenticated;
grant execute on function public.log_access_request(text, text, text)   to anon, authenticated;

-- UPDATE 2026-11 (audit finding F10): the grants that stood here for
-- list_all_physicians() (anon, see Appendix B), get_line_bind_gate_status(text)
-- (anon, see Appendix A) and bind_line_user_id(text, text) (authenticated)
-- are removed. All three are dropped (live per DATA_EXPOSURE_ANALYSIS.md
-- section 5, and in source by scripts/audit-fixes-2026-11.sql PART 4); never
-- grant them again. log_access_request is the 3-argument version from that
-- file's PART 2; the 2-argument one no longer exists.


-- ----------------------------------------------------------------------------
-- Block 4 — Defense in depth: assert the caller's role INSIDE the privileged
--           functions, so a future grant mistake cannot expose them again.
--
--   The entire incident behind this file is "a grant was supposed to protect
--   this and silently didn't". Fixing the grant alone recreates the same single
--   point of failure. An in-body assertion means the function is safe even when
--   the grant is wrong.
--
--   ⚠️  VERIFY ON THE BRANCH. auth.role() reads request.jwt.claims ->> 'role',
--       which PostgREST populates. This project uses the NEW Supabase API key
--       format (sb_publishable_… / sb_secret_…); confirm on the branch that a
--       service_role call still yields 'service_role' here before applying to
--       production, and that provision-next-month.mjs still succeeds. If the
--       claim is absent for your key type, this guard would lock the automation
--       out — which is why Block 0 exists.
-- ----------------------------------------------------------------------------
create or replace function public.assert_service_role()
returns void
language plpgsql
stable
set search_path = public
as $$
begin
  -- auth.role() is null for a direct (non-PostgREST) connection such as the
  -- SQL editor or a psql session, which we allow — those are already
  -- superuser-adjacent paths.
  if auth.role() is not null and auth.role() <> 'service_role' then
    raise exception 'forbidden: this function is service_role only (caller role: %)', auth.role()
      using errcode = '42501';
  end if;
end $$;

revoke all on function public.assert_service_role() from public, anon, authenticated;

-- Wire the guard into the three functions that perform privileged writes.
-- Bodies are otherwise unchanged from their current definitions; only the
-- first statement is added. (approve/reject shown; provision_month is long —
-- add `perform public.assert_service_role();` as its first statement too.)
create or replace function public.approve_access_request(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.access_requests%rowtype;
begin
  perform public.assert_service_role();

  select * into v_row from public.access_requests where approve_token = p_token and not resolved;
  if not found then
    return false;
  end if;

  insert into public.physician_directory (email, full_name)
  values (v_row.email, v_row.name)
  on conflict (email) do update
    set full_name = coalesce(excluded.full_name, public.physician_directory.full_name),
        active    = true;

  update public.access_requests set resolved = true where approve_token = p_token;
  return true;
end;
$$;

create or replace function public.reject_access_request(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_service_role();
  update public.access_requests set resolved = true where approve_token = p_token and not resolved;
  return found;
end;
$$;

-- The event trigger in Block 2 fires on these CREATE OR REPLACEs and strips
-- anon/authenticated again, but re-assert service_role explicitly:
grant execute on function public.approve_access_request(text) to service_role;
grant execute on function public.reject_access_request(text)  to service_role;


-- ----------------------------------------------------------------------------
-- Block 5 — Remove stale permissive policies on p4p_submissions (797 rows).
--
--   Two undocumented policies are live and appear in NO repo script (added via
--   the dashboard). They are inert today only because anon lacks a SELECT
--   grant — but RLS policies are OR'd, so any future grant, or a table
--   recreated by supabase_admin (default ACL anon=arwdDxtm), turns them into a
--   full public dump of every submission record.
-- ----------------------------------------------------------------------------
drop policy if exists "allow anon read" on public.p4p_submissions;
drop policy if exists "anon read only"  on public.p4p_submissions;


-- ----------------------------------------------------------------------------
-- Block 6 — Existing table privileges left behind by the default-privileges
--           leak. anon currently holds TRUNCATE on both of these; TRUNCATE
--           ignores RLS entirely.
--
--   public.fetch is an undocumented 1-row table (id bigint, fetch text) with a
--   wide-open `ALL / public / true` policy — it looks like an abandoned test
--   table. Confirm, then drop it.
-- ----------------------------------------------------------------------------
revoke all on public.email_sent_log from anon, authenticated;
revoke all on public."fetch"        from anon, authenticated;
drop policy if exists "ALL" on public."fetch";

-- drop table if exists public."fetch";   -- uncomment once confirmed unused


-- ----------------------------------------------------------------------------
-- Block 7 — Unguessable approve tokens, for FUTURE requests only.
--
--   Current default is substr(md5(random()::text || clock_timestamp()::text), 1, 12)
--   — 48 bits from a non-cryptographic PRNG. pgcrypto is installed.
--   16 bytes hex = 32 chars; 'appr|' + 32 = 37 bytes, comfortably under
--   Telegram's 64-byte callback_data cap (the reason the original was short).
--
--   Existing tokens are deliberately NOT rotated: they are embedded in Telegram
--   messages already sent, and rotating them would break the ✅/❌ buttons on
--   the 4 currently-unresolved requests (R1-BUG-3). Rotate them only if you
--   also re-send those alerts.
-- ----------------------------------------------------------------------------
alter table public.access_requests
  alter column approve_token set default encode(gen_random_bytes(16), 'hex');

commit;


-- ============================================================================
-- Block 8 — VERIFICATION. Run after applying. Compare against the expectations.
-- ============================================================================

-- (a) anon-executable functions. EXPECTED, exactly three:
--       is_sender_allowlisted, log_access_request, get_line_bind_gate_status
--     plus list_all_physicians until Appendix B is done.
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
order by p.proname;

-- (b) anon/public-visible RLS policies. EXPECTED: zero rows.
select tablename, policyname, roles::text
from pg_policies
where schemaname = 'public' and ('anon' = any(roles) or 'public' = any(roles));

-- (c) TABLE-level grants. EXPECTED: zero rows for anon.
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon';

-- (d) COLUMN-level grants — role_table_grants does NOT show these, which is why
--     (c) alone is not sufficient. EXPECTED: authenticated only, and only
--     firstname/lastname/department/submitted_at on rosters plus the four
--     p4p_submissions columns. Zero rows for anon.
select grantee, table_name, string_agg(column_name, ',' order by column_name) as cols
from information_schema.column_privileges
where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type = 'SELECT'
group by grantee, table_name order by grantee, table_name;

-- (e) Default privileges. EXPECTED: the postgres rows no longer mention
--     anon/authenticated. The supabase_admin rows WILL still mention them —
--     that is expected and is what Block 2's event trigger covers.
select pg_get_userbyid(defaclrole) as grantor, defaclobjtype as objtype,
       array_to_string(defaclacl::text[], ' | ') as default_acl
from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
where n.nspname = 'public' order by objtype, grantor;

-- (f) Prove Block 2 works end to end. EXPECTED: the select returns false.
--     (Run outside the transaction above.)
-- create table public.__grant_canary (id int);
-- select has_table_privilege('anon', 'public.__grant_canary', 'SELECT')
--     or has_table_privilege('anon', 'public.__grant_canary', 'TRUNCATE') as anon_has_something;
-- drop table public.__grant_canary;


-- ============================================================================
-- Appendix A — main.js change required before get_line_bind_gate_status can be
--              locked down (and a deeper problem with that gate).
-- ============================================================================
--  Today main.js:147-158 calls the RPC with the anon key. Change it to use the
--  user's already-resolved access token (`at`, in scope at main.js:196):
--
--      headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + at, ... }
--
--  then `revoke execute on function public.get_line_bind_gate_status(text)
--  from anon;` becomes safe, and the email-enumeration oracle closes.
--
--  SEPARATELY, and more important: the gate FAILS OPEN. Any error — network
--  blip, 403, timeout — makes getLineBindGateStatus return null, and main.js:199
--  then skips BOTH the bind requirement AND the blocked_emails denylist check.
--  Failing open on the bind requirement is a defensible UX decision. Failing
--  open on revocation is not: it means the only mechanism for cutting off a
--  departed or compromised physician stops working, silently, whenever that RPC
--  hiccups. Recommend splitting the two: fail open on `is_bound`, fail CLOSED on
--  `is_blocked` (or cache the denylist in the server process and fall back to
--  the cache rather than to "allow").
--
-- ============================================================================
-- Appendix B — the largest exposure, which no grant can fix.
-- ============================================================================
--  list_all_physicians() returns all 250 physician full names to any caller
--  holding the publishable key — which is, correctly, published in page source.
--  verify/app.js:254 calls it pre-login to populate the "select your name"
--  dropdown, so it cannot simply be revoked; 238 such calls are recorded in
--  pg_stat_statements. RLS restricts firstname/lastname to allow-listed
--  authenticated users, and this function hands the same data to anon.
--
--  Options, best first:
--    1. Delete the dropdown. Take the physician's name as free text on the
--       access-request form (cap length, strip control chars — it is
--       interpolated into a Telegram message). The admin already sees the name
--       and email in the approval alert, and the automation already does
--       Levenshtein matching. Removes the endpoint entirely.
--    2. Keep a dropdown but never send the roster: have the client POST the
--       typed name and return only a boolean/close-match count from a
--       SECURITY DEFINER function, so no list ever crosses the wire.
--    3. Weakest: keep it, but require the email to have already passed
--       is_sender_allowlisted. Does not help here — by definition the people
--       who see this form are NOT allow-listed.
--
--  Option 1 is a small change to verify/app.js + verify/index.html and closes
--  the only confirmed PII-to-internet path in the system.
--
--  ---------------------------------------------------------------------------
--  STATUS: option 1 is IMPLEMENTED in the app (verify/index.html now has a
--  length-capped text input; verify/app.js no longer calls the RPC), and
--  log_access_request() was hardened server-side on 2026-08-07 to strip control
--  characters and cap the name at 100 chars — verified against the live DB:
--    newline-injection attempt -> collapsed to one line
--    500-char name             -> truncated to 100
--    tabs/CRLF                 -> stripped, whitespace collapsed
--    malformed email           -> row not created at all
--    blank name                -> does not wipe a previously recorded name
--
--  UPDATE 2026-11 (audit findings F10, F13): the hardened log_access_request
--  described above was never written back into the repo, so the source still
--  had the old body. It now lives in scripts/audit-fixes-2026-11.sql PART 1
--  (same cleaning, plus: an existing request's name and department are never
--  overwritten and a resolved request is never reopened), and PART 5 of that
--  file does the revoke + drop below, uncommented. The rest of this appendix
--  is kept as the record of how it got there.
--
--  ⚠️  THE FUNCTION IS STILL PRESENT AND STILL ANON-CALLABLE, ON PURPOSE.
--  Production serves `main`, and the currently deployed /verify/ still calls
--  list_all_physicians() to fill its dropdown. Dropping it now would leave new
--  physicians unable to submit an access request at all (the dropdown would
--  never populate and the submit handler requires a selection).
--
--  RUN THIS ONLY AFTER the app change is merged to main and deployed, and
--  after loading /verify/ once to confirm the text field renders:
--
--      revoke all on function public.list_all_physicians() from public, anon, authenticated;
--      drop function if exists public.list_all_physicians();
--
--  Verify afterwards — expect exactly THREE anon-executable functions
--  (is_sender_allowlisted, log_access_request, get_line_bind_gate_status):
--
--      select p.proname
--      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
--      order by p.proname;
