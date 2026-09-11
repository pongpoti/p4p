# Going private — cutover checklist

> **Superseded in part (2026-09).** This is the going-*private* runbook, kept
> for its reasoning and for step 5 (the aggregate Drive folders), which is
> still outstanding and is independent of repo visibility. If you are going the
> other way, read [`GOING_PUBLIC.md`](GOING_PUBLIC.md) — in particular, step 6
> below says a history rewrite "stops being urgent" once private, and that is
> exactly the assumption that stops holding when the repo goes public again.


Ordered runbook for switching `SKH-MSO/p4p` from public to private, plus what
that switch does and does not fix.

Companion to [`DATA_EXPOSURE_ANALYSIS.md`](DATA_EXPOSURE_ANALYSIS.md).

---

## What going private actually fixes

Going private closes **discovery through GitHub** in one move, with no history
rewrite needed:

| Exposure | Closed by going private? |
|---|---|
| 773 rows of physician name + department + score in git history | ✅ |
| 18 department heads' personal addresses in git history | ✅ |
| Two Drive folder ids readable in `process/*.js` and in history | ✅ |
| Actions job logs printing physician names (public on a public repo) | ✅ |
| **Drive folders shared `anyone` with the link** | ❌ **no** |

That last row is the one to keep in view. Repo visibility and Drive sharing are
unrelated systems. The monthly report emails already carry links into the Drive
tree, so those links exist in inboxes regardless of who can read the repo.

**Accepted risk (owner's decision, 2026-08):** department heads are trusted not
to forward report emails outside the hospital, so the per-physician file tree
stays shared-by-link for now. This is a deliberate acceptance, not an oversight
— it is recorded here so the next person to read this does not treat it as a
finding.

The two **aggregate** folders are a different case and are not covered by that
acceptance: their ids were published in a public repository for weeks, so the
population that may hold those links is not "department heads" but "anyone who
read the repo". Those should be locked regardless. See step 5.

---

## Order matters

Going private **breaks deployment** unless step 1 is done first. Vercel's Hobby
plan will not deploy a private repository owned by a GitHub organisation, and
its collaboration rule rejects deploys whose commit author is not the single
allowed account — and most commits here are authored by `Claude`.

Do not flip the switch before step 1 is verified working.

---

## 1. Rework deployment — BEFORE going private

Pick one:

- **GitHub Actions + `VERCEL_TOKEN`.** Add a workflow that runs the Vercel CLI
  on push to `main`. Bypasses the Git integration entirely, so repo visibility
  and commit authorship stop mattering. Free.
- **Vercel Pro.** Lifts both restrictions directly. Paid per seat.

Verify a real deploy lands from a push to `main` **while still public**. If it
does not work public, it will not work private.

## 2. Add the two new GitHub secrets

The pipeline now refuses to run without these rather than defaulting:

| Secret | Used by | Value |
|---|---|---|
| `P4P_REPORT_FOLDER_ID` | `process/report.js` | folder holding the outstanding-submissions list |
| `P4P_ELIGIBLE_FOLDER_ID` | `process/eligible-list.js` | folder holding the monthly eligible PDF |

Both ids are in this repository's git history if you need to recover them —
`git log -S'reportFolderId' -p` and the equivalent for `folderId`.

Confirm `OVERSIGHT_EMAIL` is still set from the earlier change, or the
all-departments summary email is skipped with a warning.

## 3. Flip the repository to private

Settings → General → Danger Zone → Change visibility.

## 4. Verify nothing silently broke

- [ ] a push to `main` still deploys
- [ ] `Process report` workflow completes and writes to the right folder
- [ ] `Eligible list` workflow completes
- [ ] `p4p-cron` still processes submissions
- [ ] the monthly score-report email still sends, including the oversight copy

The pipeline runs on cron, so a break may not surface for hours. Trigger the
workflows manually rather than waiting.

## 5. Lock the two aggregate Drive folders

Independent of the repo, and **not covered by the trusted-heads acceptance**,
because their addresses were public rather than emailed:

- outstanding-submissions folder (`P4P_REPORT_FOLDER_ID`)
- eligible-PDF folder (`P4P_ELIGIBLE_FOLDER_ID`)

Change each from *Anyone with the link* to *Restricted* in the Drive share
dialog. Check first that nobody circulates those two links directly — if the
eligible PDF gets passed around by URL, that stops working.

`automation/scripts/fix-drive-sharing.mjs` can do this for the whole tree, but
for two folders the share dialog is faster and easier to reason about.

## 6. Optional, once private

- **History rewrite** stops being urgent. A private repo's history is not
  readable by outsiders, and a folder id for a restricted folder is worthless.
  Still worth doing before the repo is ever made public again.
- **Re-enable Actions log artifacts** if you want them back — job logs are no
  longer world-readable. The name-redaction question in `automation/index.js`
  becomes a preference rather than an exposure.

---

## What stays open after all of this

- The per-physician Drive tree remains link-shared (accepted risk, above).
- No read logging anywhere: there is still no record of who opened which file.
- The admin session cookie is valid 90 days and cannot be revoked without
  rotating a secret that breaks other things.
- Supabase is the single copy of the roster data — confirm backups/PITR.
