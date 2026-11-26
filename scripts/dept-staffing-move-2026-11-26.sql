-- อัตรากำลัง: one session-paid doctor moves from กุมารเวชกรรม to เวชกรรมสังคม
-- (Pong, 2026-11-26; SUPABASE_MIGRATIONS step 34). PED อัตราจ้าง 1 to 0, SOC อัตราจ้าง 15 to 16.
-- Both multipliers stay 1.00, so SK03 pay does not change.
-- Same as two saves on the อัตรากำลัง tab: staffing_save queues the
-- 2569_08 and 2569_09 rebuilds and one staffing.save row per department
-- goes into ประวัติการใช้งาน. A second run changes nothing.
with v (code, name, fte, staff, monthly, daily) as (
  values ('PED', 'กุมารเวชกรรม', 19, 19, 0, 0),
         ('SOC', 'เวชกรรมสังคม', 10, 5, 0, 16)
),
todo as (
  select v.* from v join public.dept_staffing d on d.code = v.code
   where (d.fte, d.staff, d.monthly, d.daily) is distinct from (v.fte, v.staff, v.monthly, v.daily)
),
saved as materialized (
  select t.code, t.name, public.staffing_save(t.code, t.fte, t.staff, t.monthly, t.daily, 'ปองสิทธิ์') as out
    from todo t order by t.code
),
owner as (
  select coalesce((select a.actor_line_id from public.dashboard_audit_log a
                    where a.action = 'review.reset' and a.actor_line_id <> ''
                    order by a.id desc limit 1), '') as line_id
)
insert into public.dashboard_audit_log (actor_line_id, actor_name, action, target, ip, user_agent)
select o.line_id, 'ปองสิทธิ์', 'staffing.save',
       jsonb_build_object(
         'code', s.code, 'name', s.name,
         'before', jsonb_build_object('fte', (s.out -> 'before' ->> 'fte')::int, 'staff', (s.out -> 'before' ->> 'staff')::int,
                                      'monthly', (s.out -> 'before' ->> 'monthly')::int, 'daily', (s.out -> 'before' ->> 'daily')::int,
                                      'absent', (s.out -> 'before' ->> 'absent')::int),
         'after', jsonb_build_object('fte', (s.out -> 'after' ->> 'fte')::int, 'staff', (s.out -> 'after' ->> 'staff')::int,
                                     'monthly', (s.out -> 'after' ->> 'monthly')::int, 'daily', (s.out -> 'after' ->> 'daily')::int,
                                     'absent', (s.out -> 'after' ->> 'absent')::int),
         'k', 5,
         'multiplier_before', round(1 + 5 * greatest(0, 1 - ((s.out -> 'before' ->> 'staff')::int + (s.out -> 'before' ->> 'monthly')::int
                                      + (s.out -> 'before' ->> 'daily')::int)::numeric / (s.out -> 'before' ->> 'fte')::int), 4),
         'multiplier_after', round(1 + 5 * greatest(0, 1 - ((s.out -> 'after' ->> 'staff')::int + (s.out -> 'after' ->> 'monthly')::int
                                     + (s.out -> 'after' ->> 'daily')::int)::numeric / (s.out -> 'after' ->> 'fte')::int), 4),
         'rebuild', coalesce(s.out -> 'rebuild', '[]'::jsonb)),
       '', 'Supabase SQL editor: dept-staffing-move-2026-11-26.sql'
  from saved s cross join owner o
returning target ->> 'code' as code, target -> 'before' as before, target -> 'after' as after, target -> 'rebuild' as rebuild;

-- Check: PED 19 19 0 0, SOC 10 5 0 16; totals 234 FTE, 220 at work.
select code, fte, staff, monthly, daily, absent, updated_at from public.dept_staffing where code in ('PED', 'SOC') order by code;
