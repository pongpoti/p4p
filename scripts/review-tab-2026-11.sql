-- ============================================================================
--  review-tab-2026-11.sql — the /dashboard/ ตรวจสอบ (review) tab.
--
--  One month's pay is checked in rounds. The auditee (ผู้จัดทำ) types the
--  month's budget and per P4P once, the system builds the SK03 and the merged
--  per-doctor file (workflow 2.2, process/process.ts), the auditee downloads
--  both and sends them back, and the auditor (ผู้ตรวจสอบ) checks every person.
--
--    review_inputs        budget and per P4P per month, typed in the tab
--    review_requests      "build this month now" requests; the always-on relay
--                         (workflow 1) starts workflow 2.2 for each one
--    review_builds        each SK03 + merged file 2.2 built, with the copies in
--                         Storage, their SHA-256 and the build-level problems
--    review_build_people  per person in a build: the two automatic checks
--                         (score vs the doctor's stated total, staff/intern pay
--                         vs the department sheet) and a snapshot of the
--                         doctor's own sheet for the viewer
--    review_uploads       files the auditee picked, checked against the builds
--    review_rounds        one per submission by the auditee
--    review_decisions     one per person per round (null = still to check)
--    review_issues        "ปัญหาอื่น ๆ", with review_issue_replies
--
--  Storage: private bucket review-files (builds/, uploads/, pdf/).
--
--  service_role only, like dashboard_followups: RLS on with no policies,
--  and every function revoked from public/anon/authenticated. main.ts calls
--  these with the service key behind the dashboard session (owner only);
--  process/ and automation/ use the same key in GitHub Actions.
--
--  Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.review_inputs (
  month       text primary key check (month ~ '^[0-9]{4}_[0-9]{2}$'),
  budget      numeric(14,2) not null check (budget > 0 and budget < 100000000000),
  per_p4p     numeric(12,2) not null check (per_p4p > 0 and per_p4p < 10000000),
  updated_at  timestamptz not null default now(),
  updated_by  text not null default ''
);

create table if not exists public.review_requests (
  id            bigint generated always as identity primary key,
  month         text not null check (month ~ '^[0-9]{4}_[0-9]{2}$'),
  reason        text not null check (reason in ('rebuild', 'inputs')),
  status        text not null default 'queued' check (status in ('queued', 'dispatched', 'running', 'done', 'failed')),
  attempts      int  not null default 0,
  requested_at  timestamptz not null default now(),
  requested_by  text not null default '',
  dispatched_at timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  run_url       text not null default '',
  build_id      uuid,
  error         text not null default '' check (char_length(error) <= 2000)
);
-- At most one waiting request per month (one more may be dispatched/running).
create unique index if not exists review_requests_one_queued
  on public.review_requests (month) where status = 'queued';
create index if not exists review_requests_queued
  on public.review_requests (requested_at) where status = 'queued';

create table if not exists public.review_builds (
  id            uuid primary key default gen_random_uuid(),
  month         text not null check (month ~ '^[0-9]{4}_[0-9]{2}$'),
  built_at      timestamptz not null default now(),
  request_id    bigint,                         -- null: the nightly run
  run_url       text not null default '',
  sk03_file_id  text not null default '',       -- the Google Sheet it was exported from
  sk03_path     text not null,
  sk03_sha256   text not null check (sk03_sha256 ~ '^[0-9a-f]{64}$'),
  sk03_bytes    int  not null check (sk03_bytes > 0),
  merged_path   text not null,
  merged_sha256 text not null check (merged_sha256 ~ '^[0-9a-f]{64}$'),
  merged_bytes  int  not null check (merged_bytes > 0),
  content_sha256 text not null default '',      -- what was checked (people, inputs, doctors' files): the
                                                -- nightly run keeps the last build when this is unchanged
  budget        numeric(14,2),                  -- the review_inputs written into the sheet (null: none yet)
  per_p4p       numeric(12,2),
  sheet_budget  numeric,                        -- staff Y9 as read back from the built sheet
  sheet_w9      text not null default '',       -- intern W9 formula as read back
  people        int  not null,
  staff         int  not null,
  interns       int  not null,
  pay_total     numeric,                        -- Σ department sheets G (รวมเป็นเงิน)
  problems      jsonb not null default '[]'::jsonb,  -- [{code, blocking, count, names?}]
  depts         jsonb not null default '[]'::jsonb   -- department sheets as built (PDF)
);
create index if not exists review_builds_month on public.review_builds (month, built_at desc);

create table if not exists public.review_build_people (
  build_id     uuid not null references public.review_builds(id) on delete cascade,
  roster_index uuid not null,
  name         text not null,
  department   text not null,
  is_intern    boolean not null,
  sk03_row     int,
  sk03_score   numeric,                        -- staff/intern sheet K
  sk03_pay     numeric,                        -- staff/intern sheet N
  dept_row     int,
  dept_pay     numeric,                        -- department sheet F (ตามสัดส่วนวิชาชีพ)
  dept_admin   numeric,                        -- department sheet E (งานบริหาร)
  merged_sheet text,
  stated_total numeric,                        -- the total the doctor wrote, never recalculated
  stated_cell  text,
  stated_how   text not null default '',
  score_check  text not null check (score_check in ('match', 'mismatch', 'missing')),
  money_check  text not null check (money_check in ('match', 'mismatch', 'missing')),
  submitted_at timestamptz,
  sheet        jsonb,
  primary key (build_id, roster_index)
);

create table if not exists public.review_uploads (
  id          uuid primary key default gen_random_uuid(),
  month       text not null check (month ~ '^[0-9]{4}_[0-9]{2}$'),
  kind        text not null check (kind in ('sk03', 'merged')),
  path        text not null unique,
  file_name   text not null default '' check (char_length(file_name) <= 200),
  bytes       int  not null check (bytes > 0),
  created_at  timestamptz not null default now(),
  created_by  text not null default '',
  verified_at timestamptz,
  sha256      text check (sha256 ~ '^[0-9a-f]{64}$'),
  build_id    uuid references public.review_builds(id) on delete set null,
  -- latest: the newest build's file · older: an earlier build's file ·
  -- other_kind: the other file of a build · unknown: not a file the system built
  result      text check (result in ('latest', 'older', 'other_kind', 'unknown'))
);
create index if not exists review_uploads_month on public.review_uploads (month, created_at desc);

create table if not exists public.review_rounds (
  id                bigint generated always as identity primary key,
  month             text not null check (month ~ '^[0-9]{4}_[0-9]{2}$'),
  round_no          int  not null check (round_no >= 1),
  build_id          uuid not null references public.review_builds(id),
  sk03_upload       uuid not null references public.review_uploads(id),
  merged_upload     uuid not null references public.review_uploads(id),
  budget            numeric(14,2) not null,
  per_p4p           numeric(12,2) not null,
  -- submitted: the auditor's turn · returned: sent back, the auditee's turn ·
  -- superseded: the next round was sent · approved: all approved
  status            text not null default 'submitted' check (status in ('submitted', 'returned', 'superseded', 'approved')),
  submitted_at      timestamptz not null default now(),
  submitted_by      text not null default '',
  auditor_opened_at timestamptz,               -- the auditee can withdraw until then
  returned_at       timestamptz,
  returned_by       text not null default '',
  auditee_opened_at timestamptz,               -- the auditor can withdraw a return until then
  approved_at       timestamptz,
  approved_by       text not null default '',
  pdf_status        text not null default 'none' check (pdf_status in ('none', 'queued', 'building', 'ready', 'failed')),
  pdf_path          text,
  pdf_bytes         int,
  pdf_pages         int,
  pdf_error         text not null default '',
  unique (month, round_no)
);
-- One live round per month.
create unique index if not exists review_rounds_one_live
  on public.review_rounds (month) where status in ('submitted', 'returned', 'approved');

create table if not exists public.review_decisions (
  round_id     bigint not null references public.review_rounds(id) on delete cascade,
  roster_index uuid not null,
  decision     text check (decision in ('approve', 'fix')),   -- null: still to check (รอตรวจ)
  remark       text not null default '' check (char_length(remark) <= 1000),
  carried      boolean not null default false,  -- kept from the previous round, not re-checked
  recheck_why  text not null default '',        -- fix · new · score · department · name · check
  decided_at   timestamptz,
  decided_by   text not null default '',
  reply        text not null default '' check (char_length(reply) <= 1000),  -- the auditee's answer to a ต้องแก้ไข
  primary key (round_id, roster_index),
  check (decision is distinct from 'fix' or char_length(btrim(remark)) > 0)
);

create table if not exists public.review_issues (
  id           bigint generated always as identity primary key,
  month        text not null check (month ~ '^[0-9]{4}_[0-9]{2}$'),
  round_no     int  not null,
  roster_index uuid,
  body         text not null check (char_length(btrim(body)) between 1 and 2000),
  status       text not null default 'open' check (status in ('open', 'closed')),
  created_at   timestamptz not null default now(),
  created_by   text not null default '',
  closed_at    timestamptz,
  closed_by    text not null default ''
);
create index if not exists review_issues_month on public.review_issues (month, id);

create table if not exists public.review_issue_replies (
  id          bigint generated always as identity primary key,
  issue_id    bigint not null references public.review_issues(id) on delete cascade,
  role        text not null check (role in ('auditor', 'auditee')),
  body        text not null check (char_length(btrim(body)) between 1 and 2000),
  round_no    int,                             -- the round it went with (null: auditee draft)
  created_at  timestamptz not null default now(),
  created_by  text not null default ''
);
create index if not exists review_issue_replies_issue on public.review_issue_replies (issue_id, id);

do $$
declare t text;
begin
  foreach t in array array['review_inputs', 'review_requests', 'review_builds', 'review_build_people',
    'review_uploads', 'review_rounds', 'review_decisions', 'review_issues', 'review_issue_replies'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ── Storage ─────────────────────────────────────────────────────────────────
-- Private, no policies: only the service key and signed URLs reach it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-files', 'review-files', false, 52428800,
        array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── Build requests ──────────────────────────────────────────────────────────
-- Queue one build of p_month, or return the one already open. A changed
-- budget / per P4P ('inputs') while a build is already running queues one
-- more, since the running build read the old numbers. A request that never
-- started (its run was cancelled, or the relay was down) or ran past the
-- job's time limit is given up first, so a stuck one never blocks a retry.
create or replace function public.review_request_build(p_month text, p_reason text, p_actor text)
returns public.review_requests
language plpgsql
set search_path = ''
as $$
declare
  r public.review_requests;
begin
  if p_month !~ '^[0-9]{4}_[0-9]{2}$' then raise exception 'review: bad month'; end if;
  update public.review_requests
     set status = 'failed', finished_at = now(), error = 'timed out'
   where month = p_month
     and ((status in ('queued', 'dispatched') and requested_at < now() - interval '90 minutes')
       or (status = 'running' and started_at < now() - interval '80 minutes'));
  select * into r from public.review_requests
   where month = p_month
     and status in ('queued', 'dispatched', 'running')
     and (p_reason <> 'inputs' or status = 'queued')
   order by (status = 'queued') desc, id desc limit 1;
  if found then return r; end if;
  insert into public.review_requests (month, reason, requested_by)
  values (p_month, p_reason, coalesce(p_actor, ''))
  returning * into r;
  return r;
end;
$$;

-- The relay's claim: the oldest queued request, marked dispatched.
create or replace function public.claim_review_request()
returns setof public.review_requests
language sql
set search_path = ''
as $$
  update public.review_requests
     set status = 'dispatched', dispatched_at = now(), attempts = attempts + 1
   where id = (select id from public.review_requests
                where status = 'queued' order by requested_at
                for update skip locked limit 1)
  returning *;
$$;

-- ── Rounds ──────────────────────────────────────────────────────────────────
-- The auditee sends round N. Both uploads must be the newest build's own
-- files, that build must have no blocking problem and carry the typed budget
-- and per P4P, and it must be the auditee's turn. From round 2 on, a person
-- the auditor approved keeps that result unless their own score, department
-- or name changed, or one of their checks no longer matches; everyone else
-- is checked again (recheck_why says why). Other doctors' pay moving because
-- one score changed does not on its own mean a re-check.
create or replace function public.review_submit_round(p_month text, p_sk03 uuid, p_merged uuid, p_actor text)
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
  perform pg_advisory_xact_lock(hashtext('review:' || p_month));
  select * into v_inputs from public.review_inputs where month = p_month;
  if not found then raise exception 'review: no budget yet'; end if;
  select * into v_build from public.review_builds where month = p_month order by built_at desc limit 1;
  if not found then raise exception 'review: no build yet'; end if;
  if not exists (select 1 from public.review_uploads where id = p_sk03 and month = p_month and kind = 'sk03'
                   and result = 'latest' and build_id = v_build.id)
     or not exists (select 1 from public.review_uploads where id = p_merged and month = p_month and kind = 'merged'
                   and result = 'latest' and build_id = v_build.id) then
    raise exception 'review: files are not the latest build';
  end if;
  if exists (select 1 from jsonb_array_elements(v_build.problems) e where (e->>'blocking')::boolean) then
    raise exception 'review: the build has a blocking problem';
  end if;
  if v_build.budget is distinct from v_inputs.budget or v_build.per_p4p is distinct from v_inputs.per_p4p then
    raise exception 'review: the build does not carry the typed numbers';
  end if;
  select * into v_prev from public.review_rounds
   where month = p_month and status in ('submitted', 'returned', 'approved') for update;
  if found and v_prev.status <> 'returned' then raise exception 'review: not the auditee''s turn'; end if;

  select coalesce(max(round_no), 0) + 1 into v_no from public.review_rounds where month = p_month;
  if v_prev.id is not null then
    update public.review_rounds set status = 'superseded' where id = v_prev.id;
  end if;
  insert into public.review_rounds (month, round_no, build_id, sk03_upload, merged_upload, budget, per_p4p, submitted_by)
  values (p_month, v_no, v_build.id, p_sk03, p_merged, v_inputs.budget, v_inputs.per_p4p, coalesce(p_actor, ''))
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
               when p.score_check <> 'match' or p.money_check <> 'match' then 'check'
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

-- The auditee takes back a round the auditor has not opened yet.
create or replace function public.review_withdraw_round(p_month text, p_actor text)
returns int
language plpgsql
set search_path = ''
as $$
declare
  r public.review_rounds;
begin
  perform pg_advisory_xact_lock(hashtext('review:' || p_month));
  select * into r from public.review_rounds where month = p_month and status = 'submitted' for update;
  if not found then raise exception 'review: nothing to withdraw'; end if;
  if r.auditor_opened_at is not null then raise exception 'review: the auditor has started'; end if;
  update public.review_issue_replies x set round_no = null
    from public.review_issues i
   where x.issue_id = i.id and i.month = p_month and x.role = 'auditee' and x.round_no = r.round_no;
  delete from public.review_rounds where id = r.id;
  update public.review_rounds set status = 'returned'
   where month = p_month and round_no = r.round_no - 1 and status = 'superseded';
  return r.round_no;
end;
$$;

-- ── The tab's view of one month ─────────────────────────────────────────────
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
  v_build uuid;
begin
  if p_month !~ '^[0-9]{4}_[0-9]{2}$' then raise exception 'review: bad month'; end if;
  if to_regclass(format('public.%I', p_month)) is not null then
    execute format('select count(*), count(submitted_at) from public.%I', p_month) into v_total, v_sent;
  end if;
  select * into v_live from public.review_rounds
   where month = p_month and status in ('submitted', 'returned', 'approved');
  select id into v_build from public.review_builds where month = p_month order by built_at desc limit 1;
  return jsonb_build_object(
    'month', p_month,
    'roster', jsonb_build_object('total', v_total, 'sent', v_sent, 'exists', to_regclass(format('public.%I', p_month)) is not null),
    'inputs', (select to_jsonb(i) from public.review_inputs i where i.month = p_month),
    'build', (select to_jsonb(b) - 'depts' from public.review_builds b where b.id = v_build),
    'buildChecks', (select jsonb_build_object(
        'scoreMismatch', count(*) filter (where score_check = 'mismatch'),
        'scoreMissing',  count(*) filter (where score_check = 'missing'),
        'moneyMismatch', count(*) filter (where money_check = 'mismatch'),
        'moneyMissing',  count(*) filter (where money_check = 'missing'))
      from public.review_build_people where build_id = v_build),
    'builds', (select count(*) from public.review_builds where month = p_month),
    'request', (select to_jsonb(q) from public.review_requests q where q.month = p_month order by q.id desc limit 1),
    'uploads', (select coalesce(jsonb_object_agg(u.kind, to_jsonb(u) - 'path'), '{}'::jsonb) from (
        select distinct on (kind) * from public.review_uploads
         where month = p_month and verified_at is not null order by kind, created_at desc) u),
    'rounds', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'round_no', r.round_no, 'status', r.status, 'build_id', r.build_id,
        'budget', r.budget, 'per_p4p', r.per_p4p,
        'submitted_at', r.submitted_at, 'submitted_by', r.submitted_by,
        'auditor_opened_at', r.auditor_opened_at, 'returned_at', r.returned_at,
        'auditee_opened_at', r.auditee_opened_at, 'approved_at', r.approved_at,
        'pdf_status', r.pdf_status, 'pdf_bytes', r.pdf_bytes, 'pdf_pages', r.pdf_pages,
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

-- Months for the month picker: each roster table's counts and review state.
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
    v_total := 0; v_sent := 0;
    if to_regclass(format('public.%I', m)) is not null then
      execute format('select count(*), count(submitted_at) from public.%I', m) into v_total, v_sent;
    else
      continue;
    end if;
    out := out || jsonb_build_object(
      'month', m, 'total', v_total, 'sent', v_sent,
      'builtAt', (select max(built_at) from public.review_builds where month = m),
      'round', (select jsonb_build_object('round_no', round_no, 'status', status, 'pdf_status', pdf_status)
                  from public.review_rounds where month = m and status in ('submitted', 'returned', 'approved')),
      'hasInputs', exists (select 1 from public.review_inputs where month = m));
  end loop;
  return out;
end;
$$;

revoke all on function public.review_request_build(text, text, text) from public, anon, authenticated;
revoke all on function public.claim_review_request() from public, anon, authenticated;
revoke all on function public.review_submit_round(text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.review_withdraw_round(text, text) from public, anon, authenticated;
revoke all on function public.review_state(text) from public, anon, authenticated;
revoke all on function public.review_months(text[]) from public, anon, authenticated;
grant execute on function public.review_request_build(text, text, text) to service_role;
grant execute on function public.claim_review_request() to service_role;
grant execute on function public.review_submit_round(text, uuid, uuid, text) to service_role;
grant execute on function public.review_withdraw_round(text, text) to service_role;
grant execute on function public.review_state(text) to service_role;
grant execute on function public.review_months(text[]) to service_role;
