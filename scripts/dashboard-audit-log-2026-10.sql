-- ============================================================================
--  dashboard-audit-log-2026-10.sql — who did what on /dashboard/.
--
--  One row per sign-in, refused sign-in, sign-out, page view, list opened,
--  follow-up note added or deleted, and audit-log view. main.ts writes every
--  row on the server (never the browser), so an admin cannot skip or forge
--  one. Only the dashboard owner (DASHBOARD_OWNER_LINE_USER_IDS, default
--  ADMIN_LINE_USER_ID) can read it, through /dashboard/api/audit.
--
--  service_role only, like dashboard_followups: RLS on with no policies.
--  Append-only: a trigger refuses UPDATE and DELETE for every role, the
--  service key included, so the app cannot rewrite history. Removing that
--  guard takes the project owner in the Supabase SQL editor.
-- ============================================================================

create table if not exists public.dashboard_audit_log (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  actor_line_id text        not null default '',
  actor_name    text        not null default '',
  action        text        not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  target        jsonb       not null default '{}'::jsonb,
  ip            text        not null default '',
  user_agent    text        not null default '' check (char_length(user_agent) <= 300)
);

create index if not exists dashboard_audit_log_created_idx
  on public.dashboard_audit_log (created_at desc);
create index if not exists dashboard_audit_log_actor_idx
  on public.dashboard_audit_log (actor_line_id, created_at desc);

alter table public.dashboard_audit_log enable row level security;
revoke all on table public.dashboard_audit_log from anon, authenticated;

create or replace function public.dashboard_audit_log_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'dashboard_audit_log is append-only';
end;
$$;

drop trigger if exists dashboard_audit_log_no_change on public.dashboard_audit_log;
create trigger dashboard_audit_log_no_change
  before update or delete on public.dashboard_audit_log
  for each row execute function public.dashboard_audit_log_append_only();

-- TRUNCATE skips row triggers, so refuse it separately.
drop trigger if exists dashboard_audit_log_no_truncate on public.dashboard_audit_log;
create trigger dashboard_audit_log_no_truncate
  before truncate on public.dashboard_audit_log
  for each statement execute function public.dashboard_audit_log_append_only();
