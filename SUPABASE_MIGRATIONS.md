# Supabase Migration Order

This project has no formal migration tool — every `.sql` file under
`scripts/` and `automation/sql/` is meant to be pasted into the Supabase
SQL Editor by hand. That's fine for a project this size, but it means
there's no single place that says *which files are still authoritative*
and *what order they need to run in* — which is exactly what let
`scripts/provision-month-function.sql` drift out of sync with
`scripts/security-rls-auth.sql` (see the "RLS gap" entry below). This file
is that ledger. When you add a new migration, add it here too.

Files are listed in the order they need to be run on a fresh project. All
are idempotent (`create or replace`, `create table if not exists`,
`drop policy if exists` before `create policy`, etc.) — re-running an
already-applied file is safe.

## Current, authoritative (run in this order)

1. `automation/sql/p4p_submissions.sql` — `p4p_submissions` table + RLS.
2. `automation/sql/dept_heads.sql` — `dept_heads` table + RLS.
3. `automation/sql/sender_physician_match.sql` — `sender_physician_match`
   table + RLS.
4. `automation/sql/bump_sender_match.sql` — atomic increment RPC for
   `sender_physician_match.email_count` (used by the live pipeline).
5. `automation/sql/management_stipends.sql` — `management_stipends` table +
   RLS + seed data. Replaces `process/process.js`'s previously-hardcoded
   `MANAGEMENT_DATA`/`DEPT_HEAD_SET` (real physician names + compensation
   figures baked into source). Read by `process/process.js`'s
   `loadManagementStipends()`, once per run.
6. `scripts/security-rls-auth.sql` — **the current RLS model**: locks every
   monthly roster table (`YYYY_MM`) and `p4p_submissions` to
   `authenticated` + `is_current_user_allowlisted()`, revokes `anon`
   entirely, and installs the `trg_secure_new_roster` event trigger so any
   *future* `CREATE TABLE public."YYYY_MM"` is automatically locked down
   the same way. Also creates `physician_directory`, `access_requests`,
   `blocked_emails`, and the allow-list functions
   (`is_sender_allowlisted`, `is_current_user_allowlisted`,
   `log_access_request`).
7. `scripts/provision-month-function.sql` — `provision_month(p_new, p_old)`,
   the function `provision-next-month.mjs` calls every month to create the
   next roster table. **Must be run AFTER step 6** — it relies on
   `trg_secure_new_roster` already existing to lock down the table it
   creates, and asserts (rather than re-derives) that the resulting grants
   are `authenticated`-only with zero `anon` policies. Running this before
   step 6 would leave newly-created tables unprotected until step 6 is
   applied.
8. `scripts/list-all-physicians.sql` — `list_all_physicians()` RPC (feeds
   the `/verify/` physician-name dropdown).
9. `scripts/bind-line-user.sql` + `scripts/line-user-id-columns.sql` +
   `scripts/line-bind-gate.sql` — LINE userId binding
   (`bind_line_user_id`, `record_bind_failure`,
   `get_line_bind_gate_status`) and the `line_bind_attempts` table.
10. `scripts/line-binding-status-view.sql` — admin view of binding status.
11. `scripts/email-sent-log-setup.sql` — `email_sent_log` table + RLS
    (score-tracker dedup).
12. `scripts/telegram-approve-buttons.sql` +
    `scripts/telegram-approve-sender-display-name.sql` +
    `scripts/telegram-approve-name-match.sql` — Telegram approve/reject
    buttons on the access-request alert, the cross-check email display name,
    and a match/mismatch indicator comparing the two.
13. `scripts/notify-access-request.sql` and
    `scripts/auth-hook-restrict-signups.sql` — both explicitly marked
    "TEMPLATE — verify before enabling" in-file; review before running.

14. `scripts/auth-rewrite-2026-08.sql` — **the current auth model**, replacing
    steps 6 (its `physician_directory`/`blocked_emails`/allow-list-union half)
    and 9-10 (the LINE-bind-as-second-factor machinery) with a single
    `physicians` table (email, LINE binding, active flag, all in one row) and
    a trigger that auto-provisions a row the moment the email-matching
    pipeline confirms a submission sender. `is_sender_allowlisted` /
    `is_current_user_allowlisted` keep their names (so RLS policies and
    `provision_month` need no changes) but their bodies now read only
    `physicians`. Run AFTER step 6 and step 9-10 (it migrates data out of
    what they created) and BEFORE deploying the app version that assumes it —
    see the file's own Block 6 for the post-deploy cleanup step. Also
    replaces `notify_access_request()` (drops the Telegram approve/reject
    buttons — approval now happens in the `/admin/` dashboard).
15. `scripts/access-request-department-2026-08.sql` — adds `department` to
    `access_requests` and to what `log_access_request()` accepts/stores,
    closing a gap where an admin-approved physician (as opposed to one
    auto-provisioned from a matched submission) landed in `physicians` with
    no department at all — the request form never asked for one before this.
    Run AFTER step 14.
16. `scripts/liff-access-alert-2026-08.sql` — `liff_access_log` table +
    `log_liff_access()` RPC + `notify_liff_access()` trigger: one Telegram
    alert per rich-menu page open (status/list/ranking/verify). Requires
    `pg_net` + the same Vault secrets (`telegram_bot_token`,
    `telegram_chat_id`) as `notify_access_request()`.
17. `scripts/liff-access-server-side-2026-08.sql` — **required companion to
    step 16, run immediately after it**: rewrites `log_liff_access()` to
    derive LINE identity from `physicians.line_user_id`/`line_display_name`
    for status/list/ranking's beacon (which sends only `p_page`, no LIFF
    SDK). Without this file, those 3 pages' Telegram alerts show `—` for
    LINE name/ID even for a fully bound, `auth_pass = true` physician,
    because the step-16 version only ever inserted whatever
    `p_line_user_id`/`p_line_display_name` the caller passed — confirmed
    live in prod (2026-08-22) via
    `select pg_get_functiondef('public.log_liff_access(text,text,text,text,text)'::regprocedure)`.
    Also fixes a throttle gap (see the file's own header).

## Superseded — do NOT run

- **`scripts/security-rls.sql`** — the original anon-open RLS model,
  replaced by `scripts/security-rls-auth.sql` (step 6 above). Re-running it
  after step 6 would silently reopen anonymous read access on every
  roster/submissions table. Kept in the repo for history only; the file
  itself carries a large warning banner saying the same thing.
- **`scripts/backfill-submitted-at.sql`** and
  **`scripts/cleanup-stale-policies.sql`** — one-time backfill /
  cleanup scripts from the `security-rls.sql` → `security-rls-auth.sql`
  transition. Not part of a fresh-project setup; only relevant if you're
  replaying that specific historical migration.
- **`scripts/provision-month.sql`** — a thin manual wrapper that just calls
  the `provision_month()` RPC from step 7 with an explicit month key
  (for backfills). Not a separate migration; requires step 7 already
  applied.

## Known incident: the RLS gap

`scripts/provision-month-function.sql` was originally written (see commit
`949aa03`) *before* `scripts/security-rls-auth.sql` existed (`f13b898`),
back when the anon-open model (`scripts/security-rls.sql`) was still
current. Its own step 6 recreated that anon-open policy on every new
roster table. When `security-rls-auth.sql` later locked existing tables to
`authenticated`-only, `provision_month()` was never updated to match — so
every month it ran, it re-added an `anon`-visible policy on top of the
authenticated-only one (RLS policies are OR'd together), silently
reopening public read access to that month's physician roster. Fixed by
having `provision_month()` assert the `trg_secure_new_roster`-installed
shape instead of re-deriving a competing one (see the file's own header
comment). This ledger exists so the next schema change doesn't reintroduce
the same class of drift.

## Retired by `scripts/auth-rewrite-2026-08.sql`

These already ran in production at some point (they're not hazardous to
re-run the way `security-rls.sql` is), but the tables/functions they created
are superseded by `physicians` and dropped in step 14's post-deploy Block 6.
No need to run them on a fresh project; kept for history:

- `scripts/bind-line-user.sql`, `scripts/line-user-id-columns.sql`,
  `scripts/line-bind-gate.sql`, `scripts/line-bind-verified.sql`,
  `scripts/line-binding-status-view.sql` — the LINE-bind-as-second-factor
  machinery (`line_user_bindings`, `line_bind_attempts`,
  `line_verified_sessions`, the `bind_line_user_id*` /
  `get_line_bind_gate_status*` functions). Traceability now lives on
  `physicians.line_user_id`, updated in-app on every login, no DB-side
  gating logic involved.
- `scripts/telegram-approve-buttons.sql`,
  `scripts/telegram-approve-sender-display-name.sql`,
  `scripts/telegram-approve-name-match.sql` — the Telegram inline
  Approve/Reject flow. Approval now happens in `/admin/` (authenticated,
  service-role write), not a bearer token in `callback_data`
  (see SECURITY_ANALYSIS.md §2c).
- `scripts/list-all-physicians.sql` — already unused by the app (see its own
  in-file deprecation header); dropped in step 14's Block 6.

## Health check — catching this class of bug automatically

This exact class of regression (a roster table ending up with an
anon-visible policy alongside the authenticated-only one) is mechanically
detectable — run this in the Supabase SQL Editor at any time, or wire it
into a scheduled check, to confirm no roster table has drifted back to
anon-open:

```sql
select tablename
from pg_policies
where schemaname = 'public'
  and tablename ~ '^[0-9]{4}_[0-9]{2}$'
  and 'anon' = any(roles);
-- Expect ZERO rows. Any row returned here means that month's roster table
-- is readable by the public anon key with no login — the exact bug fixed
-- above. `provision_month()` itself now asserts this for the table it just
-- created (see scripts/provision-month-function.sql step 7b), but this
-- query checks every table, including ones provisioned before that fix.
```
