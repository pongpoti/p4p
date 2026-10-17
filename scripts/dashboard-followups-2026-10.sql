-- ============================================================================
--  dashboard-followups-2026-10.sql — the /dashboard/ ตามส่ง (follow-up) log.
--
--  One row per phone call or LINE message an admin records for a physician
--  who has not sent that month's file yet. The physician is identified by
--  the month's roster table and that table's row `index` (uuid), with the
--  name snapshotted so the log still reads correctly if the roster changes.
--
--  service_role only, like dept_heads / physician_directory: RLS on with no
--  anon/authenticated policies. main.ts "/dashboard/api/followups" reads and
--  writes it with SUPABASE_SERVICE_ROLE_KEY after checking the dashboard
--  session, so the key never reaches the browser.
-- ============================================================================

create table if not exists public.dashboard_followups (
  id             bigint generated always as identity primary key,
  month_key      text        not null check (month_key ~ '^[0-9]{4}_[0-9]{2}$'),
  roster_index   uuid        not null,
  physician_name text        not null,
  channel        text        not null check (channel in ('phone', 'line')),
  note           text        not null default '' check (char_length(note) <= 500),
  logged_by      text        not null default '',
  created_at     timestamptz not null default now()
);

create index if not exists dashboard_followups_month_idx
  on public.dashboard_followups (month_key, roster_index, channel, created_at);

alter table public.dashboard_followups enable row level security;
revoke all on table public.dashboard_followups from anon, authenticated;
