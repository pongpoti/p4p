-- ============================================================================
--  review-reset-2026-11.sql — รีเซ็ตเดือน: the owner starts a month's
--  ตรวจสอบ again from round 1, from the user menu (step 31).
--
--  Pong, 2026-11-24: "I want you to create month session reset function on
--  admin setting. try design". Until now a reset was a delete pasted into
--  the SQL editor (five times for ส.ค. 69).
--
--  What this file adds:
--    1. review_resets: one row per reset, with who, when and why, and a copy
--       of every round it cleared (with each round's decisions) and of the
--       month's ปัญหาอื่น (with their replies), as they were. Rows are only
--       ever added: nothing can change or delete them;
--    2. review_reset_months(months): for the dialog, each month's rounds,
--       decisions, live round, approval PDFs and its last reset;
--    3. review_reset_month(month, actor, reason, rounds): the reset. Refused
--       when the month has no round, or when its rounds are no longer the
--       ones the dialog showed (rounds: how many it showed). An email to the
--       auditor not sent yet is cancelled (refused while one is going out
--       right now); then the month's rounds (their decisions go with them)
--       and ปัญหาอื่น are deleted.
--  Kept: the budget and N (review_inputs), every build and its files, the
--  score edits, the roster, History, and the emails already sent. A PDF
--  stays in Storage; its path is in the copy.
--
--  Run after scripts/review-rounds-2026-11.sql (step 30), in the Supabase
--  SQL editor. Safe to re-run. No backslashes, so it pastes through chat.
--  End with the check query at the bottom.
-- ============================================================================

-- 1. The record of every reset.
create table if not exists public.review_resets (
  id         bigint generated always as identity primary key,
  month      text not null check (month ~ '^[0-9]{4}_[0-9]{2}$'),
  reset_at   timestamptz not null default now(),
  reset_by   text not null default '',
  reason     text not null default '' check (char_length(reason) <= 1000),
  rounds     int  not null check (rounds >= 1),
  decisions  int  not null default 0,
  snapshot   jsonb not null
);
create index if not exists review_resets_month on public.review_resets (month, id desc);
alter table public.review_resets enable row level security;
revoke all on table public.review_resets from public, anon, authenticated;
grant select, insert on table public.review_resets to service_role;
revoke update, delete, truncate on table public.review_resets from service_role;

-- 2. The dialog's list: one row per month asked for.
create or replace function public.review_reset_months(p_months text[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'month', m.month,
    'rounds', (select count(*) from public.review_rounds r where r.month = m.month),
    'decisions', (select count(*) from public.review_decisions d
                    join public.review_rounds r on r.id = d.round_id where r.month = m.month),
    'live', (select jsonb_build_object('round_no', r.round_no, 'status', r.status)
               from public.review_rounds r
              where r.month = m.month and r.status in ('submitted', 'returned', 'approved')),
    'pdfs', (select count(*) from public.review_rounds r where r.month = m.month and r.pdf_path is not null),
    'cancelled', (select count(*) from public.review_rounds r where r.month = m.month and r.status = 'cancelled'),
    'resets', (select count(*) from public.review_resets x where x.month = m.month),
    'last', (select jsonb_build_object('at', x.reset_at, 'by', x.reset_by, 'rounds', x.rounds, 'reason', x.reason)
               from public.review_resets x where x.month = m.month order by x.id desc limit 1)
  ) order by m.month), '[]'::jsonb)
  from unnest(p_months) as m(month)
  where m.month ~ '^[0-9]{4}_[0-9]{2}$';
$$;

-- 3. The reset itself.
create or replace function public.review_reset_month(p_month text, p_actor text, p_reason text, p_rounds int)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_reason    text := btrim(coalesce(p_reason, ''));
  v_rounds    int;
  v_decisions int;
  v_issues    int;
  v_id        bigint;
begin
  if p_month !~ '^[0-9]{4}_[0-9]{2}$' then raise exception 'review: bad month'; end if;
  if char_length(v_reason) > 1000 then raise exception 'review: the reason is too long'; end if;
  -- The same lock as every other round change of the month.
  perform pg_advisory_xact_lock(hashtext('review:' || p_month));
  perform 1 from public.review_rounds where month = p_month for update;
  select count(*) into v_rounds from public.review_rounds where month = p_month;
  if v_rounds = 0 then raise exception 'review: nothing to reset'; end if;
  if p_rounds is distinct from v_rounds then raise exception 'review: another round'; end if;
  select count(*) into v_decisions from public.review_decisions d
    join public.review_rounds r on r.id = d.round_id where r.month = p_month;
  select count(*) into v_issues from public.review_issues where month = p_month;

  insert into public.review_resets (month, reset_by, reason, rounds, decisions, snapshot)
  values (p_month, coalesce(p_actor, ''), v_reason, v_rounds, v_decisions, jsonb_build_object(
    'rounds', (select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('decisions',
                 (select coalesce(jsonb_agg(to_jsonb(d) - 'round_id' order by d.roster_index), '[]'::jsonb)
                    from public.review_decisions d where d.round_id = r.id)) order by r.round_no), '[]'::jsonb)
                 from public.review_rounds r where r.month = p_month),
    'issues', (select coalesce(jsonb_agg(to_jsonb(i) || jsonb_build_object('replies',
                 (select coalesce(jsonb_agg(to_jsonb(x) - 'issue_id' order by x.id), '[]'::jsonb)
                    from public.review_issue_replies x where x.issue_id = i.id)) order by i.id), '[]'::jsonb)
                 from public.review_issues i where i.month = p_month)))
  returning id into v_id;

  -- An email about a round that is going away does not go out. The rows are
  -- locked first, so the relay (which skips locked rows) cannot take one
  -- meanwhile. One the relay is sending right now finishes first (about a
  -- minute); a claim 15 minutes old is a relay that stopped, and goes too.
  perform 1 from public.review_emails where month = p_month and status in ('queued', 'sending') for update;
  if exists (select 1 from public.review_emails where month = p_month and status = 'sending'
              and claimed_at >= now() - interval '15 minutes') then
    raise exception 'review: an email is being sent';
  end if;
  update public.review_emails set status = 'cancelled', error = 'รีเซ็ตเดือน'
   where month = p_month and status in ('queued', 'sending');
  delete from public.review_issues where month = p_month;
  delete from public.review_rounds where month = p_month;
  return jsonb_build_object('reset', v_id, 'rounds', v_rounds, 'decisions', v_decisions, 'issues', v_issues);
end;
$$;

-- service_role only, like the rest of the review functions.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('review_reset_months', 'review_reset_month') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Check: table_1 = 1, functions_2 = 2, anon_0 = 0, append_only = true.
select
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'review_resets') as table_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('review_reset_months', 'review_reset_month')) as functions_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'review_reset%' and has_function_privilege('anon', p.oid, 'execute')) as anon_0,
  not has_table_privilege('service_role', 'public.review_resets', 'delete')
    and not has_table_privilege('service_role', 'public.review_resets', 'update') as append_only;
