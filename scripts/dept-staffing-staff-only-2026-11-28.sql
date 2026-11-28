-- อัตรากำลัง: ขาดแคลน counts ข้าราชการ only (Pong, 2026-11-28: "The calculation
-- now does not include อัตราจ้าง"; SUPABASE_MIGRATIONS step 35).
--
-- Run it AFTER the app update of 2026-11-28 is merged. The rule lives in the
-- code (lib/dept-staffing.ts deptLack), which every SK03 build reads from
-- main, so a build queued before the merge would still count the hires.
--
-- No table changes: dept_staffing keeps its numbers (monthly and daily hires
-- stay, for the record). This queues a new SK03 build of every ตรวจสอบ month
-- from 2569_08 still on the auditee's side, the same as a save on the
-- อัตรากำลัง tab does (a month already sent to the auditor or approved keeps
-- the build it was sent with), and writes one staffing.rule row to
-- ประวัติการใช้งาน. A second run queues nothing new while those builds still
-- wait, and adds one more row. No backslashes.
do $$
declare
  v_month  text;
  v_months text[] := '{}';
  v_owner  text;
begin
  if to_regprocedure('public.review_request_build(text, text, text)') is null
     or to_regclass('public.review_rounds') is null then
    raise exception 'staffing: the ตรวจสอบ tables are not installed (steps 22 and 30)';
  end if;
  for v_month in
    select distinct b.month from public.review_builds b where b.month >= '2569_08' order by 1
  loop
    -- The month's ตรวจสอบ lock, as staffing_save takes it.
    perform pg_advisory_xact_lock(hashtext('review:' || v_month));
    if not exists (select 1 from public.review_rounds r
                    where r.month = v_month and r.status in ('submitted', 'approved')) then
      perform public.review_request_build(v_month, 'inputs', 'ปองสิทธิ์');
      v_months := v_months || v_month;
    end if;
  end loop;
  -- The owner's LINE id, as on the owner's own rows.
  select coalesce((select a.actor_line_id from public.dashboard_audit_log a
                    where a.action in ('review.reset', 'staffing.save') and a.actor_line_id <> ''
                    order by a.id desc limit 1), '') into v_owner;
  insert into public.dashboard_audit_log (actor_line_id, actor_name, action, target, ip, user_agent)
  values (v_owner, 'ปองสิทธิ์', 'staffing.rule',
          jsonb_build_object('rule', 'staff_only', 'k', 5, 'rebuild', to_jsonb(v_months)),
          '', 'Supabase SQL editor: dept-staffing-staff-only-2026-11-28.sql');
  raise notice 'queued: %', v_months;
end;
$$;

-- Check: one queued (or already running) build each for 2569_08 and 2569_09,
-- and the history row.
select id, month, reason, status, requested_by, requested_at
  from public.review_requests
 where month >= '2569_08' and requested_at > now() - interval '1 hour'
 order by id desc;
select id, created_at, action, target from public.dashboard_audit_log
 where action = 'staffing.rule' order by id desc limit 1;
