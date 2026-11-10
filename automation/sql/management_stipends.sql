-- One-time DDL + seed for the management_stipends table.
-- Run this in the Supabase SQL Editor (supabase-js/PostgREST cannot run DDL).
--
-- Replaces process/process.js's hardcoded MANAGEMENT_DATA array and
-- DEPT_HEAD_SET — real physicians' names, roles, and monthly stipend
-- amounts (compensation data) were previously committed straight into
-- source, permanently baking PII into git history. Same reasoning as
-- automation/sql/dept_heads.sql: this data changes occasionally (a role
-- changes, a stipend is adjusted), and a Table Editor row-edit beats a
-- code change + redeploy.
--
-- SECURITY: same posture as dept_heads.sql / sender_physician_match.sql —
-- no page ever reads this table (process.js is a standalone Node script,
-- not a browser client), so RLS is enabled with NO anon/authenticated
-- policies at all. Only service_role (used by process.js) can access it.
--
-- To edit later: Supabase Dashboard -> Table Editor -> management_stipends
-- -> edit the row directly, or:
--   UPDATE management_stipends SET amount = 1200 WHERE physician_name = 'ชื่อ นามสกุล';

create table if not exists management_stipends (
  -- Normalised "firstname lastname" (trimmed, single-spaced) — matches the
  -- key process/process.js's normaliseName() already produces, so lookups
  -- against roster rows need no extra transformation.
  physician_name text primary key,
  remark         text,
  amount         numeric not null default 0,
  is_dept_head   boolean not null default false,
  updated_at     timestamptz not null default now()
);

alter table public.management_stipends enable row level security;
revoke all on public.management_stipends from anon, authenticated;
grant select, insert, update, delete on public.management_stipends to service_role;

-- No seed rows here. This repo is public, and the names, roles and stipend
-- amounts are personal pay data: they live only in the Supabase table, where
-- the owner adds or edits rows in the Table Editor. (An earlier version of
-- this file seeded 22 real rows; they are still in git history.) Re-pasting
-- this file is safe: it creates nothing that exists and changes no row.
