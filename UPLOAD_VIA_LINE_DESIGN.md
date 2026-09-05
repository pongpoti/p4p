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
                                    ▼  (under a minute, §7.3)
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
 │                                                                        │
 │  4. POST /upload/score  (main.js — §7.7)                               │
 │     download object (service_role) → resolveScore() confidence gate    │
 │     high tier → saveScore() + logSubmission() now, ~1–2 s               │
 │     low tier  → skip scoring here; row stays for the async path below  │
 │     ← { score, month, late } | { pending: true }                       │
 │                                                                        │
 │  5. liff.sendMessages(text)                     ◀ FREE, as the user   │
 └────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
 ┌─ SUPABASE ─────────────────────────────────────────────────────────────┐
 │  storage: p4p-uploads (private, 5 MB cap, xlsx-only, insert-only)      │
 │  table  : p4p_upload_queue                                             │
 │           status: pending → processing → done | failed | rejected      │
 │           archive_status: archive_pending → archived (§7.7 rec 2)      │
 └────────────────────────────────────────────────────────────────────────┘
      │ webhook (from step 5) — §7.5           │  claimed within ~10 s (§7.3)
      ▼                                         ▼
 ┌─ main.js /line ──────────────┐   ┌─ GITHUB ACTIONS — automation/ ──────────┐
 │ reply (FREE) with a          │   │  6. claim archive_pending row            │
 │ "ดูผลคะแนน" postback button   │   │     FOR UPDATE SKIP LOCKED               │
 │                               │   │  7. extractFirstSheetBuffer → Drive      │
 │ tap → fresh reply token →     │   │  8. if score was never resolved above    │
 │ reply (FREE) with the score   │   │     (low-confidence tier): processBuffer │
 │ receipt read from the row,    │   │     runs analyseJson + saveScore too     │
 │ or the reason if it failed    │   │  9. mark archived · LINE PUSH on         │
 │                               │   │     failure only · Telegram either way  │
 └───────────────────────────────┘   │ 10. delete the storage object            │
                                      └──────────────────────────────────────────┘
```

The two right-hand branches at step 5/6 both exist because §7.7's confidence
gate is not all-or-nothing: most files resolve at the high-confidence tier and
get their score in step 4, in which case step 8 is a no-op and the archive
worker only moves bytes. A file that lands on the low-confidence tier gets no
score in step 4 — the page shows "กำลังตรวจสอบ" — and the archive worker falls
back to the full `processBuffer()` pipeline (Claude included) exactly as
originally designed, before pushing the result rather than waiting for a tap.

Properties worth naming, because each one is a decision:

- **No new secret in Vercel.** `saveScore`/`logSubmission` still go through
  `SUPABASE_SERVICE_ROLE_KEY`, which Vercel already holds. `exceljs` **is** a
  new root dependency (lazy-`require`d, §7.7 rec 4) — the claim that nothing
  changes in the root build no longer holds since §7.7; what's preserved is
  narrower and stated correctly there: no Anthropic key, no Google credential,
  and no `googleapis`/`@anthropic-ai/sdk` reach Vercel.
- **The browser's upload of file bytes still goes straight to Supabase.**
  C3's 4.5 MB body cap on *that* PUT stays irrelevant. What changed with §7.7
  is that `main.js` now fetches the same bytes back from Storage
  server-to-server to score them — real work, on a real execution budget,
  which is exactly why §7.7's timeout wrap (rec 3) is a precondition and not a
  nicety.
- **One pipeline, not two.** `processBuffer()` gains parameters; it is not
  forked. `automation/excel-parse.js`'s own header documents what happened last
  time this logic was copy-pasted — a fix in one copy had no way to reach the
  other. That mistake is not worth repeating at a larger scale.
- **Two things can be queued, not one.** For the common (high-confidence)
  case, only the Drive archive waits. For the uncommon (low-confidence) case,
  §7.7's gate defers scoring itself to the same worker, which then runs the
  full `processBuffer()` pipeline — Claude included — exactly as originally
  designed. The diagram above is the complete picture; the rest of this
  document describes the pipeline both branches ultimately feed.
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
(the hourly relay overlapping a still-running loop) safe by construction
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

### 7.3 Latency — where the time actually goes

The extraction is **not** slow. Parse + `resolveScore`/Claude + Drive + two
Supabase writes is well under a minute per file, which is what the email
pipeline already does per thread. Every earlier "~10 minutes" in this document
was **queue wait** — an artefact of choosing a polling cron — and none of it
was processing. The two must not be conflated, because only one of them is a
law of physics:

| | |
|---|---|
| Wait for the cron to fire | 0–10 min, plus GitHub's own scheduling delay |
| Runner boot + checkout + `npm ci` | ~40–60 s |
| **Actual work** (parse → Claude → Drive → save) | **~20–40 s** |

So 95% of the wait was the trigger, and the trigger is the thing to fix.

For scale: an emailing physician waits up to **two hours** today
(`p4p-cron.yml` is `17 */2 * * *`) for that same sub-minute job. Anything here
is an improvement; that is not a reason to settle for one.

#### Recommended: a long-polling drain, not a cron

```yaml
# .github/workflows/upload-drain.yml
on:
  schedule:    [ { cron: "5 * * * *" } ]      # hourly relay, not the trigger
  workflow_dispatch:
concurrency:
  group: p4p-upload-drain
  cancel-in-progress: false
```

`drain-uploads.mjs` does not exit after one pass. It polls
`claim_p4p_upload()` every ~10 seconds for ~65 minutes, then exits and lets the
next hourly run take over. Runs overlap deliberately — the 65-minute loop
against a 60-minute schedule means a delayed start is covered by the previous
run still being alive, and `FOR UPDATE SKIP LOCKED` (§6.5) makes the overlap
harmless.

**Pickup latency: ~10 seconds. End to end: under a minute**, matching what the
email pipeline achieves per thread, with the runner already warm so the
`npm ci` cost is paid once an hour instead of on every file.

Two honest caveats:

- **Free, but a grey area.** Actions minutes are unlimited on a public
  repository, and a job that idles polling this project's own queue is
  cheaper in wall-clock than 288 cold starts a day. It is still a
  long-running job kept alive to wait for work, which is not what a CI runner
  is nominally for. Worth a look at GitHub's Actions policy before committing,
  and worth dropping to a `*/5` cron (3–8 min) if that reading comes back
  uncomfortable.
- **A gap is possible** if GitHub delays the hourly start past the previous
  loop's exit. Uploads wait, they are not lost — the queue holds them and the
  next run drains them in order.

#### Rejected: instant dispatch from the database

A trigger on insert → `pg_net` → GitHub, the shape `notify_access_request()`
already uses, would fire in seconds. The blocker is the token, and it is worse
than it first looks: **both** dispatch APIs need `contents: write` on a
fine-grained PAT — `repository_dispatch` documented as such, and
`workflow_dispatch` reported to need Contents as well rather than Actions
alone. There is no narrower token to reach for.

`contents: write` means push access. Push access means editing
`.github/workflows/`, and those workflows run with `ANTHROPIC_API_KEY`,
`GOOGLE_REFRESH_TOKEN` and `SUPABASE_KEY`. So a token in Vault that leaks
escalates from "database access" to "every credential the automation holds" —
on a public repository. The long-poll loop above gets to the same latency for
no token at all, which makes this trade unnecessary rather than merely
unattractive.

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
  under a minute later by a GitHub runner that never saw an event. There is no
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

### 7.5 Three ways a message can reach the chat — and what each costs

"Reply or push" is the wrong split; there are three mechanisms, and the LIFF
page has access to one the bot does not.

| Mechanism | Who it appears from | Quota | Usable for the result? |
|---|---|---|---|
| `liff.sendMessages()` | **the physician** — their own message, right-hand side of the chat | Not an OA message, so not against the OA's quota | Only for what the page knows *now* |
| Reply (`replyToken`) | the OA | **Free** | No — token expires long before the result |
| Push (`/message/push`) | the OA | **Counted** | Yes |

**`liff.sendMessages()` is free, and the page can use it.** It sends on behalf
of the user into the chat the LIFF app was opened from, needs the
`chat_message.write` scope, and works only inside the LIFF browser launched
from a chat. It is not the OA sending anything, so it does not draw on the OA's
message quota. Up to 5 message objects, Flex included.

Two documented limits decide how far it gets us:

- **A Flex or template sent this way fires no webhook.** LINE sends a webhook
  for the other message types but not for those two. So the clever chain —
  page posts a Flex as the user → bot receives it → bot replies free — does not
  exist. A **text** message does fire a webhook, and that reply token is real
  and free.
- **The page can only send what it already knows.** This is the real
  constraint, and it is ours, not LINE's: at the moment the page is still open,
  the file has only been queued. The score arrives seconds later from a
  GitHub runner. `liff.sendMessages()` can post *"📤 ส่งไฟล์ P4P เดือนมิถุนายน
  2569"* for free; it cannot post a score that does not exist yet.

So the split is: **the acknowledgement can be free, the score receipt cannot** —
not while scoring is asynchronous.

#### The genuinely zero-push variant: pull instead of push

If the quota check comes back tight, this removes the last push without giving
up the chat receipt:

1. On upload, the page calls `liff.sendMessages()` with a **text** line —
   *"ส่งไฟล์ P4P เดือนมิถุนายน 2569"*. Free, and it leaves a visible record in
   the physician's own chat history.
2. That text fires a webhook. `main.js`'s `/line` handler replies — **free** —
   with an acknowledgement bubble carrying a `postback` quick-reply:
   `[ ดูผลคะแนน ]`.
3. Whenever the physician taps it, the postback arrives with a **fresh** reply
   token, so the bot answers — **free** — with the §7.4 receipt read straight
   out of `p4p_upload_queue`, or "ยังตรวจสอบไม่เสร็จ" if it is still pending.

Total OA quota consumed: **zero**. The cost is that the physician has to tap to
learn the result instead of being told, and some will not. Push is worth its
quota precisely because an unprompted answer is the product; this variant
trades that away, and should only be taken if the plan check forces it.

A middle setting exists and is probably the right one if it comes to that:
**pull for success, push for failure.** Successes are the common case and the
physician has no action to take; failures are rare and demand one.

#### The pull workflow, step by step

```
①  UPLOAD                                    in the LIFF page
    physician picks month + file → ส่งไฟล์
    page → Storage + enqueue_p4p_upload()
    page → liff.sendMessages(text)                      ◀ FREE (sent as the user)

    the chat now shows, on the physician's own side:
      ╭─────────────────────────────────╮
      │  ส่งไฟล์ P4P มิถุนายน 2569        │
      ╰─────────────────────────────────╯

②  ACK                                       webhook, ~1 second later
    that text fires a webhook carrying a replyToken
    main.js /line → find this LINE user's latest queue row
                  → reply                              ◀ FREE
      ╭─────────────────────────────────╮
      │ 📥 รับไฟล์แล้ว                   │
      │ กำลังตรวจสอบ สักครู่              │
      │        [ ดูผลคะแนน ]            │   ← postback button
      ╰─────────────────────────────────╯

③  PROCESS                                   GitHub Actions, ~30 s
    drain → analyseJson → Drive → saveScore
    queue row: pending → done (1,842.50)
    ── sends nothing ──                                ◀ where the push used to be

④  TAP                                       whenever the physician wants
    [ ดูผลคะแนน ] → postback event with a FRESH replyToken
    main.js /line → read the row → reply               ◀ FREE
      done    → the §7.4 score receipt
      pending → "ยังตรวจสอบไม่เสร็จ" + the same button again
      failed  → the reason + [ ส่งไฟล์อีกครั้ง ]
```

**Why step ① exists at all.** The button has to get into the chat somehow, and
the bot cannot put it there on its own without spending a push. A message from
the *user* is what earns the bot a free reply — so the page makes the user
"say" something, and the bot's answer carries the button. That is the entire
mechanism.

**The text is a trigger, not data.** The bot ignores what it says and resolves
the row from `source.userId` → `physicians.line_user_id` → the latest
`p4p_upload_queue` row. Nothing in the message is trusted. A useful side
effect: a physician who types "ส่งไฟล์ P4P" by hand gets the same answer, so
this doubles as a free status command with no extra code.

**Authorisation.** The postback's `data` carries the queue id; the handler
still checks the row's `line_user_id` against `event.source.userId` before
answering. Postback data comes from a button the bot itself sent and the
webhook is signature-verified, so this is defence in depth rather than the
primary control — but it is two lines.

**If `liff.sendMessages()` turns out not to work from a rich-menu launch**
(the unverified assumption in §7.5), the fallback needs no LIFF capability at
all: make the rich menu's upload block a `richmenuswitch` to a small submenu
with two areas — `ส่งไฟล์` (uri → the LIFF app) and `ดูผลล่าสุด` (**postback**).
A rich-menu postback fires the same webhook with the same free reply token.
Worse discovery — the physician has to think to go look — but it cannot fail
for capability reasons, and it is the same `richmenuswitch` pattern the month
picker already uses.

Build both: `sendMessages` as progressive enhancement, the menu entry as the
path that is always there.

**What it costs.** If the physician never taps, they never learn the result.
Three things soften that — the button stays in the chat indefinitely, the
upload page's history list shows the same state, and `/status/` already shows
their `submitted_at` — but "never told" is still the trade being made. Which is
why **failures should still push**: a success needs no action from the
physician, a failure does.

**One risk to measure before committing to this.** Reply tokens are short-lived
and steps ② and ④ both spend one after a Supabase lookup, on a Vercel function
that may be cold. Two queries on a warm function is a few hundred milliseconds;
a cold start plus two queries is the case to time. If it proves marginal, reply
first with a static acknowledgement and resolve the row only on the postback,
where the physician's own tap has already warmed the function.

#### What to verify on a device before designing around this

`liff.sendMessages()` requires a LIFF app launched **from a chat**. Our entry
point is the rich menu, which lives inside the 1:1 chat with the OA, so the
context should be `utou` and the call should work — but "should" is exactly the
word that preceded the `openid`-scope failure, the double-reload beacon
incident, and the fragment-stripping redirect loop in this project's history.
`/preflight` exists for this: add a `liff.getContext()` dump and a
`sendMessages` probe to it and confirm on a real phone, launched from the rich
menu, before any of this is load-bearing.

### 7.6 What the admin gets — the Telegram message

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

### 7.7 Instant scoring — the chosen variant, and what it costs

**Decided:** the score is computed **synchronously**, during the upload
request, and the receipt goes out immediately. The background worker keeps only
the part that genuinely needs a credential the web tier does not have — the
Google Drive archive.

```
physician taps ส่งไฟล์
   │
   ├─ browser → Storage (bytes)                        as before
   ├─ browser → POST /upload/score  (main.js)          NEW
   │     parse → resolveScore() → month cross-check
   │     → saveScore() + logSubmission() via service role
   │     ← { score, month, late }                      ~1–2 s
   ├─ page shows the score
   ├─ page → liff.sendMessages(Flex receipt)           free AND instant
   └─ queue row enqueued with status 'archive_pending'
         │
         └─ long-poll worker → extractFirstSheetBuffer → drive.uploadFile
```

Why this is even possible: `resolveScore()` already computes the number in pure
JS before Claude is called — `analyseJson`'s prompt then says "USE THIS VALUE".
Claude's real job is deciding **who** and **which month**, and on this path both
are already known (§8). So the fast leg needs no Anthropic key, no Google
credential, and no network call at all beyond Supabase.

#### The drawbacks, ranked

**1. A receipt cannot be un-sent — and the score is no longer Claude-checked.**
Today `analysis.score` is *Claude's* answer, steered hard toward the JS value
but free to differ. Dropping Claude from the fast path silently changes the
score in whatever edge cases it currently corrects, and these scores decide
ranking. Worse, if the background worker still runs `analyseJson` as a checker
and disagrees, there are only two options: change a number the physician has
already screenshotted, or leave it wrong.

*This is the decision, not a detail.* Resolve it with evidence before building:
every run log already prints both numbers —

```
🔢  JS score pre-scan: 1842.50 (sum of sub-total rows)
✅  Score     : 1842.50            ← Claude's answer
```

— so a pass over a few months of Actions logs answers "does Claude ever
disagree?" definitively. If it never does, drop it from the fast path with
confidence. If it does, the fast path is not safe as designed and the honest
options are to keep Claude in the synchronous call (adds ~2–10 s, still far
better than a queue) or to show the instant number as provisional, which gives
up most of what this variant is for.

**Recommendation: gate eligibility on `resolveScore()`'s own confidence tag,
run the log audit to confirm, and never overwrite a sent receipt.**
`resolveScore()` already tells you how sure it is — its `method` string
distinguishes a declared grand-total/free-text label (`"grand-total label row
(all columns)"`, `"free-text summary line"`) from the three uncached-formula
fallback tiers (`"sum of sub-total rows…"`,
`"reconstructed from daily cells × rate…"`). Take the synchronous path **only**
on the labelled-total tier — the case where the workbook itself states the
number and Claude's job is closest to a formality. Route everything else
(uncached formulas, reconstructed totals) through the existing queued path
with Claude still in the loop, and show "กำลังตรวจสอบ" rather than a number.
Then run the log audit anyway, scoped to that labelled-total tier specifically
— it should show near-zero disagreement, and if it doesn't, the gate is wrong,
not just the drawback. On the queued path, if a Claude cross-check disagrees
after a receipt already went out, that is a Telegram alert for the admin to
resolve by hand, never an auto-correction to a number the physician has
already screenshotted.

**2. A score can now exist with no archived file.** Today Drive-before-score is
an invariant; this breaks it. `drive-client.js` deliberately does not
auto-create folders — a missing month folder throws. Today that failure is
loud: nothing saves. Afterwards it is quiet: every score saves and every
archive fails, while `process/`'s SK03/merge step silently builds a month
missing those files.

**Recommendation: split "archive failed" from "processing failed" as a
lifecycle, not just a label, and never bounce it back to the physician.**
Once the score is saved, the physician has nothing left to fix — a missing
Drive folder or a Google API hiccup is entirely an operations problem now,
not a submission problem, so `attempts < 3` → terminal `failed` (§6.5) is the
wrong shape for this state. Retry `archive_pending` indefinitely on a backoff
(hourly, say, capped at daily), add a "scored but not archived" panel to
`/admin/` sorted by age, and alert on the first row that crosses an hour and
again daily after that. The queue guarantees retries; it does not guarantee
anyone looks, and nobody outside `/admin/` should ever see this state.

**3. Untrusted xlsx parsing moves into the web server.** Today a hostile
workbook is parsed on a disposable GitHub runner. Afterwards it is parsed
inside the Vercel function that holds `SUPABASE_SERVICE_ROLE_KEY`. The
zip-entry / uncompressed-size guard in §11 stops being a nice-to-have and
becomes a precondition — enforced **before** `ExcelJS.load()`, alongside the
5 MB cap.

**Recommendation: the guard is necessary but not sufficient — wrap the parse
itself in a timeout, and fail closed to the queue rather than making the
physician wait on it.** A file that passes the entry-count/size guard can
still be pathological in ways that cost CPU rather than memory (deeply nested
shared-formula chains, for instance) — the guard bounds the input, not the
work. `Promise.race` the parse against ~5–8 s; on timeout, skip the
synchronous score, enqueue the row for the async path exactly as if it had
been a large file, and tell the physician "กำลังตรวจสอบ" instead of leaving
the request hanging against Vercel's own execution limit. This turns "slow
enough to be suspicious" into a graceful downgrade instead of a 504.

**4. `exceljs` enters the production build.** This is C8, conceded knowingly:
it is pure JS with no native build, unlike `googleapis`. But `vercel.json`
routes *every* path to the single `main.js` function, so a top-level
`require("exceljs")` would put its import cost on `/status/`, `/list/` and
`/verify/` too.

**Recommendation: lazy `require` first, measure before reaching for
anything bigger.** `require("exceljs")` inside the upload handler (not at
module top level) keeps the parse/eval cost off every route that isn't
`/upload/score` — cheap and immediate. Be precise about what it does and does
not fix: `@vercel/nft` traces the whole file's reachable imports into the
bundle regardless, so this is a cold-start-latency win on unrelated routes,
not a bundle-size win. Measure cold start on `/status/` before and after
before deciding it's solved. If it turns out `exceljs` still measurably taxes
every route, the next lever is giving `/upload/score` its own Vercel function
in `vercel.json` rather than routing through the shared one — but that is a
second moving part, worth it only if the measurement says so, not on
suspicion.

**5. Two places now parse workbooks, and more code, not less.** The scoring
functions must move to one shared module that both Vercel and `automation/`
import — the mistake `automation/excel-parse.js`'s header already documents,
now with a second runtime to drift against. Extend the parity guard to cover
it. And the async path does not go away: a slow phone, a big file or a cold
function still needs the "still working, we will notify you" fallback, so both
paths are maintained rather than one replaced.

**Recommendation: follow the pattern this repo already uses for exactly this
problem — a vendored copy plus an automated parity test — rather than
reaching for npm workspaces.** `automation/`, `process/` and the root are
deliberately isolated (C8); merging their dependency trees to get real code
sharing is a bigger structural change than this feature justifies, and
`web/lib/__tests__/parity.test.ts` already establishes the cheaper answer for
this exact situation (three legacy copies of month/department/colour data,
kept honest by a test that reads all of them and diffs). Do the same here:
`automation/claude-analyst.js` stays canonical (it's what the test suite in
`automation/test/` exercises), the root gets its own copy of just
`resolveScore`/`extractScoreFromRows`, and a root-level test hashes both
files' relevant exports and fails the build the moment they diverge. Cheaper
to build than a shared package, and it fails loudly in CI instead of quietly
in production.

#### One consequence worth a policy decision

An instant score plus `logSubmission`'s ignore-duplicates rule (first timestamp
wins, §9) means a physician can upload, dislike the number, adjust the
workbook, and re-upload with no cost to their punctuality — as many times as
they like. That is either "good, they can fix their own mistakes quickly" or
"score-shopping", and it is a policy call rather than a technical one. If it
matters, the cheap control is to count uploads per `(email, month_key)` on the
queue and surface the count in `/admin/` — visibility rather than a limit.

**Recommendation: visibility, not a limit, and not in the first cut.** Log the
per-`(email, month_key)` upload count either way — it's one column and one
`WHERE` clause. Don't gate on it unless `/admin/` usage over the first couple
of months actually shows repeat-uploading being used to game the number rather
than to fix a typo. A limit designed before the behavior is observed is a
guess wearing a policy's clothes.
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

**Phase −1 — the one thing to know before writing any code: the log audit.**
§7.7's whole fast path stands or falls on how often `resolveScore()`'s
labelled-total tier disagrees with Claude. This costs nothing to check —
`p4p-cron.yml`'s existing Actions logs already print both numbers side by
side — and it should happen before Phase 0, not during Phase 1, because the
answer decides whether §7.7 ships as designed, ships with Claude still in the
synchronous call, or doesn't ship at all.

**Phase 0 — prerequisites** (each has a human owner and blocks what follows)

1. **Register LIFF app #5** in the LINE Developers console: endpoint
   `https://p4p-sakhonmso.vercel.app/upload/`, scopes `profile` + `openid`,
   same channel (`2008561527`). This is the same console access
   `web/README.md` has been blocked on — worth resolving once, for both.
   While in there: confirm `chat_message.write` is grantable for §7.5's
   `liff.sendMessages()` path, and add a `liff.getContext()` +
   `sendMessages` probe to `/preflight` per §7.5's closing note.
2. Create the bucket and run the SQL in §6 (SQL Editor, per
   `SUPABASE_MIGRATIONS.md`) — including the `archive_pending` lifecycle
   from §7.7's recommendation on drawback 2, not just the original four
   states.
3. Check the LINE Official Account's message-quota plan against the push
   budget in §7.4, which settles open question 7 (push vs. pull). No new
   secret either way — `LINE_ACCESS_TOKEN` / `LINE_TOKEN` are already GitHub
   Actions secrets.

**Phase 1 — the synchronous score path, testable with no UI.**
This is now the core of the feature, not the worker — §7.7 moved it here.
`POST /upload/score` in `main.js`: lazy-`require("exceljs")`, the zip-guard +
parse timeout from §7.7/§11, `resolveScore()`'s confidence gate, `saveScore()`
+ `logSubmission()` via service role. Verify by POSTing a file with a
service-role-authenticated request before any page code exists. This is also
where the vendored-copy-plus-parity-test from §7.7's recommendation 5 gets
built, alongside the `automation/` copy it must never drift from.

**Phase 2 — the archive worker and the free-notification loop.**
The long-polling drain (§7.3) now claims `archive_pending` rows only —
`extractFirstSheetBuffer` → `drive.uploadFile`, retried indefinitely, never
terminal, per §7.7's recommendation 2. Alongside it: the `sendMessages` →
free-reply-with-postback → free-reply-with-receipt chain from §7.5, plus its
rich-menu-postback fallback, built and tested regardless of which the
`/preflight` probe from Phase 0 recommends.

**Phase 3 — the page.** `upload/index.html`, `upload/app.js`, the `gatedPages`
entry, the static mount, `vercel.json`. Reachable by URL, not linked from
anywhere. Test with two or three volunteers — this is the first point real
physicians touch any of it.

**Phase 4 — the rich menu.** Edit the SVG and `setup-richmenu.mjs`, run it
once. This is the moment the feature exists for everyone; everything behind it
is already proven.

**Phase 5 — optional.** `physicians.roster_name` (§6.6); an `/admin/` panel
for `archive_pending` age (§7.7 rec 2) and re-upload counts (§7.7's policy
question) if Phase 3/4 usage suggests either is needed; the `web/app/upload/`
port.

**Tests** (`automation/test/`, `node:test`, matching what is there, plus a
root-level suite for Phase 1's vendored copy): month-window and
deadline/late computation; `.xlsx` / `~$` / magic-byte rejection; the
zip-entry guard and the parse-timeout fallback; the confidence-tier gate
against fixtures for each of `resolveScore()`'s methods; `processBuffer`
routing with `identity` set vs null, using a `notify` double; the archive
reaper's retry/backoff arithmetic; the parity test between the root and
`automation/` copies of the scoring functions.

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
6. **The long-polling drain (§7.3)** gets pickup to ~10 seconds with no new
   token, at the cost of a job that idles waiting for work. Comfortable with
   that reading of GitHub's Actions policy, or fall back to a `*/5` cron and
   a 3–8 minute wait?
7. **Push or pull for the result?** The unprompted push costs quota; the
   pull variant in §7.5 costs nothing but needs a tap. Answer depends
   entirely on what the OA's plan check in §7.4 comes back with.

---

## 16. Change inventory

| File | Change |
|---|---|
| `src/richmenu.svg` | `2500×1686`, fourth full-width block, fourth gradient |
| `scripts/setup-richmenu.mjs` | menu size + fourth area → the upload LIFF URI; a `ดูผลล่าสุด` postback area if §7.5's fallback submenu is needed |
| `upload/index.html`, `upload/app.js` | **new** — the page; calls `POST /upload/score` and `liff.sendMessages()` |
| `assets/shared.js` | month window / deadline / file-validation helpers (shared with the eventual `web/` port) |
| `package.json` (root) | **new dependency** — `exceljs`, lazy-`require`d only inside the upload handler (§7.7 rec 4) |
| `lib/p4p-score.js` (root, **new**) | vendored copy of `resolveScore`/`extractScoreFromRows` + the zip-guard/parse-timeout wrapper — kept honest by the parity test below (§7.7 rec 5) |
| `main.js` | `gatedPages` += `"upload"`; static mount; **new** `POST /upload/score` route (parse → confidence gate → `saveScore`/`logSubmission` via service role, §7.7); `/line` handler gains the trigger-text / postback branch (§7.5) |
| `vercel.json` | `includeFiles` += `"upload/**"` |
| `scripts/line-upload-2026-09.sql` | **new** — bucket, policies, `p4p_upload_queue` (with the `archive_pending` lifecycle, not the original four states — §7.7 rec 2), the RPCs |
| `automation/index.js` | `processBuffer()` gains `source` / `identity` / `monthKey` / `notify`; email path passes `null` and is unchanged |
| `automation/upload-queue.js` | **new** — claims `archive_pending` rows only; indefinite backoff retry, never terminal (§7.7 rec 2) |
| `automation/line-push.js` | **new** — LINE push transport for the failure case only; success is a free reply (§7.5), not a push |
| `automation/templates/line-receipt.js` | **new** — the success/failure Flex bubbles (§7.4), alongside `reply.js` / `error-reply.js` |
| `automation/telegram.js` | optional `source`/`account` block on `formatResultMessage` / `formatErrorMessage` (§7.6); email-path output unchanged |
| `automation/scripts/drain-uploads.mjs` | **new** — long-polling archive drain (§7.3), plus the `archive_pending` age alert (§7.7 rec 2) |
| `.github/workflows/upload-drain.yml` | **new** — hourly relay + `workflow_dispatch`; the loop, not the schedule, is the trigger (§7.3) |
| `automation/test/*`, root-level test suite | new tests per §13, including the root/`automation/` parity test for `lib/p4p-score.js` |
| `/admin/` (`AdminClient.tsx` or `admin/app.js`, `web/app/admin/api/…`) | new panel for `archive_pending` age and re-upload counts (§7.7 rec 2 and the policy question) — Phase 5, built only if usage shows it's needed |
| `SUPABASE_TABLES.md`, `DATA_EXPOSURE_ANALYSIS.md`, `SECURITY_ANALYSIS.md` | document the queue table and the bucket |
| `REACT_REWRITE_PLAN.md` | add `/upload/` to the phase list |
