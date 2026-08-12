-- One-time DDL + seed for the dept_heads table.
-- Run this in the Supabase SQL Editor (supabase-js/PostgREST cannot run DDL).
-- Replaces the DEPT_HEADS_JSON GitHub secret: heads change often, and
-- secrets are write-only (can't be read back), so score-tracker.mjs and
-- resend-month.mjs now read this table instead via getDeptHeads().
--
-- SECURITY: same reasoning as sql/sender_physician_match.sql — the
-- status/list/ranking pages query Supabase directly from the browser with
-- the public "anon" key (see assets/shared.js), and a freshly created table
-- is otherwise readable/writable by that same public key (per
-- automation/scripts/fix-supabase-grants.sql). No page needs this table, so
-- RLS is enabled with NO anon/authenticated policies at all — only
-- service_role (used by the automation) can access it.
--
-- To manually update a head's email later: Supabase Dashboard -> Table
-- Editor -> dept_heads -> edit the head_email cell directly, or:
--   UPDATE dept_heads SET head_email = 'new@email.com' WHERE department = 'ศัลยกรรม';

create table if not exists dept_heads (
  department text primary key,
  head_email text,
  updated_at timestamptz not null default now()
);

alter table public.dept_heads enable row level security;
revoke all on public.dept_heads from anon, authenticated;
grant select, insert, update, delete on public.dept_heads to service_role;

-- SEED DATA REMOVED — do not re-add it here.
--
-- This file used to carry the full department -> head_email mapping inline.
-- That is 18 named individuals' personal email addresses, and this repository
-- is public, so the seed was published to the internet. Worse, those same
-- addresses are the login allow-list (login is possession of the inbox, with
-- no MFA), so the seed doubled as a target list.
--
-- The mapping now lives ONLY in the dept_heads table, which is where the file
-- header above already says it should live. It is populated and edited through
-- the Supabase Table Editor. The 18 rows were verified present and identical
-- to this former seed before it was removed.
--
-- To (re)populate on a fresh project, run an insert with the real values
-- pasted into the SQL Editor directly — never through a file in this repo.
-- The DDL and grants above are the only part that belongs in version control.
