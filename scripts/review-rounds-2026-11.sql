-- ============================================================================
--  review-rounds-2026-11.sql — every round keeps its files; ยกเลิกอนุมัติ
--  starts a new round; ส่งกลับ can carry a note (step 30).
--
--  Pong, 2026-11-20: "On audit tab : when auditee and auditor submit back
--  and forth, the generated excel and pdf is missing or lost. When resubmit
--  occurs, UI is very hard to use. Try redesign frontend backend."
--
--  What was wrong:
--    * ยกเลิกเอกสารและเปิดตรวจอีกครั้ง turned the approved round back into
--      the auditor's turn and deleted its PDF, so the PDF and the allocation
--      Excel of that approval were gone for good;
--    * it also opened a ปัญหาอื่น that only the auditor could close, and
--      while it was open a round could only be sent back, never approved.
--
--  What this file changes:
--    1. review_rounds gets status 'cancelled' (an approval that was undone:
--       its PDF stays), return_note (the auditor's note to the ผู้จัดทำ when
--       sending back) and reopen_of (a round started by ยกเลิกอนุมัติ: the
--       round it replaces);
--    2. review_reopen_round(month, reason, actor, return): the approved
--       round becomes 'cancelled' with its PDF and reason kept, and a new
--       round starts with the same build and every approval carried over.
--       return = false: the new round is the auditor's to check again;
--       return = true: it goes straight back to the ผู้จัดทำ with the
--       reason as its note. No ปัญหาอื่น is opened;
--    3. review_return_round(month, actor, note): sends back with a note;
--       a note alone (everyone approved) is enough to send back, and
--       review_unreturn_round (ดึงกลับ) takes the note back too;
--    4. review_approve_round: no longer held by an open ปัญหาอื่น;
--    5. review_email_on_round: a round started by ยกเลิกอนุมัติ is not
--       emailed (the next round the ผู้จัดทำ sends is);
--    6. review_state: each round also carries return_note, reopen_of and
--       has_pdf;
--    7. the ปัญหาอื่น left open by an earlier reopen are closed (the tab no
--       longer shows them).
--  Nothing is deleted. Every function stays service_role only.
--
--  Run after scripts/review-tab-2026-11.sql, scripts/review-tab-2026-11-auditee.sql,
--  scripts/review-email-2026-11.sql and scripts/review-approve-all-2026-11.sql,
--  in the Supabase SQL editor. Safe to re-run. No backslashes, so it pastes
--  through chat. End with the check query at the bottom.
-- ============================================================================

-- 1. The columns, and 'cancelled' as a round status.
alter table public.review_rounds
  add column if not exists return_note text not null default '',
  add column if not exists reopen_of   int;

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.review_rounds'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%superseded%'
  loop
    execute format('alter table public.review_rounds drop constraint %I', c.conname);
  end loop;
end
$$;
alter table public.review_rounds add constraint review_rounds_status_check
  check (status in ('submitted', 'returned', 'superseded', 'approved', 'cancelled'));

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_rounds'::regclass
                  and conname = 'review_rounds_return_note_len') then
    alter table public.review_rounds add constraint review_rounds_return_note_len
      check (char_length(return_note) <= 1000);
  end if;
end
$$;

-- 2. ยกเลิกอนุมัติ: the approved round is kept as cancelled (its PDF stays,
--    unless it was not made yet), and the next round starts from it.
drop function if exists public.review_reopen_round(text, text, text);
create or replace function public.review_reopen_round(p_month text, p_reason text, p_actor text, p_return boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.review_rounds;
  n public.review_rounds;
  v_no int;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if char_length(v_reason) = 0 then raise exception 'review: a reopen needs a reason'; end if;
  if char_length(v_reason) > 1000 then raise exception 'review: the reason is too long'; end if;
  perform pg_advisory_xact_lock(hashtext('review:' || p_month));
  select * into r from public.review_rounds where month = p_month and status = 'approved' for update;
  if not found then raise exception 'review: not approved'; end if;
  update public.review_rounds
     set status = 'cancelled',
         reopened_at = now(), reopened_by = coalesce(p_actor, ''), reopen_reason = v_reason,
         -- A PDF still being made is not made any more; a made one stays.
         pdf_status = case when pdf_status = 'ready' then 'ready' else 'none' end,
         pdf_claimed_at = null
   where id = r.id;
  select coalesce(max(round_no), 0) + 1 into v_no from public.review_rounds where month = p_month;
  insert into public.review_rounds
    (month, round_no, build_id, budget, per_p4p, doctors, status, submitted_at, submitted_by,
     auditor_opened_at, returned_at, returned_by, return_note, reopen_of)
  values
    (p_month, v_no, r.build_id, r.budget, r.per_p4p, r.doctors,
     case when p_return then 'returned' else 'submitted' end, now(), coalesce(p_actor, ''),
     -- Opened already: the ผู้จัดทำ cannot take back a round they did not send.
     now(),
     case when p_return then now() end, case when p_return then coalesce(p_actor, '') else '' end,
     case when p_return then v_reason else '' end, r.round_no)
  returning * into n;
  -- Everyone keeps the approval they had (คงผลรอบก่อน).
  insert into public.review_decisions (round_id, roster_index, decision, carried, recheck_why, decided_at, decided_by)
  select n.id, d.roster_index, d.decision, true, '', d.decided_at, d.decided_by
    from public.review_decisions d where d.round_id = r.id;
  return jsonb_build_object('round_no', n.round_no, 'status', n.status, 'cancelled', r.round_no);
end;
$$;

-- 3. ส่งกลับ, with an optional note; the note alone is reason enough.
drop function if exists public.review_return_round(text, text);
create or replace function public.review_return_round(p_month text, p_actor text, p_note text default '')
returns public.review_rounds
language plpgsql
set search_path = ''
as $$
declare
  r public.review_rounds;
  v_note text := btrim(coalesce(p_note, ''));
begin
  if char_length(v_note) > 1000 then raise exception 'review: the message is too long'; end if;
  r := public.review_live_round(p_month, 'submitted');
  if exists (select 1 from public.review_decisions where round_id = r.id and decision is null) then
    raise exception 'review: someone is still to check';
  end if;
  if v_note = '' and not exists (select 1 from public.review_decisions where round_id = r.id and decision = 'fix') then
    raise exception 'review: nothing to fix';
  end if;
  update public.review_rounds
     set status = 'returned', returned_at = now(), returned_by = coalesce(p_actor, ''),
         auditee_opened_at = null, return_note = v_note
   where id = r.id returning * into r;
  return r;
end;
$$;

-- 3b. ดึงกลับ (taking back a send-back) also takes back its note.
create or replace function public.review_unreturn_round(p_month text, p_actor text)
returns public.review_rounds
language plpgsql
set search_path = ''
as $$
declare r public.review_rounds;
begin
  r := public.review_live_round(p_month, 'returned');
  if r.auditee_opened_at is not null then raise exception 'review: the auditee has started'; end if;
  if exists (select 1 from public.review_issue_replies x join public.review_issues i on i.id = x.issue_id
              where i.month = p_month and x.role = 'auditee' and x.round_no is null)
     or exists (select 1 from public.review_decisions where round_id = r.id and reply <> '') then
    raise exception 'review: the auditee has started';
  end if;
  update public.review_rounds set status = 'submitted', returned_at = null, returned_by = '', return_note = ''
   where id = r.id returning * into r;
  return r;
end;
$$;

-- 4. อนุมัติทั้งหมด: everyone approved is enough.
create or replace function public.review_approve_round(p_month text, p_actor text)
returns public.review_rounds
language plpgsql
set search_path = ''
as $$
declare r public.review_rounds;
begin
  r := public.review_live_round(p_month, 'submitted');
  if exists (select 1 from public.review_decisions where round_id = r.id and decision is distinct from 'approve') then
    raise exception 'review: not everyone is approved';
  end if;
  update public.review_rounds
     set status = 'approved', approved_at = now(), approved_by = coalesce(p_actor, ''),
         auditor_opened_at = coalesce(auditor_opened_at, now()),
         pdf_status = 'queued', pdf_path = null, pdf_bytes = null, pdf_pages = null, pdf_error = ''
   where id = r.id returning * into r;
  return r;
end;
$$;

-- 5. Only a round the ผู้จัดทำ sent is emailed to the auditor.
create or replace function public.review_email_on_round()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.reopen_of is not null then return null; end if;
  insert into public.review_emails (month, round_id, round_no, build_id, created_by)
  values (new.month, new.id, new.round_no, new.build_id, coalesce(new.submitted_by, ''));
  return null;
end;
$$;

-- 6. The month's state: as before, and each round's return_note,
--    reopen_of and has_pdf.
create or replace function public.review_state(p_month text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_total int := 0;
  v_sent  int := 0;
  v_live  public.review_rounds;
  v_build public.review_builds;
  v_last  timestamptz;
begin
  if p_month !~ '^[0-9]{4}_[0-9]{2}$' then raise exception 'review: bad month'; end if;
  if to_regclass(format('public.%I', p_month)) is not null then
    execute format('select count(*), count(submitted_at) from public.%I', p_month) into v_total, v_sent;
  end if;
  select * into v_live from public.review_rounds
   where month = p_month and status in ('submitted', 'returned', 'approved');
  select * into v_build from public.review_builds where month = p_month order by built_at desc limit 1;
  select max(submitted_at) into v_last from public.review_rounds where month = p_month;
  return jsonb_build_object(
    'v', 2,
    'month', p_month,
    'roster', jsonb_build_object('total', v_total, 'sent', v_sent, 'exists', to_regclass(format('public.%I', p_month)) is not null),
    'inputs', (select to_jsonb(i) from public.review_inputs i where i.month = p_month),
    'build', case when v_build.id is null then null else to_jsonb(v_build) - 'depts' end,
    'buildChecks', (select jsonb_build_object(
        'scoreMismatch', count(*) filter (where score_check = 'mismatch'),
        'scoreMissing',  count(*) filter (where score_check = 'missing'),
        'moneyMismatch', count(*) filter (where money_check = 'mismatch'),
        'moneyMissing',  count(*) filter (where money_check = 'missing'),
        'high',          count(*) filter (where sk03_score >= 30000),
        'low',           count(*) filter (where sk03_score < 2200))
      from public.review_build_people where build_id = v_build.id),
    'stale', public.review_build_stale(p_month, v_build.id),
    'builds', (select count(*) from public.review_builds where month = p_month),
    -- A request past its deadline reads as failed, so the tab never waits on a dead run.
    'request', (select case when public.review_request_deadline(q) < now()
                  then to_jsonb(q) || jsonb_build_object('status', 'failed', 'error', 'timed out',
                                                         'finished_at', public.review_request_deadline(q))
                  else to_jsonb(q) end
                  from public.review_requests q where q.month = p_month order by q.id desc limit 1),
    -- People whose score was edited since the last round was sent (all edits before the first).
    'edits', (select count(distinct roster_index) from public.review_score_edits
               where month = p_month and (v_last is null or created_at > v_last)),
    'rounds', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'round_no', r.round_no, 'status', r.status, 'build_id', r.build_id,
        'budget', r.budget, 'per_p4p', r.per_p4p, 'doctors', r.doctors,
        'submitted_at', r.submitted_at, 'submitted_by', r.submitted_by,
        'auditor_opened_at', r.auditor_opened_at, 'returned_at', r.returned_at,
        'auditee_opened_at', r.auditee_opened_at, 'approved_at', r.approved_at,
        'pdf_status', r.pdf_status, 'pdf_bytes', r.pdf_bytes, 'pdf_pages', r.pdf_pages,
        'pdf_error', r.pdf_error, 'pdf_built_at', r.pdf_built_at, 'approved_by', r.approved_by,
        'returned_by', r.returned_by, 'reopened_at', r.reopened_at, 'reopened_by', r.reopened_by,
        'reopen_reason', r.reopen_reason, 'return_note', r.return_note, 'reopen_of', r.reopen_of,
        'has_pdf', r.pdf_path is not null and r.pdf_status = 'ready',
        -- People whose score the auditee edited for this round.
        'edits', (select count(distinct e.roster_index) from public.review_score_edits e
                   where e.month = p_month and e.created_at <= r.submitted_at
                     and e.created_at > coalesce((select max(r0.submitted_at) from public.review_rounds r0
                                                   where r0.month = p_month and r0.round_no < r.round_no), '-infinity')),
        'counts', (select jsonb_build_object(
            'approve', count(*) filter (where d.decision = 'approve'),
            'fix', count(*) filter (where d.decision = 'fix'),
            'waiting', count(*) filter (where d.decision is null),
            'carried', count(*) filter (where d.carried))
          from public.review_decisions d where d.round_id = r.id)
      ) order by r.round_no), '[]'::jsonb) from public.review_rounds r where r.month = p_month),
    'live', case when v_live.id is null then null else v_live.round_no end,
    'issues', (select jsonb_build_object(
        'open', count(*) filter (where status = 'open'),
        'closed', count(*) filter (where status = 'closed'))
      from public.review_issues where month = p_month)
  );
end;
$$;

-- 7. The ปัญหาอื่น an earlier reopen left open: closed, so nothing waits on them.
update public.review_issues
   set status = 'closed', closed_at = now(), closed_by = 'review-rounds-2026-11.sql'
 where status = 'open';

-- service_role only, like the rest of the review functions.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('review_reopen_round', 'review_return_round', 'review_unreturn_round',
                                'review_approve_round', 'review_email_on_round', 'review_state') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Check: columns_2 = 2, cancelled_ok = true, reopen_4 = 4, return_3 = 3, anon_0 = 0, open_issues_0 = 0.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'review_rounds' and column_name in ('return_note', 'reopen_of')) as columns_2,
  (select count(*) from pg_constraint where conrelid = 'public.review_rounds'::regclass
    and pg_get_constraintdef(oid) like '%cancelled%') = 1 as cancelled_ok,
  (select pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'review_reopen_round') as reopen_4,
  (select pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'review_return_round') as return_3,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'review%' and has_function_privilege('anon', p.oid, 'execute')) as anon_0,
  (select count(*) from public.review_issues where status = 'open') as open_issues_0;
