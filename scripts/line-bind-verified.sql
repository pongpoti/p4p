-- ============================================================================
--  P4P — LINE binding as a REAL second factor (server-verified ID tokens)
-- ============================================================================
--  ✅ Blocks 1-3 APPLIED to production 2026-08-07. Block 4 is POST-DEPLOY only.
--  Run scripts/bind-line-user.sql and scripts/line-bind-gate.sql first.
--
--  THE PROBLEM THIS FIXES
--  ----------------------
--  bind_line_user_id(p_line_user_id text, ...) takes the LINE userId as a
--  PARAMETER. It reads the email from auth.jwt() correctly, so a user can only
--  bind their own email — but the LINE identity is whatever the client says it
--  is. liff.getProfile() runs in the browser; its output is just a string the
--  page chooses to send. Any holder of a valid session could call the RPC with
--  any userId.
--
--  So the binding was never a second factor, and a "does the live userId match
--  the stored one?" check would not have made it one: the client supplies the
--  value being compared. On first bind an attacker sets it; afterwards anyone
--  who learns the opaque U… string can replay it.
--
--  THE FIX
--  -------
--  LIFF also exposes liff.getIDToken() — an OpenID Connect JWT signed by LINE.
--  main.js POSTs it to https://api.line.me/oauth2/v2.1/verify with the LINE
--  Login channel id as client_id; LINE validates signature, expiry and audience
--  and returns the claims. The `sub` claim is an AUTHENTICATED LINE userId the
--  client cannot forge.
--
--    • bind_line_user_id_verified() is service_role ONLY. The browser cannot
--      reach it; only main.js can, and only after LINE has vouched.
--    • A mismatch is REFUSED and alerted, not silently accepted.
--    • line_verified_sessions records WHICH SESSION proved the identity.
--      Without it the mismatch check gates nothing: an attacker who fails the
--      bind still walks into /status/, because the old gate only asked "is this
--      email bound to anything?" — true, thanks to the victim's own bind.
--
--  HARDENING ADDED AFTER REVIEW (all verified against the live DB)
--  ---------------------------------------------------------------
--   #4 Mismatch alerts are rate-limited to one per email per hour. Without a
--      cooldown, an attacker with a stolen session can loop /line/bind and
--      flood the admin's Telegram — and alert fatigue defeats the only
--      detection this feature adds. The running count rides along in the
--      message so a burst is still visible. Verified: 3 rapid mismatches queue
--      1 alert; the counter still reaches 3; after the hour it re-arms.
--   #5 line_user_bindings.first_verified_at drives GRADUATED enforcement. Only
--      emails that have proved at least once are subject to it, so turning
--      LINE_BIND_ENFORCE on cannot lock out every physician at once if the LIFF
--      app turns out to be missing the `openid` scope. It lives here rather
--      than on line_verified_sessions precisely because those rows get garbage
--      collected — enforcement must never be silently downgraded by cleanup.
--      The 18 pre-existing bindings were written the old, client-asserted way,
--      so they are NULL and phase in as each physician next visits.
--   #6 session_revoked: Supabase DELETES the auth.sessions row on sign-out, so
--      a missing row means the token outlived its session. /auth/logout only
--      cleared our cookie and never called Supabase signOut, so until now
--      nothing here could actually revoke a session.
--   #7 The display name comes from the ID token and is user-controlled — same
--      cleaning as log_access_request(). Plus opportunistic cleanup of
--      line_verified_sessions, which otherwise grew without bound.
--
--  PREREQUISITE: the /verify/ LIFF app needs the `openid` scope, or
--  liff.getIDToken() returns null and every bind fails. getProfile() only needs
--  `profile`, so this is very likely NOT enabled yet — check the LINE
--  Developers console BEFORE DEPLOYING, not just before enforcing.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Block 1 — per-session proof + enforcement/alert state.
--
--   line_verified_sessions is keyed on the access token's `session_id` claim,
--   which Supabase documents as required on every access token and stable
--   across refreshes — so a physician proves once per session, not per page.
--   verified_at gives the proof a shelf life; it is the only expiry anything
--   in this system has, since auth.sessions.not_after is NULL on every row and
--   the session cookie lasts 400 days.
-- ----------------------------------------------------------------------------
create table if not exists public.line_verified_sessions (
  session_id    text primary key,
  email         text        not null,
  line_user_id  text        not null,
  verified_at   timestamptz not null default now()
);
create index if not exists line_verified_sessions_email_idx
  on public.line_verified_sessions (email);

alter table public.line_verified_sessions enable row level security;
revoke all on public.line_verified_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.line_verified_sessions to service_role;

alter table public.line_user_bindings
  add column if not exists first_verified_at      timestamptz,
  add column if not exists mismatch_count         integer not null default 0,
  add column if not exists last_mismatch_at       timestamptz,
  add column if not exists last_mismatch_alert_at timestamptz;


-- ----------------------------------------------------------------------------
-- Block 2 — the verified bind. service_role ONLY.
--
--   p_line_user_id is NOT client input: main.js only ever passes the `sub`
--   claim LINE itself returned. Returns {status: bound|match|mismatch|invalid}
--   so main.js can tell them apart — a mismatch must not be reported to the
--   client as retryable, and must not count toward line_bind_attempts (that
--   counter exists for device/permission problems, and letting a mismatch burn
--   it down to the fail-open limit would hand back the bypass this removes).
-- ----------------------------------------------------------------------------
create or replace function public.bind_line_user_id_verified(
  p_email             text,
  p_line_user_id      text,
  p_line_display_name text default null,
  p_session_id        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email      text := lower(btrim(coalesce(p_email, '')));
  v_uid        text := btrim(coalesce(p_line_user_id, ''));
  v_name       text;
  v_sid        text := nullif(btrim(coalesce(p_session_id, '')), '');
  v_existing   text;
  v_count      integer;
  v_last_alert timestamptz;
  v_token      text;
  v_chat       text;
begin
  if v_email = '' or v_uid = '' then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_name := regexp_replace(coalesce(p_line_display_name, ''), '[[:cntrl:]]', ' ', 'g');
  v_name := btrim(regexp_replace(v_name, '\s+', ' ', 'g'));
  v_name := nullif(left(v_name, 100), '');

  select line_user_id, mismatch_count, last_mismatch_alert_at
    into v_existing, v_count, v_last_alert
    from public.line_user_bindings where email = v_email;

  if v_existing is not null and v_existing <> v_uid then
    update public.line_user_bindings
      set mismatch_count   = coalesce(mismatch_count, 0) + 1,
          last_mismatch_at = now()
      where email = v_email
      returning mismatch_count into v_count;

    if v_last_alert is null or v_last_alert < now() - interval '1 hour' then
      update public.line_user_bindings set last_mismatch_alert_at = now() where email = v_email;

      select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';
      select decrypted_secret into v_chat  from vault.decrypted_secrets where name = 'telegram_chat_id';
      if v_token is not null and v_chat is not null then
        perform net.http_post(
          url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
          body    := jsonb_build_object(
            'chat_id', v_chat,
            'text', '🚨 การเข้าใช้งานผิดปกติ (P4P)' || E'\n' ||
                    'อีเมล: ' || v_email || E'\n' ||
                    'บัญชี LINE ไม่ตรงกับที่ผูกไว้ครั้งแรก' || E'\n' ||
                    'ผูกไว้: ' || v_existing || E'\n' ||
                    'ที่พยายามเข้า: ' || v_uid || E'\n' ||
                    'จำนวนครั้งสะสม: ' || v_count || E'\n' ||
                    'ระบบปฏิเสธการเข้าใช้งานแล้ว หากเป็นการเปลี่ยนเครื่อง/บัญชี LINE จริง ' ||
                    'ให้ลบแถวของอีเมลนี้ในตาราง line_user_bindings เพื่อให้ผูกใหม่ได้' || E'\n' ||
                    '(แจ้งเตือนซ้ำได้ไม่เกินชั่วโมงละครั้ง)'
          ),
          headers := '{"Content-Type": "application/json"}'::jsonb
        );
      end if;
    end if;
    return jsonb_build_object('status', 'mismatch');
  end if;

  if v_existing is null then
    insert into public.line_user_bindings (email, line_user_id, line_display_name, bound_at, first_verified_at)
    values (v_email, v_uid, v_name, now(), now())
    on conflict (email) do nothing;

    update public.physician_directory    set line_user_id = v_uid where lower(email)        = v_email;
    update public.sender_physician_match set line_user_id = v_uid where lower(sender_email) = v_email;
  else
    update public.line_user_bindings
      set line_display_name = coalesce(v_name, line_display_name),
          first_verified_at = coalesce(first_verified_at, now())
      where email = v_email;
  end if;

  delete from public.line_bind_attempts where email = v_email;

  if v_sid is not null then
    insert into public.line_verified_sessions (session_id, email, line_user_id, verified_at)
    values (v_sid, v_email, v_uid, now())
    on conflict (session_id) do update
      set email = excluded.email, line_user_id = excluded.line_user_id, verified_at = now();
  end if;

  delete from public.line_verified_sessions
    where verified_at < now() - interval '60 days'
       or not exists (select 1 from auth.sessions s where s.id::text = session_id);

  return jsonb_build_object('status', case when v_existing is null then 'bound' else 'match' end);
exception when others then
  raise warning 'bind_line_user_id_verified failed for %: %', v_email, sqlerrm;
  return jsonb_build_object('status', 'error');
end;
$$;

revoke all on function public.bind_line_user_id_verified(text, text, text, text) from public, anon, authenticated;
grant execute on function public.bind_line_user_id_verified(text, text, text, text) to service_role;


-- ----------------------------------------------------------------------------
-- Block 3 — gate status WITHOUT an email parameter.
--
--   The old get_line_bind_gate_status(p_email) is granted to anon and takes any
--   address, making it an unauthenticated "is this person a registered
--   physician?" oracle. It was also called by main.js WITH THE ANON KEY, which
--   is why it could not simply be revoked: the call would 403, the handler
--   would swallow it and return null, and main.js would then skip the whole
--   gate — including the blocked_emails denylist.
--
--   This takes no argument and reads the email from the caller's own JWT, so
--   there is nothing to enumerate. main.js must call it with the USER'S access
--   token, not the anon key.
-- ----------------------------------------------------------------------------
drop function if exists public.get_line_bind_gate_status_self();
create function public.get_line_bind_gate_status_self()
returns table(
  is_blocked       boolean,
  is_bound         boolean,
  attempts         integer,
  session_verified boolean,
  session_revoked  boolean,
  enforce_eligible boolean
)
language sql
security definer
stable
set search_path = public
as $$
  select
    exists (select 1 from public.blocked_emails b where lower(b.email) = lower(auth.jwt() ->> 'email')),
    exists (select 1 from public.line_user_bindings lb where lb.email = lower(auth.jwt() ->> 'email')),
    coalesce((select a.attempts from public.line_bind_attempts a where a.email = lower(auth.jwt() ->> 'email')), 0),
    exists (
      select 1 from public.line_verified_sessions s
      where s.session_id = (auth.jwt() ->> 'session_id')
        and s.email      = lower(auth.jwt() ->> 'email')
        and s.verified_at > now() - interval '30 days'
    ),
    not exists (
      select 1 from auth.sessions s where s.id::text = (auth.jwt() ->> 'session_id')
    ),
    exists (
      select 1 from public.line_user_bindings lb
      where lb.email = lower(auth.jwt() ->> 'email') and lb.first_verified_at is not null
    );
$$;

revoke all on function public.get_line_bind_gate_status_self() from public, anon;
grant execute on function public.get_line_bind_gate_status_self() to authenticated, service_role;


-- ============================================================================
-- Block 4 — POST-DEPLOY ONLY. Do not run until the new main.js + verify/app.js
--           are live, or the currently deployed /verify/ breaks: it calls
--           bind_line_user_id() directly and would start failing every bind.
-- ============================================================================
--
--   revoke all on function public.bind_line_user_id(text, text)   from public, anon, authenticated;
--   revoke all on function public.get_line_bind_gate_status(text) from public, anon, authenticated;
--   drop function if exists public.bind_line_user_id(text, text);
--   drop function if exists public.get_line_bind_gate_status(text);
--
--   Verify — expect only is_sender_allowlisted and log_access_request to remain
--   anon-executable (plus list_all_physicians until that one is dropped too,
--   see security-hardening-2026-08.sql):
--
--     select p.proname
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
--     order by p.proname;
--
--   Before setting LINE_BIND_ENFORCE=true, confirm real binds are landing:
--
--     select count(*) from public.line_verified_sessions where verified_at > now() - interval '1 day';
--     select count(*) from public.line_user_bindings where first_verified_at is not null;
--
--   Only the second number's population is enforced, so it doubles as the
--   blast radius of turning the flag on.
--
--   Admin runbook — a physician legitimately changed phone or LINE account:
--     delete from public.line_user_bindings     where email = '<their email>';
--     delete from public.line_verified_sessions where email = '<their email>';
--   Their next visit re-binds (trust on first use) with no OTP re-entry.
--
--   NOTE: with Block 5 below in place, that runbook is now MANDATORY when an
--   account moves. Previously a stale row could linger harmlessly; now the
--   unique index will reject the new bind until the old row is deleted.
-- ============================================================================


-- ============================================================================
-- Block 5 — one LINE account maps to at most ONE email.  ✅ APPLIED 2026-08.
-- ============================================================================
--
--  The mismatch check in Block 2 guards a single direction: "does this EMAIL
--  already have a different LINE id?". Nothing asked the reverse, so two
--  emails could bind the same LINE account.
--
--  That matters because /line/silent-auth (main.js) looks up in exactly the
--  unguarded direction — line_user_id -> email — and the result decides WHICH
--  IDENTITY to mint a session for. It took rows[0] from an unordered PostgREST
--  response, so with duplicates present the choice was nondeterministic.
--
--  Two ordinary workflows produced that state: a physician binding both a
--  personal and an institutional address, and the runbook above when someone
--  changes email rather than LINE account (the old row survives).
--
--  Verified before applying: 24 bindings, 0 duplicate line_user_ids, 0 nulls.
--  main.js additionally sends &limit=2 and refuses with 409 on a second row, so
--  a violation is detected even if this index is ever dropped.
create unique index if not exists line_user_bindings_line_user_id_key
  on public.line_user_bindings (line_user_id);
