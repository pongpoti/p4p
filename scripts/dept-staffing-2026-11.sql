-- ============================================================================
--  dept-staffing-2026-11.sql — each department's physician staffing in Supabase.
--
--  Pong, 2026-11-16: a dashboard tab อัตรากำลัง (Staffing) lists every STAFF
--  department's staffing and its department multiplier, and the owner edits
--  the numbers there. They are kept here, in dept_staffing, one row per
--  department code (the 18 codes of lib/dept-staffing.ts):
--    fte      จำนวนที่ควรมี (FTE), at least 1
--    staff    รวมอัตราตามจริง less the monthly hires (doctors on staff)
--    monthly  ลูกจ้างชั่วคราว รายเดือน (doctors hired by the month)
--    daily    ลูกจ้างชั่วคราว รายวัน (doctors hired by the day)
--  Workflow 2.2 reads the table on every SK03 build:
--    lack = max(0, 1 - (staff + monthly + daily) / fte), multiplier = 1 + 5 x lack.
--
--  Pong, 2026-11-17: monthly hires get their own column. The sheet's
--  รวมอัตราตามจริง already counts them, so a table made before this file
--  had the column keeps the same totals: re-running PART 1 adds the column
--  and moves MED's and EYE's one monthly hire out of staff (37 to 36 + 1,
--  8 to 7 + 1) where the row is still as on the sheet. No multiplier
--  changes. Re-run PART 2 too: staffing_save now takes the monthly hires.
--
--  PART 1 makes the table and fills it with the starting numbers of
--  lib/dept-staffing.ts. Until 2026-11-25 those were the physician staffing
--  sheet of 13 Nov 2026 (13-11-69); since then FTE is from that sheet and
--  on staff, monthly and daily hires from the staffing report of 25 Nov
--  2026 (อัตรากำลัง 25-11-69). A table made before then got the 25-11-69
--  numbers through scripts/dept-staffing-update-2026-11-25.sql.
--  updated_at and updated_by stay empty on these rows: empty means "as on
--  the sheet", not edited on the dashboard. Re-running PART 1 never
--  overwrites a number saved on the dashboard.
--
--  PART 2 adds staffing_save, which the tab calls (through the Vercel app,
--  service role only) to save one department. A save also queues a new
--  build of every ตรวจสอบ month still on the auditee's side (no round with
--  the auditor or approved), so none of them can be sent with pay worked
--  out from the old numbers; other months use the new numbers on their
--  next build.
--
--  Run in the Supabase SQL editor. Each PART can be pasted on its own, PART 1
--  first. Safe to re-run. No backslashes, so it pastes through chat.
-- ============================================================================

-- ── PART 1: the table and the starting numbers ─────────────────────────────
-- Run it after the dashboard update with the จ้างรายเดือน column is live:
-- the app before that reads staff without the monthly hires.

create table if not exists public.dept_staffing (
  code       text primary key check (code in ('PED','EYE','PSY','CPT','FOR','OPD','PAT','RAD','ANS',
                                              'RHB','SOC','EMR','SUR','ORT','OBG','ENT','OCM','MED')),
  fte        int not null check (fte between 1 and 999),
  staff      int not null check (staff between 0 and 999),
  daily      int not null default 0 check (daily between 0 and 999),
  updated_at timestamptz,
  updated_by text
);

-- Monthly hires (2026-11-17); a no-op once the column is there.
alter table public.dept_staffing
  add column if not exists monthly int not null default 0 check (monthly between 0 and 999);

-- Service role only: the browser never reads or writes it directly.
alter table public.dept_staffing enable row level security;
revoke all on table public.dept_staffing from public, anon, authenticated;
grant select, insert, update on table public.dept_staffing to service_role;

insert into public.dept_staffing (code, fte, staff, monthly, daily)
values
  ('PED', 19, 19, 0,  1),
  ('EYE',  9,  6, 1,  0),
  ('PSY',  4,  4, 0,  2),
  ('CPT',  1,  1, 0,  0),
  ('FOR',  3,  2, 0,  0),
  ('OPD',  5,  3, 0, 11),
  ('PAT',  2,  3, 0,  0),
  ('RAD', 15, 13, 0,  1),
  ('ANS', 15,  7, 0,  0),
  ('RHB',  6,  4, 0,  0),
  ('SOC', 10,  5, 0, 15),
  ('EMR', 10, 10, 0,  0),
  ('SUR', 39, 33, 0,  1),
  ('ORT', 17, 15, 0,  0),
  ('OBG', 18, 13, 0,  2),
  ('ENT',  9,  8, 0,  0),
  ('OCM',  5,  3, 0,  0),
  ('MED', 47, 33, 0,  4)
on conflict (code) do nothing;

-- A table made before the monthly column counted MED's and EYE's monthly
-- hire in staff (13-11-69 sheet: 37 and 8): move it, only where the row is
-- still as on that sheet. A no-op on a table seeded above.
update public.dept_staffing t
   set staff = t.staff - m.monthly, monthly = m.monthly
  from (values ('EYE', 8, 1), ('MED', 37, 1)) as m (code, sheet_staff, monthly)
 where t.code = m.code and t.staff = m.sheet_staff and t.monthly = 0 and t.updated_at is null;

-- Check: 18 departments; 234 FTE, 182 on staff, 1 monthly, 37 daily (25-11-69).
select count(*) as departments, sum(fte) as fte, sum(staff) as on_staff, sum(monthly) as monthly,
       sum(daily) as daily, count(updated_at) as edited
  from public.dept_staffing;


-- ── PART 2: staffing_save, one department from the dashboard ───────────────
-- Saves FTE, on staff, monthly and daily hires for one department code and returns
-- the row before (null: none yet), the row after, and the months whose
-- rebuild it queued. The numbers are checked here as well as in the app.
-- When a number changed, the ตรวจสอบ months (from 2569_08) that have a
-- build and are on the auditee's side get a build request (reason 'inputs': one more is queued
-- after a build that is already running, since that one read the old
-- numbers), and sending waits for it. Skipped while the ตรวจสอบ tables are
-- not installed. Replaces the version without monthly hires.
drop function if exists public.staffing_save(text, int, int, int, text);
create or replace function public.staffing_save(p_code text, p_fte int, p_staff int, p_monthly int, p_daily int,
                                                 p_actor text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_before public.dept_staffing;
  v_after  public.dept_staffing;
  v_month  text;
  v_months text[] := '{}';
begin
  if p_code is null or p_code not in ('PED','EYE','PSY','CPT','FOR','OPD','PAT','RAD','ANS',
                                      'RHB','SOC','EMR','SUR','ORT','OBG','ENT','OCM','MED') then
    raise exception 'staffing: unknown department';
  end if;
  if p_fte is null or p_fte < 1 or p_fte > 999 then raise exception 'staffing: bad fte'; end if;
  if p_staff is null or p_staff < 0 or p_staff > 999 then raise exception 'staffing: bad staff'; end if;
  if p_monthly is null or p_monthly < 0 or p_monthly > 999 then raise exception 'staffing: bad monthly'; end if;
  if p_daily is null or p_daily < 0 or p_daily > 999 then raise exception 'staffing: bad daily'; end if;
  perform pg_advisory_xact_lock(hashtext('staffing:' || p_code));
  select * into v_before from public.dept_staffing where code = p_code;
  insert into public.dept_staffing as t (code, fte, staff, monthly, daily, updated_at, updated_by)
  values (p_code, p_fte, p_staff, p_monthly, p_daily, now(), coalesce(p_actor, ''))
  on conflict (code) do update
     set fte = excluded.fte, staff = excluded.staff, monthly = excluded.monthly, daily = excluded.daily,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by
  returning * into v_after;
  if (v_before.code is null or (v_before.fte, v_before.staff, v_before.monthly, v_before.daily)
                                is distinct from (v_after.fte, v_after.staff, v_after.monthly, v_after.daily))
     and to_regclass('public.review_builds') is not null and to_regclass('public.review_rounds') is not null
     and to_regprocedure('public.review_request_build(text, text, text)') is not null then
    for v_month in
      select distinct b.month from public.review_builds b where b.month >= '2569_08' order by 1
    loop
      -- The month's ตรวจสอบ lock: a send waits for this save, or this save
      -- sees the round it sent.
      perform pg_advisory_xact_lock(hashtext('review:' || v_month));
      if not exists (select 1 from public.review_rounds r
                      where r.month = v_month and r.status in ('submitted', 'approved')) then
        perform public.review_request_build(v_month, 'inputs', coalesce(p_actor, ''));
        v_months := v_months || v_month;
      end if;
    end loop;
  end if;
  return jsonb_build_object(
    'before', case when v_before.code is null then null else to_jsonb(v_before) end,
    'after', to_jsonb(v_after),
    'rebuild', to_jsonb(v_months));
end;
$$;

revoke all on function public.staffing_save(text, int, int, int, int, text) from public, anon, authenticated;
grant execute on function public.staffing_save(text, int, int, int, int, text) to service_role;
