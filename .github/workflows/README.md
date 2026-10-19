# Workflows

The number at the front of each name sorts the Actions tab into four groups.
File names are unchanged, so run history, the relay's self-restart
(`gh workflow run line-upload-processing.yml`) and the checks' path filters
keep working.

## 1. Always on

| Name | File | When |
|---|---|---|
| 1. Always on: process LINE uploads and submission emails | `line-upload-processing.yml` | Back to back, each run about 60 min, then it starts the next; cron :05/:25/:45 restarts it if the chain breaks. Reads the Gmail inbox every minute. Disable it here to stop the relay. |

## 2. Scheduled

| Name | File | When (Bangkok time) |
|---|---|---|
| 2.1 Every 2 hours: missing submission report | `3-missing-submission-report.yml` | Every 2 h from 07:17 |
| 2.2 Nightly: build SK03 files and notify department heads | `2-build-files-and-notify-heads.yml` | Daily ~00:37 |
| 2.3 Daily: keep database awake | `daily-database-keep-alive.yml` | Daily 07:00 |
| 2.4 Monthly: create next month's roster table | `monthly-new-roster-table.yml` | 1st of month 01:00 |
| 2.5 Monthly: update LINE menu month picker | `monthly-line-menu-month-update.yml` | 1st of month 06:00 |
| 2.6 Monthly: eligible physician list (PDF) | `monthly-eligible-physician-list.yml` | 1st of month 09:00 |
| 2.7 Yearly: create Drive year folders | `yearly-create-drive-folders.yml` | 1 January 07:00 |

## 3. Manual (Run workflow button)

| Name | File | Use it to |
|---|---|---|
| 3.1 Manual · Email: read submission emails (backup) | `1-read-submission-emails.yml` | Read the inbox once if the always-on run is stopped |
| 3.2 Manual · Email: resend a month's emails | `manual-resend-month.yml` | Resend department-head emails for chosen months |
| 3.3 Manual · Email: unstar old P4P document emails | `manual-unstar-old-emails.yml` | Clear stars on old เอกสาร P4P mail |
| 3.4 Manual · LINE: set up LINE menu | `manual-setup-line-menu.yml` | Push the rich menu after a menu change is merged |
| 3.5 Manual · LINE: send feature carousel | `manual-send-line-carousel.yml` | Send (or test-send) the LINE feature carousel |
| 3.6 Manual · Drive: verify copies against emails | `manual-verify-drive-copies.yml` | Read-only check of Drive copies |
| 3.7 Manual · Drive: repair blank copies | `manual-repair-drive-copies.yml` | Fix Drive copies that open blank in Excel |
| 3.8 Manual · Drive: restore copies from emails | `manual-restore-drive-copies.yml` | Rebuild Drive copies from the emailed originals |

## 4. Checks (run on PRs and pushes)

| Name | File |
|---|---|
| 4.1 Check: no personal data committed | `check-no-personal-data.yml` |
| 4.2 Check: root tests | `check-root-tests.yml` |
| 4.3 Check: automation tests | `check-automation-tests.yml` |
| 4.4 Check: web tests | `check-web-tests.yml` |

When adding a workflow, give it the next number in its group.
