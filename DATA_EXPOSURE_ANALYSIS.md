# P4P — Data Exposure Analysis

**Scope:** where physician data actually leaves the trust boundary — the
repository itself, CI artifacts, third-party processors, and the auth paths
added since the last review.
**Reviewed:** repo tree + git history, `.github/workflows/`, `main.js`,
`web/`, `automation/`, `scripts/*.sql`
**Date:** 2026-08

Companion to [`SECURITY_ANALYSIS.md`](SECURITY_ANALYSIS.md), which covers MFA,
rate limiting and anomaly detection against the **live database**. That review
deliberately scoped itself to the app and the DB. This one asks a different
question — *where else does this data exist?* — and the answer turns out to
matter more than anything in the database.

---

## 0. Executive summary

`SECURITY_ANALYSIS.md` ranks as its top finding that `list_all_physicians()`
returns **250 physician names to anyone with no login**, and calls it "the only
finding that leaks real PII to the internet today."

That is not correct, and the reason is one line of `git`:

> **The repository is public** (verified via the GitHub API:
> `SKH-MSO/p4p` → `"visibility": "public"`, `"private": false`), and it contains
> `csv_2569_01-04/*.csv` — **773 rows of physician full name + department +
> P4P score**, in plaintext, for four consecutive months.

So the leak is not 250 names behind an RPC. It is ~250 named physicians *with
their departments and their actual monthly performance scores*, published to
the open internet, cloneable without authentication, indexed, forkable, and
already in the git history. Every control described in the companion document —
RLS, column grants, OTP, the LINE second factor, the allow-list, the denylist —
protects a dataset that is simultaneously being served as a static file from
`github.com`.

| Sev | Finding | Where | Status |
|---|---|---|---|
| **CRITICAL** | 773 rows of named physician scores in a **public** repo | `csv_2569_01-04/*.csv` | Live, in git history |
| **HIGH** | 18 department heads' personal email addresses committed | `automation/sql/dept_heads.sql:32-49` | Live, in git history |
| **HIGH** | CI run logs containing physician names published as public artifacts | 3 workflows, 30-day retention | Live, rolling |
| **MED-HIGH** | `/line/silent-auth` turns the "second factor" into a **sufficient** credential | `main.js:687-784` | Live |
| **MED-HIGH** | No unique constraint on `line_user_id`; silent-auth picks `rows[0]` | `main.js:704-717` + `line-bind-verified.sql` | Live |
| **MEDIUM** | Admin signing key silently degrades to a constant when a secret is unset | `main.js:228`, `web/lib/admin/tokens.ts:27` | Live |
| **LOW** | Middleware forwards a client-supplied `x-p4p-access-token` | `web/middleware.ts:67` | Latent |
| **LOW** | Physician names/scores sent to a third-party LLM API; base URL env-overridable | `automation/claude-analyst.js:11-24` | By design, ungoverned |

---

## 1. CRITICAL — Named physician performance data in a public repository

```
csv_2569_01-04/2569_01.csv   194 lines
csv_2569_01-04/2569_02.csv   194 lines
csv_2569_01-04/2569_03.csv   193 lines
csv_2569_01-04/2569_04.csv   192 lines
                             773 rows total
```

Header: `Full Name,Department,Score`. The rows are real — full Thai given name
and surname, the same 18 clinical departments as `dept_heads`, and scores
spanning 2,201.68 – 31,630.96. Tracked since **PR #95** ("Add roster CSV exports
for 2569_01-04"), never removed.

This is *more* sensitive than what the DB exposes. `list_all_physicians()`
returned names only. These files join name → department → **individual
performance score**, across four months, which is exactly the ranking data
`/ranking/` gates behind a session and RLS.

**The `.gitignore` already states the rule and misses these files:**

```gitignore
# Contains real physician PII — data now lives in the Supabase
# sender_physician_match table instead (see automation/sql/).
sender-physician-match.csv
```

The rule was written filename-by-filename rather than by shape, so the next PII
CSV to arrive was not covered. That is the actual defect — the control is a
denylist of one.

**Remediation is not `git rm`.** Deleting at HEAD leaves every byte reachable
via the commit history, the GitHub API, existing clones, forks and Google's
cache. Treat this as **data already disclosed**:

1. Remove the files and rewrite history (`git filter-repo --path csv_2569_01-04
   --invert-paths`), force-push, and ask GitHub Support to purge cached views
   and any forks.
2. Replace the `.gitignore` line with a shape-based rule (`*.csv` with explicit
   `!` exceptions for fixtures) plus a pre-commit/CI check that fails on a Thai
   name column or an email column in any added file.
3. **Consider whether the repo needs to be public at all.** Nothing here is a
   library or a public good — it is one hospital's internal workflow. Flipping
   it private is a single click and removes findings 1, 2 and 3 simultaneously.
4. Notify per the applicable duty (Thailand's PDPA — this is identified
   employee performance data on healthcare staff).

---

## 2. HIGH — Department heads' personal email addresses committed

`automation/sql/dept_heads.sql:32-49` seeds the table with 18 real addresses,
mapped to the department each person heads. They are **personal** accounts
(gmail / hotmail / yahoo), not institutional aliases.

`SUPABASE_TABLES.md` describes how this got here:

> Replaces a previous `DEPT_HEADS_JSON` GitHub secret (secrets are write-only;
> this table is viewable/editable via the Supabase Table Editor).

The data moved out of a write-only secret store and into a plaintext file in a
public repo. The migration to a DB table was right; committing the seed data
alongside it undid the benefit.

Impact is sharper than a generic address leak: these same addresses are the
**auth allow-list identities**. Login is possession of the inbox
(`SECURITY_ANALYSIS.md` §1), there is no MFA, and OTP endpoints have no CAPTCHA
or rate limit. Publishing the list of valid targets, with each person's role
and department for pretexting, is a directly usable phishing kit against the
accounts that hold access.

**Fix:** strip the `insert` block to a `-- seed applied out-of-band` comment,
rewrite history alongside finding 1, and load the mapping from a GitHub secret
or the Table Editor. Rotate nothing (no credential leaked) but expect targeted
phishing and warn the 18 people.

---

## 3. HIGH — Public CI artifacts carry physician names

Three workflows upload run logs with 30-day retention:

| Workflow | Line | Path |
|---|---|---|
| `p4p-cron.yml` | 61 | `automation/run.log` |
| `process-pipeline.yml` | 73 | `process/*.log` |
| `process-report.yml` | 48 | `process/*.log` |

Those logs are not sanitised. `automation/index.js:526` writes
`✅ Physician : ${analysis.name}` for every submission processed, and the
surrounding lines log fuzzy-match candidates, similarity scores and attachment
filenames (`index.js:543-594`, `768`, `1017`).

On a **public** repository, workflow-run artifacts are downloadable by anyone —
no account required for the run pages, and the artifact API is open. So this is
not a one-time dump like the CSVs but a **rolling 30-day feed** of who submitted
what, refreshed on every cron run.

**Fix:** drop the artifact uploads, or gate them behind a private repo, or route
names through a redaction helper before logging (hash or initials are enough for
debugging a fuzzy match). Shortest path: set `retention-days: 1` and make the
repo private today, redact properly after.

---

## 4. MED-HIGH — `/line/silent-auth` makes LINE a *sufficient* credential

`main.js:687-784`, added in `97a8035` and not covered by the previous review.

The endpoint is unauthenticated by design ("there is no session yet; proving
identity via a LINE ID token is the entire point"). Given a valid LINE ID token
it:

1. verifies the token with LINE (`main.js:370-392` — fails closed if
   `LINE_LOGIN_CHANNEL_ID` is unset, correct),
2. reverse-looks-up `line_user_bindings` by `line_user_id` to get an email,
3. checks `blocked_emails`,
4. calls `admin/generate_link` with the **service-role key** to mint a magic-link
   OTP for that email and immediately redeems it server-side
   (`mintSessionForEmail`, `main.js:651-683`),
5. sets the 400-day session cookie.

No email is sent. No OTP is typed. The physician never sees the form.

The engineering is careful — the direction of the lookup is deliberate and
documented, the denylist is re-checked server-side rather than trusted to client
JS, and the post-mint bind goes through the same mismatch-checking RPC. The
problem is architectural, not defensive:

> `SECURITY_ANALYSIS.md` §1 spent its top recommendation making the LINE binding
> into a **second** factor. `silent-auth` makes it an **alternative first**
> factor. The system now has two independent single-factor paths — email
> possession **OR** LINE possession — and the weaker of the two wins, because an
> attacker chooses which to attack.

Concretely: possession of a physician's LINE ID token is now equivalent to a
full 400-day session. The ID token is a bearer string the client holds; it is
handed to `liff.getIDToken()` in a webview, and the four LIFF apps
(`/verify`, `/status`, `/list`, `/ranking`) share a LINE Login channel, so a
token minted in any of them is accepted here.

Secondary issues on the same endpoint:

- **No rate limit** (consistent with the rest of the app), and it burns a
  service-role `generate_link` call per request.
- **Enumeration oracle**: `404 not_bound` / `403 blocked` / `200 ok` tells an
  unauthenticated caller whether a given LINE account belongs to a registered —
  or revoked — physician (`main.js:717`, `735`, `778`).

**Fix:** if silent resume is worth keeping, bind it to something the attacker
cannot replay — require the LIFF `nonce` and check it server-side, cap the
resumed session's lifetime to something far below 400 days, and log every mint
to the `auth_events` table §3-P1 of the companion doc already calls for. Do not
let a silent path issue a longer-lived session than the interactive one.

---

## 5. MED-HIGH — `line_user_id` is not unique, but silent-auth treats it as if it were

`line_user_bindings` is keyed on **`email`** (`scripts/bind-line-user.sql`,
extended by `line-bind-verified.sql:91-95`). There is **no unique constraint or
index on `line_user_id`**.

The mismatch check in `bind_line_user_id_verified` only guards one direction —
*does this email already have a different LINE id?*
(`line-bind-verified.sql:138-174`). Nothing asks the reverse: *is this LINE id
already bound to a different email?*

`silent-auth` queries in exactly that unguarded direction:

```js
// main.js:704-710
SUPABASE_URL + "/rest/v1/line_user_bindings?line_user_id=eq." + ... + "&select=email"
email = r.data && r.data[0] && r.data[0].email
```

No `ORDER BY`, no `limit=1`, no "exactly one row" assertion — `rows[0]` from an
unordered PostgREST result decides **which identity a session is minted for**.

The companion review measured `shared_line_ids = 0` today, so this is latent
rather than exploited. But two documented, ordinary workflows create the state:

- A physician with two addresses (personal + institutional) binds both to their
  one LINE account — nothing rejects the second bind.
- The admin runbook at `line-bind-verified.sql:294-297` says to delete the
  binding row when someone changes phone or LINE account. Change *email* instead
  and the old row survives, giving one LINE id two emails.

Then which account you are silently logged into is a coin flip decided by
Postgres row order.

**Compounding:** Block 4 of `line-bind-verified.sql:270-275` — which revokes and
drops the **old client-asserted `bind_line_user_id(text, text)`** — is commented
out and marked POST-DEPLOY ONLY. It has not run. That RPC takes the LINE userId
as a caller-supplied parameter and is still `authenticated`-executable, so a
single compromised inbox can bind an attacker-controlled LINE account to that
email and then use `silent-auth` for **permanent, OTP-free re-entry** — a
one-time email compromise upgraded into durable access.

**Fix (all three, in order):**
1. `create unique index on public.line_user_bindings (line_user_id);` — and
   resolve any duplicates first.
2. Make silent-auth `limit=2` and refuse when it gets more than one row.
3. Run Block 4. The Express `/verify/` that needed the old RPC is the reason it
   was deferred; confirm and drop it.

---

## 6. MEDIUM — Admin signing key degrades to a constant when a secret is missing

Both implementations derive the admin token key by concatenating two secrets:

```js
// main.js:228
const ADMIN_TOKEN_KEY = LINE_CHANNEL_SECRET + ":" + SUPABASE_SERVICE_ROLE_KEY
```
```ts
// web/lib/admin/tokens.ts:27-29
return `${serverEnv.lineChannelSecret() ?? ""}:${serverEnv.supabaseServiceRoleKey() ?? ""}`
```

Neither checks that the secrets exist. If `LINE_CHANNEL_SECRET` or
`SUPABASE_SERVICE_ROLE_KEY` is unset, the HMAC key becomes the fully predictable
`"undefined:undefined"` (Express) or `":"` (Next) — and the token body is just
`purpose:exp`, with no nonce and no user identity. **Anyone can then forge an
admin session cookie**, and the admin routes are precisely the ones holding the
RLS-bypassing service-role key (`web/lib/admin/roster.ts:26-34`,
`main.js:1002-1116`).

This is a realistic misconfiguration, not a theoretical one: a preview
deployment, a renamed env var, or a Vercel environment that never got the
secrets set all produce it silently. The `?? ""` in the TypeScript version makes
the degradation deliberate-looking.

Related, same file:

- The login token has no `jti`/nonce, so it is **replayable for its full 10-minute
  window**, not single-use (`main.js:993`, `web/app/admin/login/route.ts`).
- Session tokens last 90 days and **cannot be revoked** without rotating a secret
  that would break the rest of the system — already acknowledged in
  `REACT_REWRITE_PLAN.md` §13 and in the header comment of `tokens.ts:20-23`.

**Fix:** throw at startup (or refuse to sign/verify) when either secret is
absent; add a random `jti` to login tokens and record redemption; shorten the
session to days and add a server-side generation counter so revocation is
possible.

---

## 7. LOW — Middleware forwards a client-supplied `x-p4p-access-token`

`web/middleware.ts:67` seeds the forwarded headers from the incoming request:

```ts
const forwarded = new Headers(request.headers)
```

`TOKEN_HEADER` is then overwritten only on `/verify` (line 127) and on the
`serve` branch for gated pages (line 193). Every other path — `/`,
`/preflight`, anything added later — forwards whatever the client sent under
`x-p4p-access-token` straight through to the Server Component.

No current page outside the three gated ones calls `requireAccessToken`
(`web/lib/server-token.ts:20`), so this is not exploitable today. It is on this
list because the fix is one line and it closes the class:

```ts
const forwarded = new Headers(request.headers)
forwarded.delete(TOKEN_HEADER)   // never trust an inbound value
```

---

## 8. LOW / GOVERNANCE — Physician data sent to a third-party LLM API

`automation/claude-analyst.js` posts physician workload sheet contents (name,
date, score) to the Anthropic Messages API for extraction. That is a reasonable
design, but it means health-staff PII has a **third-party processor** that is
documented nowhere in `SUPABASE_TABLES.md` or `SECURITY_ANALYSIS.md`.

Two concrete items:

- `automation/claude-analyst.js:20-23` honours `ANTHROPIC_BASE_URL`, so the
  destination for that PII is redirectable to an arbitrary host by anyone who
  can set an env var or a GitHub Actions variable. Pin it or drop the override
  in production.
- Add the processor to whatever data inventory exists, with a retention note.
  `MAX_ROW_JSON_CHARS` already caps what is sent — record *what* that is.

---

## 9. What holds up well

Worth stating, because the failures above are all at the edges rather than in
the core design:

- The trust anchor for LINE identity is correct. `verifyLineIdToken`
  (`main.js:370-392`, `web/lib/line/verify.ts`) validates server-side against
  LINE and **fails closed** when `LINE_LOGIN_CHANNEL_ID` is missing; `sub` is
  never taken from the client.
- `/line/bind` establishes both identities server-side and never trusts the
  request body for either (`web/app/line/bind/route.ts:34-52`).
- The admin API surface is uniformly wrapped (`web/lib/admin/handler.ts`), the
  `:table` param is re-validated against the live roster list rather than
  trusted (`roster.ts:76-81`), and the request body is filtered to real non-PK
  columns before any service-role write (`roster.ts:91-101`).
- Admin token comparison is constant-time in both implementations
  (`tokens.ts:50-53`), and the Next.js Telegram webhook fixed the `!==` issue
  flagged as §2h in the companion doc — though it is still a plain `!==`
  (`web/app/telegram/webhook/route.ts:44`) and should use `timingSafeEqual` too.
- The Next.js CSP is genuinely tighter than the Express one — nonce-based, no
  `unsafe-inline` in `script-src`, no CDN origins (`web/middleware.ts:31-51`).
- **No credentials are committed.** A full history scan turned up only the
  Supabase publishable key (intended to be public) and test placeholders.
- `web/` is not yet the deployed app — `vercel.json` still routes everything to
  `main.js` — so findings 6 and 7 are pre-deployment fixes, which is the cheap
  time to make them.

---

## 10. Priority

| # | Action | Effort | Impact |
|---|---|---|---|
| 1 | **Make the repository private.** Removes findings 1–3 immediately while the rest is done properly | XS | **Critical** |
| 2 | Purge `csv_2569_01-04/` from history; shape-based `.gitignore` + CI check | M | **Critical** |
| 3 | Strip the seed `insert` from `dept_heads.sql`; purge from history; warn the 18 heads | S | **High** |
| 4 | Stop uploading un-redacted run logs as artifacts | XS | **High** |
| 5 | `unique index on line_user_bindings (line_user_id)` + `limit=2` guard in silent-auth | XS | **High** |
| 6 | Run Block 4 — drop the client-asserted `bind_line_user_id` | XS | **High** |
| 7 | Fail hard when the admin signing secrets are unset | XS | **High** |
| 8 | Nonce-bind and lifetime-cap silent-auth sessions | M | **Med-High** |
| 9 | PDPA assessment / notification for the disclosed dataset | M | **Med-High** |
| 10 | `forwarded.delete(TOKEN_HEADER)` in middleware | XS | Low |
| 11 | Pin `ANTHROPIC_BASE_URL`; document the processor | XS | Low |

Items 1, 4, 5, 6, 7 and 10 are each a few minutes' work and together close the
two highest-impact findings plus every latent auth issue. Item 2 is the only one
that needs real coordination.
