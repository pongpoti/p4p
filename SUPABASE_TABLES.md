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

- **Columns:** `email` (PK), `name` (self-reported), `requested_at`,
  `request_count`, `resolved` (bool). (`approve_token` is dropped by
  `scripts/auth-rewrite-2026-08.sql` — approval no longer travels through
  Telegram `callback_data`.)
- Written via the `log_access_request()` RPC, called from `/verify/` when a
  user's email fails the allow-list check.
- `scripts/notify-access-request.sql`'s trigger fires an informational
  Telegram alert on INSERT (no buttons). An admin approves or rejects from
  `/admin/`'s Access Requests panel — `POST /admin/api/access-requests/:email`
  (service-role write, upserts into `physicians` and marks `resolved`).
- **Access:** RLS, no anon/authenticated SELECT — insert-only via the RPC;
  the admin panel reads/writes it via `service_role`.
- Migration: `scripts/security-rls-auth.sql` (Block 0a),
  `scripts/auth-rewrite-2026-08.sql` (drops `approve_token`).

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

All of it is guarded by `SECURITY DEFINER` RPCs, so the underlying email/name
data is never exposed directly to `anon`/`authenticated` clients — only
yes/no or self-scoped results are.
