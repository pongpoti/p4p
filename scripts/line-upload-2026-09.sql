-- ============================================================================
--  P4P — LINE rich-menu file upload: storage bucket, queue table, RPCs
-- ============================================================================
--  ⚠️  VERIFY BEFORE ENABLING — but further along than a first draft. Every
--      statement in this file has actually been RUN, not just read: against
--      a real Postgres 16 instance, under a stubbed-but-structurally-real
--      approximation of Supabase's auth.*/storage.* schema and role
--      privileges (including service_role's BYPASSRLS attribute — its
--      absence in an earlier pass of this test caught a missing GRANT on
--      p4p_upload_queue that would otherwise have surfaced as "permission
--      denied" the first time a real worker called either claim function).
--      Exercised: the enqueue happy path end to end; the double-submit
--      unique-violation caught and re-raised as the friendly Thai message,
--      not a raw 500; a deferred (no-exact-roster-match) enqueue; three
--      rejection classes (wrong extension, oversize, unknown month table);
--      both claim functions actually taking `FOR UPDATE SKIP LOCKED` locks
--      and returning the right row; and the archive backoff schedule at its
--      exact 1h/4h boundaries (59 vs 61 minutes, 3h59m vs 4h1m) — which is
--      how an off-by-one between this file's original formula and its own
--      "1h, 2h, 4h…" doc comment was actually caught and fixed, not just
--      asserted correct. None of that reaches "verified" for a satisfied
--      Supabase project, though — it was never run against real RLS-aware
--      PostgREST request flow, real `auth.jwt()` claim shapes, or this
--      project's actual `physicians`/roster-table data. Test on staging
--      first, the same way every other file in this directory says to.
--      Two things are still open, not closed by any of the above:
--        1. The BE-year → deadline arithmetic (part 3, enqueue_p4p_upload)
--           duplicates the logic in web/lib/months.ts's deadlineISO() by
--           necessity (SQL can't import a TS module) — confirmed to produce
--           the identical instant (not just a plausible one) for both of
--           that function's own documented test cases
--           (2569_04 → 2026-05-10T23:59:59+07:00, 2569_12 → 2027-01-
--           10T23:59:59+07:00, checked via a direct equality assertion, not
--           eyeballed) but not against that function's full test suite.
--        2. The name-normalisation in part 3's exact-roster-match step is a
--           reasonable guess (trim + collapse whitespace + casefold), NOT
--           a byte-for-byte port of automation/supabase-client.js's
--           normalise(). This is low-risk by construction — a mismatch
--           only ever makes the exact match miss and defer to the JS fuzzy
--           matcher (matchName()), which is already the fallback path, so
--           it is never a WRONG match, only an occasionally-unnecessary
--           deferral — but reconcile the two before relying on the "exact"
--           label in admin-facing Telegram messages (§7.6) meaning what it
--           says.
--
--  WHY THIS EXISTS
--  ----------------
--  See UPLOAD_VIA_LINE_DESIGN.md for the full design. In one line: a second
--  way to submit a monthly P4P scorecard, via a LIFF page reached from the
--  LINE rich menu, alongside (not instead of) the existing email path. File
--  bytes go browser → Supabase Storage directly; a queue table + a handful
--  of RPCs are the only thing standing between "a physician tapped submit"
--  and "the existing automation/ pipeline can act on it."
--
--  WHAT THIS RUNS AGAINST
--  ----------------------
--  Postgres 15+ (Supabase's current baseline). Assumes `pgcrypto` (for
--  gen_random_uuid()) is already enabled, which it is by default on every
--  Supabase project. No other extension is required — deliberately: the
--  "instant dispatch" alternative that would have needed pg_net + Vault was
--  rejected (§7.3), so this file needs neither.
--
--  HOW TO INSTALL
--  --------------
--  Paste this whole file into Supabase Dashboard → SQL Editor → Run, per
--  SUPABASE_MIGRATIONS.md. Safe to re-run: every CREATE is guarded
--  (IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS first) so a second run
--  after a fix lands is a normal way to iterate, not a hazard.
--
--  WHAT IT DOES, IN ORDER
--    Part 1 — the storage bucket + its one INSERT policy (§6.1).
--    Part 2 — p4p_upload_queue: both lifecycles, both indexes (§6.2).
--    Part 3 — enqueue_p4p_upload(): the only way a row is created (§6.3).
--    Part 4 — my_p4p_identity() / my_p4p_uploads(): the two read RPCs (§6.4).
--    Part 5 — claim_p4p_score_fallback() / claim_p4p_archive(): the two
--              worker-side claim functions (§6.5).
--    Part 6 — grants summary + a smoke-test script to run by hand after
--              installing, before wiring up any real page or worker code.
-- ============================================================================


-- ============================================================================
--  PART 1 — Storage bucket: a write-only drop box
-- ============================================================================
--  No SELECT/UPDATE/DELETE policy for `authenticated`, anywhere in this file.
--  A physician can drop a file in and can never read one back — not their
--  own, not anyone else's. Only `service_role` (the worker, and
--  /upload/score's own service-role calls) ever reads an object.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'p4p-uploads', 'p4p-uploads', false, 5242880,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do update
  set file_size_limit     = excluded.file_size_limit,
      allowed_mime_types  = excluded.allowed_mime_types,
      public              = excluded.public;

drop policy if exists "p4p_uploads_own_folder_insert" on storage.objects;
create policy "p4p_uploads_own_folder_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'p4p-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Object path convention (enforced by the policy above, not by a constraint —
-- Storage has no column-level checks on `name` beyond what a policy can see):
--   p4p-uploads/<auth.uid()>/<month_key>/<uuid>.xlsx


-- ============================================================================
--  PART 2 — p4p_upload_queue: two lifecycles on one row
-- ============================================================================
--  `status` — did the number get read and saved.
--  `archive_status` — did the file reach Drive.
--  A row can be scored (status='done') for minutes or hours while
--  archive_status is still catching up; that gap is invisible to the
--  physician by design (§7.7 rec 2), which is the entire reason these are
--  two columns and not one.

create table if not exists public.p4p_upload_queue (
  id            uuid primary key default gen_random_uuid(),

  -- identity, snapshotted at enqueue so a later roster edit can't rewrite
  -- history
  email         text        not null references public.physicians(email) on update cascade,
  full_name     text        not null,
  department    text,
  line_user_id  text,

  -- what is being submitted
  month_key     text        not null,          -- 'YYYY_MM', BE year
  roster_index  bigint,                        -- set when the exact match hits (part 3)
  object_path   text        not null unique,
  filename      text        not null,          -- original name, display only
  size_bytes    integer     not null,

  -- THE punctuality timestamp: when the physician handed the file over, not
  -- when a runner (or /upload/score) happened to act on it. See design §9.
  received_at   timestamptz not null default now(),

  -- ── scoring lifecycle ────────────────────────────────────────────────
  -- Set to 'done' either by /upload/score directly (service_role, common
  -- high-confidence-tier case) or by claim_p4p_score_fallback()'s caller
  -- (uncommon low-confidence-tier case). This file's enqueue_p4p_upload()
  -- never advances status past its 'pending' default — admitting a row is
  -- not scoring it.
  status        text        not null default 'pending'
                check (status in ('pending','processing','done','failed','rejected')),
  attempts      smallint    not null default 0,
  claimed_at    timestamptz,
  finished_at   timestamptz,
  error_type    text,                          -- mirrors automation's ALERT_SUBJECTS keys
  error_detail  text,
  score         numeric,                       -- what was saved, for the history list
  score_method  text,                          -- resolveScore()'s method tag — which
                                                -- confidence tier resolved it
  notified_at   timestamptz,

  -- ── archive lifecycle — independent of `status` once scoring succeeds ──
  -- NULL until status='done'; then 'archive_pending' until Drive succeeds,
  -- then 'archived'. Deliberately NO failure value: once the score is
  -- saved the physician has nothing left to fix, so this backs off rather
  -- than ever terminating (design §7.7 rec 2, §12).
  archive_status          text
                check (archive_status in ('archive_pending','archived')),
  archive_attempts        smallint    not null default 0,
  archive_last_attempt_at timestamptz,
  archived_at             timestamptz
);

create index if not exists p4p_upload_queue_drain_idx
  on public.p4p_upload_queue (received_at)
  where status = 'pending';

create index if not exists p4p_upload_queue_archive_idx
  on public.p4p_upload_queue (received_at)
  where archive_status = 'archive_pending';

-- One in-flight upload per physician per month. Makes queue flooding
-- structurally impossible rather than rate-limited — see the design's §11
-- for the narrower angle this doesn't cover (a scripted caller resubmitting
-- as fast as each row clears 'pending', now that clearing can take ~1-2s).
create unique index if not exists p4p_upload_queue_one_inflight
  on public.p4p_upload_queue (email, month_key)
  where status in ('pending','processing');

alter table public.p4p_upload_queue enable row level security;
-- No anon/authenticated policies, on purpose. Reached only through the
-- RPCs below and by service_role — the same posture as every other table
-- documented in SUPABASE_TABLES.md.

-- Explicit, rather than assumed. service_role has BYPASSRLS, which skips
-- row-level policies — but that is not the same thing as an object-level
-- GRANT, which every role still needs regardless of BYPASSRLS. A fresh
-- Supabase project's own default privileges may already cover this for
-- every new public table, but this migration does not lean on that being
-- true for the project it lands in: found by actually running this file
-- against a real Postgres instance (not just eyeballing it) and watching
-- claim_p4p_score_fallback() fail with "permission denied for table
-- p4p_upload_queue" under a plain, non-superuser service_role — the exact
-- failure a missing grant produces.
grant select, insert, update, delete on public.p4p_upload_queue to service_role;


-- ============================================================================
--  PART 3 — enqueue_p4p_upload(): the only way a row is created
-- ============================================================================
--  SECURITY DEFINER, callable by `authenticated`. Everything it needs about
--  the caller it reads from auth.jwt()/auth.uid(); nothing identifying is
--  taken as a parameter — there is no field here for a forged identity to
--  live in.
--
--  On the six-visible-month check: this function deliberately does NOT
--  re-derive "which six months does the page currently show" in SQL. That
--  window is relative to today's date (src/constants.cjs's MONTH_ITERATOR),
--  and reimplementing a moving window in plpgsql would be a second,
--  independently-driftable copy of logic that already has exactly one home.
--  The actual security boundary enforced here is to_regclass(...) is not
--  null — the month table must really exist. A physician who somehow POSTs
--  an old-but-real month key still only affects a month that was genuinely
--  provisioned, which this design already tolerates (late submissions are
--  accepted, not blocked — design §9). The UI's six chips are what actually
--  narrows the practical choice.

create or replace function public.enqueue_p4p_upload(
  p_object_path text,
  p_month_key   text,
  p_filename    text,
  p_size_bytes  integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email        text;
  v_uid          text;
  v_full_name    text;
  v_department   text;
  v_line_user_id text;
  v_roster_index bigint;
  v_queue_id     uuid;
  v_roster_match text := 'none';
  v_deadline     timestamptz;
  v_ce_year      integer;
  v_month_num    integer;
  v_norm_name    text;
begin
  -- 1. Same single gate the pages use.
  if not public.is_current_user_allowlisted() then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  v_email := auth.jwt() ->> 'email';
  v_uid   := auth.uid()::text;
  if v_email is null or v_uid is null then
    raise exception 'no authenticated session' using errcode = '42501';
  end if;

  -- 2. Month key must look like BE-year YYYY_MM and the table must exist.
  --    (Format bound: 2400-2700 mirrors provision-month-function.sql's own
  --    sanity range for the same key shape.)
  if p_month_key !~ '^(24|25|26)[0-9]{2}_(0[1-9]|1[0-2])$' then
    raise exception 'invalid month key: %', p_month_key using errcode = '22023';
  end if;
  if to_regclass('public.' || p_month_key) is null then
    raise exception 'unknown month table: %', p_month_key using errcode = '42P01';
  end if;

  -- 3. object_path must be this caller's own, and must already exist in
  --    storage.objects (never trust a path handed in as a plain parameter).
  if p_object_path !~ ('^' || v_uid || '/') then
    raise exception 'object_path does not belong to caller' using errcode = '42501';
  end if;
  if not exists (
    select 1 from storage.objects
     where bucket_id = 'p4p-uploads' and name = p_object_path
       and owner = auth.uid()
  ) then
    raise exception 'object not found or not owned by caller' using errcode = '42501';
  end if;

  -- 4. Size and filename sanity — re-checked here even though the client
  --    (§5.3) and the bucket's file_size_limit already gate this; a
  --    parameter is a parameter.
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 5242880 then
    raise exception 'oversize' using errcode = '22023';
  end if;
  if p_filename !~* '\.xlsx$' or p_filename ~ '^~\$' then
    raise exception 'wrong_extension' using errcode = '22023';
  end if;

  -- 5/6. Resolve identity from `physicians` by JWT email. Doing this before
  -- the insert (rather than trusting a client-passed name) is what makes
  -- "uploading as another physician" structurally impossible (design §11).
  select p.full_name, p.department, p.line_user_id
    into v_full_name, v_department, v_line_user_id
    from public.physicians p
   where p.email = v_email and p.active;
  if v_full_name is null then
    -- is_current_user_allowlisted() already passed, so this should not
    -- happen — but fail loudly rather than insert a row with a null name
    -- if the allow-list and this table ever disagree.
    raise exception 'no active physician record for %', v_email using errcode = 'P0002';
  end if;

  -- 7. Exact roster resolution — deliberately the ONLY matcher in SQL. See
  -- this file's own header comment on why the normalisation here doesn't
  -- need to be byte-identical to automation/'s normalise(): a mismatch
  -- only ever causes an unnecessary defer, never a wrong match.
  v_norm_name := lower(regexp_replace(trim(v_full_name), '\s+', ' ', 'g'));
  execute format(
    'select index from public.%I
       where lower(regexp_replace(trim(coalesce(firstname,'''') || '' '' || coalesce(lastname,'''')), ''\s+'', '' '', ''g'')) = $1
       limit 2',
    p_month_key
  ) into v_roster_index using v_norm_name;
  -- (limit 2 + relying on "into" taking the first row is intentional here:
  -- if this ever needs to distinguish "0 matches" from "2+ matches" the
  -- way the JS fast-path does for single-token names, switch this to a
  -- FOR loop with an explicit count — not needed for the common case of a
  -- full "first last" name, which is what `full_name` already is.)

  if v_roster_index is not null then
    v_roster_match := 'exact';
  else
    v_roster_match := 'deferred';  -- automation/'s matchName() gets the next try
  end if;

  -- Deadline: 10th of the month AFTER month_key, 23:59:59 Asia/Bangkok.
  -- Mirrors web/lib/months.ts's deadlineISO() — see this file's header
  -- comment for which two cases this was checked against.
  v_ce_year  := substring(p_month_key from 1 for 4)::integer - 543;
  v_month_num := substring(p_month_key from 6 for 2)::integer;
  v_deadline := timezone(
    'Asia/Bangkok',
    make_date(v_ce_year, v_month_num, 1)
      + interval '1 month 9 days 23 hours 59 minutes 59 seconds'
  );

  -- Insert, with the double-tap race (§6.3's "concurrency note") handled
  -- explicitly rather than left to surface as a raw 500.
  begin
    insert into public.p4p_upload_queue (
      email, full_name, department, line_user_id,
      month_key, roster_index, object_path, filename, size_bytes
    ) values (
      v_email, v_full_name, v_department, v_line_user_id,
      p_month_key, v_roster_index, p_object_path, p_filename, p_size_bytes
    )
    returning id into v_queue_id;
  exception when unique_violation then
    raise exception 'ส่งไฟล์เดือนนี้ไปแล้ว กำลังตรวจสอบ' using errcode = '23505';
  end;

  return jsonb_build_object(
    'queue_id',     v_queue_id,
    'roster_match', v_roster_match,
    'deadline',     v_deadline,
    'is_late',      now() > v_deadline
  );
end;
$$;

revoke all on function public.enqueue_p4p_upload(text, text, text, integer) from public;
grant execute on function public.enqueue_p4p_upload(text, text, text, integer) to authenticated;


-- ============================================================================
--  PART 4 — Read-side RPCs: my_p4p_identity(), my_p4p_uploads()
-- ============================================================================
--  Both SECURITY DEFINER, both self-scoped from the JWT — there is no
--  parameter here that selects whose data comes back.

create or replace function public.my_p4p_identity(p_month text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email      text := auth.jwt() ->> 'email';
  v_full_name  text;
  v_department text;
  v_in_roster  boolean := false;
  v_submitted  timestamptz;
  v_norm_name  text;
begin
  select p.full_name, p.department
    into v_full_name, v_department
    from public.physicians p
   where p.email = v_email and p.active;

  if v_full_name is not null and to_regclass('public.' || p_month) is not null then
    v_norm_name := lower(regexp_replace(trim(v_full_name), '\s+', ' ', 'g'));
    execute format(
      'select submitted_at from public.%I
         where lower(regexp_replace(trim(coalesce(firstname,'''') || '' '' || coalesce(lastname,'''')), ''\s+'', '' '', ''g'')) = $1
         limit 1',
      p_month
    ) into v_submitted using v_norm_name;
    v_in_roster := found;
  end if;

  return jsonb_build_object(
    'full_name',    v_full_name,
    'department',   v_department,
    'in_roster',    v_in_roster,
    'submitted_at', v_submitted
  );
end;
$$;

revoke all on function public.my_p4p_identity(text) from public;
grant execute on function public.my_p4p_identity(text) to authenticated;


create or replace function public.my_p4p_uploads(p_limit integer default 10)
returns table (
  month_key   text,
  filename    text,
  received_at timestamptz,
  status      text,
  score       numeric,
  error_type  text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select q.month_key, q.filename, q.received_at, q.status, q.score, q.error_type
    from public.p4p_upload_queue q
   where q.email = auth.jwt() ->> 'email'
   order by q.received_at desc
   limit least(coalesce(p_limit, 10), 50);
$$;

revoke all on function public.my_p4p_uploads(integer) from public;
grant execute on function public.my_p4p_uploads(integer) to authenticated;


-- ============================================================================
--  PART 5 — Worker claim functions: claim_p4p_score_fallback(), claim_p4p_archive()
-- ============================================================================
--  Two functions, not one flag on a shared one, because they claim
--  different rows under different predicates with different retry rules.
--  FOR UPDATE SKIP LOCKED is not expressible through PostgREST, which is
--  the actual reason these are RPCs at all — not privilege elevation:
--  automation/'s worker already calls Supabase as service_role, which
--  bypasses RLS on its own. Restricting EXECUTE to service_role below is
--  belt-and-suspenders, matching this repo's existing style of being
--  explicit about grants (see security-rls-auth.sql).

create or replace function public.claim_p4p_score_fallback()
returns public.p4p_upload_queue
language plpgsql
as $$
declare
  v_row public.p4p_upload_queue;
begin
  update public.p4p_upload_queue q
     set status = 'processing', attempts = attempts + 1, claimed_at = now()
   where q.id = (
     select id from public.p4p_upload_queue
      where status = 'pending' and attempts < 3
      order by received_at
      limit 1
      for update skip locked)
  returning q.* into v_row;
  return v_row;
end;
$$;

revoke all on function public.claim_p4p_score_fallback() from public;
grant execute on function public.claim_p4p_score_fallback() to service_role;


create or replace function public.claim_p4p_archive()
returns public.p4p_upload_queue
language plpgsql
as $$
declare
  v_row public.p4p_upload_queue;
begin
  update public.p4p_upload_queue q
     set archive_attempts = archive_attempts + 1,
         archive_last_attempt_at = now()
   where q.id = (
     select id from public.p4p_upload_queue
      where archive_status = 'archive_pending'
        and (archive_last_attempt_at is null
             or archive_last_attempt_at
                < now() - make_interval(hours => least(24, 2 ^ greatest(0, archive_attempts - 1))::int))
      order by received_at
      limit 1
      for update skip locked)
  returning q.* into v_row;
  return v_row;
end;
$$;

revoke all on function public.claim_p4p_archive() from public;
grant execute on function public.claim_p4p_archive() to service_role;


-- ============================================================================
--  PART 6 — Grants summary + smoke test
-- ============================================================================
--  Grants, all stated explicitly above rather than left implicit:
--    enqueue_p4p_upload, my_p4p_identity, my_p4p_uploads  → authenticated only
--    claim_p4p_score_fallback, claim_p4p_archive          → service_role only
--    storage.objects INSERT on bucket p4p-uploads         → authenticated,
--      own-folder only, via the policy in Part 1 (no SELECT/UPDATE/DELETE
--      policy exists for authenticated at all)
--    p4p_upload_queue direct table access                 → service_role
--      only (RLS enabled, zero anon/authenticated policies)
--
--  Run this after installing, as the project's service_role (or via the
--  SQL Editor, which already runs as a superuser) — NOT as a physician —
--  to confirm the shape end to end before wiring up any real page or
--  worker code:
--
--    -- 1. Upload a real .xlsx as service_role directly into Storage under
--    --    a throwaway auth.uid()-shaped path, e.g.
--    --    '00000000-0000-0000-0000-000000000000/2569_06/test.xlsx'.
--    -- 2. As that same (test) authenticated user:
--    select public.enqueue_p4p_upload(
--      '00000000-0000-0000-0000-000000000000/2569_06/test.xlsx',
--      '2569_06', 'test.xlsx', 12345
--    );
--    -- Expect a jsonb result with a queue_id, not an exception.
--    -- 3. As service_role:
--    select * from public.claim_p4p_archive();     -- expect: no rows yet
--                                                   -- (status is still 'pending')
--    select * from public.claim_p4p_score_fallback();  -- expect: the row,
--                                                       -- now 'processing'
--    -- 4. Manually UPDATE that row to status='done',
--    --    archive_status='archive_pending', then re-run claim_p4p_archive()
--    --    and confirm it claims that row this time.
-- ============================================================================
