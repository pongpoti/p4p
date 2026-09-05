# Uploading a P4P scorecard through the LINE rich menu

**Status:** design proposal, nothing built. Written against the code as it stands
on `main` (Express `main.js` in production, `web/` not deployed).

A physician's only way to submit a monthly P4P scorecard today is to email the
`.xlsx` to the P4P mailbox and wait for the automation to notice it. This
document designs a second, equal path: a **"ส่งไฟล์ P4P" block on the LINE rich
menu** that opens a LIFF upload page, takes the file, and puts it through the
*same* pipeline the email path uses.

The email path is not deprecated and nothing about it changes behaviourally.
Physicians who prefer email keep emailing.

---

## 1. What the physician sees

```
LINE rich menu
└── ส่งไฟล์ P4P  ──▶  /upload/  (LIFF)
                      ├── "คุณ: นพ. สมชาย ใจดี — อายุรกรรม"        ← identity, resolved, not typed
                      ├── เดือนที่ส่ง: [มิ.ย. 69 ▾]  กำหนดส่ง 10 ก.ค.  ← month, picked, not guessed
                      ├── [ เลือกไฟล์ .xlsx ]                        ← LINE's own file picker
                      ├── [ ส่งไฟล์ ]
                      └── "รับไฟล์แล้ว กำลังตรวจสอบ — จะแจ้งผลทาง LINE"
                                    │
                                    ▼  (≤ ~10–30 min, §7)
                      LINE push: "✅ บันทึกคะแนนเดือนมิถุนายน 2569 แล้ว: 1,842.50"
                                 หรือ  "❌ ไฟล์ไม่ถูกต้อง: <เหตุผล> กรุณาส่งใหม่"
```

Three things are *known* on this path that are *guessed* on the email path —
who is submitting, which month, and whether the sender is a real physician.
That is where most of the value is; see §8.

---

## 2. Constraints that shape the design

These are not preferences. Each one rules out an otherwise-obvious approach.

| # | Constraint | Consequence |
|---|---|---|
| **C1** | Production is `main.js` (Express) deployed from the repo root. `web/` (Next.js) is written but **not deployed** — `web/README.md`. | The page ships in the Express app. A `web/app/upload/` port is a follow-up, not the delivery vehicle. |
| **C2** | `ANTHROPIC_API_KEY`, `GOOGLE_REFRESH_TOKEN`, `P4P_FOLDER_ID` are **GitHub Actions secrets**. Vercel holds only LINE credentials + the Supabase service-role key (`.env.example`). | The web tier **cannot** score a workbook or write to Drive. Processing has to happen where those secrets already are. |
| **C3** | Vercel serverless: ~4.5 MB request body cap, short execution budget. The per-file work (parse → Claude → Drive) routinely takes tens of seconds. | Don't push file bytes through Vercel, and don't process inline in the request. |
| **C4** | On roster tables `YYYY_MM`, `authenticated` may `SELECT` only `firstname, lastname, department, submitted_at` (`provision-month-function.sql` step 7). Not `index`, not `score`. | The browser can never resolve a roster row or write a score. Every such step is `SECURITY DEFINER` or `service_role`. |
| **C5** | A LIFF launch can get **fresh, non-persistent webview storage** — the session cookie is not guaranteed to survive (`REACT_REWRITE_PLAN.md` §"Carry forward: silent LINE reauth"). | The new page must be a registered LIFF app behind the same `/verify/` bounce as `/status/`, `/list/`, `/ranking/`. It cannot be a plain `uri` to an https URL. |
| **C6** | CSP has **no `unsafe-inline`** on `script-src`; `connect-src` already allows `https://*.supabase.co` (`main.js`). | Page JS is an external `upload/app.js`. A browser → Supabase Storage upload needs **no CSP change at all**. |
| **C7** | `pg_net` + Supabase Vault is an established pattern here (`notify-access-request.sql`, `liff-access-alert-2026-08.sql`). | A DB trigger making an outbound HTTP call is idiomatic in this codebase, not a novelty. |
| **C8** | `automation/` and `process/` are deliberately isolated sub-projects with their own `package.json`; the root one is what Vercel builds. | Adding `exceljs`/`googleapis`/`@anthropic-ai/sdk` to the root `package.json` would change how production is built. Don't. |

C2 + C3 + C8 together are the whole argument for the queue in §3: the tier that
can *accept* a file and the tier that can *process* one are, today, different
machines with different secrets — and that separation is worth keeping.

---

## 3. Architecture — a store-and-forward queue

```
 ┌─ BROWSER (LINE webview, LIFF app #5) ──────────────────────────────────┐
 │                                                                        │
 │  1. GET /upload/                                                       │
 │     main.js servePage("upload") → cookie → access token in <meta>      │
 │     (no session → 302 /verify/?return=/upload/ → silent LINE reauth)   │
 │                                                                        │
 │  2. PUT  <project>.supabase.co/storage/v1/object/p4p-uploads/…         │
 │     supabase-js, USER's JWT, RLS: own folder only, write-only bucket   │
 │                                       ── file bytes never touch Vercel │
 │  3. RPC  enqueue_p4p_upload(object_path, month_key, filename, size)    │
 │     → validates, resolves identity, inserts p4p_upload_queue row       │
 │     ← { queue_id, roster_match, deadline, is_late }                    │
 └────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
 ┌─ SUPABASE ─────────────────────────────────────────────────────────────┐
 │  storage: p4p-uploads (private, 5 MB cap, xlsx-only, insert-only)      │
 │  table  : p4p_upload_queue  (pending → processing → done | failed)     │
 └────────────────────────────────────────────────────────────────────────┘
                                    │  polled every 10 min
                                    ▼
 ┌─ GITHUB ACTIONS — automation/ (where the secrets already live) ────────┐
 │  4. claim_p4p_upload()          FOR UPDATE SKIP LOCKED                 │
 │  5. download object (service_role)                                     │
 │  6. processBuffer(buffer, { source:"line-upload", identity, monthKey })│
 │        firstSheetToRows → analyseJson → (identity known: no fuzzy)     │
 │        → extractFirstSheetBuffer → drive.uploadFile → saveScore        │
 │        → logSubmission                                                 │
 │  7. mark done/failed · LINE push to the physician · Telegram on error  │
 │  8. delete the storage object                                          │
 └────────────────────────────────────────────────────────────────────────┘
```

Properties worth naming, because each one is a decision:

- **No new secret in Vercel, no new dependency in the root `package.json`.**
  The Express app gains one gated page and one static mount. That is all.
- **File bytes go browser → Supabase directly.** C3's 4.5 MB body cap and the
  function timeout stop being relevant instead of being worked around.
- **One pipeline, not two.** `processBuffer()` gains parameters; it is not
  forked. `automation/excel-parse.js`'s own header documents what happened last
  time this logic was copy-pasted — a fix in one copy had no way to reach the
  other. That mistake is not worth repeating at a larger scale.
- **The queue is the durability boundary.** Once the row exists the submission
  is safe: the workflow can fail, the runner can die, Drive can be down, and
  the file is still there with `received_at` recorded.

---

## 4. The rich menu

### 4.1 Layout

Current main menu is `2500×843`, three blocks of `833×843`
(`scripts/setup-richmenu.mjs`, `src/richmenu.svg`).

**Recommendation: move to `2500×1686` (LINE's "large" size), two rows.**

```
┌───────────────┬───────────────┬───────────────┐
│  สถานะการส่ง   │    อันดับ      │   รายชื่อ      │   ← unchanged: 833×843 each,
│  (month pick) │   (ranking)   │    (list)     │      same positions, same art
├───────────────┴───────────────┴───────────────┤
│              ส่งไฟล์ P4P                       │   ← new: 2500×843, full width
└───────────────────────────────────────────────┘
```

Why this over squeezing a fourth column into `2500×843`:

- The three existing blocks keep their **exact positions and sizes**. Nobody
  re-learns the menu they use every month; the SVG edit is additive rather than
  a re-layout of all three.
- Upload is the only block that *writes*. It earns a distinct, unmissable
  target rather than a quarter-width one competing with three read-only pages.
- The month-picker submenu is already `2500×1686`, so the taller menu is a
  shape these users have seen.

Cost: the open menu covers more of the chat. This bot's chat carries three
commands (`status`, `myid`, `admin`) and no conversation, so that is cheap
here. If it isn't acceptable, the alternative is four `625×843` columns — same
design everywhere else in this document, only §4.2's `bounds` change.

### 4.2 Script changes

`scripts/setup-richmenu.mjs`, `mainPayload`:

```js
size: { width: 2500, height: 1686 },
areas: [
  { bounds: { x:    0, y:   0, width: 833, height: 843 },
    action: { type: 'richmenuswitch', richMenuAliasId: 'month-picker', data: 'open_month_picker' } },
  { bounds: { x:  833, y:   0, width: 834, height: 843 },
    action: { type: 'uri', uri: 'https://liff.line.me/2008561527-BXrxUUDb' } },   // ranking
  { bounds: { x: 1667, y:   0, width: 833, height: 843 },
    action: { type: 'uri', uri: 'https://liff.line.me/2008561527-wyje9amz' } },   // list
  { bounds: { x:    0, y: 843, width: 2500, height: 843 },
    action: { type: 'uri', uri: 'https://liff.line.me/<UPLOAD_LIFF_ID>' } },      // NEW
],
```

`src/richmenu.svg`: `viewBox="0 0 2500 1686"`, a fourth full-width block, and a
fourth gradient alongside `copper` / `gold` / `sage`. Use the design-system
primary `#A68966` on `#4B3D33` (`design.md`) so the new block reads as part of
the same family without being mistaken for one of the three read-only ones.

### 4.3 Operational notes

- `setup-richmenu.mjs` **recreates both menus and re-sets the default for all
  users**. It is the only script that touches the main menu — the monthly
  `update-month-picker.yml` job regenerates the picker only, so the new block
  survives every month-boundary run untouched.
- Run it *last* (§13, Phase 4). The button is a global, all-users switch; it
  should not appear until everything behind it works.
- It needs `LINE_TOKEN` locally; it is not wired to a workflow today. Keep it
  that way — a rich-menu rebuild is a deliberate act.

---

## 5. The `/upload/` page

### 5.1 Wiring (deliberately boring — it reuses the existing gate)

```
main.js:  const gatedPages = ["status", "list", "ranking", "upload"]
          app.use("/upload", express.static("upload"))
vercel.json:  includeFiles += "upload/**"
new files:    upload/index.html   upload/app.js
```

That is the entire server-side change. `servePage("upload")` already does the
trailing-slash canonicalisation with its `#`, the cookie → access-token
refresh, the `is_current_user_allowlisted()` check, the `no-store` header and
the `stampAssets` cache-busting. `assets/auth-guard.js` already turns the
injected `<meta name="p4p-session">` token into an authenticated `P4P.db`
client. The upload page is a fourth consumer of machinery that exists.

CSP: unchanged. `connect-src https://*.supabase.co` already covers
`/storage/v1/…` and `/rest/v1/rpc/…` — Storage is the same origin as
everything else Supabase.

### 5.2 Screen states

| State | Content |
|---|---|
| **Identity** | `นพ. สมชาย ใจดี — อายุรกรรม`, from `my_p4p_identity()`. Not editable. If the physician is not in the selected month's roster: a blocking notice with "ติดต่อผู้ดูแล" — *before* they pick a file, not after they wait. |
| **Month** | Six chips from `MONTH_ITERATOR` (`src/constants.cjs`), same accent colours as every other page, **defaulting to the previous month** — the month people are actually submitting for. Each chip shows this physician's own `submitted_at` if any ("ส่งแล้ว 12 มิ.ย. 14:32", readable under the existing 4-column grant) and the month's deadline. |
| **Deadline** | `กำหนดส่ง 10 ก.ค. 23:59`. Past it, an amber banner: the upload will still be recorded and scored, but ranking counts it as late. Say this **before** the upload, never after. |
| **File** | `<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">` — LINE's own picker, which reaches Files / Drive / iCloud. Client-side checks in §5.3. |
| **Confirm** | One sentence naming all three facts: *"ส่งไฟล์ `<name>` เป็นผลงานเดือน `<month>` ในชื่อ นพ. สมชาย ใจดี"* — the point where a wrong month or a wrong account is caught by the one person who can tell. |
| **Uploading** | XHR progress. These files are tens of KB; the bar exists for a bad connection, not a big file. |
| **Accepted** | "รับไฟล์แล้ว กำลังตรวจสอบ — ระบบจะแจ้งผลทาง LINE" + the live queue status, polled from `my_p4p_uploads()`. |
| **History** | Last 10 uploads: month, time, status chip (รอตรวจ / สำเร็จ + คะแนน / ไม่สำเร็จ + เหตุผล). This is also the fallback if a LINE push fails to arrive. |

Resubmission is normal and the copy should say so: *"ส่งซ้ำได้ — ระบบจะใช้ไฟล์
ล่าสุด แต่เวลาส่งจะนับจากครั้งแรก"* (§9).

### 5.3 Client-side validation (UX only — the worker re-checks everything)

- Extension is `.xlsx`. `.xls`, `.pdf`, a photo of the sheet → rejected with the
  reason, no upload attempted.
- Basename does not start with `~$` — Excel's lock file. This is a real error
  class on the email path (`ALERT_SUBJECTS.temp_file`); catching it in the
  picker is strictly better than catching it 20 minutes later.
- Size ≤ 5 MB. A genuine scorecard is tens of KB.
- First four bytes are `PK\x03\x04` (`FileReader` on a 4-byte slice). Catches a
  renamed `.xls` or a corrupt download before it costs a round trip.

None of these are trusted. They are there so the common mistakes fail in one
second with a clear message instead of in twenty minutes with a push message.

### 5.4 Why not put this in `web/`

Because `web/` is not deployed (C1). Building it there means the feature ships
when the whole Next.js cutover ships. Build it in Express, and add
`web/app/upload/` to the rewrite's phase list — it is the simplest of the
pages, and by then the RPCs and the worker already exist and are unchanged.

To keep the eventual port cheap, month-window / deadline / file-validation
helpers go in `assets/shared.js` (the existing shared browser lib, already
watched by `web/lib/__tests__/parity.test.ts`) rather than inline in
`upload/app.js`.

---

## 6. Data model

> Every SQL block below is a **sketch for review**, in the same spirit as
> `scripts/notify-access-request.sql`'s "VERIFY BEFORE ENABLING" header. None of
> it has been run. Migrations in this project are applied by hand via the SQL
> Editor (`SUPABASE_MIGRATIONS.md`).

### 6.1 Storage bucket — a write-only drop box

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('p4p-uploads', 'p4p-uploads', false, 5242880,
        array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);

-- INSERT only, and only into a folder named after the caller's own uid.
create policy "p4p_uploads_own_folder_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'p4p-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
-- Deliberately NO select / update / delete policy for `authenticated`.
```

Object path: `p4p-uploads/<auth.uid()>/<month_key>/<uuid>.xlsx`.

The missing `SELECT` policy is the point. A physician can drop a file in and
can never read one back — not their own, not anyone else's. The bucket cannot
become a file-sharing service, cannot leak another physician's scorecard, and
has no listing surface. Only `service_role` (the worker) reads it.

### 6.2 `p4p_upload_queue`

```sql
create table public.p4p_upload_queue (
  id            uuid primary key default gen_random_uuid(),
  -- identity, snapshotted at enqueue so a later roster edit can't rewrite history
  email         text        not null references public.physicians(email) on update cascade,
  full_name     text        not null,
  department    text,
  line_user_id  text,
  -- what is being submitted
  month_key     text        not null,          -- 'YYYY_MM', BE year
  roster_index  bigint,                        -- set when the exact match hits (§6.3)
  object_path   text        not null unique,
  filename      text        not null,          -- original name, display only
  size_bytes    integer     not null,
  -- THE punctuality timestamp: when the physician handed the file over,
  -- not when a runner happened to pick it up. See §9.
  received_at   timestamptz not null default now(),
  -- lifecycle
  status        text        not null default 'pending'
                check (status in ('pending','processing','done','failed','rejected')),
  attempts      smallint    not null default 0,
  claimed_at    timestamptz,
  finished_at   timestamptz,
  error_type    text,                          -- mirrors automation ALERT_SUBJECTS keys
  error_detail  text,
  score         numeric,                       -- what was saved, for the history list
  notified_at   timestamptz
);

create index p4p_upload_queue_drain_idx
  on public.p4p_upload_queue (status, received_at);

-- One in-flight upload per physician per month. Makes queue flooding
-- structurally impossible rather than rate-limited.
create unique index p4p_upload_queue_one_inflight
  on public.p4p_upload_queue (email, month_key)
  where status in ('pending','processing');

alter table public.p4p_upload_queue enable row level security;
-- No anon/authenticated policies. Reached only through the RPCs below
-- and by service_role — the same posture as every other table in
-- SUPABASE_TABLES.md.
```

### 6.3 `enqueue_p4p_upload()` — the only way a row is created

`SECURITY DEFINER`, callable by `authenticated`. Everything it needs about the
caller it reads from `auth.jwt()`; nothing identifying is taken as a parameter.

Checks, in order — each maps to an error the physician sees immediately:

1. `is_current_user_allowlisted()` — the same single gate the pages use.
2. `month_key` is one of the six months in the visible window **and**
   `to_regclass('public.'||month_key)` is not null.
3. `object_path` starts with `<auth.uid()>/`, exists in `storage.objects`,
   and its owner is the caller. (A path is a parameter; it is never trusted.)
4. `size_bytes` ≤ 5 MB and `filename` ends in `.xlsx`, does not start with `~$`.
5. No row already `pending`/`processing` for this `(email, month_key)`.
6. Resolves the physician from `physicians` by JWT email → `full_name`,
   `department`, `line_user_id` (all snapshotted onto the row).
7. **Exact** roster resolution: normalised `firstname || ' ' || lastname` =
   normalised `full_name` on `month_key` → `roster_index`. On a miss, leaves it
   null and lets the worker's `matchName()` do the fuzzy work.

Returns `{ queue_id, roster_match: 'exact'|'deferred'|'none', deadline, is_late }`.

> **One fuzzy matcher, in JS.** `automation/supabase-client.js`'s
> `matchName()` — normalise → single-token fast path → Levenshtein → 0.6
> threshold — stays the only fuzzy matcher in the system. A `pg_trgm`
> reimplementation in plpgsql would be a second one, and two matchers that
> disagree about the same physician is a bug that surfaces months later as
> "why did June match and July not". The RPC does the trivial exact case only,
> because that is what lets the UI say "not in this month's roster" before the
> physician uploads anything.

### 6.4 Read-side RPCs

```sql
my_p4p_identity(p_month text)
  -> { full_name, department, in_roster boolean, submitted_at timestamptz }

my_p4p_uploads(p_limit int default 10)
  -> setof { month_key, filename, received_at, status, score, error_type }
     where email = jwt email
```

Both `SECURITY DEFINER`, both self-scoped from the JWT — no parameter selects
whose data comes back. `my_p4p_identity` is what lets the page block on "not in
this month's roster" up front; `my_p4p_uploads` drives the history list and the
post-upload status poll.

### 6.5 `claim_p4p_upload()` — service_role only

```sql
update public.p4p_upload_queue q
   set status = 'processing', attempts = attempts + 1, claimed_at = now()
 where q.id = (
   select id from public.p4p_upload_queue
    where status = 'pending' and attempts < 3
    order by received_at
    limit 1
    for update skip locked)
returning q.*;
```

`FOR UPDATE SKIP LOCKED` is not expressible through PostgREST, which is why
this is an RPC rather than a client-side query. It makes two overlapping drains
(the 10-minute cron overlapping a slow previous run) safe by construction
rather than by a `concurrency:` group alone.

### 6.6 Optional — `physicians.roster_name`

The exact match in §6.3 fails whenever `physicians.full_name` is spelled
differently from the roster's `firstname`/`lastname` — which is common enough
that `matchName()` exists at all. Adding a nullable `physicians.roster_name`,
written by the worker the first time its fuzzy match succeeds, turns every
later month into an exact hit and lets the UI answer "are you in this roster?"
correctly for everyone. Self-healing, one column, no new matcher. Phase 4.

---

## 7. The worker

### 7.1 One pipeline, parameterised

`processBuffer()` in `automation/index.js` currently hard-codes three things
that are only true of email: identity comes from name resolution, the month
comes from filename/subject/body, and feedback is a Gmail reply. All three
become parameters:

```js
processBuffer(buffer, {
  filename, subject, body, emailDate,          // unchanged
  source  : "email" | "line-upload",           // new — for logging and Telegram
  identity: null | { email, fullName, department, rosterIndex, lineUserId },
  monthKey: null | "2569_06",
  notify  : { ok(result), fail(errorType, detail) },   // new — replaces the
                                                       // inline gmail replies
})
```

- `identity === null` → today's behaviour exactly: `analyseJson()` names the
  physician, `matchName()` resolves the roster row, the fallback-candidate loop
  runs. **The email path passes `null` and is byte-for-byte unaffected.**
- `identity` set → `analyseJson()` is still called (it is the score extractor),
  but its `name` output is used **only as a cross-check**, never to route. The
  roster row comes from `identity.rosterIndex`, or from one `matchName()` call
  against `identity.fullName` when the exact match deferred. A Claude-extracted
  name that disagrees with the authenticated one is a warning in the log and a
  Telegram note — not a routing decision, and never a `physician_not_found`.
- `monthKey` set → skips `resolveBeMonth`/`resolveBeYear` for routing, but the
  inferred month is still computed and compared. A file whose contents say
  July uploaded under June is the one mistake this path can still make, so it
  becomes an explicit `month_mismatch` rejection with both months named,
  rather than a silent write to the wrong table.
- `notify` is implemented by `sendAlertReply`/`buildHtmlReply` for email and by
  `automation/line-push.js` for uploads. The pipeline stops knowing which.

This is a seam, not a fork. The alternative — a second copy of the pipeline for
uploads — is the exact mistake `automation/excel-parse.js`'s header documents,
at ten times the size.

### 7.2 New files

```
automation/upload-queue.js          claim / complete / fail / delete-object
automation/line-push.js             LINE push messages (mirrors telegram.js)
automation/scripts/drain-uploads.mjs  the drain loop
.github/workflows/upload-drain.yml    schedule + workflow_dispatch
```

`drain-uploads.mjs`, per iteration: `claim_p4p_upload()` → download the object
with the service-role key → `processBuffer(..., { source:"line-upload", ... })`
→ mark `done` (with the score) or `failed` (with `error_type`) → push the
result to LINE → delete the object. Loop until the claim returns nothing or a
per-run cap (say 25) is hit.

### 7.3 Latency, and why a 10-minute cron

```yaml
# .github/workflows/upload-drain.yml
on:
  schedule:    [ { cron: "*/10 * * * *" } ]
  workflow_dispatch:
concurrency:
  group: p4p-upload-drain
  cancel-in-progress: false
```

Expected turnaround ≤ 10 minutes; worst case ~30, because GitHub delays
scheduled runs under load — the same behaviour `process-pipeline.yml`'s own
comment describes and works around with an off-the-hour minute. **The UI
promises "ภายใน 30 นาที" and under-promises deliberately.** For a submission
made once a month, against a deadline measured in days, that is fine.

The obvious upgrade is instant dispatch: a trigger on
`p4p_upload_queue` insert → `pg_net` → `POST /repos/{owner}/{repo}/dispatches`,
exactly the shape `notify_access_request()` already uses, taking turnaround to
seconds. It is **not** in the recommended first cut, for one reason: that call
needs a GitHub token with repository write in Supabase Vault, on a public
repository. Trading a token that can write to the repo for 10 minutes of
latency on a monthly task is a bad trade. Phase 4, with eyes open, if the wait
turns out to bother anyone.

Runner cost: 144 runs/day of roughly a minute, free on a public repository.
Add an early bail — count `pending` rows first, exit if zero — so the common
run is checkout + `npm ci` + one query.

### 7.4 What the physician gets back — the LINE Flex receipt

**Yes, with the extracted score — but only the score that was actually
saved.** The bubble is sent *after* `saveScore()` succeeds, never before. If
extraction worked and the write did not (Drive failed, roster row missing),
the physician gets the failure message, not a number. A score shown in LINE is
a receipt for a row in the database, and physicians will screenshot it as
proof; it must never be a preview of something that did not land.

It carries the same four facts as the email auto-reply (`templates/reply.js`) —
name, department, month/year, total score — because a physician should get the
same answer whichever way they submitted, in the medium that path uses.

```
altText: "บันทึกคะแนน P4P เดือนมิถุนายน 2569 — 1,842.50"   ← the push preview
         answers the question without opening the app

┌──────────────────────────────────────┐
│ ✅ บันทึกคะแนน P4P แล้ว                │  header  #4B3D33, white
│ องค์กรแพทย์ โรงพยาบาลสมุทรสาคร          │  sub     #ffffa0
├══════════════════════════════════════┤  hero    5px, month accent
│ ชื่อแพทย์      นพ. สมชาย  ใจดี         │  body    #F5F5F0
│ กลุ่มงาน       อายุรกรรม               │
│ เดือน / ปี     มิถุนายน 2569           │
│ ──────────────────────────────────── │
│ คะแนนรวม                   1,842.50  │  size xxl, bold, #4B3D33
│ ──────────────────────────────────── │
│ ส่งเมื่อ 5 ก.ค. 69 14:32 · ตรงเวลา     │  or "เกินกำหนด" in #B03A2E
├──────────────────────────────────────┤
│         [ ดูสถานะการส่ง ]             │  → the month's status page
└──────────────────────────────────────┘
  หากส่งไฟล์ใหม่ ระบบจะใช้ไฟล์ล่าสุดแทน      footer, small
```

Details that are decisions, not decoration:

- **The palette is the bot's existing one.** `#4B3D33` header, `#ffffa0`
  subtitle, `#81A7AE` hero rule, `#F5F5F0` body — the exact tokens
  `createStatusList()` in `main.js` already uses for the month picker, so the
  receipt reads as the same bot rather than a new one. The hero rule takes the
  month's accent from `COLOR_ARRAY`, matching the month tab the button opens.
- **The button reuses the URI the month picker already builds:**
  `https://liff.line.me/2008561527-a0xP1XmY?sheetname=<month_key>&color=<tw>`.
  No new deep-link format.
- **Score formatting is `toFixed(2)` plus a thousands separator** — the same
  string `buildHtmlReply()` puts in the email, so the two channels can never
  disagree about the number.
- **`ตรงเวลา` / `เกินกำหนด` is computed from `received_at` vs the month's
  deadline** (§9), not from the drain time. It is the same comparison
  `/ranking/` makes, stated once here so the physician is not surprised by
  their position later.

**Failure** uses the same skeleton with a `#B03A2E` header, the Thai reason
text from the error taxonomy (§10), and a button chosen by `error_type`:
`ส่งไฟล์อีกครั้ง` → the upload LIFF for a fixable file (`wrong_extension`,
`temp_file`, `month_mismatch`, `zero_score`), `ติดต่อผู้ดูแล` for one the
physician cannot fix alone (`not_in_roster`, repeated `other`). A retry button
on an unretryable error is worse than no button.

**Quota: replies are free, pushes are not — and this result can only be a
push.** LINE counts push / multicast / narrowcast / broadcast against the
Official Account's monthly quota and does **not** count reply messages (the
ones sent with a `replyToken` in answer to a user's own message) at all.
Two rules follow from how the counting works:

- **A message is one delivery to one person, not one message object.** A push
  carrying a Flex bubble *and* a text note to one physician costs **1**, the
  same as either alone. So the receipt can be as rich as it needs to be —
  there is no reason to compress two ideas into one bubble to save quota.
- **A reply is not available here.** A `replyToken` only exists in answer to a
  webhook event and expires within about a minute; this result is produced
  ~10 minutes later by a GitHub runner that never saw an event. There is no
  way to make the async receipt free by turning it into a reply.

Budget: at full adoption, one push per physician per month — order of 200 —
plus retries and failure notices. That shares a quota with
`scripts/broadcast-flex.mjs`, where **one** carousel broadcast costs one
message *per follower* (another ~200). Two broadcasts plus a month of upload
receipts is already ~600. Check the plan in LINE Official Account Manager
before rollout; Thailand's free tier has historically been 500 messages/month,
with paid plans well above that, but the number moves and is not worth
designing against from memory.

If the quota turns out to be tight, the lever is to **push only when it
matters** rather than to drop the receipt:

- always push on **failure** — the physician has to act, and failures are rare;
- on success, push only if the physician is no longer watching. The page
  already polls `my_p4p_uploads()`; have it record a "seen" timestamp on the
  row, and let the worker skip the push when the result was already read on
  screen. Steady-state cost falls to roughly the number of people who closed
  LINE while waiting.

That is a real complexity cost for a saving that may not be needed, so it is
deliberately **not** in the first cut — it is the thing to reach for if the
plan check comes back tight.

The failure mode either way is silent: the API rejects the push and the
physician simply never hears back. The queue row and the page's history list
are the fallback, and `notified_at` stays null so the gap is visible rather
than invisible.

**When there is no `line_user_id`** — the physician logged in by OTP but never
had a LINE ID token captured (the `openid`-scope problem in
`SUPABASE_TABLES.md`) — fall back to the **email** reply the pipeline can
already send. We know their address; it is the PK of `physicians`.

**No new secret.** `.github/workflows/send-carousel.yml` already resolves
`secrets.LINE_ACCESS_TOKEN || secrets.LINE_TOKEN` for exactly this API, and
`LINE_TOKEN` is what the rich-menu workflows use. `automation/line-push.js`
reads the same pair.

### 7.5 What the admin gets — the Telegram message

`automation/telegram.js` already fires on **every** submission, success
(`formatResultMessage`) and failure (`formatErrorMessage`) alike. The upload
path keeps that, with the fields changed to match what is actually worth
checking on this path.

On the email path the admin's question is *"did the fuzzy match pick the right
person?"* — hence `👤 Name` (what Claude read) versus `🔗 Matched` (who it was
matched to) and a similarity percentage. On the upload path there is no fuzzy
match to doubt: identity came from a verified session. The interesting question
becomes *"did the file agree with what the physician claimed?"*

```
📋 P4P Workload Report

📥 Source   : LINE upload
👤 Account  : สมชาย ใจดี <somchai@example.com>
🔗 Roster   : สมชาย ใจดี (exact)          ← or "(fuzzy 87%)" when deferred
📅 Month    : 2569_06 (เลือกเอง)
🏅 Score    : 1842.50
💾 ✅ Score saved to DB

📎 File: P4P_มิย69.xlsx
```

with warning lines appended only when the file disagrees with the account —
the one class of mistake this path can still produce, and the reason to send a
Telegram at all:

```
⚠️ Name in file : สมหญิง ใจดี (≠ account)
⚠️ Month in file: 2569_05 (≠ 2569_06 selected)
```

The first is informational — a physician can legitimately submit a file whose
header carries a colleague's name if they copied a template, and the write goes
to the authenticated identity regardless (§7.1). The second is a rejection
(`month_mismatch`), and the message says so.

Failures:

```
❌ P4P Upload Error

📥 Source : LINE upload
👤 Account: สมชาย ใจดี <somchai@example.com>
📅 Month  : 2569_06
🚫 Type   : month_mismatch
💬 Error  : ไฟล์ระบุเดือน 2569_05 แต่เลือกส่งเดือน 2569_06
🔁 Attempt: 3/3 — ยุติการลองใหม่

📎 File: P4P_มิย69.xlsx
```

Shape notes:

- **Plain text, no `parse_mode`.** `sendTelegram()`'s own comment records why:
  Markdown renders literally in this setup. Thai names contain characters that
  MarkdownV2 would require escaping anyway.
- **`formatResultMessage` / `formatErrorMessage` gain an optional
  `source`/`account` block** rather than being replaced. The email path passes
  nothing new and its messages stay byte-identical — the admin's eye is trained
  on that layout.
- **`🔁 Attempt: n/3`** appears only on the upload path, because only it
  retries (§12). It is the difference between "this will come back" and "this
  is over, someone has to look".
- **The account email is included** — consistent with
  `notify_access_request()`, which already sends addresses to the same private
  chat. If that chat's membership ever widens, this is one of the lines to cut
  first; it is the only field here that is not already in the message.
- **Volume does not change materially.** A physician submits once a month by
  one path or the other, and both paths notify. The new traffic is retries and
  the two new warning classes.

---

## 8. What this path deletes

The email path's hardest machinery exists because an inbound email carries no
trustworthy identity. Compare:

| Question | Email path | Upload path |
|---|---|---|
| Who is this? | `resolvePhysicianName()` over filename → subject → body, then `matchName()` Levenshtein ≥ 0.6, then a fallback loop over every other candidate source | The session's email → `physicians` row. Verified at login. |
| Which month? | `resolveBeYear()` three-tier scan + `resolveBeMonth()` across filename/subject/body/rows, with the email date as a last resort | Picked from six chips. |
| Is the sender a physician at all? | Inferred afterwards from `sender_physician_match` | `is_current_user_allowlisted()`, before the file is accepted. |
| Failure when it goes wrong | `physician_not_found` / `wrong_date` reply, hours later | Blocked in the UI, seconds later, with the reason. |

Two whole error classes (`physician_not_found`, `wrong_date`) become
structurally impossible on this path. That is the strongest argument for
building it — stronger than the convenience of not opening a mail client.

What does *not* change: score extraction. `resolveScore()` / `analyseJson()`
run identically. The scorecard format is the scorecard format, and this design
does not touch the part of the system that has been tuned against real files.

---

## 9. Punctuality, deadlines and resubmission

**`submitted_at` is `received_at`, never the drain time.** Ranking counts a
submission when `submitted_at <= deadlineISO(month)` — the 10th of the
following month, 23:59:59 +07:00 (`web/lib/months.ts`, `ranking/app.js`). If
the worker wrote its own clock instead, a file handed over at 23:55 on the 10th
and drained at 00:05 would silently become late. The queue row carries
`received_at` from the moment of enqueue and `processBuffer` receives it as the
submission timestamp.

**Resubmission** follows the email path's existing semantics exactly, because
they are already correct:

- `logSubmission()` upserts with `ignoreDuplicates: true` → the **first**
  submission's timestamp stands. Fixing a file does not cost you your
  punctuality.
- `saveScore()` overwrites, and `drive.uploadFile()` replaces by physician name
  → the **last** file wins for score and for the Drive copy.

**Across paths**, the same rules hold: a physician who emails and then uploads
(or the reverse) gets the last file's score and the first submission's
timestamp. Nothing needs to detect the collision, because both paths converge
on the same two functions with the same conflict behaviour.

**Late uploads are accepted, not blocked** — recorded, scored, and ranked late.
Refusing them would mean a physician with a late file has no way to submit at
all, which serves nobody. The banner warns before the upload (§5.2).

---

## 10. Error taxonomy

The queue's `error_type` reuses `ALERT_SUBJECTS`' keys so one vocabulary spans
both paths, plus three that only an upload can produce:

| `error_type` | Cause | Where it is caught |
|---|---|---|
| `wrong_extension` | not `.xlsx` | picker (§5.3), re-checked by `isExcelFile()` |
| `temp_file` | `~$…` lock file | picker, re-checked by `isOfficeLockFile()` |
| `file_link` | a share link instead of a file | n/a — impossible on this path |
| `zero_score` | extracted score ≤ 0 | worker, unchanged |
| `wrong_date` | month table missing | n/a — validated at enqueue |
| `physician_not_found` | no roster match | n/a — validated at enqueue |
| `other` | workbook unreadable / no rows / < 3 non-null cells | worker, unchanged |
| **`month_mismatch`** *(new)* | file contents say a different month than the one picked | worker, §7.1 |
| **`not_in_roster`** *(new)* | physician absent from that month's roster | enqueue RPC, surfaced in the UI |
| **`oversize`** *(new)* | > 5 MB | picker + bucket limit + RPC |

Every one of them reaches the physician in Thai, through LINE, naming the file
and what to do next — the same contract `templates/error-reply.js` provides
over email.

---

## 11. Security review

Following `SECURITY_ANALYSIS.md`'s convention: the threat, then what actually
stops it.

| Threat | Mitigation |
|---|---|
| Anonymous upload | The page is behind `servePage()` (session cookie → refresh → `is_current_user_allowlisted()`), and the Storage policy requires an `authenticated` JWT. Two independent gates; neither is the browser's word for it. |
| Uploading **as** another physician | Identity is never a parameter. The RPC reads the email from `auth.jwt()`; the storage policy pins the folder to `auth.uid()`. There is no field to forge. |
| Writing a score to another physician's roster row | `roster_index` is resolved server-side from the authenticated identity, and `authenticated` has no grant on `index` or `score` at all (C4). The write happens under `service_role`, in the worker, from a row the RPC built. |
| Submitting to an arbitrary/ancient month | RPC validates `month_key` against the six-month window **and** `to_regclass`. |
| Path traversal / claiming someone's object | `object_path` must start with the caller's own uid and must resolve to an existing `storage.objects` row owned by them. A crafted path fails both checks. |
| Bucket used as file storage / data leak | No `SELECT`, `UPDATE` or `DELETE` policy for `authenticated`. Write-only, no listing, no read-back. Objects are deleted after processing (§12). |
| Queue flooding | Partial unique index: one in-flight upload per physician per month. Plus the 5 MB bucket cap and the `attempts < 3` claim filter. |
| **Zip bomb / hostile `.xlsx`** | Genuinely new exposure: today's workbooks arrive through Gmail, which scans them; these arrive raw. Before `ExcelJS.load()`, enumerate the zip with the JSZip dependency the pipeline already has and reject > 200 entries or > 50 MB uncompressed. **Put this in the shared loader so the email path gets it too** — it has the same weakness, just with a filter in front. |
| Service-role key exposure | Stays in GitHub Actions, unchanged. Vercel gains nothing; the browser never sees it; the RPCs are `SECURITY DEFINER` with no key involved. |
| PII in a new place | Scorecards contain physician names and workload. They already live in Drive and Supabase. The bucket adds a *transient* copy — minutes for a success, at most 7 days for a failure — with a stricter policy than anything else in the system. Add it to `DATA_EXPOSURE_ANALYSIS.md` when this ships. |
| Replay of an old upload | `object_path` is unique; a completed row cannot be re-claimed (`status != 'pending'`); the object is gone. |
| A repo-write token in the database | Avoided in the recommended design — that is exactly why §7.3 recommends the cron over `repository_dispatch`. |

---

## 12. Failure modes

**Queue state machine.**
`pending → processing → done | failed | rejected`. `rejected` is a validation
refusal (never retried); `failed` is an execution failure after `attempts = 3`.

**At-least-once, not exactly-once.** A runner that dies mid-`processBuffer`
leaves a row `processing` forever. A reaper in the same script releases rows
`processing` for > 15 minutes back to `pending`. Because the whole pipeline is
idempotent per `(physician, month)` — `saveScore` overwrites, `uploadFile`
replaces by name, `logSubmission` ignores duplicates — a double-processed file
produces exactly the same end state. That property is what makes at-least-once
acceptable here, and it is worth not breaking.

**Poison file.** Three attempts, then `failed`, then a Telegram alert to the
admin (reusing `formatErrorMessage`) and a LINE message to the physician. The
object is kept 7 days for diagnosis, then removed by a cleanup step in the same
workflow. A file that kills the worker never blocks the queue: the claim filter
is `attempts < 3`.

**Concurrent drains.** `FOR UPDATE SKIP LOCKED` (§6.5) plus a `concurrency:`
group. Two runners cannot claim the same row.

**Drive or Claude down.** Existing behaviour: `processBuffer` returns without
saving a score. Here it also leaves the row for retry — strictly better than
the email path, where a failed run depends on the message still being unread.

**Supabase Storage down at upload time.** The file never leaves the phone and
the physician sees an error immediately with a retry button. No half-state: the
queue row is only created *after* the object exists.

**The workflow is disabled or broken.** Rows accumulate as `pending` and
nothing is lost; the page shows "รอตรวจ" honestly. Worth an alert: a
`pending` row older than 2 hours should fire the same Telegram path the other
triggers use.

---

## 13. Rollout

**Phase 0 — prerequisites** (each has a human owner and blocks what follows)

1. **Register LIFF app #5** in the LINE Developers console: endpoint
   `https://p4p-sakhonmso.vercel.app/upload/`, scopes `profile` + `openid`,
   same channel (`2008561527`). This is the same console access
   `web/README.md` has been blocked on — worth resolving once, for both.
2. Create the bucket and run the SQL in §6 (SQL Editor, per
   `SUPABASE_MIGRATIONS.md`).
3. Check the LINE Official Account's message-quota plan against the push
   budget in §7.4. No new secret is needed — `LINE_ACCESS_TOKEN` /
   `LINE_TOKEN` are already GitHub Actions secrets.

**Phase 1 — backend, testable with no UI.** Queue table, RPCs, worker,
workflow. Verify by inserting a queue row by hand against a file uploaded with
the service-role key: the whole path from claim to LINE push is exercised
before a single line of page code exists.

**Phase 2 — the page.** `upload/index.html`, `upload/app.js`, the `gatedPages`
entry, the static mount, `vercel.json`. Reachable by URL, not linked from
anywhere. Test with two or three volunteers.

**Phase 3 — the rich menu.** Edit the SVG and `setup-richmenu.mjs`, run it
once. This is the moment the feature exists for everyone; everything behind it
is already proven.

**Phase 4 — optional.** `physicians.roster_name` (§6.6); instant dispatch
(§7.3); an admin queue panel in `/admin/`; the `web/app/upload/` port.

**Tests** (`automation/test/`, `node:test`, matching what is there):
month-window and deadline/late computation; `.xlsx` / `~$` / magic-byte
rejection; the zip-entry guard; `processBuffer` routing with `identity` set vs
null, using a `notify` double; the reaper's timeout arithmetic.

---

## 14. Rejected alternatives

**Process the file inside the Vercel request.** Needs `ANTHROPIC_API_KEY`, the
Google refresh token and `P4P_FOLDER_ID` copied into Vercel, plus `exceljs`,
`jszip`, `googleapis` and `@anthropic-ai/sdk` in the **root** `package.json` —
which is what production builds from (C8). It also has to finish inside the
function's execution budget while Claude and Drive take their time (C3).
Rejected on all three counts.

**Send the file to the bot in chat instead of a rich-menu page.** LINE supports
file messages, and the webhook could fetch the bytes from
`api-data.line.me/v2/bot/message/{id}/content`. Genuinely tempting: no LIFF app
to register, and LINE's own attachment picker. Rejected because the *only*
identity available is `event.source.userId` → `physicians.line_user_id`, a
binding `SUPABASE_TABLES.md` explicitly describes as best-effort traceability
that is null for anyone whose ID-token capture never worked — and there is no
month picker in a chat attachment, so month inference (and `wrong_date`) comes
straight back. It gives up both of §8's wins. Worth revisiting as a *third*
path once `roster_name` and LINE binding are solid.

**A Supabase Edge Function as the worker.** It cannot reach Drive or Claude
without those secrets moving again, and it would mean porting `exceljs` +
`googleapis` + the whole pipeline to Deno. The queue drain is a batch job that
already has a home.

**Google Drive picker / a shared folder.** Puts the physician in Drive's
permission model, which is what `preprocess-drive.js` and the folder-sharing
cleanup exist to clean up after. No.

**Skip the queue; have the page call the GitHub API directly.** Puts a
repo-scoped token in the browser. Never.

---

## 15. Open questions

1. **Who registers the LIFF app?** Phase 0.1 blocks everything and has been
   blocking `web/` since Phase 0 of the rewrite.
2. **Rich menu shape** — the two-row `2500×1686` recommended in §4.1, or four
   `625×843` columns? Only §4.2's `bounds` differ.
3. **Submitting on someone's behalf.** `THREAD_RELAY_SENDERS` means a
   secretary can forward a physician's file today and have it land correctly.
   The upload path, as designed, can only submit for yourself. Is that a
   feature (accountability) or a regression (the relay is load-bearing for some
   departments)? If the latter, the natural shape is a department-head variant
   of the page that picks a physician from the roster — a small addition to
   §6.3, and a much bigger one to the security review.
4. **Notification fallback.** For a physician with no `line_user_id`, is an
   email reply the right fallback (§7.4), or should the page simply be the
   record and no message go out?
5. **Retention.** 7 days for failed uploads, immediate deletion on success —
   or keep every uploaded object for a month as an audit trail? The security
   posture in §11 assumes the former.
6. **Turnaround.** Is ≤ 10 minutes (typical) / 30 (worst case) acceptable, or
   is the instant-dispatch trade in §7.3 worth its token?

---

## 16. Change inventory

| File | Change |
|---|---|
| `src/richmenu.svg` | `2500×1686`, fourth full-width block, fourth gradient |
| `scripts/setup-richmenu.mjs` | menu size + fourth area → the upload LIFF URI |
| `upload/index.html`, `upload/app.js` | **new** — the page |
| `assets/shared.js` | month window / deadline / file-validation helpers (shared with the eventual `web/` port) |
| `main.js` | `gatedPages` += `"upload"`; `app.use("/upload", express.static("upload"))` |
| `vercel.json` | `includeFiles` += `"upload/**"` |
| `scripts/line-upload-2026-09.sql` | **new** — bucket, policies, `p4p_upload_queue`, the four RPCs |
| `automation/index.js` | `processBuffer()` gains `source` / `identity` / `monthKey` / `notify`; email path passes `null` and is unchanged |
| `automation/upload-queue.js` | **new** — claim / complete / fail / delete-object |
| `automation/line-push.js` | **new** — LINE push transport (mirrors `telegram.js`) |
| `automation/templates/line-receipt.js` | **new** — the success/failure Flex bubbles (§7.4), alongside `reply.js` / `error-reply.js` |
| `automation/telegram.js` | optional `source`/`account` block on `formatResultMessage` / `formatErrorMessage` (§7.5); email-path output unchanged |
| `automation/scripts/drain-uploads.mjs` | **new** — the drain loop |
| `.github/workflows/upload-drain.yml` | **new** — `*/10` schedule + `workflow_dispatch` |
| `automation/test/*` | new tests per §13 |
| `SUPABASE_TABLES.md`, `DATA_EXPOSURE_ANALYSIS.md`, `SECURITY_ANALYSIS.md` | document the queue table and the bucket |
| `REACT_REWRITE_PLAN.md` | add `/upload/` to the phase list |
