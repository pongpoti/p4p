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

status/list/ranking's beacon deliberately does NOT use the LIFF SDK — a first
pass did, and the first-ever `liff.init()` handshake on those 3
never-before-initialized LIFF apps caused a visible double page-reload in
production (reverted same-day). `scripts/liff-access-server-side-2026-08.sql`
replaced it: those pages now send only the page name, and `log_liff_access()`
derives the physician's LINE identity itself from whatever
`physicians.line_user_id`/`line_display_name` was captured the last time they
actually logged in and bound LINE — nothing new loads in the browser, so
nothing can cause a reload. Trade-off, accepted deliberately: the LINE
name/ID shown is "as of their last login", not captured fresh on that tap,
and there's no `client_error` to report for those 3 pages (nothing runs there
that can fail in a LIFF-specific way). `verify/app.js` is unaffected — it
still captures live via its own (pre-existing, working) LIFF app, since
there's no session yet to look anything up by.

- **Columns:** `accessed_at`, `page` (`status`/`list`/`ranking`/`verify`),
  `line_user_id`, `line_display_name` (best-effort — live from
  `liff.getProfile()` on `verify`, or the stored value on `physicians` for
  the other three; traceability only, same posture as
  `physicians.line_user_id`, nothing here is verified against an ID token),
  `auth_pass`, `matched_email` / `matched_full_name` / `matched_department`
  (populated only when `auth_pass`), `bounce_reason` (`verify`-only:
  `no_session`/`expired`/`blocked`), `client_error` (a LIFF init/profile
  failure on `verify`'s side, if any), `throttle_key` (see below).
- Written via the `log_liff_access()` RPC, called once per page load.
  `auth_pass`/`matched_*` are derived by the RPC itself from `auth.jwt()`,
  never taken from the caller. status/list/ranking call it authenticated (the
  page wouldn't have been served otherwise) and send no LINE identity at all;
  verify calls it with the anon key, before any login exists, and sends its
  own live-captured identity, which wins via `coalesce()` when present.
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
   email-processing automation.
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
