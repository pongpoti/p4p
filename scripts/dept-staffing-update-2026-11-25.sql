-- ============================================================================
--  dept-staffing-update-2026-11-25.sql — the อัตรากำลัง tab's numbers from
--  the staffing report of 25 Nov 2026 (อัตรากำลัง 25-11-69).
--
--  Pong, 2026-11-25: "update this data to dashboard and SK03 formula". The
--  numbers are the doctors shown working in the report
--  รายงานอัตรากำลังแพทย์จำแนกตามกลุ่มงาน พ.ย. 2569, made from the hospital's
--  doctor list of 25 Nov 2026 (ข้อมูลแพทย์ 25 พ.ย. 69) and the roster 2569_11:
--    staff    ข้าราชการ at work (doctors on study leave, gone or not working
--             are not counted; maternity leave counts as at work)
--    monthly  doctors hired by the month (ลูกจ้างชั่วคราว / เงินบำรุง)
--    daily    doctors paid by the session (ลูกจ้างเงินประกันสังคม รายคาบ)
--  FTE stays as on the 13-11-69 sheet (locked on the dashboard).
--
--  Changed against 13-11-69: PED, EYE, OPD, RAD, ANS, SOC, SUR, MED.
--  Multipliers: EYE 1.56 to 2.11, ANS 3.00 to 3.67, SUR 1.51 to 1.64,
--  MED 1.64 to 2.06; the others stay. Mainly because the report leaves out
--  doctors on study leave, which the 13-11-69 sheet counted.
--
--  Each department whose numbers differ goes through staffing_save, the
--  same as a save on the อัตรากำลัง tab: updated_at and updated_by are set,
--  every ตรวจสอบ month still on the auditee's side gets a new SK03 build
--  (2569_08 and 2569_09 on 2026-11-25), and one staffing.save row per
--  department goes into ประวัติการใช้งาน, as the owner. A department that
--  already has these numbers is left as it is, so a second run changes
--  nothing.
--
--  Needs scripts/dept-staffing-2026-11.sql (both PARTs) and the audit log
--  (scripts/dashboard-audit-log-2026-10.sql). Run it in the Supabase SQL
--  editor as one statement, then the check at the end. No backslashes, so
--  it pastes through chat.
-- ============================================================================

with v (code, name, fte, staff, monthly, daily) as (
  values
    ('PED', 'กุมารเวชกรรม',                        19, 19, 0,  1),
    ('EYE', 'จักษุวิทยา',                          9,  6, 1,  0),
    ('PSY', 'จิตเวชและยาเสพติด',                   4,  4, 0,  2),
    ('CPT', 'เทคนิคการแพทย์และพยาธิวิทยาคลินิก',   1,  1, 0,  0),
    ('FOR', 'นิติเวช',                             3,  2, 0,  0),
    ('OPD', 'ผู้ป่วยนอก',                           5,  3, 0, 11),
    ('PAT', 'พยาธิวิทยากายวิภาค',                  2,  3, 0,  0),
    ('RAD', 'รังสีวิทยา',                           15, 13, 0,  1),
    ('ANS', 'วิสัญญีวิทยา',                         15,  7, 0,  0),
    ('RHB', 'เวชกรรมฟื้นฟู',                        6,  4, 0,  0),
    ('SOC', 'เวชกรรมสังคม',                         10,  5, 0, 15),
    ('EMR', 'เวชศาสตร์ฉุกเฉิน',                     10, 10, 0,  0),
    ('SUR', 'ศัลยกรรม',                            39, 33, 0,  1),
    ('ORT', 'ศัลยกรรมออร์โธปิดิกส์',                17, 15, 0,  0),
    ('OBG', 'สูติ-นรีเวชกรรม',                      18, 13, 0,  2),
    ('ENT', 'โสต ศอ นาสิก',                         9,  8, 0,  0),
    ('OCM', 'อาชีวเวชกรรม',                         5,  3, 0,  0),
    ('MED', 'อายุรกรรม',                            47, 33, 0,  4)
),
todo as (
  select v.*
    from v left join public.dept_staffing d on d.code = v.code
   where d.code is null
      or (d.fte, d.staff, d.monthly, d.daily) is distinct from (v.fte, v.staff, v.monthly, v.daily)
),
saved as materialized (
  select t.code, t.name,
         public.staffing_save(t.code, t.fte, t.staff, t.monthly, t.daily, 'ปองสิทธิ์') as out
    from todo t
   order by t.code
),
counts as (
  select s.code, s.name, s.out -> 'rebuild' as rebuild,
         (s.out -> 'before' ->> 'fte')::int     as b_fte,
         (s.out -> 'before' ->> 'staff')::int   as b_staff,
         (s.out -> 'before' ->> 'monthly')::int as b_monthly,
         (s.out -> 'before' ->> 'daily')::int   as b_daily,
         (s.out -> 'after' ->> 'fte')::int      as a_fte,
         (s.out -> 'after' ->> 'staff')::int    as a_staff,
         (s.out -> 'after' ->> 'monthly')::int  as a_monthly,
         (s.out -> 'after' ->> 'daily')::int    as a_daily
    from saved s
),
owner as (
  -- The owner's LINE id, from their latest reset in the ตรวจสอบ tab (owner only).
  select coalesce((select a.actor_line_id from public.dashboard_audit_log a
                    where a.action = 'review.reset' and a.actor_line_id <> ''
                    order by a.id desc limit 1), '') as line_id
)
insert into public.dashboard_audit_log (actor_line_id, actor_name, action, target, ip, user_agent)
select o.line_id, 'ปองสิทธิ์', 'staffing.save',
       jsonb_build_object(
         'code', c.code,
         'name', c.name,
         'before', case when c.b_fte is null then null
                        else jsonb_build_object('fte', c.b_fte, 'staff', c.b_staff, 'monthly', c.b_monthly, 'daily', c.b_daily) end,
         'after', jsonb_build_object('fte', c.a_fte, 'staff', c.a_staff, 'monthly', c.a_monthly, 'daily', c.a_daily),
         'k', 5,
         'multiplier_before', case when c.b_fte is null then null
                                   else round(1 + 5 * greatest(0, 1 - (c.b_staff + c.b_monthly + c.b_daily)::numeric / c.b_fte), 4) end,
         'multiplier_after', round(1 + 5 * greatest(0, 1 - (c.a_staff + c.a_monthly + c.a_daily)::numeric / c.a_fte), 4),
         'rebuild', coalesce(c.rebuild, '[]'::jsonb),
         'source', 'อัตรากำลัง 25-11-69'),
       '', 'Supabase SQL editor: scripts/dept-staffing-update-2026-11-25.sql'
  from counts c cross join owner o
returning target ->> 'code' as code,
          target -> 'before' as before,
          target -> 'after' as after,
          target ->> 'multiplier_before' as multiplier_before,
          target ->> 'multiplier_after' as multiplier_after,
          target -> 'rebuild' as rebuild;

-- Check: 18 departments; 234 FTE, 182 on staff, 1 monthly, 37 daily (220 at
-- work); edited_8 = 8 (PED, EYE, OPD, RAD, ANS, SOC, SUR, MED).
select count(*) as departments, sum(fte) as fte, sum(staff) as on_staff, sum(monthly) as monthly,
       sum(daily) as daily, sum(staff + monthly + daily) as at_work,
       count(updated_at) filter (where updated_at > now() - interval '1 day') as edited_8
  from public.dept_staffing;
