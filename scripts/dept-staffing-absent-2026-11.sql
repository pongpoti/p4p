-- ============================================================================
--  dept-staffing-absent-2026-11.sql — ไม่ได้ปฏิบัติงาน on the อัตรากำลัง tab
--  (step 33).
--
--  Pong, 2026-11-26: the อัตรากำลัง table shows ปฏิบัติงานจริง (ข้าราชการ,
--  อัตราจ้าง) and a new column ไม่ได้ปฏิบัติงาน. That number is kept here, in
--  dept_staffing.absent: the department's doctors who are not at work (study
--  leave and the like), as in the staffing report of 25 Nov 2026
--  (รายงานอัตรากำลังแพทย์จำแนกตามกลุ่มงาน พ.ย. 2569, "แพทย์ที่ไม่ได้ปฏิบัติงาน
--  จำนวน N ราย"): PED 3, EYE 1, RAD 1, ANS 2, SUR 1, ORT 1, MED 4, the
--  others 0. The report leaves ผู้ป่วยนอก's out, so OPD starts at 0.
--
--  It is shown only: the multiplier stays 1 + 5 x lack with
--  lack = max(0, 1 - (staff + monthly + daily) / fte), and a save that only
--  changes ไม่ได้ปฏิบัติงาน queues no SK03 build.
--
--    1. the column absent (0 to 999, default 0), filled as above while
--       every department still has 0;
--    2. staffing_save takes it as a last argument p_absent (null: keep the
--       saved number), so the 6-argument calls (the app before this change,
--       scripts/dept-staffing-update-2026-11-25.sql) still work. Replaces
--       the version without it.
--
--  Needs scripts/dept-staffing-2026-11.sql (both PARTs). Run in the Supabase
--  SQL editor, then the check at the end. Safe to re-run. No backslashes, so
--  it pastes through chat.
-- ============================================================================

-- 1. The column and the 25-11-69 numbers.
alter table public.dept_staffing
  add column if not exists absent int not null default 0 check (absent between 0 and 999);

update public.dept_staffing t
   set absent = v.absent
  from (values ('PED', 3), ('EYE', 1), ('RAD', 1), ('ANS', 2), ('SUR', 1), ('ORT', 1), ('MED', 4)) as v (code, absent)
 where t.code = v.code
   -- Only while no department has one yet, so a re-run never undoes an edit.
   and not exists (select 1 from public.dept_staffing x where x.absent > 0);

-- 2. staffing_save with ไม่ได้ปฏิบัติงาน.
drop function if exists public.staffing_save(text, int, int, int, text);
drop function if exists public.staffing_save(text, int, int, int, int, text);
create or replace function public.staffing_save(p_code text, p_fte int, p_staff int, p_monthly int, p_daily int,
                                                 p_actor text, p_absent int default null)
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
  if p_absent is not null and (p_absent < 0 or p_absent > 999) then raise exception 'staffing: bad absent'; end if;
  perform pg_advisory_xact_lock(hashtext('staffing:' || p_code));
  select * into v_before from public.dept_staffing where code = p_code;
  insert into public.dept_staffing as t (code, fte, staff, monthly, daily, absent, updated_at, updated_by)
  values (p_code, p_fte, p_staff, p_monthly, p_daily, coalesce(p_absent, 0), now(), coalesce(p_actor, ''))
  on conflict (code) do update
     set fte = excluded.fte, staff = excluded.staff, monthly = excluded.monthly, daily = excluded.daily,
         absent = coalesce(p_absent, t.absent),
         updated_at = excluded.updated_at, updated_by = excluded.updated_by
  returning * into v_after;
  -- ไม่ได้ปฏิบัติงาน is not in the multiplier: a change to it alone rebuilds nothing.
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

revoke all on function public.staffing_save(text, int, int, int, int, text, int) from public, anon, authenticated;
grant execute on function public.staffing_save(text, int, int, int, int, text, int) to service_role;

-- Check: departments_18 = 18, absent_13 = 13 (PED 3, EYE 1, RAD 1, ANS 2,
-- SUR 1, ORT 1, MED 4), functions_1 = 1, anon_0 = 0.
select
  (select count(*) from public.dept_staffing) as departments_18,
  (select sum(absent) from public.dept_staffing) as absent_13,
  (select string_agg(code || ' ' || absent, ', ' order by code) from public.dept_staffing where absent > 0) as absent_by_dept,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'staffing_save') as functions_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'staffing_save' and has_function_privilege('anon', p.oid, 'execute')) as anon_0;
