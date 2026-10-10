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

The email's own send date never *chooses* a month: it says when the mail was
sent, not which month it covers. A December report sent in January would route
a year wrong. Two things to know about how it IS used:

- **Existing behaviour, unchanged:** when a mail names a month but no year
  anywhere (subject, body, filename), the year falls back to the send year
  (`resolveBeYear(…, emailDate)` in `processBuffer`, which reads the host's clock,
  not Bangkok's). A December report sent in January with no year written is
  therefore keyed to the *new* year — the very case the rules below refuse to
  guess for a Latin-month filename. Writing the year in the subject avoids it.
- **Added narrow jobs** (see "Three places the statement is read more
  generously"): to **veto** a year that cannot be what a mail sent on that date
  is reporting — this year's month at or before the send month, or (a
  December-style report sent in January) last year's month after it; last
  September's mail quoted in an October reply is neither — and, for a
  Latin-month filename only, to supply the year when no text gives one, only for
  a month at or before the send month.

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

### Three places the statement is read more generously

Each of these used to refuse a mail that *had* said the month, because the
reader missed it or counted one statement twice. They are pure functions of the
sender's own words and file name (`automation/period-gate.ts`,
`automation/sheet-rescue.ts`); none of them looks at a score or picks a month
the sender did not write, and every one fails closed (back to the refusal above)
when any condition is unmet. **The one place a year can come from the send date
rather than from words is item 2, when nothing anywhere writes a year** — marked
as a guess in the code, and stricter than the rest (see there).

Everything the strict rules above already accept is returned unchanged; only
what they would refuse is read again. Neither reading is attempted for a body
over 50,000 characters, and both run only on workbooks that will really be
processed (Excel's `~$` owner file, which some clients attach, does not make one
workbook look like several). The send date used is the Date header — unless
Gmail's own receive time is more than 3 days away from it, in which case neither
reading is attempted.

1. **The same month, with and without a year, is one period.** `กันยายน` in the
   subject and `กันยายน 2569` in the body names September 2569 once, not two
   periods. Merged only when *all* hold: exactly one year-less and one dated
   mention of that month; the dated one is in the sender's **own** text, not
   quoted history; the year-less side states **no year in any format** (`ก.ย. 69`
   beside `2568` is a conflict, not a repeat); the year is *plausible* for the
   Bangkok **send** date (the rule above); and the sender's own text uses no
   relative-year words (`ปีที่แล้ว`, `ปีกลาย`, `last year`, `a year ago`, `ปีงบ`, `FY`)
   anywhere in what the sender typed — below a quotation too — or correction
   wording (see item 2); and **no year reading of any shape** in the sender's
   own text may differ from the merged year (`ปี 25`, `Q3/25`, `9/25`, `09-25`,
   `'25`, a compact stamp). With **several**
   workbooks**, the one month then applies to every file as a one-period mail
   always did — so every workbook of the message must be known and no file name
   may say anything else about the period: no other month (strict reader, Thai
   substring, or any Latin word that is, extends or misspells a month — `Octo`,
   `Augest`), no numeric month or stamp (`08`, `Q2`, a lone digit, a 3- or
   5+-digit run), no other year in any format, no correction wording;
   otherwise the mail stays `ambiguous_period`.
   "Own text" cuts quoted history in the shapes mail clients produce: `>` lines,
   `On … wrote:` / `ในวัน … เขียน(ไว้)ว่า:` attributions (wrapped over several
   lines, with invisible marks, or ending `wrote ----`), any line with an address
   in `<…>` beside a date or time, Outlook's `____` rule and `From:/จาก:` +
   `Sent:/Subject:` header blocks (with or without an address), `Original
   Message` / `ข้อความต้นฉบับ`, Apple's *Begin forwarded message*, and, for
   HTML-only mail, `gmail_quote` / `yahoo_quoted` / `blockquote` / Outlook reply
   containers. A cut that is wrong can only remove words, so it can only make a
   reading refuse.
2. **A multi-workbook mail may carry each file's month as a Latin word in the
   filename** — `P4P-Intern_sep_<name>.xlsx`. The strict reader needs a word
   boundary and `_` is not one. The fallback applies only when the strict reader
   found nothing, the filename holds exactly one Latin month word, and the mail
   itself named that month exactly once. The year is the file's, else the mail's
   (they must agree); with neither, **the send year** — but only for a month ≤ the
   send month (a `Dec + Jan` mail sent in January stays refused rather than guess
   a year) and only when no year reading exists anywhere **and** neither the mail
   nor the file name talks about years in words (`ปี…`, `year`, `last`, `ago`,
   `ค.ศ.`, `พ.ศ.`, `ปีกลาย`, …) — then the year would be the send date's only by
   assumption. Whatever year is used
   must be plausible for the send date, and **no year reading anywhere may differ
   from it**: any 4-digit BE/CE year, Thai digits, a two-digit year (`68`; in the
   subject and file name `00–42` as well), a two-digit number right after a month
   word (`Sep 25`), a labelled one (`ปี 25`, `year 25`, `'25`, `9/25`, `Q3/25`), `d/m/yy`,
   `FY25`, or a year hidden in a compact date stamp
   (`30092568`, `20250930`, `202509`, `300925`) — in the subject, the *whole*
   body (quoted history included) and the file name. As a consequence a stray
   two-digit number next to a month in the body, or a run of 3 or 5+ digits in a
   file name, makes the answer a refusal. Also refused: a mail whose own text
   corrects, cancels or re-dates something (`ผิด`, `แก้ไข`, `ส่งใหม่`, `not`,
   `ignore`, `replace`, `revised`, `ไม่`, `มิใช่`, `เปลี่ยน`, `อัปเดต`, … — a deliberately wide net) or
   uses relative-year words, judged over everything the sender typed, below a quotation too; the same words in
   any file name of the mail; a month the mail names only as part of a dated day
   (`2 ตุลาคม`, `Oct 2` — usually the send date, not the month being reported); a file name
   that also names a different month in Thai (even glued: `ผลงานกรกฎาคม_aug`); a
   month word that doubles as a given name (`May`, `Jun(e)`, `Jan`, `Mar(ch)`,
   `Apr(il)`) unless `month`/`เดือน` comes right before it (a year beside it is not
   enough); a day-number stamp (`01Sep2569`, `Oct1`, `Sep_5` — the day a file was
   saved); a message whose workbooks are not all known to the processor; and any
   file whose month another non-`~$` workbook of the same mail also resolves to —
   the pipeline saves each file independently and the later write would silently
   replace the earlier (a year taken from the send date collides with a
   same-month sibling of *any* year, and a sibling that writes a different year
   contradicts a guessed one). A sibling the strict reader already accepts is
   scored as always; only the Latin-named file is refused. No send date in the
   mail → refused. `Sept` is read as September.
3. **A report tab beside the hospital template's example tab is one report.**
   The intern template ships `Form-Intern` plus a worked-example tab named
   `Ex-…`, frozen at a fixed period. That used to count as "two tabs, none name
   the month". It is now read as the one report only when the other tab calls
   itself an example **and** states a period of its own, exactly one candidate
   remains, that tab does not name a different month/year anywhere in its name
   or first 120 rows (and is a visible tab that does not itself call itself an
   example) — read permissively: any other month word (Thai by
   substring with spaces ignored — `ก. ค. 68`, `กรกฎา`, `กค68`; any Latin month),
   a month given as a number (`เดือนที่ 7`, `month 7`), a two-digit year after a
   month or a `ปี` label, a quarter or half-year, a numeric date, a year-first
   stamp (`2568-07`, `256807`), a different 4-digit year, a Date cell outside the
   month (text cells, whole numbers that read as a year — 2500–2599, 2020–2035 —
   and a 1–12 on a row labelled `เดือน`/`month` or within two rows below one count;
   other numbers do not; a `30/07` day-and-month with no year vetoes too, and
   misspellings such as `กรกฎคม` are read) — and, the positive
   evidence, the **filename names the target month** (and no other year). A
   silent filename keeps the refusal: "nothing contradicts it" is not the same as
   "it is right", and every reader here has blind spots. This applies to the
   email path only; the LINE upload path asks for the month up front and keeps
   its own check.

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
| One month, multi-sheet workbook, no sheet scores above 0 for it | 1 | `month_not_found` | names the required month and asks for a renamed tab or a single-sheet file |
| Same month stated twice (once without a year), year consistent with the send date | any (with 2+, no file name may say another month) | scored — read as one period | success |
| Two months, each filename carries its month as a Latin word (`…_sep_…`) | 2+ | each scored to its own month — unless another file of the mail resolves to the same month (then the Latin-named file is `ambiguous_period`), or any year signal disagrees | success per file / name each file |
| Report tab + the template's `Ex-…` example tab, filename names the month | 1 | scored from the report tab | success |
| Report tab + `Ex-…` tab, filename silent or naming another month, or the report's own title names another month | 1 | `month_not_found` | as above |

`month_not_found` fires only for multi-sheet workbooks (a single sheet is
always used, whatever it's named — see §3). The reply's "รายละเอียด" row
carries the specific month and sheet-name list from the rejection, not just
the generic per-errorType text.

Pre-existing rejections unchanged by these rules: `temp_file`, `zero_score`,
`physician_not_found`, `wrong_date`, `other`. (`wrong_extension` and `file_link`
are unchanged except in the two cases listed under "Messages with no `.xlsx` at
all".) Separately, **no alert of any type** is sent to an automated no-reply
address — the message is still handled, and the skip is logged.

**Messages with no `.xlsx` at all** (`automation/inbound-triage.ts`) — the two
alerts above (`file_link`, `wrong_extension`) are skipped, and the message is
still marked read/starred/labelled so it is not re-fetched, in two cases only:

- the sender is an **automated no-reply address** (`noreply`, `no-reply`,
  `do-not-reply`, `mailer-daemon`, `postmaster`; a `+noreply` plus-tag is a
  person and is still answered). Google's "spreadsheet shared with you" notice
  came from one. The skip is logged, and the admin Telegram chat gets one line
  (sender, subject) so a submission shared as a link is not lost silently — if
  that line cannot be sent, the message is left unmarked and looked at again next
  run;
- the same sender mailed the real `.xlsx` as **another message of the same run**
  and nothing in the link/PDF message is anything but that file:
  - identical non-empty subject; Date headers within 30 minutes (a message at or
    after the file only as a **bare rendition** within 5 minutes);
  - **every** URL in the message is introduced by the workbook's name, and
    **every** attachment is a **PDF copy** of it — `<name>.xlsx.pdf`, or
    `<name>.pdf` when the name is distinctive (any other extension — `.xls`,
    `.csv`, `.zip` — is a different file, never a copy); a rendition message,
    before or after the file, is bare: no link and at most ~30 characters of its
    own text (a second link — any host — or an unrelated PDF is still answered);
  - the name has a stem of at least 8 characters, is mentioned whole, and — when
    a *link* is what ties the two together — is **distinctive**: more than 4
    letters left after removing generic words (`p4p`, `intern`, `template`,
    `report`, `ไฟล์`, `รายงาน`, hospital and department words, …), month names,
    their abbreviations (dotted or not) and digits. `P4P.xlsx`,
    `template.xlsx`, `P4P ส.ค. 2569.xlsx` (the example name the reply suggests) and
    `Book1.xlsx` are everyone's and prove nothing;
  - neither message uses correction wording (`แก้ไข`, `ผิด`, `ใหม่`, `corrected`,
    `replaced`, `old version`…), read after invisible marks and a doubled sara-e
    are removed;
  - the **subject says which month** it is about (by any reading — Thai or Latin
    word, dotted or glued, `เดือน 9`, `09/2569`): identical subjects prove nothing
    about the file when they name no period; and no month in the link message, by
    any of those readings, that the workbook's message does not also state;
  - **and every workbook of the other message ran to completion** — none
    rejected, replied to with an error, or thrown, and every reply owed to the
    sender (the receipt, or the unknown-physician notice) was actually sent. A
    score saved and confirmed is the usual case. A failed *database* save after
    the Drive upload still sends the receipt, as before, but does not count. The decision is
    taken after the whole run; otherwise the held alert goes out after all. The
    held message is marked handled either way, with one retry — except that an
    alert which could not be *delivered* leaves its message unmarked, to be tried
    again next run, and a marking that fails twice is reported to the admin chat.
    Message order and the 30/5-minute windows use Gmail's own receive time, not
    the sender's Date header.

Not loosened, on purpose: Apple Numbers / PDF / `.xls` attachments (the pipeline
reads OOXML only), fetching Drive links from the body (a new, untrusted-input
feature rather than a relaxed rule), and a link-only message with no matching
workbook, which is still told to attach the file.

All error replies are gated by `SEND_ERROR_REPLIES` in `automation/config.js`.
With it off, physicians get silence and only Telegram sees the rejection.

---

## 3. Which sheet gets scored

Shared by both paths (`parseWorkbookRows` in `lib/p4p-score.js`,
`firstSheetToRows` in `automation/index.js` — same algorithm, two copies kept
honest by `lib/__tests__/parity.test.mjs`).

Each sheet is scored against the target period, best match wins. The tab-name
tier and the content tier are scored **independently and the higher one
wins** — a sheet's name and its content are not read as a single verdict:

| Score | Signal |
|---|---|
| 4 | tab name states the month **and** a matching year |
| 3 | tab name states the month, no year to check |
| 2 | **content** states the month and a matching year |
| 1 | content states the month, no year to check |
| 0 | neither the tab name nor the content states the target month/year |

A tab name that names *some other* month does not veto the sheet: it simply
scores 0 on the name tier, and the content tier is still checked and can
still win (e.g. a stale tab left over from copying last month's file, whose
title row correctly says the new month, scores 2 — the sheet is not thrown
out just because nobody renamed the tab). Tab names still outrank content
*when both agree with the target*, since 3/4 beats 1/2 — a name is a
deliberate label, a title row can itself be a leftover — but a contradicting
name no longer discards the content's answer. Only when **neither** tier
names the target month does the sheet score 0. When nothing scores above 0
the choice falls back to position (sheet 0, or sheet 1 if sheet 0 is
near-empty).

Tab names are read with the same strict reader as cell content
(`monthYearFromText`), so `ก.ค. 2569`, `กรกฎาคม`, `กค69` and `Jul-25` all
match. Reading them against a separate token list is what made a tab named
`ก.ค. 2569` fail to match its own month — that list had no dotted forms, while
the "names some other month" disqualifier used one that did.

Only **one** sheet is ever read. A workbook holding several months contributes
exactly one score per submission.

---

## 4. LIFF path — the file must identify itself

The page asks for the month up front, so sections 1–2 do not apply: a
submission always arrives with an explicit answer. One month per submission is
structural — one chip, one `month_key`, and a unique index on
`(email, month_key)` for anything still in flight.

The chip is the **only** thing that defines the period. What confirms or
contradicts it depends on the workbook's shape:

- **Multiple sheets holding data** — tab names and cell content are read to
  find the one sheet that names the picked month; the filename is not
  consulted at all here, since it would just be the same physician's
  assertion as the chip, made twice.
- **Exactly one sheet holding data** — its tab name and content are *not*
  consulted. A lone sheet's tab/title text is routinely stale: a physician
  reuses last month's file and never renames the tab, so a contradicting or
  silent tab is not evidence either way. The **filename** is the sole signal
  instead — it is what the physician typed *this time* they saved the file,
  which a leftover tab name is not. (Real incident this rule exists for: a
  June submission whose only sheet was still tabbed "พ.ย. 68" from a reused
  November file — the email path scored it fine via the subject line, the
  LIFF path rejected it twice as `month_not_found` because the tab
  contradicted, and renaming the *file* didn't help because the check read
  the tab, not the filename, until this rule changed that for the
  single-sheet case.)

**The rule:** a submission is refused unless the file identifies the picked
month — by tab name or title row for a multi-sheet workbook, by filename for
a single-sheet one. The chip says what the physician meant to send; this is
the file (or its name) saying what they actually sent. Without it a wrong
attachment looks exactly like a right one — a gap now narrower for
single-sheet workbooks than it used to be, since a mislabeled-but-wrong-content
file that merely has the right filename now passes.

| Physician picks | Workbook | Outcome |
|---|---|---|
| July | single sheet, filename says July | scored (sheet content not checked) |
| July | single sheet, filename says nothing about the month | `month_not_found` |
| July | single sheet, filename says June | `month_mismatch` |
| July | multi-sheet, tab named `ก.ค. 2569` / `กรกฎาคม` / `Jul-25` | scored, Flex receipt |
| July | multi-sheet, generic tabs, one title row names July | scored |
| July | multi-sheet, **no** tab/title names July anywhere | `month_not_found` |
| July | multi-sheet, one tab names a different month | `month_mismatch` |
| July | holds June + July sheets | July scored; June needs its own submission |
| July, again, earlier attempt still `pending`/`processing` | any | refused as a duplicate — `ส่งไฟล์เดือนนี้ไปแล้ว กำลังตรวจสอบ` |
| July, again, earlier attempt reached `done`/`failed`/`rejected` | corrected file | **accepted** — a terminal outcome frees the slot, scored fresh (overwrites any prior score; first submission's timestamp still wins for punctuality) |
| July | score not confidently readable | deferred to the worker, result via chat |
| July | name not exactly in roster | deferred to the fuzzy matcher, then scored |

Order matters: the mismatch check runs first, so a file naming a *different*
month gets the precise complaint, and `month_not_found` is reserved for a file
naming no month at all. Both are retryable, so the receipt carries
ส่งไฟล์อีกครั้ง.

Enforced in `main.js`'s `/upload/score` only (`lib/p4p-score.js`'s
`parseWorkbookRowsSafely`) — this single-sheet/filename carve-out is LIFF-only
and does not apply to the email worker's own month check
(`automation/index.js`, gated on `monthKey`), which still reads tab/row
content regardless of sheet count.

**Cost of this rule:** for a multi-sheet workbook, one that does not label its
month anywhere is still refused. For a single-sheet workbook, the burden moved
from "the sheet must say the month" to "the filename must" — a physician who
uploads a correctly-named file no longer needs the tab renamed too, but a
correctly-tabbed file with a generic filename (e.g. one shared to them without
renaming) now needs the filename fixed instead.

### What the physician is told

**Before upload** — inline under the file picker, nothing leaves the phone:

| Trigger | Message |
|---|---|
| not `.xlsx` | รองรับเฉพาะไฟล์ Excel (.xlsx) เท่านั้น |
| `~$…` lock file | ไฟล์นี้เป็นไฟล์ชั่วคราวของ Excel (~$) กรุณาปิดไฟล์แล้วเลือกไฟล์จริง |
| over 5 MB | ไฟล์ใหญ่เกิน 5 MB กรุณาลดขนาดไฟล์ |
| 0 bytes | ไฟล์ว่าง กรุณาเลือกไฟล์ใหม่ |
| renamed non-xlsx | ไฟล์นี้ไม่ใช่ไฟล์ Excel (.xlsx) จริง — อาจถูกเปลี่ยนนามสกุลไฟล์ กรุณาบันทึกใหม่เป็น .xlsx |

**After submit** — result card ส่งไฟล์ไม่สำเร็จ. The banner is the error
type's text; the amber line beneath is the detail, where there is one:

| Error | Banner | Detail |
|---|---|---|
| `month_not_found` | ไม่พบเดือนที่ท่านเลือกในไฟล์นี้ … ระบุเดือนไว้ในชื่อชีตหรือหัวตารางของไฟล์ | ไม่พบเดือน `กรกฎาคม 2569` ในไฟล์นี้ |
| `month_mismatch` | เดือนในไฟล์ไม่ตรงกับเดือนที่เลือกส่ง | ไฟล์ระบุเดือน `2569_06` แต่เลือกส่งเดือน `2569_07` |
| `zero_score` | ไม่พบคะแนนรวมในไฟล์ (คะแนนเป็นศูนย์) | ไม่พบคะแนนรวมในไฟล์ |
| `other` | ระบบไม่สามารถอ่านไฟล์ของท่านได้ | ไฟล์ไม่มีข้อมูล (0 แถว) / ไฟล์มีข้อมูลไม่ครบ (N ช่อง) |
| duplicate | ส่งไฟล์เดือนนี้ไปแล้ว กำลังตรวจสอบ | — |

**From the worker**, for deferred submissions: the same text in a red Flex
bubble, plus `not_in_roster`, `physician_not_found` and `wrong_date`.

Retryable errors carry a ส่งไฟล์อีกครั้ง button back to the page; the rest
(`not_in_roster`, `physician_not_found`, `other`) carry ติดต่อผู้ดูแล instead,
because a retry button on something a retry cannot fix is worse than none.

Two rough edges, both known: `file_link` and `oversize` sit in the shared text
map but are unreachable from LIFF (the picker catches oversize first), and the
duplicate-month message arrives as a raw Postgres string through the page's
generic catch, so it gets no icon, detail line or button.
