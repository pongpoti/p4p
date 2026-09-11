# Going public — cutover checklist

Runbook for switching `pongpoti/p4p` from private back to public, and what
that switch does and does not cost.

Reverses [`GOING_PRIVATE.md`](GOING_PRIVATE.md). Read the "What this does not
fix" section before flipping anything.

---

## Why this is being considered

GitHub Actions minutes are free and unmetered on a public repository and
metered on a private one. In September 2026 the account exhausted its 2,000
included minutes and every scheduled workflow stopped with *"The job was not
started because recent account payments have failed or your spending limit
needs to be increased"* — 19 consecutive failures across five workflows.

`upload-drain.yml` was 84% of that consumption: it long-polls for a full
60 minutes per run, hourly. **Going public makes the bill disappear without
making that job cheaper.** If the polling design is fixed instead, the whole
pipeline fits inside the free private allowance (measured: 1,328 min/month
before that job existed, against an allowance of 2,000). Going public is a
real option; it is not the only one, and it is the one with a privacy cost.

---

## What was verified before this document was written

The findings in [`DATA_EXPOSURE_ANALYSIS.md`](DATA_EXPOSURE_ANALYSIS.md) were
written against the **previous repository** (`SKH-MSO/p4p`). This repository
was started fresh on 2026-08-19 and has 59 commits. Its history was scanned
independently:

| Checked across all 59 commits and all branches | Result |
|---|---|
| `csv_2569_01-04/*.csv` — 773 rows of name + department + score | **absent** — no `.csv` was ever committed here |
| Roster data in any form (Thai name-shaped rows) | **absent** |
| 18 department heads' personal addresses | **absent** — `dept_heads.sql` carries no real address |
| Google Drive folder ids | **absent** — all read from secrets |
| API keys / tokens / Supabase keys | **absent** |

So the CRITICAL and HIGH findings that motivated going private **do not exist
in this repository's history**. That is the reason this is a defensible
decision rather than a reckless one.

---

## What was fixed to make the flip safe

### 1. Job logs no longer print physician names

This was the live blocker. On a public repo, workflow run logs are readable by
anyone with no login. `automation/` printed physician full names on the happy
path and sender addresses on the relay path — 48 log sites across 12 files,
published every two hours by cron.

`automation/redact.js` (ESM) and `process/redact.js` (CJS) patch `console` at
process start and scrub Thai-script runs and email addresses out of anything
logged. Redaction is *salted-pseudonymous*, not blanket `[REDACTED]`: a name
becomes `«ชื่อ#a3f9»`, stable within one run so log lines about the same
physician still correlate, and worthless outside it because the salt is random
per process and never logged.

Patching the sink rather than the 48 call sites is deliberate — a call-site
list is a denylist, and the next log line added leaks again.

Guarded by three tests in `automation/test/`:

- `redact.test.js` — masking behaviour, including that non-personal output is
  left byte-identical.
- `redactParity.test.js` — the ESM and CJS copies agree, **and** every entry
  point a workflow actually runs imports the module. Verified to fail when an
  entry point drops it.
- the same file asserts the exempt root `scripts/` (LINE card/menu tooling)
  still log no names or addresses.

### 2. The project's own mailboxes are out of the source

`SKIP_SENDERS` and `THREAD_RELAY_SENDERS` were hardcoded defaults in
`automation/config.js`; `BOT_ADDRESSES` was hardcoded in
`scripts/backfill-submissions.mjs`; `send-test-email.mjs` defaulted
`TEST_EMAIL` to a real inbox; `drive-client.js` and `index.js` named one in
comments. All now read from env with no fallback.

`SKIP_SENDERS` is **required** (`env-check.js`) rather than optional: an empty
skip-list makes the pipeline process and reply to its own automated mail.

### 3. The PII guard got stricter and harder to bypass

- It ran only on `pull_request`, so a direct push to `main` — the path an
  urgent fix takes — skipped it entirely. It now runs on push to `main` too.
- Its consumer-domain email rule allowlisted the project's two accounts, which
  put both addresses in the workflow file in plaintext *and* meant
  re-introducing them could never be caught. The allowlist is gone; fixtures
  and docs use `example.com`.

---

## Order matters

### Before flipping — required, or the pipeline breaks

1. **Add two repository secrets.** `SKIP_SENDERS` (comma-separated; the bot's
   own addresses) and `THREAD_RELAY_SENDERS` (the subset whose mail is
   thread-searched). `p4p-cron.yml` already passes both through.
   `index.js` now refuses to start without `SKIP_SENDERS`.
   The previous values are recoverable from history until a rewrite:
   `git log -S'SKIP_SENDERS' -p -- automation/config.js`.
2. **Add `BOT_ADDRESSES`** if `backfill-submissions.yml` is ever run — it exits
   with a clear message otherwise. Manual workflow, so not urgent.
3. **Trigger `p4p-cron.yml` manually and read the log.** Confirm it completes
   and that physician names appear as `«ชื่อ#…»`, not in the clear. This is
   the one check that cannot be skipped — do it *while still private*, where
   a mistake is not yet public.

### Decide before flipping — not fixed, by design

4. **Two operator mailboxes remain in git history.** `p4pskh@gmail.com` and
   `sakhonmso@gmail.com` appear in 6 files across the 59 commits
   (`automation/config.js`, `.env.example`, `drive-client.js`, `index.js`,
   `scripts/backfill-submissions.mjs`, `scripts/send-test-email.mjs`).
   Removing them at HEAD does not remove them from history.

   These are the owner's own accounts, not third-party personal data, and
   `p4pskh` is already inferable from the public deployment hostname
   `p4p-p4pskh.vercel.app`. `sakhonmso` is not inferable.

   To scrub rather than accept — 59 commits, so this is cheap:

   ```sh
   # one line per address, then:
   git filter-repo --replace-text replacements.txt
   git push --force-with-lease origin main
   ```

   Force-pushing `main` invalidates every existing clone and open PR. Do it
   before going public, not after, or the old objects stay fetchable.

5. **`scripts/send-test-flex.mjs` logs a LINE userId** (`✓ sent … to <userId>`).
   It is `workflow_dispatch`-only and normally run with your own id, but that
   log line becomes public. Mask it or leave it — a deliberate call either way.

### After flipping

6. **Verify the scheduled workflows run and are free.** Billing should show no
   Actions consumption for this repo.
7. **Re-check the two aggregate Drive folders are `Restricted`**
   (`GOING_PRIVATE.md` step 5). Their ids are no longer in the repo, but if
   either was left `Anyone with the link` the link is only as private as
   everyone who ever held it.

---

## What going public does not fix, and what it re-opens

- **Drive link-sharing is unchanged.** Repo visibility and Drive sharing are
  unrelated systems; the per-physician tree stays shared-by-link under the
  accepted risk recorded in `GOING_PRIVATE.md`. Going public does not widen
  it — but it also does not narrow it, and the aggregate folders matter more
  once anyone can read the repo again.
- **Actions log artifacts must stay disabled.** `p4p-cron.yml` and
  `process-report.yml` both carry a comment explaining that artifact uploads
  were removed because artifacts on a public repo are downloadable by anyone.
  The log redaction above does not change that: do not re-enable them.
- **Anything added later is only as safe as the guard.** `pii-guard.yml` and
  the redaction tests are the backstop. Neither can catch a roster pasted into
  a Markdown file under 20 rows, or a name logged by a service that does not
  import `redact.js`.

---

## If the goal is only the bill

Fixing `upload-drain.yml` instead keeps the repo private and costs nothing:
replace the 60-minute long poll with a LINE webhook into the Vercel app that
already serves the LIFF pages, or drop `DRAIN_MINUTES` and accept queue
latency. Measured burn without that job is 1,328 min/month against a
2,000-minute allowance. The two paths are independent — doing this one does
not require the flip, and the flip does not make this job any less wasteful.
