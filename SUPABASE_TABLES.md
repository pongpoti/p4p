# Supabase Tables Overview

This document summarizes every Supabase table used by the P4P project, **except**
the monthly roster tables (named `YYYY_MM`, e.g. `2569_06`), which are
per-month physician rosters imported separately each month.

Migrations for these tables live in `automation/sql/` and `scripts/`.

---

## `p4p_submissions`

**Purpose:** Central log of every P4P (Pay-for-Performance) report submission a
physician has emailed in, across all months.

- **Columns:** `physician_name`, `department`, `work_month` (e.g. `2569_06`),
  `submitted_at`, `thread_id` (Gmail thread), `filename`.
- Written by `automation/supabase-client.js` (`logSubmission()`) when the
  email-processing automation successfully parses a submission. Upserts with
  `onConflict: "physician_name,work_month"` + `ignoreDuplicates: true`, so
  re-processing the same email never creates a duplicate or overwrite.
- Source of truth that each monthly roster table's `submitted_at` column is
  backfilled from (`scripts/backfill-submitted-at.sql`).
- **Access:** RLS-protected — only `authenticated` users whose email is
  allow-listed can `SELECT` a restricted column set
  (`physician_name, department, work_month, submitted_at`). No `anon` access;
  writes only via `service_role`.
- Migration: `automation/sql/p4p_submissions.sql`.

## `p4p_upload_queue`

**Purpose:** Coordinates the LINE rich-menu upload path
(`UPLOAD_VIA_LINE_DESIGN.md`) — the second way a physician can submit a
scorecard, alongside email. One row per submitted file, carrying two
**independent** lifecycles:

- `status` (scoring): `pending → processing → done | failed | rejected`.
  Usually cleared in ~1-2 s by `POST /upload/score` in `main.js`, which scores
  a confidence-gated subset of files synchronously; anything it will not
  guess at stays `pending` for `claim_p4p_score_fallback()`.
- `archive_status` (Drive copy): `NULL → archive_pending → archived`. No
  failure value on purpose — once the score is saved the physician has nothing
  left to fix, so this retries on a backoff indefinitely rather than ever
  becoming terminal.

- **Columns:** identity snapshotted at enqueue (`email` FK → `physicians`,
  `full_name`, `department`, `line_user_id`, `roster_index`), the submission
  (`month_key`, `object_path`, `filename`, `size_bytes`, `received_at`),
  the scoring lifecycle (`status`, `attempts`, `claimed_at`, `finished_at`,
  `error_type`, `error_detail`, `score`, `score_method`, `notified_at`) and
  the archive lifecycle (`archive_status`, `archive_attempts`,
  `archive_last_attempt_at`, `archived_at`).
- `received_at` is THE punctuality timestamp — when the physician handed the
  file over, never when a runner got to it.
- A partial unique index on `(email, month_key) WHERE status IN
  ('pending','processing')` makes queue flooding structurally impossible:
  one in-flight upload per physician per month.
- **Access:** RLS enabled with **no** `anon`/`authenticated` policies at all.
  Physicians reach it only through three `SECURITY DEFINER` RPCs that read
  identity from `auth.jwt()` rather than taking it as a parameter —
  `enqueue_p4p_upload()` (the only way a row is created),
  `my_p4p_identity()`, `my_p4p_uploads()`. The two claim functions
  (`claim_p4p_score_fallback()`, `claim_p4p_archive()`) are granted to
  `service_role` only; they exist as RPCs because `FOR UPDATE SKIP LOCKED` is
  not expressible through PostgREST.
- Migration: `scripts/line-upload-2026-09.sql`.

## Storage bucket `p4p-uploads`

**Purpose:** A write-only drop box for the same path — the browser PUTs the
`.xlsx` straight here (bypassing Vercel's body limits) and nothing else.

- Private, 5 MB per object, `.xlsx` MIME type only.
- Object key: `<auth.uid()>/<month_key>/<uuid>.xlsx`. The bucket name is not
  part of it (`storage.objects` keeps that in `bucket_id`).
- **Access:** exactly one policy — `INSERT` for `authenticated` into their own
  `auth.uid()` folder. No `SELECT`/`UPDATE`/`DELETE` policy exists, so a
  physician can drop a file in and can never read one back, their own
  included. Only `service_role` (the worker, and `/upload/score`) reads.
- **Transient by design:** the object is deleted once `archive_status =
  'archived'`, so the raw file lives here for minutes, not indefinitely.

## `dept_heads`

**Purpose:** Maps each hospital department to its department head's email
address, so automation knows who to send the monthly score report to.

- **Columns:** `department` (PK), `head_email`, `updated_at`.
- Replaces a previous `DEPT_HEADS_JSON` GitHub secret (secrets are write-only;
  this table is viewable/editable via the Supabase Table Editor).
- Read by `getDeptHeads()` in `automation/supabase-client.js`; used by
  `score-tracker.mjs` / `resend-month.mjs`.
- **Access:** RLS enabled, no anon/authenticated policies — only
  `service_role` (the automation) can touch it.
- Migration: `automation/sql/dept_heads.sql`.

## `sender_physician_match`

**Purpose:** Links each *email sender address* (the "From" header of a
submission email) to the physician identity it was matched to.

- **Columns:** `sender_email` (PK), `sender_display_name`, `email_count`,
  `extracted_name`, `name_source`, `matched_physician`, `department`,
  `similarity`, `matched` (bool), `updated_at`.
- Replaces a previously-committed `sender-physician-match.csv`. Populated by
  the "Match Sender Emails" GitHub Action (batch, `saveSenderMatch`) and
  incrementally per live submission (`bumpSenderMatch`).
- Doubles as half of the **auth allow-list**: a `matched = true` row means
  that email belongs to a verified physician, allowed to request an OTP login
  on `/verify/` (see `is_sender_allowlisted()`).
- **Access:** RLS enabled, no anon/authenticated policies — reachable only via
  `service_role` or the `SECURITY DEFINER` allow-list functions.
- Migration: `automation/sql/sender_physician_match.sql`.

## `physicians`

**Purpose:** The whole auth system in one table — who's allowed to log in,
what LINE account belongs to their email, and whether that's currently
revoked. Replaces `physician_directory`, the auth-relevant half of
`sender_physician_match`, `blocked_emails`, and `line_user_bindings`.

- **Columns:** `email` (PK), `full_name`, `department`, `line_user_id`
  (unique, nullable), `line_display_name`, `active` (bool — `false` IS the
  denylist, no separate table), `source` (`'directory'` — an admin added it
  by hand — or `'matched_sender'` — auto-provisioned, see below),
  `created_at`, `updated_at`, `last_login_at`.
- **Auto-provisioning:** a trigger on `sender_physician_match`
  (`sync_physician_from_match()`) upserts a row here every time the
  email-matching pipeline confirms a submission sender (`matched = true`) —
  this is the mechanism behind "a physician who already emailed a submission
  can log in immediately, no admin step." The upsert never resurrects a row
  an admin has set `active = false` on.
- **LINE binding is traceability, not a security factor.** `line_user_id` /
  `line_display_name` are refreshed on every login that carries a LINE ID
  token (last-write-wins) — there is deliberately no mismatch detection, no
  attempt counter, and no per-session proof table. A missing or changed
  binding never blocks page access; email OTP is the sole auth factor.
- **Access:** RLS, no anon/authenticated policies — reachable only via
  `SECURITY DEFINER` functions (`is_sender_allowlisted`,
  `is_current_user_allowlisted`, same names as before so RLS policies and
  `provision_month()` needed no changes) or `service_role` (main.js,
  `/admin/api/access-requests`).
- Migration: `scripts/auth-rewrite-2026-08.sql`.

## `access_requests`

**Purpose:** Audit log of login attempts from emails that are *not* on the
allow-list, so an admin can see who still needs to be added (visibility only,
not an approval gate).

- **Columns:** `email` (PK), `name` (self-reported), `department`
  (self-reported, from a fixed dropdown — see below), `requested_at`,
  `request_count`, `resolved` (bool). (`approve_token` is dropped by
  `scripts/auth-rewrite-2026-08.sql` — approval no longer travels through
  Telegram `callback_data`.)
- Written via the `log_access_request()` RPC, called from `/verify/` when a
  user's email fails the allow-list check. `department` is required on the
  form (`assets/shared.js`'s `P4P.DEPARTMENTS`, the same fixed ~19-entry list
  `status/app.js`/`admin/app.js` use) so it can't drift from the canonical
  spelling the rest of the app groups by — added in
  `scripts/access-request-department-2026-08.sql` to close a gap where an
  admin-approved (as opposed to auto-provisioned) physician landed in
  `physicians` with no department at all.
- Approving copies `name`/`department` into the matching `physicians` row —
  `department` is only included in that write when the request actually has
  one, so an old pre-migration request with none doesn't overwrite an
  existing value on re-approval.
- `scripts/notify-access-request.sql`'s trigger fires an informational
  Telegram alert on INSERT (no buttons). An admin approves or rejects from
  `/admin/`'s Access Requests panel — `POST /admin/api/access-requests/:email`
  (service-role write, upserts into `physicians` and marks `resolved`).
- **Access:** RLS, no anon/authenticated SELECT — insert-only via the RPC;
  the admin panel reads/writes it via `service_role`.
- Migration: `scripts/security-rls-auth.sql` (Block 0a),
  `scripts/auth-rewrite-2026-08.sql` (drops `approve_token`).

## `liff_access_log`

**Purpose:** Audit trail (and the Telegram alert's source) for every rich-menu
LIFF open — `status`/`list`/`ranking` opened directly (always auth-passed —
main.js already gated the request before serving the page), or `verify` when
a session was missing/expired/blocked and the tap bounced there instead.

status/list/ranking's beacon does NOT use the LIFF SDK. History, worth
reading in full before touching this again: the original rollout (2026-08-17)
had all three call `liff.init()`/`liff.getProfile()` client-side and caused a
visible double page-reload on every tap — hotfixed same-day to derive
identity purely from the stored `physicians.line_user_id`/`line_display_name`
instead (this file's current state). A single-page trial on `ranking` alone
then seemed to show the reload was a one-time per-device handshake (settled
after one tap), so live capture was restored to all three (2026-08-18) — but
broader testing immediately after showed it reloading on **every** tap, on
**every** page, including the previously-"clean" `ranking`, so it was
reverted a second time, back to this no-LIFF design, same day. Root cause
still unconfirmed — the leading theory is the `profile` scope never having
been verified as actually enabled on these 3 LIFF apps' channels (only
`verify/`'s own LIFF app is confirmed to have it), but this was never proven
either way with real diagnostics (browser console access, scope
confirmation) — only inferred from production behavior. Do not re-attempt
live capture here without that diagnosis; it has now failed twice.

- **Columns:** `accessed_at`, `page` (`status`/`list`/`ranking`/`verify` —
  only `verify` captures LINE identity live today), `line_user_id`,
  `line_display_name` (best-effort — live from `liff.getProfile()` on
  `verify`, or the stored value on `physicians` for the other three;
  traceability only, same posture as `physicians.line_user_id`, nothing here
  is verified against an ID token), `auth_pass`, `matched_email` /
  `matched_full_name` / `matched_department` (populated only when
  `auth_pass`), `bounce_reason` (`verify`-only: `no_session`/`expired`/
  `blocked`), `client_error` (a LIFF init/profile failure on `verify`'s
  side, if any), `throttle_key` (see below).
- Written via the `log_liff_access()` RPC, called once per page load.
  `auth_pass`/`matched_*` are derived by the RPC itself from `auth.jwt()`,
  never taken from the caller. If the caller doesn't supply a LINE identity
  (a LIFF failure, or a caller that never captures one), the RPC falls back
  to whatever's stored on the matching `physicians` row — so a live capture
  failure degrades to "last known identity" rather than a blank one.
- Throttled per `throttle_key`, which is the LINE user id when there is one,
  otherwise the physician's own email (always present for an authenticated
  call) — closes a gap where a physician who never completed a LINE bind
  would never throttle at all under a `line_user_id`-only key. A repeat open
  within 10 minutes is dropped silently (no row, no alert). Not throttled
  when neither is available (an anonymous `verify` call with a LIFF
  failure) — those are rarer and worth seeing every time.
- `scripts/liff-access-alert-2026-08.sql`'s trigger fires a Telegram alert on
  every (non-throttled) INSERT, reusing the same Vault secrets
  (`telegram_bot_token`/`telegram_chat_id`) as `notify_access_request()`.
- **Access:** RLS, no anon/authenticated policies — insert-only via the RPC.
- Migration: `scripts/liff-access-alert-2026-08.sql`, then
  `scripts/liff-access-server-side-2026-08.sql`.

## `email_sent_log`

**Purpose:** Dedup/audit log for the monthly score-report emailer — prevents
sending the same department the same month's report twice, and records when
each report actually went out.

- **Columns:** `table_name` (the `YYYY_MM` month key), `department`,
  `sent_at`, with a unique constraint on `(table_name, department)`.
- Checked by `score-tracker.mjs` before sending; a report is skipped if a row
  already exists for that department+month, and a row is upserted
  (`ignoreDuplicates: true`) after a successful send.
- **Access:** RLS enabled, `anon` revoked — only the automation's
  `service_role` key touches it (no client page reads it).
- Migration: `scripts/email-sent-log-setup.sql`.

---

## Architecture note

These tables split into two groups:

1. **Operational data** for the P4P workflow — `p4p_submissions`,
   `dept_heads`, `sender_physician_match`, `email_sent_log` — driven by the
   email-processing automation, plus `p4p_upload_queue` (and its
   `p4p-uploads` bucket), which is the LINE upload path's own coordination
   table. Both paths converge on `p4p_submissions` and the roster tables, so
   the queue is a front door, not a second store of record.
2. **Auth / allow-list plumbing** for the `/verify/` OTP login gate —
   `physicians` (allow-list + LINE binding + revocation, all one table) and
   `access_requests`. A trigger on `sender_physician_match` keeps `physicians`
   in sync with the automation's matches; nothing else crosses the boundary
   between the two groups.
3. **Access monitoring** — `liff_access_log`, the Telegram-alert trail for
   every rich-menu LIFF open. Reads `physicians` (to resolve `matched_*`) but
   nothing else writes to it, so it sits alongside group 2 rather than inside
   it.

All of it is guarded by `SECURITY DEFINER` RPCs, so the underlying email/name
data is never exposed directly to `anon`/`authenticated` clients — only
yes/no or self-scoped results are.
