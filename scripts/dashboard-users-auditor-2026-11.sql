-- ============================================================================
--  dashboard-users-auditor-2026-11.sql — the ผู้ตรวจสอบ right (step 28).
--
--  Pong, 2026-11-18: "for audit access role : allow select ผู้ตรวจสอบ (no
--  more เฉพาะผู้ดูแล)". A dashboard user may now be given review.auditor,
--  the ตรวจสอบ tab's auditor side (check each person, approve or return,
--  approve all, reopen, the allocation Excel). One side only: a user holds
--  review.auditee or review.auditor, never both, so the one who prepares a
--  month never approves it. The owner (ADMIN_LINE_USER_ID) keeps both.
--
--  What it changes:
--    1. dashboard_users.perms accepts review.auditor, and refuses a row
--       that holds both sides;
--    2. dashboard_perms_clean (used by approve and save) does the same.
--  Nothing else: no row is written or changed, and every right stays
--  service_role only.
--
--  Needs scripts/dashboard-users-2026-11.sql (step 27). Safe to re-run.
--  No backslashes, so it pastes through chat.
-- ============================================================================

-- 1. The perms check on dashboard_users: the old one (from step 27) out,
--    the new one in. Found by what it says, so its name does not matter.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.dashboard_users'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%review.auditee%'
  loop
    execute format('alter table public.dashboard_users drop constraint %I', c.conname);
  end loop;
end
$$;

alter table public.dashboard_users add constraint dashboard_users_perms_check
  check (perms <@ array['followup.view','followup.edit','roster.view','staffing.view','review.auditee','review.auditor']::text[]
         and not (perms @> array['review.auditee','review.auditor']::text[]));

-- 2. The rights as stored: known keys only, one ตรวจสอบ side at most,
--    followup.edit brings followup.view, sorted, no repeats.
create or replace function public.dashboard_perms_clean(p_perms text[])
returns text[]
language plpgsql
set search_path = ''
as $$
declare
  v text[] := coalesce(p_perms, '{}');
begin
  if not (v <@ array['followup.view','followup.edit','roster.view','staffing.view','review.auditee','review.auditor']::text[]) then
    raise exception 'dashboard: bad perms';
  end if;
  if v @> array['review.auditee','review.auditor']::text[] then
    raise exception 'dashboard: bad perms (both review sides)';
  end if;
  if 'followup.edit' = any (v) then v := v || 'followup.view'::text; end if;
  return array(select distinct x from unnest(v) as x order by 1);
end;
$$;
revoke all on function public.dashboard_perms_clean(text[]) from public, anon, authenticated;
grant execute on function public.dashboard_perms_clean(text[]) to service_role;

-- Check: auditor_ok = true, check_ok = true, anon_0 = 0.
select
  public.dashboard_perms_clean(array['review.auditor','roster.view']) = array['review.auditor','roster.view']::text[] as auditor_ok,
  (select count(*) from pg_constraint
    where conrelid = 'public.dashboard_users'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%review.auditor%') = 1 as check_ok,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'dashboard_perms_clean'
      and has_function_privilege('anon', p.oid, 'execute')) as anon_0;
