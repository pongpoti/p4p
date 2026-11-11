-- ============================================================================
--  budget-inputs-2026-11.sql — every month's budget and N in Supabase.
--
--  Pong, 2026-11-11: the budget and N for each month live in one place, the
--  table review_inputs, which the dashboard saves (budget and จำนวนแพทย์;
--  per P4P = round(budget ÷ N, 2)). Workflow 2.2 reads it for
--  staff Y9 (budget) and intern W9 (=W10*per P4P). This file copies in the
--  17 months that were in the Monthly Budget Inputs table of
--  process/FORMULA.md (removed from there in the same change).
--
--  Sources (as written in FORMULA.md): 2568_05 to 2569_06 from each month's
--  final SK03; 2569_07 from the final July SK03 (staff Y9 2,158,709.06,
--  intern W9 =31*9551.81); 2569_08 and 2569_09 from the allocation document
--  "จัดสรร กค.-สค. 69" (row 2.1 แพทย์).
--
--  2569_08 and 2569_09 are stored in whole baht (2,189,874 and 2,210,764),
--  as the budget box takes whole baht only; per P4P is the same to the
--  satang as with the document's .33 / .71 (9,562.77 and 9,570.41). Earlier
--  months keep their satang until saved again from the budget box.
--
--  Overwrites any row already there: 2569_07 had 2,158,599 (the amount paid
--  out, Y19) and 2569_08 had the test numbers 2,000,000 / 200. A round
--  already sent keeps its own copy of the numbers it was sent with.
--
--  PART 2 adds what the overview page's budget box needs (Pong, 2026-11-11:
--  budget and N are typed on the month cards of ภาพรวม, not in ตรวจสอบ; a
--  save starts workflow 2.2 for the month at once, whatever the ตรวจสอบ
--  round's state, and Pong gets a Telegram once the SK03 is built with them).
--
--  Run after scripts/review-tab-2026-11.sql and
--  scripts/review-tab-2026-11-auditee.sql, in the Supabase SQL editor.
--  Each PART is its own statement group and can be pasted on its own.
--  Safe to re-run. No backslashes, so it pastes through chat.
-- ============================================================================

-- ── PART 1: the 17 months ───────────────────────────────────────────────────

insert into public.review_inputs as i (month, budget, per_p4p, doctors, updated_at, updated_by)
values
  ('2568_05', 2113551.36,  9784.96, 216, now(), 'FORMULA.md'),
  ('2568_06', 2102336.65,  9778.31, 215, now(), 'FORMULA.md'),
  ('2568_07', 2123888.28,  9698.12, 219, now(), 'FORMULA.md'),
  ('2568_08', 2156973.75,  9586.55, 225, now(), 'FORMULA.md'),
  ('2568_09', 2151499.84,  9604.91, 224, now(), 'FORMULA.md'),
  ('2568_10', 2213270.80, 10014.80, 221, now(), 'FORMULA.md'),
  ('2568_11', 2204138.20, 10018.81, 220, now(), 'FORMULA.md'),
  ('2568_12', 2206831.00, 10031.05, 220, now(), 'FORMULA.md'),
  ('2569_01', 2219107.41, 10041.21, 221, now(), 'FORMULA.md'),
  ('2569_02', 2211228.80, 10051.04, 220, now(), 'FORMULA.md'),
  ('2569_03', 2191518.72, 10145.92, 216, now(), 'FORMULA.md'),
  ('2569_04', 2144594.88,  9928.68, 216, now(), 'FORMULA.md'),
  ('2569_05', 2139791.04,  9906.44, 216, now(), 'FORMULA.md'),
  ('2569_06', 2159731.84,  9641.66, 224, now(), 'FORMULA.md'),
  ('2569_07', 2158709.06,  9551.81, 226, now(), 'FORMULA.md'),
  ('2569_08', 2189874.00,  9562.77, 229, now(), 'FORMULA.md'),
  ('2569_09', 2210764.00,  9570.41, 231, now(), 'FORMULA.md')
on conflict (month) do update
   set budget = excluded.budget, per_p4p = excluded.per_p4p, doctors = excluded.doctors,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by;

-- Check: 17 rows, each per P4P = round(budget ÷ N, 2) (expect 0 mismatches).
select count(*) as months,
       count(*) filter (where per_p4p <> round(budget / doctors, 2)) as mismatches
  from public.review_inputs
 where month between '2568_05' and '2569_09';


-- ── PART 2: the overview page's budget box ──────────────────────────────────
-- tg_pending: a save not yet reported. Workflow 2.2 sends Pong a Telegram
-- once it has built the month's SK03 with these numbers, then clears it.
alter table public.review_inputs add column if not exists tg_pending boolean not null default false;

-- Budget and N for one month, from the overview page. per P4P = round(budget
-- ÷ N, 2), as review_save_inputs works it out. No ตรวจสอบ round check: this
-- is its own function (a round already sent keeps the build it was sent
-- with). When everyone on the month's roster has sent, a one-month build is
-- queued (workflow 2.2 through the always-on relay); otherwise the numbers
-- wait for the build that follows the last file. Returns the row before
-- (null: none yet) and after, whether the roster is complete, and the
-- request (null when none was queued).
create or replace function public.budget_save(p_month text, p_budget numeric, p_doctors int, p_actor text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_before public.review_inputs;
  v_after  public.review_inputs;
  v_per    numeric;
  v_total  int := 0;
  v_sent   int := 0;
  v_req    public.review_requests;
begin
  if p_month !~ '^[0-9]{4}_(0[1-9]|1[0-2])$' then raise exception 'budget: bad month'; end if;
  if p_budget is null or p_budget <= 0 or p_budget >= 100000000000 or p_budget <> round(p_budget, 2) then
    raise exception 'budget: bad budget';
  end if;
  if p_doctors is null or p_doctors <= 0 or p_doctors >= 100000 then raise exception 'budget: bad doctors'; end if;
  v_per := round(p_budget / p_doctors, 2);
  if v_per <= 0 or v_per >= 10000000 then raise exception 'budget: per P4P out of range'; end if;
  perform pg_advisory_xact_lock(hashtext('review:' || p_month));
  select * into v_before from public.review_inputs where month = p_month;
  insert into public.review_inputs as i (month, budget, per_p4p, doctors, updated_at, updated_by, tg_pending)
  values (p_month, p_budget, v_per, p_doctors, now(), coalesce(p_actor, ''), true)
  on conflict (month) do update
     set budget = excluded.budget, per_p4p = excluded.per_p4p, doctors = excluded.doctors,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by, tg_pending = true
  returning * into v_after;
  if to_regclass(format('public.%I', p_month)) is not null then
    execute format('select count(*)::int, count(submitted_at)::int from public.%I', p_month) into v_total, v_sent;
  end if;
  if v_total > 0 and v_sent = v_total then
    v_req := public.review_request_build(p_month, 'inputs', p_actor);
  end if;
  return jsonb_build_object(
    'before', case when v_before.month is null then null else to_jsonb(v_before) end,
    'after', to_jsonb(v_after),
    'complete', v_total > 0 and v_sent = v_total,
    'request', case when v_req.id is null then null else to_jsonb(v_req) end);
end;
$$;

revoke all on function public.budget_save(text, numeric, int, text) from public, anon, authenticated;
grant execute on function public.budget_save(text, numeric, int, text) to service_role;

