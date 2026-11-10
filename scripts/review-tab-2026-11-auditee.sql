-- ============================================================================
--  review-tab-2026-11-auditee.sql — the ตรวจสอบ tab, part 2: the auditee
--  (ผู้จัดทำ) side as redesigned on 2026-11-09.
--
--  Run after scripts/review-tab-2026-11.sql, in the Supabase SQL editor.
--  Idempotent: safe to re-run, and re-running the first file afterwards does
--  not undo it (the functions below live only in this file).
--
--  What changes:
--    * The auditee types the month's budget and N (จำนวนแพทย์). per P4P is
--      no longer typed: per P4P = budget ÷ N, rounded to 2 decimals, worked
--      out here (review_save_inputs) so every reader gets the same number.
--    * No download or upload: the SK03 and รวมค่าคะแนน files stay in Google
--      Drive (linked from the tab, view only). A round is the newest build
--      as checked; review_rounds no longer needs the uploaded copies.
--    * The auditee can edit one person's score (review_edit_score). It is
--      written to the month's roster table, logged in review_score_edits,
--      and a fresh build is queued (reason 'score').
--    * Sending is refused while a build is on its way, while the newest
--      build no longer matches the roster (a score, a department, or who is
--      on it changed since), and while any score in it is 30,000 or more or
--      under 2,200.
--
--  service_role only, like the first file.
-- ============================================================================

-- ── Tables ──────────────────────────────────────────────────────────────────
alter table public.review_inputs add column if not exists doctors int;
alter table public.review_inputs drop constraint if exists review_inputs_doctors_check;
alter table public.review_inputs add constraint review_inputs_doctors_check
  check (doctors is null or (doctors > 0 and doctors < 100000));

alter table public.review_rounds add column if not exists doctors int;
alter table public.review_rounds alter column sk03_upload drop not null;
alter table public.review_rounds alter column merged_upload drop not null;

-- The รวมค่าคะแนน file's Drive id. sk03_file_id (the Google Sheet) and this
-- are refreshed by every 2.2 run, also when it keeps the build (the SK03
-- gets a new id on every run).
alter table public.review_builds add column if not exists merged_file_id text not null default '';

alter table public.review_requests drop constraint if exists review_requests_reason_check;
alter table public.review_requests add constraint review_requests_reason_check
  check (reason in ('rebuild', 'inputs', 'score'));

create table if not exists public.review_score_edits (
  id           bigint generated always as identity primary key,
  month        text not null check (month ~ '^[0-9]{4}_[0-9]{2}$'),
  roster_index uuid not null,
  name         text not null default '',
  old_score    double precision,
  new_score    double precision not null,
  note         text not null default '' check (char_length(note) <= 500),
  created_at   timestamptz not null default now(),
  created_by   text not null default ''
);
create index if not exists review_score_edits_person on public.review_score_edits (month, roster_index, id desc);
alter table public.review_score_edits enable row level security;
revoke all on table public.review_score_edits from anon, authenticated;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- The auditee's turn: no round sent, or the live round sent back.
create or replace function public.review_auditee_turn(p_month text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not exists (select 1 from public.review_rounds
                      where month = p_month and status in ('submitted', 'approved'));
$$;

-- JS trim(): the build reads departments with it (process.ts). Its
-- whitespace, written with chr() so the file has no backslash escapes: tab,
-- new line, vertical tab, form feed, return, space, NBSP, U+1680,
-- U+2000-200A, U+2028, U+2029, U+202F, U+205F, U+3000, BOM.
create or replace function public.review_js_trim(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(coalesce(p, ''), '^[' || w.c || ']+|[' || w.c || ']+$', '', 'g')
    from (select chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || ' ' || chr(160) || chr(5760)
                 || chr(8192) || '-' || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287)
                 || chr(12288) || chr(65279) as c) w;
$$;

-- How many people the build no longer matches the roster on: someone added
-- or removed since, a department changed, or a score changed (the SK03
-- score K is the roster score; a difference under half a satang is the
-- sheet's arithmetic). 0: the build is up to date.
create or replace function public.review_build_stale(p_month text, p_build uuid)
returns int
language plpgsql
stable
set search_path = ''
as $$
declare n int := 0;
begin
  if p_build is null or p_month !~ '^[0-9]{4}_[0-9]{2}$' or to_regclass(format('public.%I', p_month)) is null then
    return 0;
  end if;
  execute format($q$
    select count(*)::int
      from public.%I r
      full join (select * from public.review_build_people where build_id = $1) p on p.roster_index = r.index
     where r.index is null or p.roster_index is null
        or public.review_js_trim(r.department) is distinct from p.department
        or (p.sk03_score is not null and abs(coalesce(r.score, 0)::numeric - p.sk03_score) >= 0.005)
  $q$, p_month) into n using p_build;
  return n;
end;
$$;

-- ── Build requests ──────────────────────────────────────────────────────────
-- Queue one build of p_month, or return the one already open. A changed
-- budget / N ('inputs') or score ('score') while a build is already running
-- queues one more, since the running build read the old numbers. A request
-- past its deadline is given up first, so a stuck one never blocks a retry.
create or replace function public.review_request_build(p_month text, p_reason text, p_actor text)
returns public.review_requests
language plpgsql
set search_path = ''
as $$
declare
  r public.review_requests;
begin
  if p_month !~ '^[0-9]{4}_[0-9]{2}$' then raise exception 'review: bad month'; end if;
  update public.review_requests q
     set status = 'failed', finished_at = public.review_request_deadline(q), error = 'timed out'
   where q.month = p_month and public.review_request_deadline(q) < now();
  select * into r from public.review_requests
   where month = p_month
     and status in ('queued', 'dispatched', 'running')
     and (p_reason not in ('inputs', 'score') or status = 'queued')
   order by (status = 'queued') desc, id desc limit 1;
  if found then return r; end if;
  insert into public.review_requests (month, reason, requested_by)
  values (p_month, p_reason, coalesce(p_actor, ''))
  returning * into r;
  return r;
end;
$$;

-- ── The auditee's inputs ────────────────────────────────────────────────────
-- Budget and N, on the auditee's turn. per P4P = round(budget ÷ N, 2).
-- Returns the row before (null: none yet) and after.
create or replace function public.review_save_inputs(p_month text, p_budget numeric, p_doctors int, p_actor text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_before public.review_inputs;
  v_after  public.review_inputs;
  v_per    numeric;
begin
  if p_month !~ '^[0-9]{4}_[0-9]{2}$' then raise exception 'review: bad month'; end if;
  if p_budget is null or p_budget <= 0 or p_budget >= 100000000000 or p_budget <> round(p_budget, 2) then
    raise exception 'review: bad budget';
  end if;
  if p_doctors is null or p_doctors <= 0 or p_doctors >= 100000 then raise exception 'review: bad doctors'; end if;
  v_per := round(p_budget / p_doctors, 2);
  if v_per <= 0 or v_per >= 10000000 then raise exception 'review: per P4P out of range'; end if;
  perform pg_advisory_xact_lock(hashtext('review:' || p_month));
  if not public.review_auditee_turn(p_month) then raise exception 'review: not the auditee''s turn'; end if;
  select * into v_before from public.review_inputs where month = p_month;
  insert into public.review_inputs as i (month, budget, per_p4p, doctors, updated_at, updated_by)
  values (p_month, p_budget, v_per, p_doctors, now(), coalesce(p_actor, ''))
  on conflict (month) do update
     set budget = excluded.budget, per_p4p = excluded.per_p4p, doctors = excluded.doctors,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by
  returning * into v_after;
  return jsonb_build_object(
    'before', case when v_before.month is null then null else to_jsonb(v_before) end,
    'after', to_jsonb(v_after));
end;
$$;

-- One person's score, on the auditee's turn: written to the month's roster
-- table (where the SK03 takes it from), logged, and a fresh build queued.
-- The same score again changes nothing.
create or replace function public.review_edit_score(p_month text, p_index uuid, p_score numeric, p_note text, p_actor text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_old  double precision;
  v_name text;
  v_n    int;
  e      public.review_score_edits;
  q      public.review_requests;
begin
  if p_month !~ '^[0-9]{4}_[0-9]{2}$' or to_regclass(format('public.%I', p_month)) is null then
    raise exception 'review: bad month';
  end if;
  if p_score is null or p_score < 0 or p_score >= 1000000 or p_score <> round(p_score, 2) then
    raise exception 'review: bad score';
  end if;
  if char_length(btrim(coalesce(p_note, ''))) > 500 then raise exception 'review: the note is too long'; end if;
  perform pg_advisory_xact_lock(hashtext('review:' || p_month));
  if not public.review_auditee_turn(p_month) then raise exception 'review: not the auditee''s turn'; end if;
  execute format($q$
    select score, btrim(btrim(coalesce(prefix, '') || coalesce(firstname, '')) || ' ' || coalesce(lastname, ''))
      from public.%I where index = $1 for update
  $q$, p_month) into v_old, v_name using p_index;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'review: not on the roster'; end if;
  if v_old is not null and abs(v_old::numeric - p_score) < 0.005 then
    return jsonb_build_object('changed', false);
  end if;
  execute format('update public.%I set score = $1 where index = $2', p_month) using p_score::double precision, p_index;
  insert into public.review_score_edits (month, roster_index, name, old_score, new_score, note, created_by)
  values (p_month, p_index, coalesce(v_name, ''), v_old, p_score::double precision, btrim(coalesce(p_note, '')), coalesce(p_actor, ''))
  returning * into e;
  q := public.review_request_build(p_month, 'score', p_actor);
  return jsonb_build_object('changed', true, 'edit', to_jsonb(e), 'request', to_jsonb(q));
end;
$$;

-- ── Rounds ──────────────────────────────────────────────────────────────────
-- The first file's version took the two uploaded files; this one sends the
-- newest build as it is.
drop function if exists public.review_submit_round(text, uuid, uuid, text);

-- The auditee sends round N: the newest build, which must carry the typed
-- budget and per P4P, have no blocking problem, still match the roster, have
-- no score of 30,000 or more or under 2,200, and no build may be on its
-- way. From round 2 on, a person the auditor approved keeps that result
-- unless their own score, department or name changed, their pay check is not
-- a match or their score check is a mismatch (a score check of missing, no
-- saved total in the doctor's file, keeps it); everyone else is checked again
-- (recheck_why says why).
create or replace function public.review_submit_round(p_month text, p_actor text)
returns public.review_rounds
language plpgsql
set search_path = ''
as $$
declare
  v_inputs public.review_inputs;
  v_build  public.review_builds;
  v_prev   public.review_rounds;
  v_round  public.review_rounds;
  v_no     int;
begin
  if p_month !~ '^[0-9]{4}_[0-9]{2}$' then raise exception 'review: bad month'; end if;
  perform pg_advisory_xact_lock(hashtext('review:' || p_month));
  select * into v_prev from public.review_rounds
   where month = p_month and status in ('submitted', 'returned', 'approved') for update;
  if found and v_prev.status <> 'returned' then raise exception 'review: not the auditee''s turn'; end if;
  select * into v_inputs from public.review_inputs where month = p_month;
  if not found or v_inputs.doctors is null then raise exception 'review: no budget yet'; end if;
  select * into v_build from public.review_builds where month = p_month order by built_at desc limit 1;
  if not found then raise exception 'review: no build yet'; end if;
  if exists (select 1 from public.review_requests q
              where q.month = p_month and q.status in ('queued', 'dispatched', 'running')
                and public.review_request_deadline(q) >= now()) then
    raise exception 'review: a build is on its way';
  end if;
  if exists (select 1 from jsonb_array_elements(v_build.problems) e where (e->>'blocking')::boolean) then
    raise exception 'review: the build has a blocking problem';
  end if;
  if v_build.budget is distinct from v_inputs.budget or v_build.per_p4p is distinct from v_inputs.per_p4p then
    raise exception 'review: the build does not carry the typed numbers';
  end if;
  if public.review_build_stale(p_month, v_build.id) > 0 then raise exception 'review: the build is out of date'; end if;
  if exists (select 1 from public.review_build_people
              where build_id = v_build.id and (sk03_score >= 30000 or sk03_score < 2200)) then
    raise exception 'review: a score is out of range';
  end if;

  select coalesce(max(round_no), 0) + 1 into v_no from public.review_rounds where month = p_month;
  if v_prev.id is not null then
    update public.review_rounds set status = 'superseded' where id = v_prev.id;
  end if;
  insert into public.review_rounds (month, round_no, build_id, budget, per_p4p, doctors, submitted_by)
  values (p_month, v_no, v_build.id, v_inputs.budget, v_inputs.per_p4p, v_inputs.doctors, coalesce(p_actor, ''))
  returning * into v_round;

  insert into public.review_decisions (round_id, roster_index, decision, carried, recheck_why, decided_at, decided_by)
  select v_round.id, x.roster_index,
         case when x.why = 'keep' then 'approve' end,
         x.why = 'keep',
         case when x.why = 'keep' then '' else x.why end,
         case when x.why = 'keep' then x.decided_at end,
         case when x.why = 'keep' then x.decided_by else '' end
    from (
      select p.roster_index, d.decided_at, d.decided_by,
             case
               when v_prev.id is null then ''
               when d.roster_index is null then 'new'
               when d.decision is distinct from 'approve' then 'fix'
               when q.roster_index is null then 'new'
               when q.sk03_score is distinct from p.sk03_score then 'score'
               when q.department is distinct from p.department then 'department'
               when q.name is distinct from p.name then 'name'
               -- A score check of missing (no saved total in the doctor's file)
               -- was approved after a look (2026-11-10) and keeps it.
               when p.score_check = 'mismatch' or p.money_check <> 'match' then 'check'
               else 'keep'
             end as why
        from public.review_build_people p
        left join public.review_decisions d on d.round_id = v_prev.id and d.roster_index = p.roster_index
        left join public.review_build_people q on q.build_id = v_prev.build_id and q.roster_index = p.roster_index
       where p.build_id = v_build.id
    ) x;

  -- The auditee's answers to other issues go with this round.
  update public.review_issue_replies r set round_no = v_no
    from public.review_issues i
   where r.issue_id = i.id and i.month = p_month and r.role = 'auditee' and r.round_no is null;
  return v_round;
end;
$$;

-- ── The tab's view of one month ─────────────────────────────────────────────
-- v: 2 tells the app this file has been run.
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
        'reopen_reason', r.reopen_reason,
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

-- Months for the month tabs: each roster table's counts and review state.
create or replace function public.review_months(p_months text[])
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  m text;
  v_total int;
  v_sent int;
  out jsonb := '[]'::jsonb;
begin
  foreach m in array p_months loop
    continue when m !~ '^[0-9]{4}_[0-9]{2}$';
    continue when to_regclass(format('public.%I', m)) is null;
    execute format('select count(*), count(submitted_at) from public.%I', m) into v_total, v_sent;
    out := out || jsonb_build_object(
      'month', m, 'total', v_total, 'sent', v_sent,
      'builtAt', (select max(built_at) from public.review_builds where month = m),
      'round', (select jsonb_build_object('round_no', r.round_no, 'status', r.status, 'pdf_status', r.pdf_status,
                         'fix', (select count(*) from public.review_decisions d where d.round_id = r.id and d.decision = 'fix'))
                  from public.review_rounds r where r.month = m and r.status in ('submitted', 'returned', 'approved')),
      'hasInputs', exists (select 1 from public.review_inputs where month = m and doctors is not null));
  end loop;
  return out;
end;
$$;

-- The newest build's people for the auditee's list: both checks, the
-- score now on the roster (differs from score while a rebuild is due) and
-- the person's latest score edit.
create or replace function public.review_auditee_people(p_month text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_build  uuid;
  v_roster jsonb := '{}'::jsonb;
begin
  if p_month !~ '^[0-9]{4}_[0-9]{2}$' then raise exception 'review: bad month'; end if;
  select id into v_build from public.review_builds where month = p_month order by built_at desc limit 1;
  if v_build is null then return jsonb_build_object('build_id', null, 'people', '[]'::jsonb); end if;
  if to_regclass(format('public.%I', p_month)) is not null then
    execute format($q$select coalesce(jsonb_object_agg(index::text, score), '{}'::jsonb) from public.%I$q$, p_month) into v_roster;
  end if;
  return jsonb_build_object('build_id', v_build, 'people', coalesce((select jsonb_agg(jsonb_build_object(
      'index', p.roster_index, 'name', p.name, 'department', p.department, 'intern', p.is_intern,
      'sk03Row', p.sk03_row, 'score', p.sk03_score, 'stated', p.stated_total, 'statedCell', p.stated_cell,
      'statedHow', p.stated_how, 'sheet', p.merged_sheet, 'pay', p.sk03_pay, 'deptPay', p.dept_pay,
      'scoreCheck', p.score_check, 'moneyCheck', p.money_check,
      'onRoster', v_roster ? (p.roster_index::text),
      'roster', v_roster -> (p.roster_index::text),
      'edit', (select jsonb_build_object('old', e.old_score, 'new', e.new_score, 'note', e.note,
                                         'at', e.created_at, 'by', e.created_by)
                 from public.review_score_edits e
                where e.month = p_month and e.roster_index = p.roster_index
                order by e.id desc limit 1)
    ) order by p.is_intern, p.department, p.name)
    from public.review_build_people p where p.build_id = v_build), '[]'::jsonb));
end;
$$;

-- Everyone in a round, with both checks, the decision, the previous round's
-- decision, remark and reply, and the auditee's latest score edit made
-- before the round was sent. p_round null: the live round.
create or replace function public.review_people(p_month text, p_round int)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  r public.review_rounds;
  v_prev bigint;
begin
  select * into r from public.review_rounds
   where month = p_month and (round_no = p_round or (p_round is null and status in ('submitted', 'returned', 'approved')))
   order by round_no desc limit 1;
  if not found then return jsonb_build_object('round', null, 'people', '[]'::jsonb); end if;
  select id into v_prev from public.review_rounds where month = p_month and round_no = r.round_no - 1;
  return jsonb_build_object(
    'round', jsonb_build_object('id', r.id, 'round_no', r.round_no, 'status', r.status, 'build_id', r.build_id),
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'index', p.roster_index, 'name', p.name, 'department', p.department, 'intern', p.is_intern,
        'sk03Row', p.sk03_row, 'score', p.sk03_score, 'stated', p.stated_total, 'statedCell', p.stated_cell,
        'statedHow', p.stated_how, 'sheet', p.merged_sheet, 'pay', p.sk03_pay, 'deptRow', p.dept_row,
        'deptPay', p.dept_pay, 'admin', p.dept_admin, 'scoreCheck', p.score_check, 'moneyCheck', p.money_check,
        'decision', d.decision, 'remark', d.remark, 'carried', d.carried, 'why', d.recheck_why,
        'decidedAt', d.decided_at, 'reply', d.reply,
        'prev', case when pd.roster_index is null then null else
          jsonb_build_object('decision', pd.decision, 'remark', pd.remark, 'reply', pd.reply) end,
        'edit', (select jsonb_build_object('old', e.old_score, 'new', e.new_score, 'note', e.note,
                                           'at', e.created_at, 'by', e.created_by)
                   from public.review_score_edits e
                  where e.month = p_month and e.roster_index = p.roster_index and e.created_at <= r.submitted_at
                  order by e.id desc limit 1)
      ) order by p.is_intern, p.department, p.name)
      from public.review_build_people p
      left join public.review_decisions d on d.round_id = r.id and d.roster_index = p.roster_index
      left join public.review_decisions pd on pd.round_id = v_prev and pd.roster_index = p.roster_index
     where p.build_id = r.build_id), '[]'::jsonb));
end;
$$;

-- Every review function: service role only.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (starts_with(p.proname, 'review_') or p.proname in ('claim_review_request', 'claim_review_pdf')) loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
