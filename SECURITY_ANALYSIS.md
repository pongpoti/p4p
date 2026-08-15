# P4P — App Data Security Analysis

> **Superseded (2026-08).** The auth system this document analyzes —
> email OTP + LINE-bind-as-second-factor with staged enforcement, bind
> attempts, and per-session proof — was deliberately replaced by a much
> simpler design: email OTP is the sole auth factor, and LINE binding is
> traceability only (see `scripts/auth-rewrite-2026-08.sql`,
> `supabase/functions/line-verify`, and the `physicians` table in
> `SUPABASE_TABLES.md`). Section 1's MFA recommendations (P1, P2, P12) are
> a description of what the OLD design did — they do not apply to the
> current one, which never claims a second factor in the first place. The
> rate-limiting (§2) and anomaly-detection (§3) findings are independent of
> that redesign and still describe real, live gaps.

**Scope:** MFA · rate limiting · anomaly detection
**Reviewed:** `main.js`, `verify/`, `assets/`, `status|list|ranking/`, `scripts/*.sql`, `automation/`
**Live project verified:** `zjeizbrzcltkgtlmkbji` (P4P, ap-southeast-1, Postgres 17.6)
**Date:** 2026-08

Every finding below was checked against the **live database**, not just the repo.
Where the deployed state differs from what the migration scripts intended, the
live state is what is reported. Only two things could not be verified: the Auth
dashboard's rate-limit/CAPTCHA sliders, and the OTP expiry value (Supabase's
`auth_otp_long_expiry` lint did **not** fire, so expiry is ≤ 1 hour, but the
exact value is not readable through the API). Direct HTTP probing of the REST
endpoint was blocked by this sandbox's egress proxy, so exploitability is
evidenced at the grant level (`has_function_privilege`) plus PostgREST's
documented behaviour of exposing every `public` function the role can execute.

---

## 0. Executive summary

The **data-at-rest model is sound**: 12 roster tables + `p4p_submissions` are
RLS-protected, column-restricted, and confirmed unreadable by `anon`. The
problems are all in the **access-control plumbing around** that data.

The single most important discovery is structural, and it explains most of the
individual findings:

> **Every `revoke ... from public` in `scripts/*.sql` is a no-op against
> `anon`.** Supabase sets `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT
> EXECUTE ON FUNCTIONS TO anon, authenticated, service_role`. That grants
> `anon` an **explicit** privilege on every new function. `REVOKE ... FROM
> PUBLIC` only removes the `PUBLIC` pseudo-role grant — it never touches the
> explicit `anon`/`authenticated` grants. So the scripts *look* locked down,
> ran without error, and achieved nothing.

Verified default ACL on the live project:

```
schema=public  objtype=f(unction)
default_acl = postgres=X/postgres | anon=X/postgres |
              authenticated=X/postgres | service_role=X/postgres
```

Result: **all 13** `public` functions are `anon`-executable, including the four
the repo explicitly tried to restrict to `service_role`.

| Severity | Finding | Status |
|---|---|---|
| **HIGH** | `list_all_physicians()` leaks 250 physician names to anyone, no login | Live, in daily use (238 calls) |
| **HIGH** | `provision_month()` anon-callable → unauthenticated table creation / storage exhaustion | Live |
| **MEDIUM-HIGH** | `approve_access_request()` anon-callable → allow-list insertion, contradicting its own design doc | Live |
| **MEDIUM-HIGH** | Zero MFA (0 factors, all 69 sessions `aal1`) + sessions that **never expire** (`not_after` NULL ×69) | Live |
| **MEDIUM** | Two stale `anon`/`public` RLS policies on `p4p_submissions` (797 rows) — inert only because a grant is missing | Live |
| **MEDIUM** | No auth audit trail whatsoever — `auth.audit_log_entries` is **empty** | Live |
| **MEDIUM** | Signup allow-list hook does not exist in the DB; 1 non-allow-listed account already created | Live |
| **LOW** | `anon` holds `TRUNCATE` on `email_sent_log` and `fetch` | Live, not reachable via PostgREST |

---

## 1. MFA — Multi-Factor Authentication

### Verified: strictly single-factor

| Check | Live value |
|---|---|
| `auth.mfa_factors` | **0 rows** — nobody has enrolled any factor |
| `auth.sessions` distinct `aal` | **`aal1` only** (all 69 sessions) |
| `auth.users` | 22 |
| `auth.sessions.not_after` | **NULL for all 69** — no server-side session expiry |
| `auth.refresh_tokens` | 133 (64 revoked, 69 live) |
| Oldest session | 2026-07-02 |

Authentication is possession of an email inbox, nothing more. No RLS policy
tests assurance level — `is_current_user_allowlisted()` reads only
`auth.jwt() ->> 'email'`.

### The second factor exists in the schema and is not used as one

`line_user_bindings` holds 18 rows mapping email → LINE `userId`.
`scripts/bind-line-user.sql` states the intent plainly: *"pure traceability,
NOT an auth factor... no automatic alerting is added here."*

The gate in `main.js:198-207` checks *blocked?*, *bound at all?*, *attempt
count* — never **"is the LINE account in front of me the one bound to this
email?"** Anyone who can read a physician's email logs in from their own LINE
account and reads every roster. `bind_line_user_id()`'s `ON CONFLICT DO UPDATE`
refreshes only the display name, so the original `userId` silently survives and
**the login still succeeds**.

Good news from the data: `shared_line_ids = 0` — no two emails share a LINE
`userId` today, so enforcing the match would not break any current user.

### The fail-open is not theoretical — it has already fired

```
line_bind_attempts: 1 row → attempts = 3, admin_notified = true
auth.users without a LINE binding: 4 of 22
```

One account hit the 3-failure limit, the one-time Telegram alert fired, and that
email is now **permanently admitted unbound** with no further signal — exactly
the "alert once, then silence forever" gap. Three more accounts have no binding
at all.

Fail-open paths, all confirmed in code:

| Path | Code | Behaviour |
|---|---|---|
| Gate RPC errors | `main.js:154-157` | returns `null` → gate skipped entirely |
| ≥3 failed binds | `main.js:204`, `verify/app.js:212` | admitted unbound, alert never repeats |
| `record_bind_failure` unreachable | `verify/app.js:180-183` | returns the limit → admitted |
| Bind from *any* LINE account | `bind_line_user_id()` | no comparison performed |

### Sessions are effectively permanent

`main.js:79` sets `Max-Age=34560000` (**400 days**), and the live check shows
`not_after IS NULL` on all 69 sessions — Supabase is not expiring them either.
A stolen cookie is good indefinitely. Revocation exists (`blocked_emails`
re-checked every page load, `main.js:200`) but `blocked_emails` has **0 rows** —
it has never been exercised in production.

### Recommendations

- **P1 — Enforce the LINE binding as a real second factor.** **Implemented**
  (`scripts/line-bind-verified.sql`, `main.js` `POST /line/bind`), but note the
  correction below — the first version of this recommendation was wrong.

  > **Correction.** This originally said to add
  > `verify_line_binding(p_line_user_id)` comparing the live
  > `liff.getProfile().userId` to the stored one. That would not have been a
  > second factor. `bind_line_user_id` takes the userId as a **parameter**, and
  > `liff.getProfile()` runs in the browser — its output is just a string the
  > page chooses to send. The client would have been supplying the value being
  > compared: it sets it on first bind, and afterwards anyone who learns the
  > opaque `U…` string can replay it.
  >
  > What actually works is `liff.getIDToken()` — an OIDC JWT signed by LINE —
  > verified server-side via `POST https://api.line.me/oauth2/v2.1/verify`. The
  > `sub` claim is then an authenticated LINE userId the client cannot forge.
  > `bind_line_user_id_verified()` is `service_role`-only, so the browser cannot
  > reach it at all; only `main.js` can, and only after LINE has vouched.
  >
  > A second correction follows from the first: a mismatch check gates nothing
  > on its own. An attacker holding a stolen email inherits the victim's
  > earlier bind, so `is_bound` is true and they walk into `/status/` even
  > though their own bind was refused. Proof has to be **per session** —
  > `line_verified_sessions`, keyed on the access token's `session_id` claim
  > (a required claim, stable across refreshes).

  Rolled out in two stages via `LINE_BIND_ENFORCE`: detect-only first (verify +
  refuse + alert on mismatch, existing access rules untouched), then enforcing.
  The gate is the reason for the staging — it depends on the LIFF app having the
  `openid` scope, which `getProfile()` never needed.
- **P2 — Bound the fail-open** to the current session and re-alert each time,
  instead of one latch per email forever. **Partly done**: with
  `LINE_BIND_ENFORCE=true` both fail-opens are off (the attempts limit and the
  "gate RPC unreachable" path). The one-shot `admin_notified` latch in
  `record_bind_failure()` is unchanged.
- **P3 — Expire sessions.** Set a Supabase session timeout (e.g. 30 days
  rolling / 90 absolute) and cut the cookie `Max-Age` to match. 400 days on a
  monthly-use tool is pure downside.
- **P4 — MFA for admins.** TOTP for ~200 physicians in a LINE webview is a UX
  non-starter, but anyone with dashboard/`service_role` access should have it.
  Also enable leaked-password protection (flagged by the advisor).

---

## 2. Rate limiting

### Application layer: still none

`main.js` mounts four routes with no limit, quota, or backpressure; no
rate-limit dependency in `package.json`; no WAF rules in `vercel.json`.
`POST /auth/session` is unauthenticated and makes an outbound Supabase call per
request — both an amplifier and a token-validity oracle (401 vs 200).

### Database layer: the real exposure, and it is worse than the scripts imply

All 13 `public` functions are `anon`-executable. Verified individually:

```
has_function_privilege('anon', 'list_all_physicians()',            'EXECUTE') → true
has_function_privilege('anon', 'provision_month(text,text)',       'EXECUTE') → true
has_function_privilege('anon', 'approve_access_request(text)',     'EXECUTE') → true
```

**2a. `list_all_physicians()` — 250 names, no authentication. (HIGH)**
The function unions every `YYYY_MM` roster and returns `firstname || lastname`.
Live count: **250 distinct names**. `verify/app.js:254` calls it to populate the
login dropdown *before* login, so this is not a lurking bug — it is the normal
operating mode. `pg_stat_statements` records **238 PostgREST calls, 15.6s total
exec time**. RLS carefully restricts `firstname`/`lastname` to allow-listed
`authenticated` users; this `SECURITY DEFINER` function hands the same names to
`anon` and bypasses that entirely.

**2b. `provision_month(p_new, p_old)` — unauthenticated table creation. (HIGH)**
Input validation is good (regex-bound `YYYY_MM`, BE 2400–2700, no injection),
and it refuses to overwrite an existing table. But an unauthenticated caller can
walk the whole valid keyspace — **3,612 possible table names** — each call doing
`CREATE TABLE ... INCLUDING ALL` plus a ~200-row copy. That is unbounded storage
and catalog growth from the public key. The script's own comment reads *"Only
the automation (service_role) may provision. Never anon/authenticated."*; the
`revoke` ran (3 times, per `pg_stat_statements`) and did not take effect.

**2c. `approve_access_request()` / `reject_access_request()` — anon-callable. (MEDIUM-HIGH)**
`scripts/telegram-approve-buttons.sql` asserts *"the actual privileged DB write
happens server-side using the service_role key that only Vercel holds."* That is
**false in production** — `anon` can call it directly. The token is 12 hex chars
(48 bits) from `substr(md5(random()::text || clock_timestamp()::text), 1, 12)`,
so blind brute force over HTTP is impractical; but `random()` is not a CSPRNG,
and the token travels in Telegram `callback_data`, so anyone in that chat — or
holding the bot token — can approve straight into `physician_directory` without
going through Vercel at all. The intended "only our server can do this" control
does not exist.

**2d. Email enumeration oracles.** `is_sender_allowlisted` and
`get_line_bind_gate_status` are `anon`-callable and unmetered — yes/no oracles
over a 207-row directory. Note that `get_line_bind_gate_status` **cannot simply
be revoked**: `main.js:152` calls it with the anon key as both `apikey` and
`Bearer`, not with the user's token, and the failure path (`main.js:155`)
returns `null`, which makes `main.js:199` skip the gate — *including the
`blocked_emails` denylist*. Revoking it would silently disable revocation.
`main.js` must be changed to pass the user's token (`at`, already in scope)
first. Same for the fail-open itself: failing open on the bind requirement is
defensible; failing open on the denylist is not.

**2e. OTP spam / junk accounts — hook confirmed absent.**
`restrict_signups_to_allowlist` **does not exist** in `pg_proc`, so the
"Before User Created" hook cannot be enabled. The allow-list check at
`verify/app.js:394` is therefore client-side only, and
`signInWithOtp({shouldCreateUser:true})` is callable for any address. Evidence
it matters: **1 of 22 `auth.users` is in neither `physician_directory` nor
`sender_physician_match`** (created 2026-07-02, the project's first day, 1
session, no LINE binding). RLS correctly denies it all data, but the account
exists.

**2f. Stale permissive policies on `p4p_submissions`. (MEDIUM)**
Two undocumented policies are live — neither appears under these names in any
repo script, so they were added via the dashboard:

```
"allow anon read"  cmd=SELECT  roles={public}  qual=true
"anon read only"   cmd=SELECT  roles={anon}    qual=true
"verified read submissions" cmd=SELECT roles={authenticated} qual=is_current_user_allowlisted()
```

They are **inert today** only because the matching grant is absent
(`has_table_privilege('anon','p4p_submissions','SELECT') = false`). A single
stray `GRANT SELECT ... TO anon` — or a table recreated by `supabase_admin`,
whose default ACL is `anon=arwdDxtm` (full CRUD) — instantly exposes all **797**
submission rows. RLS policies are OR'd, so these override the authenticated-only
policy the moment a grant appears. `scripts/cleanup-stale-policies.sql` exists
but targets different policy names and did not remove these.

**2g. Leftover table privileges. (LOW)**
`has_table_privilege('anon','email_sent_log','TRUNCATE') = true`; same on the
undocumented 1-row `public.fetch` table, which additionally carries a wide-open
`ALL / public / true` policy. Not reachable through PostgREST (no TRUNCATE
verb, and TRUNCATE ignores RLS anyway), so impact is low — but it is the same
default-privileges leak, and `fetch` looks like an abandoned test table that
should simply be dropped.

**2h. Minor.** `main.js:276` compares the Telegram webhook secret with `!==`
(not constant-time); use `crypto.timingSafeEqual`. The handler also logs on
every unauthenticated hit.

### Recommendations

- **P1 — Fix the root cause, but not with `alter default privileges` alone.**
  That statement only edits the *executing role's* entry, and this project has
  two (`postgres` and `supabase_admin`) across functions, tables **and**
  sequences. The `supabase_admin` entry — which grants `anon` full CRUD
  (`arwdDxtm`) on new tables — cannot be altered from the SQL editor at all,
  because `postgres` is not a member of `supabase_admin` (verified via
  `pg_auth_members`). Since this project creates a roster table every month,
  the durable fix is an **event trigger** that strips `anon`/`authenticated`
  from every new object in `public` regardless of creator, ordered to fire
  before `trg_secure_new_roster` re-grants the four roster columns. Then revoke
  on the existing functions. See `scripts/security-hardening-2026-08.sql`.
- **P2 — Stop leaking 250 names.** Replace the `anon` dropdown feed: either
  gate `list_all_physicians()` behind a submitted email that already passed
  `is_sender_allowlisted`, return a department-scoped subset, or drop the
  dropdown for free text plus server-side matching. This is the only finding
  that leaks real PII to the internet today.
- **P3 — Drop the two stale `p4p_submissions` policies** and the `fetch` table.
- **P4 — Create and enable the signup hook.** The function does not exist;
  validate it on a branch project, then enable "Before User Created".
- **P5 — Supabase Auth rate limits + CAPTCHA** on the OTP endpoint (dashboard).
  Adding a CAPTCHA host needs `script-src`/`connect-src`/`frame-src` updates to
  the CSP at `main.js:226-235`.
- **P6 — Rate-limit and sanitise `log_access_request`** (cap `p_name` length,
  strip control chars — it is interpolated straight into a Telegram message) and
  cap inserts per hour.
- **P7 — Per-IP limits on `/auth/session`** via the Vercel WAF; an in-process
  limiter is only partly effective across serverless instances.
- **P8 — Regenerate `approve_token` with `gen_random_bytes`** (pgcrypto is
  already installed) instead of `md5(random())`.

---

## 3. Anomaly detection

### Verified: there is no audit trail at all

```
auth.audit_log_entries → 0 rows
```

Zero, against 22 users, 69 sessions and 133 refresh tokens. There is **no
record of any login, failed OTP, or session refresh** anywhere in the system —
not in the database, and nothing in the app writes one. After an incident there
is no way to answer *"who accessed what, when"* beyond
`line_user_bindings.bound_at`.

What does exist:

| Signal | Live status | Limitation |
|---|---|---|
| `trg_notify_access_request` on `access_requests` | **active**; Vault holds `telegram_bot_token` + `telegram_chat_id` | INSERT-only. Repeats are `ON CONFLICT DO UPDATE` → silent. Live data shows `max(request_count) = 2`, i.e. a repeat already happened with no second alert |
| `record_bind_failure()` ≥3 | **has fired once** (`admin_notified = true`) | `admin_notified` latch → never alerts again for that email |
| Vercel `console.log` | webhook only | ephemeral, unretained, unread |

Current state of the queues nobody is watching: **4 of 8 access requests
unresolved**; `blocked_emails` empty (revocation never used); 207 directory rows
all `active`.

### Not detected at all

- **LINE `userId` mismatch** — the strongest available compromise indicator,
  explicitly left unalerted by design.
- **Bulk reads.** `ranking/app.js:114` self-limits to 500 rows, but that is a
  client courtesy; the RLS policy has no row cap. One compromised account can
  drain all 12 roster tables and 797 submissions silently.
- **Enumeration bursts** against the anon RPCs — invisible. `pg_stat_statements`
  is the *only* place the 238 `list_all_physicians` calls are visible, and it is
  a rolling aggregate, not an alertable log.
- **IP / user-agent / geo** — never captured anywhere.
- **`service_role` misuse.** The key bypasses all RLS (`rolbypassrls = true`,
  confirmed) and is held by Vercel plus every GitHub Action. No usage alerting,
  no rotation schedule.
- **Off-hours access.** A monthly tool has an extremely predictable usage shape,
  which makes baseline deviation unusually easy to detect here — and its absence
  unusually cheap to fix.
- **Alert-channel health.** Everything goes to one Telegram chat. No heartbeat
  proves it still works. (The API log also shows `rpc/bump_sender_match`
  returning **404** repeatedly — a missing function the automation still calls
  nightly. Not a security issue, but proof that silent failures currently go
  unnoticed for a long time.)

### Recommendations

- **P1 — `auth_events` audit table.** Server-written on every session-affecting
  action (`/auth/session` ok/fail, gate denial, bind ok/mismatch/fail, page
  access): `email`, `event`, `ip` (`x-forwarded-for`), `user_agent`,
  `line_user_id`, `at`. `service_role` write, no client read. Nothing else here
  is possible without it.
- **P2 — Alert on LINE `userId` mismatch** — highest signal, lowest noise; pairs
  with MFA-P1.
- **P3 — De-latch the existing alerts.** Re-alert on repeat access requests
  (`request_count` thresholds) and on continued bind failures.
- **P4 — Daily digest + heartbeat** via the existing GitHub Actions cron (no
  `pg_cron` on this project): logins, new emails, failed OTPs, unresolved access
  requests, bind anomalies, rows read per user. Send it even at zero — that is
  the proof the channel is alive.
- **P5 — Threshold rules over `auth_events`**: >N emails attempting OTP from one
  IP/hour; >N failed OTPs per email; access outside the submission window; any
  session reading >N rows. Add a second channel (email) so detection does not
  hinge on one bot token.
- **P6 — Retention + rotation.** Fix a retention window for `auth_events` (this
  is health-staff PII — 90 days is plenty) and set a rotation schedule for
  `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, and the LINE tokens.
- **P7 — Run `get_advisors` in CI.** It independently flagged 13 of these
  issues; wiring it into the existing Actions turns this whole review into a
  standing check.

---

## 4. Priority summary

**Status: items 1 and 3 were applied to production on 2026-08-07 13:42 UTC**
via `scripts/security-hardening-2026-08.sql` (Blocks 1, 2, 3, 5, 6, 7; Block 4
held back pending an automation run). Verified after: anon-executable
`SECURITY DEFINER` functions dropped from 10 to 4 — the four being the
intentional pre-login surface — anon/public RLS policies went 3 → 0, and a live
canary confirmed new tables/functions/roster tables come out with zero anon
access while still getting the 4 `authenticated` column grants.

**Item 2 is half-done and the leak is still open.** The app side is fixed —
`/verify/` no longer calls `list_all_physicians()`; the roster dropdown is now a
length-capped free-text field, and `log_access_request()` was hardened
server-side (control characters stripped, name capped at 100, malformed emails
rejected — all verified against the live DB). But **the function still exists
and is still `anon`-callable, deliberately**: production serves `main`, and the
deployed `/verify/` still depends on it. Dropping it before this branch is
merged and deployed would leave new physicians unable to request access at all.
The `drop` statement and its verification query are at the end of
`scripts/security-hardening-2026-08.sql`. Until that runs, all 250 names remain
reachable with the publishable key.

| # | Action | Area | Effort | Impact |
|---|---|---|---|---|
| ~~1~~ | ~~Event trigger stripping anon grants on new objects **+** re-revoke the existing functions~~ **DONE** | Rate limit | S | **Critical** |
| 2 | Stop `list_all_physicians()` returning 250 names to `anon` — **app change done, DB drop pending deploy** (see below) | Rate limit | M | **High** |
| ~~3~~ | ~~Drop the two stale `p4p_submissions` anon policies~~ **DONE** (the `fetch` table itself still exists; its wide-open policy is gone) | Rate limit | XS | **High** |
| ~~4~~ | ~~Enforce LINE `userId` match as a second factor~~ **CODE DONE, awaiting deploy + `openid` scope** — server-verified ID tokens, not a client-supplied userId (see §1 P1) | MFA | M | **High** |
| 5 | `auth_events` audit table | Anomaly | M | **High** |
| 6 | Expire sessions (Supabase timeout + cookie `Max-Age`) | MFA | S | High |
| 7 | Create + enable the signup allow-list hook | Rate limit | S | High |
| 8 | Alert on LINE `userId` mismatch | Anomaly | S | High |
| 9 | Auth rate limits + CAPTCHA (dashboard) | Rate limit | S | Medium |
| 10 | Rate-limit + sanitise `log_access_request` | Rate limit | S | Medium |
| 11 | De-latch alerts; daily digest + heartbeat | Anomaly | M | Medium |
| 12 | Bound the bind fail-open to one session | MFA | S | Medium |
| 13 | `approve_token` via `gen_random_bytes` | Rate limit | XS | Medium |
| 14 | `get_advisors` in CI | Anomaly | XS | Medium |
| 15 | `timingSafeEqual` for the Telegram secret | Rate limit | XS | Low |

### What is genuinely good

Verified, not assumed: all 12 roster tables and `p4p_submissions` have RLS on
with an `authenticated` + `is_current_user_allowlisted()` policy and
column-level grants limited to `firstname, lastname, department, submitted_at`;
`anon` has **no** SELECT on any of them (spot-checked at the privilege level).
Every PII table (`physician_directory`, `sender_physician_match`,
`blocked_emails`, `line_user_bindings`, `dept_heads`) is RLS-on with zero
policies — default deny. `bind_line_user_id()` takes the email from the JWT, not
the client. `provision_month()` validates identifiers before dynamic SQL and
actively asserts no anon policy exists on new tables. The refresh token is
HttpOnly/Secure/SameSite with the access token held only in memory; the CSP has
no `unsafe-inline` in `script-src` and the CDN bundles carry SRI; the
open-redirect guard at `verify/app.js:50` is correct; the LINE webhook is
signature-verified. The design intent throughout is sound — what failed is that
Supabase's default privileges silently defeated the `revoke` statements meant to
enforce it.
