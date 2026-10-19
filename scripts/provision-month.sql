-- ============================================================================
--  provision-month.sql — MANUAL entry point to create a new monthly roster
--  table from last month's.
--
--  This is now a thin wrapper around public.provision_month(p_new, p_old),
--  defined in scripts/provision-month-function.sql — the single source of
--  truth shared with the automated monthly workflow
--  (.github/workflows/2-4-monthly-create-roster-table.yml). Keeping both paths on the same
--  function guarantees a manual provision and an automated provision behave
--  identically (this is what prevents the kind of drift that caused the
--  missing-anon-grant outage).
--
--  PREREQUISITE (one-time): run scripts/provision-month-function.sql once in
--  the SQL editor to install/refresh the function.
--
--  HOW TO USE
--    1. Find/replace the two placeholders below (case-sensitive):
--         {{NEW}}  → the month you are creating, e.g. 2569_08
--         {{OLD}}  → the previous month to copy from, e.g. 2569_07
--    2. Paste the whole file into Supabase Dashboard → SQL Editor → Run.
--
--  Safe to re-run: provision_month() no-ops if {{NEW}} already exists, so this
--  never overwrites existing data.
-- ============================================================================

-- Provision (copies structure + roster, resets score/submitted_at, applies RLS,
-- and hard-asserts anon can read all 4 columns). Returns a summary string.
SELECT public.provision_month('{{NEW}}', '{{OLD}}');

-- Verify — roster count, RLS on, and anon's actual column grants (should list
-- the 4 read columns). column_privileges is used deliberately: role_table_grants
-- does NOT surface column-level grants unless they cover every column.
SELECT count(*) AS roster_count FROM public."{{NEW}}";

SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' AND tablename = '{{NEW}}';

SELECT table_name, column_name, privilege_type
FROM information_schema.column_privileges
WHERE grantee = 'anon' AND table_schema = 'public' AND table_name = '{{NEW}}'
ORDER BY column_name;
