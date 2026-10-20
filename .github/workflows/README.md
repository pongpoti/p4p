# Workflows

The number at the front of each name sorts the Actions tab into four groups,
and each file name starts with the same number (`3.4 …` lives in `3-4-….yml`).
When renaming a file, update every reference to it: the relay starts its next
run by file name (`gh workflow run 1-always-on-process-line-uploads-and-emails.yml`)
the checks list their own file in their path filters, and 1.2 lists the
group 1-2 workflows it watches by their name.

## 1. Always on

| Name | File | When |
|---|---|---|
| 1. Always on: process LINE uploads and submission emails | `1-always-on-process-line-uploads-and-emails.yml` | Back to back, each run about 60 min, then it starts the next; cron :05/:25/:45 restarts it if the chain breaks. Reads the Gmail inbox every minute. Disable it here to stop the relay. |
| 1.2 Always on: alert when a scheduled run fails | `1-2-always-on-alert-failed-runs.yml` | Starts by itself whenever a group 1 or 2 run finishes and sends a Telegram alert if it failed or timed out (cancelled runs are normal for the relays and ignored). At :15/:45 it also checks that 1 and 2.1 still have a run going and alerts if either has been stopped for 45 minutes. It watches workflows by name, so add a renamed or new group 1-2 workflow to its list. |

## 2. Scheduled

| Name | File | When (Bangkok time) |
|---|---|---|
| 2.1 Every minute: missing submission report | `2-1-every-minute-missing-submission-report.yml` | Every minute, in ~58-minute runs that start the next one themselves (cron :10/:30/:50 restarts the chain if it breaks). Updates the Excel and PNGs in the report Drive folder; sends nothing. |
| 2.2 Nightly: build SK03 files and notify department heads | `2-2-nightly-build-sk03-and-notify-heads.yml` | Daily ~00:37 |
| 2.3 Daily: keep database awake | `2-3-daily-keep-database-awake.yml` | Daily 07:00 |
| 2.4 Monthly: create next month's roster table | `2-4-monthly-create-roster-table.yml` | 1st of month 01:00 |
| 2.5 Monthly: update LINE menu month picker | `2-5-monthly-update-line-menu-month.yml` | 1st of month 06:00 |
| 2.6 Monthly: eligible physician list (PDF) | `2-6-monthly-eligible-physician-list.yml` | 1st of month 09:00 |
| 2.7 Yearly: create Drive year folders | `2-7-yearly-create-drive-folders.yml` | 1 January 07:00 |

## 3. Manual (Run workflow button)

| Name | File | Use it to |
|---|---|---|
| 3.1 Manual · Email: read submission emails (backup) | `3-1-manual-email-read-submission-emails.yml` | Read the inbox once if the always-on run is stopped |
| 3.2 Manual · Email: resend a month's emails | `3-2-manual-email-resend-month.yml` | Resend department-head emails for chosen months |
| 3.3 Manual · Email: unstar old P4P document emails | `3-3-manual-email-unstar-old-emails.yml` | Clear stars on old เอกสาร P4P mail |
| 3.4 Manual · LINE: set up LINE menu | `3-4-manual-line-setup-menu.yml` | Push the rich menu after a menu change is merged |
| 3.5 Manual · LINE: send feature carousel | `3-5-manual-line-send-carousel.yml` | Send (or test-send) the LINE feature carousel |
| 3.6 Manual · Drive: verify copies against emails | `3-6-manual-drive-verify-copies.yml` | Read-only check of Drive copies |
| 3.7 Manual · Drive: repair blank copies | `3-7-manual-drive-repair-copies.yml` | Fix Drive copies that open blank in Excel |
| 3.8 Manual · Drive: restore copies from emails | `3-8-manual-drive-restore-copies.yml` | Rebuild Drive copies from the emailed originals |

## 4. Checks (run on PRs and pushes)

| Name | File |
|---|---|
| 4.1 Check: no personal data committed | `4-1-check-no-personal-data.yml` |
| 4.2 Check: root tests | `4-2-check-root-tests.yml` |
| 4.3 Check: automation tests | `4-3-check-automation-tests.yml` |
| 4.4 Check: web tests | `4-4-check-web-tests.yml` |

When adding a workflow, give it the next number in its group.
