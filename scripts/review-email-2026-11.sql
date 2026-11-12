-- ============================================================================
--  review-email-2026-11.sql — email the auditor when the ผู้จัดทำ sends a month.
--
--  Pong, 2026-11-12: when the ผู้จัดทำ presses ส่ง in the ตรวจสอบ tab, the
--  month goes to the auditor by email the way the secretary sends it by hand
--  (sakhonmso to p4pskh and the usual people, Gmail label เอกสาร อกพ), with
--  the round's SK03 and รวมค่าคะแนน files attached. A later round goes as a
--  reply in the month's thread, marked แก้ไขครั้งที่ N.
--
--    review_email_settings  one row: recipients, greeting, signature lines
--                           and test_to (set: every mail goes to that one
--                           address only, marked [ทดสอบ]). NOT filled here:
--                           it holds people's names and addresses and this
--                           repository is public. Fill it in the SQL editor.
--    review_emails          one row per email: queued by a round being sent
--                           (a trigger on review_rounds) or by the tab's
--                           ส่งอีเมล button; the always-on relay (workflow 1,
--                           automation/review-email.ts) claims it, sends it
--                           and writes back what happened.
--
--  A round taken back (ดึงกลับ) before its email went out cancels the email.
--  Nothing is sent while review_email_settings has no recipients and no
--  test_to: the emails wait, queued.
--
--  service_role only, like the rest of the review tables.
--
--  Run after scripts/review-tab-2026-11.sql and
--  scripts/review-tab-2026-11-auditee.sql, in the Supabase SQL editor.
--  Safe to re-run. No backslashes, so it pastes through chat.
-- ============================================================================

create table if not exists public.review_email_settings (
  id          int primary key default 1 check (id = 1),
  recipients  text[] not null default '{}',   -- the To line, one address each
  greeting    text not null default '',       -- the first line of the body
  signature   text[] not null default '{}',   -- the lines under the body
  test_to     text not null default '',       -- set: test mode, only this address gets the mail
  updated_at  timestamptz not null default now()
);

create table if not exists public.review_emails (
  id          bigint generated always as identity primary key,
  month       text not null check (month ~ '^[0-9]{4}_[0-9]{2}$'),
  round_id    bigint references public.review_rounds(id) on delete set null,  -- null: the round was taken back
  round_no    int not null,
  build_id    uuid references public.review_builds(id) on delete set null,   -- the files that go with it
  -- queued: waiting for the relay · sending: claimed (a claim 15 minutes old
  -- is taken again) · sent · failed: 3 tries failed · cancelled: taken back
  status      text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempts    int not null default 0,
  next_try_at timestamptz,                    -- a failed try waits 5 minutes
  claimed_at  timestamptz,
  test        boolean not null default false, -- sent in test mode (to test_to only)
  fix_no      int,                            -- 0: the month's first mail · N: แก้ไขครั้งที่ N
  sent_to     text not null default '',
  gmail_id    text not null default '',
  thread_id   text not null default '',
  sent_at     timestamptz,
  error       text not null default '',
  created_at  timestamptz not null default now(),
  created_by  text not null default ''
);
create index if not exists review_emails_month on public.review_emails (month, id desc);
-- One email on its way per round.
create unique index if not exists review_emails_one_open
  on public.review_emails (round_id) where status in ('queued', 'sending');

do $$
declare t text;
begin
  foreach t in array array['review_email_settings', 'review_emails'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ── A round sent: its email is queued ───────────────────────────────────────
-- Rounds are only ever inserted by review_submit_round, so this is "the
-- ผู้จัดทำ pressed ส่ง". A trigger, so that function stays as it is.
create or replace function public.review_email_on_round()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.review_emails (month, round_id, round_no, build_id, created_by)
  values (new.month, new.id, new.round_no, new.build_id, coalesce(new.submitted_by, ''));
  return null;
end;
$$;
drop trigger if exists review_email_on_round on public.review_rounds;
create trigger review_email_on_round
  after insert on public.review_rounds
  for each row execute function public.review_email_on_round();

-- A round taken back (review_withdraw_round deletes it): an email not sent
-- yet is cancelled. One already sent stays, with no round (round_id null).
create or replace function public.review_email_on_withdraw()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.review_emails
     set status = 'cancelled', error = 'ดึงกลับก่อนส่งอีเมล'
   where round_id = old.id and status = 'queued';
  return old;
end;
$$;
drop trigger if exists review_email_on_withdraw on public.review_rounds;
create trigger review_email_on_withdraw
  before delete on public.review_rounds
  for each row execute function public.review_email_on_withdraw();

-- ── The tab's ส่งอีเมล button ────────────────────────────────────────────────
-- Emails the live round (sent to the auditor, or approved) again: for a
-- month sent before this file was run, a failed email, or a test. Refused
-- while one is on its way, or once a real (not test) email went out for it.
create or replace function public.review_email_queue(p_month text, p_actor text)
returns public.review_emails
language plpgsql
set search_path = ''
as $$
declare
  r public.review_rounds;
  e public.review_emails;
begin
  if p_month !~ '^[0-9]{4}_[0-9]{2}$' then raise exception 'review: bad month'; end if;
  perform pg_advisory_xact_lock(hashtext('review:' || p_month));
  select * into r from public.review_rounds
   where month = p_month and status in ('submitted', 'approved') for update;
  if not found then raise exception 'review: no round to email'; end if;
  if exists (select 1 from public.review_emails where round_id = r.id and status in ('queued', 'sending')) then
    raise exception 'review: an email is on its way';
  end if;
  if exists (select 1 from public.review_emails where round_id = r.id and status = 'sent' and not test) then
    raise exception 'review: already emailed';
  end if;
  insert into public.review_emails (month, round_id, round_no, build_id, created_by)
  values (r.month, r.id, r.round_no, r.build_id, coalesce(p_actor, ''))
  returning * into e;
  return e;
end;
$$;

-- ── The relay's claim ───────────────────────────────────────────────────────
-- The oldest email due, marked sending. A claim 15 minutes old is a relay
-- that stopped mid-send: it is taken again, and the relay looks in Gmail's
-- Sent for it first, so it never goes out twice.
create or replace function public.claim_review_email()
returns setof public.review_emails
language sql
set search_path = ''
as $$
  update public.review_emails
     set status = 'sending', claimed_at = now(), attempts = attempts + 1
   where id = (select id from public.review_emails
                where (status = 'queued' and coalesce(next_try_at, created_at) <= now())
                   or (status = 'sending' and claimed_at < now() - interval '15 minutes')
                order by id
                for update skip locked limit 1)
  returning *;
$$;

-- Every function here: service role only.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('review_email_on_round', 'review_email_on_withdraw', 'review_email_queue', 'claim_review_email') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
