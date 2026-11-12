-- ============================================================================
--  review-approve-all-2026-11.sql — อนุมัติทุกคนที่รอตรวจ, one press.
--
--  Pong, 2026-11-12: on the auditor's side, an approve-all button, usable
--  only when nobody still to check has a ไม่ตรงกัน or ไม่พบ result. It
--  approves everyone in the live round still รอตรวจ, in one go, and only
--  when every one of them has both checks (เทียบคะแนน and เทียบเงิน)
--  ตรงกัน. Anyone already decided (อนุมัติ or ต้องแก้ไข) keeps their result.
--
--  Run after scripts/review-tab-2026-11.sql and
--  scripts/review-tab-2026-11-auditee.sql, in the Supabase SQL editor.
--  Safe to re-run. No backslashes, so it pastes through chat.
-- ============================================================================

create or replace function public.review_approve_all(p_month text, p_round int, p_actor text)
returns int
language plpgsql
set search_path = ''
as $$
declare
  r public.review_rounds;
  v_n int;
begin
  -- The round on the auditor's turn, locked like every other decision.
  r := public.review_live_round(p_month, 'submitted');
  -- The round the auditor was looking at, not one sent since.
  if r.round_no is distinct from p_round then raise exception 'review: another round'; end if;
  -- Someone still to check whose checks are not both ตรงกัน (or who has no
  -- checks at all): they are checked one by one first.
  if exists (select 1 from public.review_decisions d
               left join public.review_build_people p on p.build_id = r.build_id and p.roster_index = d.roster_index
              where d.round_id = r.id and d.decision is null
                and (p.roster_index is null or p.score_check <> 'match' or p.money_check <> 'match')) then
    raise exception 'review: a check is not a match';
  end if;
  update public.review_rounds set auditor_opened_at = coalesce(auditor_opened_at, now()) where id = r.id;
  update public.review_decisions
     set decision = 'approve', remark = '', carried = false,
         decided_at = now(), decided_by = coalesce(p_actor, '')
   where round_id = r.id and decision is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'review: nobody to approve'; end if;
  return v_n;
end;
$$;

-- service_role only, like the rest of the review functions.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('review_approve_all') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
