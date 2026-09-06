# How a submission's month is decided, and when it is refused

Two ways in — an emailed attachment and the LIFF `/upload/` page — and both
have to answer the same question before a score can be written: **which month
is this file for?**

Getting it wrong is expensive and quiet. A score filed under the wrong month
looks perfectly normal in every table it touches; nobody notices until a
physician queries their pay. So both paths are built to **refuse rather than
guess**, and neither is allowed to infer the period from the workbook alone.

Sections 1–3 are settled. Section 4 (LIFF) is current behaviour, not
necessarily final.

---

## 1. Email path — the period must be stated

A submission has to *say* which month it is for. Sheet contents are never
enough on their own: a physician who keeps every month in one workbook has no
way of telling us which of them a send is about, and guessing on their behalf
is how one month's work gets filed as another's.

**Order of authority** (`statedPeriods`, `automation/claude-analyst.js`):

1. What the sender wrote — **subject and body**, pooled
2. The **filename**, consulted only when the mail itself says nothing

The email's own send date is never used for routing: it says when the mail was
sent, not which month it covers. A December report sent in January would route
a year wrong. It remains a last resort for *sheet selection* only, where a
wrong guess costs a harmless fallback.

### The three gates

| Stated periods | Workbooks | Result |
|---|---|---|
| none | any | **rejected** — `no_period` |
| one | any | proceed with that period |
| more than one | 1 | **rejected** — `ambiguous_period` |
| more than one | 2+ | proceed **only** where each file names its own period in its own filename; otherwise `ambiguous_period` |

In the multi-workbook case a file is matched to a period **by its own
filename**. That is the only per-file signal available — matching by opening
the workbook is exactly the guess these rules exist to prevent.

### Reading the statement conservatively

This value is what a submission is routed on and refused against, so it is read
more strictly than a mere hint would be:

- **Month** via `monthFromCellText`, not `resolveBeMonth`. An email body is
  running Thai just like a spreadsheet cell, and `รวมคะแนน` contains `มค` —
  matching that as January would reject a correct July file.
- **Year** 4-digit only. `resolveBeYear`'s two-digit tier reads any standalone
  43–99 as a year, so `ส่งคะแนน 85 แต้ม` becomes 2585. Two-digit years still
  work for sheet selection, where being wrong only costs a fallback.
- Each month keeps **the year written beside it** (`periodsInText`). Read
  flatly, `ธ.ค. 2568 และ ม.ค. 2569` resolves to January 2568 — a period the
  sender never wrote.

### Cross-check against the file

The stated period outranks Claude's reading of the sheet. Where they disagree,
**neither is written** — rejected as `month_mismatch`. Sheet selection already
targets the stated period, so a disagreement means no sheet matched and the
positional fallback holds some other month. Only a component that actually
resolved is compared; an unstated year is not a disagreement.

---

## 2. Email path — outcomes and the reply each sends

| Email / filename states | Files | Outcome | Reply |
|---|---|---|---|
| One month, file agrees | 1 | scored | success: name, เดือน/ปี, คะแนนรวม |
| Month only in the filename | 1 | scored | success |
| One month, file is a different month | 1 | `month_mismatch` | names **both** months and both fixes |
| One month, no sheet matches it | 1 | `month_mismatch` | as above |
| Nothing anywhere | any | `no_period` | how to state the month, with an example |
| Two months | 1 | `ambiguous_period` | send one month per email |
| Two months, generic filenames | 2+ | `ambiguous_period` | name each file |
| Two months, each filename names its month | 2+ | each scored to its own month | success per file |

Pre-existing rejections unchanged by these rules: `wrong_extension`,
`temp_file`, `file_link`, `zero_score`, `physician_not_found`, `wrong_date`,
`other`.

All error replies are gated by `SEND_ERROR_REPLIES` in `automation/config.js`.
With it off, physicians get silence and only Telegram sees the rejection.

---

## 3. Which sheet gets scored

Shared by both paths (`parseWorkbookRows` in `lib/p4p-score.js`,
`firstSheetToRows` in `automation/index.js` — same algorithm, two copies kept
honest by `lib/__tests__/parity.test.mjs`).

Each sheet is scored against the target period, best match wins:

| Score | Signal |
|---|---|
| 4 | tab name states the month **and** a matching year |
| 3 | tab name states the month, no year to check |
| 2 | **content** states the month and a matching year |
| 1 | content states the month, no year to check |
| 0 | states nothing, or **contradicts** the target |

A contradicting sheet scores 0 rather than ranking last: a sheet that says it
is some other month is the wrong answer, not a weak match. When nothing scores
above 0 the choice falls back to position (sheet 0, or sheet 1 if sheet 0 is
near-empty) and the `month_mismatch` check is what catches it.

Only **one** sheet is ever read. A workbook holding several months contributes
exactly one score per submission.

---

## 4. LIFF path — current behaviour

The page asks for the month up front, so a submission always arrives with an
explicit answer and sections 1–2 do not apply. One month per submission is
structural: one chip, one `month_key`, and a unique index on
`(email, month_key)` for anything still in flight.

| Physician picks | Workbook | Outcome |
|---|---|---|
| July | single sheet, July | scored, Flex receipt |
| July | multi-sheet, tabs named by month | July tab scored |
| July | multi-sheet, generic tabs, title rows name months | July sheet scored |
| July | multi-sheet, **nothing names any month** | sheet 1 scored as July — nothing can detect a mistake |
| July | file is June, and says so | `month_mismatch`, nothing saved |
| July | holds June + July | July scored; June needs its own submission |
| July, again | any | refused — one in-flight submission per month |
| July | score not confidently readable | deferred to the worker, result via chat |
| July | name not exactly in roster | deferred to the fuzzy matcher, then scored |

**Known gap:** row 4. When no tab name, no filename and no cell states a
period, there is nothing to compare the physician's choice against, so a
wrong-sheet pick is undetectable. This is the one shape none of the current
rules improve.
