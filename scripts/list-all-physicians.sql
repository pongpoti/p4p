-- ============================================================================
--  ⚠️  SUPERSEDED — the dropdown this backs was REMOVED. Do not reintroduce.
-- ============================================================================
--  This function is a PII leak and is DROPPED: running this file now removes
--  it (see the bottom of the file and scripts/audit-fixes-2026-11.sql PART 5).
--  The app change it waited on is deployed: verify/ no longer calls it.
--
--  Why it was removed
--  ------------------
--  The reasoning in the original header (kept below) contains one wrong step:
--  it argues this "keeps the same exposure as the old free-text field, which
--  also just captured a self-reported name". That compares the wrong things.
--  The free-text field only ever moved data INTO the system — one name, typed
--  by the person themselves. This function moves data OUT: it returns all ~250
--  physician names, and because the request-access step runs BEFORE login, it
--  has to be executable by `anon`. The publishable key is (correctly) in page
--  source, so in practice this published the hospital's entire physician roster
--  to anyone who looked. Confirmed on the live project: 250 names returned,
--  238 recorded calls.
--
--  RLS deliberately restricts firstname/lastname to allow-listed authenticated
--  users; SECURITY DEFINER here bypassed exactly that control. /verify/ is back
--  to a length-capped, control-character-stripped free-text field
--  (verify/index.html + verify/app.js sanitizeName(), with the authoritative
--  cleaning server-side in log_access_request()). The admin already sees the
--  name and email in the Telegram approval alert, so the dropdown only ever
--  saved a typo.
--
--  ---------------------------- ORIGINAL HEADER -------------------------------
--  The "request access" step on /verify/ used to be a free-text name field.
--  This backs a dropdown instead: every distinct "firstname lastname" that has
--  ever appeared in ANY monthly roster table (YYYY_MM), so an unregistered
--  physician picks their own name rather than typing it.
--
--  SECURITY DEFINER because roster tables have no anon/authenticated grants
--  (locked down in security-rls-auth.sql) — this function only ever returns
--  names, never department/score/submission data, keeping the same exposure
--  as the old free-text field (which also just captured a self-reported name).
--
--  Sorting: returned in whatever order Postgres's default collation gives;
--  the actual Thai-dictionary-correct sort happens client-side in
--  verify/app.js via Intl.Collator, since it's far more reliably tested there
--  than guessing at Postgres ICU collation availability on this project.
-- ============================================================================

-- UPDATE 2026-11 (audit finding F10): this file used to create
-- list_all_physicians() and grant it to anon, so pasting it again (or following an old copy
-- of SUPABASE_MIGRATIONS.md, which listed it as step 8) re-published the
-- whole roster. It now only removes it — the same statements as
-- scripts/audit-fixes-2026-11.sql PART 5. The old body is in git history.
do $$
begin
  if to_regprocedure('public.list_all_physicians()') is not null then
    execute 'revoke all on function public.list_all_physicians() from public, anon, authenticated';
  end if;
end $$;
drop function if exists public.list_all_physicians();
