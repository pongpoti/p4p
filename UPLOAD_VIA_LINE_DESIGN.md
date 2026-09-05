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
                      │
                      ▼  common case — the file's total is stated outright (§7.7)
                      "✅ บันทึกคะแนนเดือนมิถุนายน 2569 แล้ว: 1,842.50"   ← ON THE PAGE, ~1–2 s
                      + the same receipt in the chat, free (§7.5)
                      (Drive archiving happens after this, invisibly)
                      │
                      ▼  uncommon case — the file's total needs Claude to read it
                      "กำลังตรวจสอบ — จะแจ้งผลทางแชท"
                                    │
                                    ▼  under a minute (§7.3), free — no tap needed
                                       until the result arrives; then one tap (§7.5)
                      "✅ บันทึกคะแนน…" หรือ "❌ ไฟล์ไม่ถูกต้อง: <เหตุผล> กรุณาส่งใหม่"
```

Three things are *known* on this path that are *guessed* on the email path —
who is submitting, which month, and whether the sender is a real physician.
That is where most of the value is; see §8. A fourth thing, decided later in
this document (§7.7), turns out to matter as much as any of them: on this
path the *score itself* can usually be read straight off the file with no
inference at all, which is what makes the common case instant rather than
"under a minute."

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
 │  5. liff.sendMessages(…)                        ◀ FREE, as the user   │
 │     high tier → the real Flex receipt, done (§7.5's whole mechanism    │
 │                  below is for the OTHER branch)                        │
 │     low tier  → a trigger-text line; the free reply/postback dance     │
 │                  in §7.5 picks up from there                           │
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
 │ reply (FREE) with a          │   │  6. claim_p4p_archive() first —          │
 │ "ดูผลคะแนน" postback button   │   │     the common case, no Claude needed    │
 │                               │   │     → extractFirstSheetBuffer → Drive    │
 │ tap → fresh reply token →     │   │     → archived · no push, ever (§7.2)    │
 │ reply (FREE) with the score   │   │                                          │
 │ receipt read from the row,    │   │  7. else claim_p4p_score_fallback() —    │
 │ or the reason if it failed    │   │     the rare case, score not yet known   │
 │                               │   │     → full processBuffer(): Claude,      │
 │                               │   │       Drive, saveScore together          │
 │                               │   │     → done (pulled, §7.5) | failed×3     │
 │                               │   │       (PUSHED — §7.2/§12, §7.6 Telegram) │
 └───────────────────────────────┘   │  8. delete the object once archived      │
                                      └──────────────────────────────────────────┘
```

The two right-hand branches exist because §7.7's confidence gate is not
all-or-nothing. Most files resolve at the high-confidence tier in step 4 and
never touch step 7 at all — the archive worker (step 6) only moves bytes, and
never pushes, because the physician already has the receipt from step 5. A
file that lands on the low-confidence tier gets no score in step 4 — the page
shows "กำลังตรวจสอบ" — and step 7 falls back to the full `processBuffer()`
pipeline (Claude included). Even there, success is still *pulled* via the
same postback step 5 already placed (§7.5); step 7 only ever pushes on a
terminal failure (§7.2/§12) — the one outcome nothing else in this design
will ever tell the physician about otherwise.

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

`scripts/setup-richmenu.mjs`, `mainPayload` — **written, not illustrative.**
The id comes from a required `UPLOAD_LIFF_ID` env var, validated at the top of
the script alongside `LINE_TOKEN`: Step 1 already creates a month-picker menu
and reassigns its alias, so a check placed next to the payload that uses it
would abort halfway and leave a new picker live with the main menu never
updated. A dead fourth block pushed to every user is worse than no fourth
block.

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

`src/richmenu.svg` — **built, rendered and eyeballed, not just specified.**
`viewBox="0 0 2500 1686"`, the three existing cards untouched at their
original coordinates, and a fourth full-width card in row 2 on a new `clay`
gradient (`#A68966` → `#5C4632`, design.md's own primary into its secondary
rather than a fourth invented hue — this is the only block that *writes*, so
it should read as the house colour, not as a fourth sibling).

Two things came out of actually rendering it rather than reasoning about it:

- **Row 2 is laid out horizontally — icon-left / text / chevron-right — where
  the three above stack vertically.** The first attempt centred an icon+text
  pair in the card, which left roughly a thousand pixels of void on the right
  and read as unfinished. The row grammar fills 2388px honestly, and the
  contrast against the vertical cards is doing useful work: those three go to
  a page, this one starts a task. The upload circle is aligned to card 1's
  circle (`cx=435`) so the two form a column rather than two unrelated
  placements.
- **The trophy's star was a tofu box (▯) in production and nobody had
  noticed.** It was a `&#9733;` `<text>` node; Noto Sans Thai has no glyph for
  U+2605, and `render.mjs` sets `loadSystemFonts:false` deliberately (for
  deterministic output across dev machines and CI runners), so there was no
  fallback font to rescue it. Replaced with a drawn `<polygon>`, which has no
  font dependency at all. Pre-existing bug, fixed in passing.

Rendered size is ~570 KB against LINE's 1 MB cap for rich-menu images — worth
re-checking after any future edit, since the cap is on the PNG, not the SVG.

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
          app.use("/lib",    express.static("lib"))          // ← §16's Flex builder
          app.post("/upload/score", express.json({limit:"8kb"}), …)  // ← §7.8
vercel.json:  includeFiles += "upload/**", "lib/**"
new files:    upload/index.html   upload/app.js   lib/line-receipt-flex.js
```

**The GET page really is a fourth consumer of machinery that already
exists** — `servePage("upload")` does the trailing-slash canonicalisation
with its `#`, the cookie → access-token refresh, the
`is_current_user_allowlisted()` check, the `no-store` header and the
`stampAssets` cache-busting, and `assets/auth-guard.js` already turns the
injected `<meta name="p4p-session">` token into an authenticated `P4P.db`
client. Two things beyond that page are **not** free, and an earlier draft
of this section claimed they were:

- **`/lib` needs its own static mount and its own `includeFiles` entry.**
  `main.js` mounts exactly `status`, `list`, `ranking`, `verify`, `admin`,
  `assets` — nothing serves `/lib/`, so §16's
  `<script src="/lib/line-receipt-flex.js">` would 404 in production while
  working fine locally against a dev server that serves the repo root.
  (`stampAssets` already resolves a leading-slash `src` from the repo root,
  so cache-busting needs no change — only the mount and the bundle entry.)
- **`POST /upload/score` is a route of its own, not part of `gatedPages`.**
  That loop registers `app.get` handlers only, and body parsing is per-route
  here (§7.8) — neither comes for free by adding `"upload"` to the array.

CSP: unchanged. `connect-src https://*.supabase.co` already covers
`/storage/v1/…` and `/rest/v1/rpc/…` — Storage is the same origin as
everything else Supabase.

### 5.2 Screen states

| State | Content |
|---|---|
| **Identity** | `นพ. สมชาย ใจดี — อายุรกรรม`, from `my_p4p_identity()`. Not editable. When `in_roster` comes back false: an **advisory** notice, never a block — "ไม่พบชื่อท่านในรายชื่อเดือนนี้ — ส่งได้ตามปกติ ระบบจะจับคู่ให้ภายหลัง", plus a "ติดต่อผู้ดูแล" link for the case where it really is wrong. See §5.5 for why this must not be the gate it looks like it should be. |
| **Month** | Six chips from `MONTH_ITERATOR` (`src/constants.cjs`), same accent colours as every other page, **defaulting to the previous month** — the month people are actually submitting for. Each chip shows this physician's own `submitted_at` if any ("ส่งแล้ว 12 มิ.ย. 14:32", readable under the existing 4-column grant) and the month's deadline. |
| **Deadline** | `กำหนดส่ง 10 ก.ค. 23:59`. Past it, an amber banner: the upload will still be recorded and scored, but ranking counts it as late. Say this **before** the upload, never after. |
| **File** | `<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">` — LINE's own picker, which reaches Files / Drive / iCloud. Client-side checks in §5.3. |
| **Confirm** | One sentence naming all three facts: *"ส่งไฟล์ `<name>` เป็นผลงานเดือน `<month>` ในชื่อ นพ. สมชาย ใจดี"* — the point where a wrong month or a wrong account is caught by the one person who can tell. |
| **Uploading** | XHR progress. These files are tens of KB; the bar exists for a bad connection, not a big file. |
| **Result — instant** | The common case (§7.7): `POST /upload/score` returns a score in ~1–2 s. Show it immediately — the same four facts as the LINE receipt (§7.4) — with no "please wait" in between. The page does not know or care that Drive archiving is still pending; that never surfaces here (§7.7 rec 2). |
| **Result — deferred** | The uncommon case: the response is `{ pending: true }` (§7.8). "กำลังตรวจสอบ — ระบบจะแจ้งผลทางแชท" + the live queue status, polled from `my_p4p_uploads()`, as a fallback for a physician still watching the page. The primary path to the result is the free chat message (§7.5), not this poll. |
| **Result — rejected** | The response is an `error` (§7.8) — e.g. `month_mismatch`. Show the reason and the retry affordance from the error taxonomy (§10) immediately; nothing was queued. |
| **History** | Last 10 uploads: month, time, status chip (รอตรวจ / สำเร็จ + คะแนน / ไม่สำเร็จ + เหตุผล). This is also the fallback if the chat notification is missed or dismissed. |

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

### 5.5 Who actually reaches this page — and three cases the gate alone does not serve

The gate (§5.1) settles *whether* someone gets in. It does not settle whether
the page then works for them. Walking the real user types found three cases
where it doesn't, all invisible if you only test as a fully-bound physician
whose name matches their roster row.

| Who | Reaches `/upload/`? | What they get |
|---|---|---|
| Active physician, LINE-bound, live session | yes, directly | the full flow |
| Active physician, LINE-bound, stale session | yes, after `/verify/`'s silent reauth bounces them back | the full flow, one extra redirect |
| **Active physician, never LINE-bound** | yes, after email OTP | uploads and scores fine — **but the deferred tier's chat notification cannot reach them.** Gap 1. |
| **Physician whose name is spelled differently in `physicians` vs the roster** | yes | `in_roster: false`, though they *are* in the roster. Gap 2. |
| Deactivated physician (`active = false`) | **no** | bounced at `servePage()` with `reason=blocked`; `enqueue_p4p_upload()` refuses independently. Correctly double-gated. |
| Not on the allow-list | **no** | never gets a session; lands on `/verify/`'s access-request form. |
| **Desktop / non-LINE browser** | yes — nothing stops them | Gap 3. |
| Admin | only if also an allow-listed physician | the `/admin/` panels (§7.7 rec 2) are their surface, not this page. |
| Department head | n/a | email recipient only; never touches this page. |

**Gap 1 — an unbound physician has no chat identity to notify.** §7.5's pull
mechanism resolves the queue row `source.userId` → `physicians.line_user_id`
→ latest row. With `line_user_id` null there is nothing to resolve, so the
ACK reply and the postback both fail. The *instant* tier is unaffected —
`liff.sendMessages()` posts as the user and needs no stored binding — so this
only bites the deferred tier, which is also the tier that most needs a
notification.

**Fix, and it is nearly free: bind opportunistically on first upload.**
`/upload/` is a LIFF app holding a live access token in its `<meta>` (§5.1),
and the machinery already exists — `supabase/functions/line-verify`'s
`mode: "bind"` takes exactly `{ access_token, id_token }`, validates the
session against GoTrue for the email and the ID token against LINE for the
`line_user_id`, and writes both onto the `physicians` row. So on page boot,
best-effort and non-blocking: `liff.getIDToken()` → if present, POST that
pair to the Edge Function. A physician who has only ever logged in by OTP
becomes bound the first time they open the upload page, and every later
notification works. Two preconditions, both already in Phase 0: the new LIFF
app needs the `openid` scope (else `getIDToken()` returns null and this
silently no-ops, which is the correct degradation), and it must sit under the
**same LINE Login channel** as `/verify/`'s app — `LINE_LOGIN_CHANNEL_ID` is
what the function checks the token's audience against, so an app registered
under a different Login channel fails that check.

**Gap 2 — `in_roster: false` is not "not in the roster".** It is "the *exact*
name match missed", which is the same condition that leaves `roster_index`
null (§6.3, §7.8) — and exactly the condition `matchName()`'s fuzzy matching
exists to rescue. Treating it as a blocking gate, which an earlier draft of
§5.2 did, locks a legitimate physician out of submitting entirely because two
records spell their name slightly differently. That is strictly worse than
the thing it was trying to prevent: a wrong-month upload is recoverable, a
physician who cannot submit at all is not. So it is advisory copy, and the
file goes through the deferred path where the fuzzy matcher gets its turn.
(`physicians.roster_name`, §6.6, is what actually shrinks this population.)

**Gap 3 — the desktop guard matters more here than on the read-only pages.**
`/status/`, `/list/` and `/ranking/` each check `/Line\//` in the UA and show
an "open via LINE" block. `/upload/` needs the same, and for a sharper
reason: outside the LIFF browser `liff.sendMessages()` is unavailable, so a
desktop upload would score correctly and then silently produce no chat
receipt at all — the physician sees the number on screen, closes the tab, and
has nothing to show for it. Reuse the same block the other three pages use.
Uploading from a desktop is not a use case worth supporting halfway.

---

## 6. Data model

> The SQL fragments below are excerpts for following the design's reasoning
> inline; the actual, complete, runnable migration is
> `scripts/line-upload-2026-09.sql` — same "VERIFY BEFORE ENABLING" spirit as
> `scripts/notify-access-request.sql`, but further along than a first draft:
> every statement in it has been executed against a real Postgres 16
> instance (bucket, table, both indexes, all five functions, all their
> grants), and its trickier logic — the enqueue happy path, the double-submit
> guard, a deferred roster match, three rejection classes, both claim
> functions' locking, and the archive backoff schedule at its exact hour
> boundaries — was exercised with real test data, not just read for
> plausibility. That is what caught the two real bugs the file's own header
> now documents: a missing `GRANT` on `p4p_upload_queue` for `service_role`
> (table-level grants and RLS's `BYPASSRLS` are two different things, and
> only testing under a role with neither surfaced the gap), and an off-by-one
> between the documented "1h, 2h, 4h…" archive backoff and what the original
> formula actually computed ("2h, 4h, 8h…"). Still not verified against a
> *real* Supabase project's actual `auth.jwt()`/PostgREST request shape or
> this project's real data — that step remains, per the file's own header
> and `SUPABASE_MIGRATIONS.md`'s hand-apply-via-SQL-Editor convention.

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

Object path — and the bucket name is **not** part of it:

```
storage.objects.name  =  <auth.uid()>/<month_key>/<uuid>.xlsx
      bucket_id       =  'p4p-uploads'   (a separate column)
```

Worth stating explicitly because the two are easy to conflate and the
mistake is silent-ish: `supabase.storage.from('p4p-uploads').upload(path,
file)` takes a path *within* the bucket, `storage.objects` stores that key in
`name` with `bucket_id` alongside it, and `(storage.foldername(name))[1]` in
the policy above is therefore the **uid**, not the bucket. `object_path` as
passed to `enqueue_p4p_upload()` (§6.3) follows the same convention — a
browser that helpfully prefixes `p4p-uploads/` would fail that RPC's
ownership check on every single upload, with an error message
("object_path does not belong to caller") that points at permissions rather
than at the extra path segment actually causing it.

The missing `SELECT` policy is the point. A physician can drop a file in and
can never read one back — not their own, not anyone else's. The bucket cannot
become a file-sharing service, cannot leak another physician's scorecard, and
has no listing surface. Only `service_role` (the worker) reads it.

### 6.2 `p4p_upload_queue`

Two independent lifecycles live on this one row, because §7.7 split them:
**scoring** (`status`) — did the number get read and saved — and **archiving**
(`archive_status`) — did the file reach Drive. A row can be scored (`status =
'done'`) for minutes or hours while `archive_status` is still catching up;
that gap is invisible to the physician by design (§7.7 rec 2) and is exactly
what the two columns exist to represent without conflating "scored" with
"fully processed."

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

  -- ── scoring lifecycle ──────────────────────────────────────────────────
  -- Set to 'done' either by /upload/score directly (service_role, the common
  -- high-confidence-tier case, §7.7/§7.8) or by claim_p4p_score_fallback()
  -- (§6.5, the uncommon low-confidence-tier case). enqueue_p4p_upload()
  -- itself never advances this past its 'pending' default — admitting a row
  -- is not scoring it.
  status        text        not null default 'pending'
                check (status in ('pending','processing','done','failed','rejected')),
  attempts      smallint    not null default 0,
  claimed_at    timestamptz,
  finished_at   timestamptz,
  error_type    text,                          -- mirrors automation ALERT_SUBJECTS keys
  error_detail  text,
  score         numeric,                       -- what was saved, for the history list
  score_method  text,                          -- resolveScore()'s method tag — which
                                                -- confidence tier resolved it (§7.7)
  notified_at   timestamptz,

  -- ── archive lifecycle — independent of `status` once scoring succeeds ──
  -- NULL until status='done'; then 'archive_pending' until Drive succeeds,
  -- then 'archived'. Deliberately NO failure value: per §7.7's recommendation
  -- on drawback 2, once the score is saved the physician has nothing left to
  -- fix, so this retries on backoff (§6.5) rather than ever terminating.
  archive_status          text
                check (archive_status in ('archive_pending','archived')),
  archive_attempts        smallint    not null default 0,
  archive_last_attempt_at timestamptz,
  archived_at             timestamptz
);

create index p4p_upload_queue_drain_idx
  on public.p4p_upload_queue (status, received_at)
  where status = 'pending';

-- Mirrors the index above for the other claim function (§6.5). Ordering by
-- received_at keeps both queues FIFO; the backoff check in the claim query
-- itself decides which archive_pending rows are actually due.
create index p4p_upload_queue_archive_idx
  on public.p4p_upload_queue (received_at)
  where archive_status = 'archive_pending';

-- One in-flight upload per physician per month. Makes queue flooding
-- structurally impossible rather than rate-limited — see §11 for the
-- narrower angle this doesn't cover (a scripted caller resubmitting as fast
-- as each row clears 'pending', now that clearing can take ~1-2 s instead of
-- however long a full pipeline run used to take).
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

**What this RPC does *not* do: score anything.** On insert, `status` takes its
`'pending'` default and `archive_status` is left `NULL` — a freshly-enqueued
row is admitted, not scored. Clearing `'pending'` is `/upload/score`'s job
(§7.8, the common case) or `claim_p4p_score_fallback()`'s (§6.5, the uncommon
one); `enqueue_p4p_upload()` returns before either runs.

**Why `/upload/score` needs no RPC of its own for its writes.** It runs inside
`main.js`, which already holds `SUPABASE_SERVICE_ROLE_KEY` (C4) — the same key
`/admin/api/*` already uses for direct REST calls today. So its writes
(`UPDATE p4p_upload_queue`, `saveScore()`, `logSubmission()`) go straight
through that key, exactly like the admin routes, needing no `SECURITY
DEFINER` wrapper. RPCs in this design exist only where the caller holds
nothing but the *user's* JWT: this function, `my_p4p_identity`, and
`my_p4p_uploads`.

**Concurrency note.** Step 5's pre-check and the `INSERT` are not atomic — a
double-tap on "ส่งไฟล์" (an easy thing to do waiting on a mobile network) can
pass the check twice before either row lands. The partial unique index in
§6.2 is the actual guarantee; the function body must catch `unique_violation`
around its own `INSERT` and re-raise it as the same friendly "ส่งไฟล์เดือนนี้
ไปแล้ว กำลังตรวจสอบ" the pre-check produces — not let a raw constraint
violation reach the physician as an unhandled 500.

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

### 6.5 Two claim functions, service_role only

One worker (§7.2), two things it might claim, with different predicates and
different retry rules — so two functions, not one flag on a shared one.

**`claim_p4p_score_fallback()`** — the uncommon, low-confidence-tier files
`/upload/score` deferred (§7.7 rec 1). For this slice the worker still *is*
the original single-pipeline design: full `processBuffer()`, three attempts,
then terminal.

```sql
update public.p4p_upload_queue q
   set status = 'processing', attempts = attempts + 1, claimed_at = now()
 where q.id = (
   select id from public.p4p_upload_queue
    where status = 'pending' and attempts < 3
      and (score_method is not null
           or received_at < now() - interval '30 seconds')
    order by received_at
    limit 1
    for update skip locked)
returning q.*;
```

**That last clause closes a race, it is not a refinement.**
`enqueue_p4p_upload()` inserts the row as `'pending'` and the browser calls
`POST /upload/score` a second or two later (§3, steps 3 → 4). Without a
guard, a drain tick landing in that window claims the row first — so a file
the synchronous path would have scored in ~1 s goes down the slow Claude
path instead, and `/upload/score` gets back a 409 the page has no good way
to explain to the physician. A plain age check alone would fix that but
delay *every* genuinely-deferred row by the same window, pushing the
deferred tier past the "under a minute" §7.3 promises. So `/upload/score`
stamps `score_method` on its deferral branch (the losing tier's own method
string — real data, and doubling as "the synchronous path has already looked
at this row"), and those rows stay claimable immediately. Only rows nobody
has looked at yet wait.

**`claim_p4p_archive()`** — every row with a saved score still waiting on
Drive, regardless of which tier scored it. No attempt cap and no terminal
state (§7.7 rec 2): once the score is saved the physician has nothing left to
fix, so this backs off rather than giving up — 1 h, 2 h, 4 h … capped at 24 h
between attempts on any one row.

```sql
update public.p4p_upload_queue q
   set archive_attempts = archive_attempts + 1,
       archive_last_attempt_at = now()
 where q.id = (
   select id from public.p4p_upload_queue
    where archive_status = 'archive_pending'
      and (archive_last_attempt_at is null
           or archive_last_attempt_at
              < now() - make_interval(hours => least(24, 2 ^ archive_attempts)))
    order by received_at
    limit 1
    for update skip locked)
returning q.*;
```

`FOR UPDATE SKIP LOCKED` is not expressible through PostgREST, which is why
both are RPCs rather than a client-side query — not privilege elevation:
`automation/`'s worker already calls Supabase as `service_role`, which
bypasses RLS on its own. It makes two overlapping drains (the hourly relay
overlapping a still-running loop) safe by construction rather than by a
`concurrency:` group alone.

**One drain loop, two claims, in a fixed order.** `drain-uploads.mjs` (§7.2)
tries `claim_p4p_archive()` first on every tick — the common case, and the
cheaper job: no Claude, no roster matching, just bytes to Drive — and falls
through to `claim_p4p_score_fallback()` only when that returns nothing. A row
the fallback claims runs the *full* `processBuffer()`, Drive upload included,
so it never separately enters the archive queue; one worker pass covers both
steps for that rare case.

**On indefinite retry and the object's lifetime.** "Never terminal" (rec 2)
should not quietly become "retain the raw file forever" — that widens §11's
retention posture without anyone deciding to. The backoff above already caps
the *interval* at 24 h; it does not cap the *count*. Past 30 days
(`received_at`, checked by the alerting step, not the claim query — retries
keep running), escalate the existing age-based alert from "look at this" to
"this needs a human decision," but do not stop retrying and do not delete the
object out from under it. Whether to actually give up is deliberately left to
a person, not a query.

### 6.6 Optional — `physicians.roster_name`

The exact match in §6.3 fails whenever `physicians.full_name` is spelled
differently from the roster's `firstname`/`lastname` — which is common enough
that `matchName()` exists at all. Adding a nullable `physicians.roster_name`,
written by the worker the first time its fuzzy match succeeds, turns every
later month into an exact hit and lets the UI answer "are you in this roster?"
correctly for everyone. Self-healing, one column, no new matcher.

**Re-rank this once §7.7 landed: it is not really optional any more.** A null
`roster_index` sends the row down the deferred path regardless of how
confident the score was (§7.8 step 5), because `saveScore()` cannot write
without a roster primary key. So every physician whose name is spelled
differently in the two places gets the slow path *every single month*,
permanently — not as a one-off. `roster_name` is what converts that from a
standing condition into a one-time cost per physician. If the Phase −1 log
audit is what decides whether the fast path is safe, this is what decides
how often it actually fires; worth measuring alongside it (one query:
how many `physicians.full_name` values exact-match a row in the current
month's roster?) rather than discovering it after launch.

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

`drain-uploads.mjs`, per iteration (§6.5 has the two claim queries this
alternates between):

1. `claim_p4p_archive()` — the common case. Download the object
   (service_role) → `extractFirstSheetBuffer` → `drive.uploadFile` →
   `archive_status = 'archived'` → delete the object. **No LINE message here**
   — the physician already has their receipt from `/upload/score` (§7.5/§7.8);
   this step is invisible by design (§7.7 rec 2). A failure leaves
   `archive_status = 'archive_pending'` for the next backoff-eligible attempt
   — never a push, never a Telegram beyond the age-based alert.
2. If (1) claims nothing, `claim_p4p_score_fallback()` — the uncommon case.
   Download the object → `processBuffer(..., { source:"line-upload", ... })`,
   which scores *and* archives in one pass (`status = 'done'` +
   `archive_status = 'archived'` together, or `status = 'failed'` with
   `error_type` after the third attempt) → delete the object on success.
   **Notification follows the same rule as everywhere else (§7.5): push on
   failure, pull on success.** The postback button (§7.5 step ②) was already
   placed in the chat at upload time, before either claim function runs — it
   does not need a score to exist yet, only a queued row — so a success here
   needs no push; the physician's next tap (or the page's own poll) reads the
   now-`'done'` row same as the common case. Only `status = 'failed'` pushes,
   because that is the one outcome the physician cannot simply wait out.

Loop until both claims return nothing or a per-run cap (say 25 across both) is
hit.

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

`drain-uploads.mjs` does not exit after one pass. It polls its two claim
functions (§6.5) every ~10 seconds for ~65 minutes, then exits and lets the
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

**Quota — and this whole subsection turned out to apply to a minority of
submissions, not all of them.** Everything below was written before §7.7
existed, when every result was async and every result therefore needed an
OA-sent message of some kind. §7.7 changes the premise: the common
(high-confidence) tier's score is known *synchronously*, inside the same page
load the physician is already looking at — it needs no reply, no push, and
not even the ACK/postback mechanism in §7.5. The page shows the score, and
`liff.sendMessages()` fires once, carrying the *actual* Flex receipt as the
physician's own message — free, and not a "reply" or a "push" in the sense
below at all (§7.5's table). Everything that follows here — the reply/push
distinction, the budget estimate, the push-only-on-failure lever — describes
the uncommon, low-confidence tier only: the files `/upload/score` defers to
`claim_p4p_score_fallback()` (§6.5), where the result genuinely isn't known
until a GitHub runner produces it later.

LINE counts push / multicast / narrowcast / broadcast against the Official
Account's monthly quota and does **not** count reply messages (the ones sent
with a `replyToken` in answer to a user's own message) at all. Two rules
follow from how the counting works:

- **A message is one delivery to one person, not one message object.** A push
  carrying a Flex bubble *and* a text note to one physician costs **1**, the
  same as either alone. So the receipt can be as rich as it needs to be —
  there is no reason to compress two ideas into one bubble to save quota.
- **A reply is not available for the deferred tier's result.** A `replyToken`
  only exists in answer to a webhook event and expires within about a minute;
  the deferred tier's result is produced under a minute later by a GitHub
  runner that never saw an event. There is no way to make that receipt free
  by turning it into a reply — which is exactly why §7.5's pull mechanism
  exists: not to make the *reply* free (it already is), but to make getting a
  *button into the chat* free, so the eventual answer can ride a fresh reply
  token whenever the physician taps it.

Budget: **only the deferred tier counts against quota, and only its terminal
failures at that** (§7.2/§12 — a deferred-tier success is pulled, never
pushed, via the same postback the ACK reply already placed). If the log audit
(§13 Phase −1) shows most files resolve at the high-confidence tier — the
premise the whole gate is built on — realistic push volume approaches the
poison-file rate alone: a handful a month, not one per physician. The
~200/physician/month estimate below is the number to plan against only if
that audit comes back the other way, or as a worst case:

at full adoption, if every submission somehow landed in the deferred tier and
every one of them pushed on both success and failure — the shape the design
had before §7.7 — that's one push per physician per month, order of 200, plus
retries and failure notices. That shares a quota with
`scripts/broadcast-flex.mjs`, where **one** carousel broadcast costs one
message *per follower* (another ~200). Two broadcasts plus a month of upload
receipts at that worst case is already ~600. Check the plan in LINE Official
Account Manager before rollout regardless of which number applies; Thailand's
free tier has historically been 500 messages/month, with paid plans well
above that, but the number moves and is not worth designing against from
memory.

**The lever this subsection used to propose as a fallback — push only on
failure, pull on success — is not a fallback anymore; §7.2/§7.5 already build
it as the default for the deferred tier.** It earns its keep more cheaply now
than it would have pre-§7.7, for the same reason the budget above shrank: it
only has to cover the minority of submissions the confidence gate defers, not
every submission.

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

**On the common (high-confidence) tier, this is the entire mechanism, end to
end.** §7.7's `/upload/score` already has the score by the time the page
calls this — it returns before `liff.sendMessages()` fires (§3, step 4 then
5) — so the page sends the *actual* Flex receipt directly, as the physician,
once. No trigger text, no webhook, no reply, no postback, no tap: everything
below exists to solve a problem — making an *asynchronous* result free — that
this tier simply does not have.

Everything from here on is about the tier that does have that problem: the
uncommon, low-confidence files `/upload/score` defers to
`claim_p4p_score_fallback()` (§6.5), where the score genuinely is not known
yet at the moment the page would otherwise announce it. Two documented limits
decide how far `liff.sendMessages()` gets us *there*:

- **A Flex or template sent this way fires no webhook.** LINE sends a webhook
  for the other message types but not for those two. So the clever chain —
  page posts a Flex as the user → bot receives it → bot replies free — does not
  exist. A **text** message does fire a webhook, and that reply token is real
  and free.
- **The page can only send what it already knows.** For this tier
  specifically: at the moment the page is still open, the file has only been
  deferred to the queue — the score arrives under a minute later from a
  GitHub runner (§7.3), not from this request. `liff.sendMessages()` can post
  *"📤 ส่งไฟล์ P4P เดือนมิถุนายน 2569"* for free; it cannot post a score that
  does not exist yet.

So the split, for the deferred tier only: **the acknowledgement can be free,
the score receipt cannot** — not while scoring is asynchronous.

#### The genuinely zero-push variant: pull instead of push (deferred tier only)

If the quota check comes back tight, this removes the last push — for the
deferred tier, the only one capable of pushing at all post-§7.7 (§7.4) —
without giving up the chat receipt:

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

#### The pull workflow, step by step (deferred tier only)

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
**And the obvious place to run that probe does not currently exist.**
`/preflight` lives in `web/app/preflight/` — the Next.js app C1 says is
written but *not deployed*. `main.js` has no such route and `vercel.json`
does not ship one, so "add a probe to `/preflight`" is, today, an
instruction to add it to a page no phone can reach. Whoever does this work
needs to either stand up a minimal `preflight/` page in the Express app
(cheapest: one static page behind the same `gatedPages` treatment, deleted
once the answer is known) or fold the `liff.getContext()` dump and
`sendMessages` probe into `/upload/` itself behind a `?probe=1` query — less
tidy, but it is the page whose LIFF context we actually care about, launched
the way we actually launch it.

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
   └─ queue row updated: status='done', archive_status='archive_pending'
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

### 7.8 `POST /upload/score` — request and response contract

The one new HTTP endpoint this design adds to `main.js`. Everything else the
browser talks to is either Supabase directly (Storage, the RPCs) or existing
Express routes. Every earlier section that says "the page calls
`/upload/score`" means exactly this.

**Auth.** Same *gate* as every physician page (§5.1) — session cookie →
refreshed access token → `is_current_user_allowlisted()` — but **not**
`servePage()` itself. That helper answers a failed check with
`res.redirect(302, "/verify/…")`, which is right for a navigation and wrong
for a `fetch()`: the browser follows the redirect transparently, the page
gets `/verify/`'s HTML back with a 200, and `await res.json()` throws a
parse error that looks nothing like "your session expired." This route
reuses the two underlying helpers (`resolveAccessToken`, then
`isCurrentUserAllowlisted`) and answers a failure with `401` + a JSON body
the page can branch on — bouncing the physician to `/verify/` is then the
page's decision, not a redirect it never asked to follow.

**Body parsing.** `main.js` attaches `express.json()` per route, not
globally (`/auth/session` and the two `/admin/api` writers each mount their
own). This route needs its own — `express.json({ limit: "8kb" })`, matching
`/auth/session`'s cap, since the body is one UUID — or `req.body` is
`undefined` and `queue_id` reads as a `TypeError` rather than a 400.

**Request**

```
POST /upload/score
Content-Type: application/json

{ "queue_id": "3fae1c9e-…-…-…-…" }
```

Deliberately just the id. Every fact this route needs — `object_path`,
`month_key`, `roster_index`, `email`, `full_name`, `department`,
`line_user_id` — is already on the row `enqueue_p4p_upload()` built (§6.3).
Accepting any of those again as request fields here would reopen exactly the
"identity/month as a client-supplied parameter" hole §11 closes everywhere
else — the id is the only thing the browser gets to name.

**What the handler does, in order:**

1. Re-fetch the row by `id` under `service_role`. 404 if missing, 409 if
   `status` is not `'pending'` (a retry of an already-resolved request, or a
   replayed one — either way there is nothing left to do).
2. Confirm the row's `email` matches the caller's own JWT email. The id is an
   opaque UUID handed back from the browser's own `enqueue` call moments
   earlier, not a secret — this check, not the lookup, is the actual access
   control, mirroring how `object_path` ownership is checked at enqueue time.
3. Download the object from Storage (`service_role`).
4. Everything from here down runs inside the guard from §11 and the
   `Promise.race` timeout from §7.7 rec 3 — a hostile or pathological file
   never reaches step 5 with the request still open.
5. `resolveScore()` → the confidence gate (§7.7 rec 1) branches. **Two
   conditions, not one** — a confident score is necessary but not sufficient:
   - **High-confidence tier AND `roster_index is not null`:** cross-check the
     file's own inferred month against `month_key` (§7.1's `month_mismatch`
     check) → `saveScore()` + `logSubmission()` (service role) →
     `UPDATE … SET status='done', score=…, score_method=…,
     archive_status='archive_pending', finished_at=now()` → respond with the
     score.
   - **Low-confidence tier, the parse timeout fired, or `roster_index is
     null`:** stamp `score_method` with whatever tier `resolveScore()` did
     land on (which is also what makes the row immediately claimable rather
     than waiting out the race guard, §6.5) and otherwise leave
     `status='pending'` as `enqueue_p4p_upload()` left it, so
     `claim_p4p_score_fallback()` picks it up on the worker's next pass →
     respond `{ pending: true }`.

   **Why `roster_index` gates this too.** `saveScore(date, index, score,
   submittedAt)` throws outright on a null index — it is the roster row's
   primary key, and there is no writing a score without one. `roster_index`
   is null exactly when §6.3's *exact* name match missed, which is precisely
   the case `matchName()`'s fuzzy matching exists to rescue — and that lives
   in JS, in the worker, by deliberate design (§6.3's "one fuzzy matcher"
   box). So a physician whose `physicians.full_name` is spelled even slightly
   differently from their roster row gets the deferred path every month, no
   matter how confidently their file states its total. That is the single
   biggest lever on how often the fast path actually fires, which makes
   `physicians.roster_name` (§6.6) less of an optional nicety than its
   "Phase 5, optional" label suggests — see the note there.
   - **A rejection** (`month_mismatch`, or the same corruption checks
     `processBuffer` already runs — no rows, < 3 non-null cells): `UPDATE …
     SET status='rejected', error_type=…, error_detail=…, finished_at=now()`
     → respond with the error. No retry follows a `rejected` row on either
     claim function — same as an enqueue-time rejection, nothing was ever
     eligible to begin with.

**Response shapes** — the page (§5.2) branches on exactly these three:

```json
// success — show the score now (Result — instant)
{ "score": 1842.50, "month_key": "2569_06", "is_late": false,
  "display_date": "มิถุนายน 2569" }

// deferred — poll my_p4p_uploads() (Result — deferred)
{ "pending": true }

// rejected — show the reason now, HTTP 422 (Result — rejected)
{ "error": "month_mismatch",
  "detail": "ไฟล์ระบุเดือน 2569_05 แต่เลือกส่งเดือน 2569_06" }
```

**What this route does not do.** It never calls Claude and never touches
Drive — both stay exclusively in `automation/`'s hands (C2), reached only
through the two claim functions in §6.5. A file this route can't confidently
score is deferred, never guessed at.

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
| `zero_score` | extracted score ≤ 0 | `/upload/score` (§7.8) for the high-confidence tier, `claim_p4p_score_fallback()`'s worker otherwise — same check either way, just two possible call sites now |
| `wrong_date` | month table missing | n/a — validated at enqueue |
| `physician_not_found` | no roster match | n/a — validated at enqueue |
| `other` | workbook unreadable / no rows / < 3 non-null cells | `/upload/score` or the fallback worker, same split as `zero_score` above |
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
| Queue flooding | Partial unique index: one in-flight upload per physician per month (§6.2), enforced on `status`, not on `archive_status` — archiving retries don't compete for the slot. Plus the 5 MB bucket cap and the `attempts < 3` claim filter on `claim_p4p_score_fallback()` specifically (`claim_p4p_archive()` has no attempt cap by design, §6.5/§7.7 rec 2, and doesn't need one — it isn't gated by `email`/`month_key` at all). |
| **Rapid resubmission, now that scoring is fast** | A sharper version of the row above: the high-confidence tier clears `'pending'` in ~1–2 s (§7.7), so the unique index's throttle window is now seconds, not minutes — a scripted caller with valid credentials could enqueue-and-score the same month dozens of times a minute, something the pre-§7.7 design's slower worker throttled for free. Mitigated, not open: every attempt still needs a real file `PUT` to Storage under a JWT `is_current_user_allowlisted()` already gated, which is nontrivial to script at volume without credentials that are themselves gated — but if `/admin/`'s upload-count visibility (§7.7's policy question) ever shows this happening, the fix is a per-user rate limit on `enqueue_p4p_upload()` itself, not a schema change. |
| **Zip bomb / hostile `.xlsx`** | Genuinely new exposure: today's workbooks arrive through Gmail, which scans them; these arrive raw. Before `ExcelJS.load()`, enumerate the zip with the JSZip dependency the pipeline already has and reject > 200 entries or > 50 MB uncompressed. **Put this in the shared loader so the email path gets it too** — it has the same weakness, just with a filter in front. On the Vercel side specifically this guard is paired with a parse timeout (§7.7 rec 3, §7.8 step 4) — the size/entry guard bounds memory, the timeout bounds CPU, and only Vercel's leg needs the second one, since a GitHub Actions runner has no request holding a physician's phone open while it works. |
| **Untrusted parsing runs inside a privileged process** | New with §7.7: a hostile workbook used to be opened only on a disposable GitHub runner; `/upload/score` (§7.8) now opens the same untrusted bytes inside the `main.js` Vercel function that holds `SUPABASE_SERVICE_ROLE_KEY` for the rest of its lifetime. The zip-guard and parse timeout above are the actual mitigation — this row exists so a security reviewer of just this table sees the exposure §7.7's own narrative already argues for, rather than needing to have read that section first. |
| Service-role key exposure | Stays in GitHub Actions and (as of §7.7) in Vercel's existing env — `/upload/score` reuses `SUPABASE_SERVICE_ROLE_KEY`, which `/admin/api/*` already holds there; nothing new is provisioned. The browser never sees it; the browser-facing RPCs stay `SECURITY DEFINER` with no key involved. |
| PII in a new place | Scorecards contain physician names and workload. They already live in Drive and Supabase. The bucket adds a *transient* copy, deleted once `archive_status = 'archived'` (§12) — ordinarily minutes, since scoring (which triggers `archive_pending`) is now itself fast. A stuck archive retries for up to 30 days before escalating to a human (§6.5) rather than deleting early or retaining silently forever — a deliberate middle point between "delete on a timer regardless of outcome" and "keep it indefinitely." Add it to `DATA_EXPOSURE_ANALYSIS.md` when this ships. |
| Replay of an old upload | `object_path` is unique. On the scoring track, a `status` past `'pending'` cannot be re-claimed by `claim_p4p_score_fallback()`. On the archive track, `archive_status = 'archived'` is excluded from `claim_p4p_archive()`'s predicate the same way — the object is gone by then regardless, so there is nothing left to replay against. |
| A repo-write token in the database | Avoided in the recommended design — that is exactly why §7.3 recommends the long-polling drain over `repository_dispatch`. |

---

## 12. Failure modes

**Two state machines on one row, because §7.7 split scoring from archiving —
§6.2 has both columns, §6.5 has both claim functions.**

*Scoring* (`status`): `pending → processing → done | failed | rejected`.
`rejected` is a validation refusal, at enqueue time or inside `/upload/score`
(§7.8) — never retried, on either claim function. `failed` is
`claim_p4p_score_fallback()` giving up after `attempts = 3` — a track that
only runs for the low-confidence tier §7.7 defers. The common,
high-confidence tier goes `pending → done` directly inside `/upload/score`'s
own request; there is no `processing` state on that leg, because there is
nothing to crash mid-way through — one synchronous call either finishes or it
doesn't, and a timeout (§7.7 rec 3) demotes it to the deferred case rather
than leaving it half-done.

*Archiving* (`archive_status`): `NULL → archive_pending → archived`, entered
the moment `status` becomes `done`, by whichever leg got it there. **No
failure value, on purpose** (§7.7 rec 2): once the score is saved the
physician has nothing left to fix, so this track backs off (§6.5) rather than
ever giving up.

**At-least-once, not exactly-once, on both tracks — for different reasons.**
On the scoring-fallback track, a runner that dies mid-`processBuffer` leaves a
row `processing` forever; a reaper in the same script releases rows
`processing` for > 15 minutes back to `pending`. On the archive track there is
no analogous stuck state to reap: claiming only ever increments
`archive_attempts` and stamps `archive_last_attempt_at` (§6.5) — it never
marks a row in a way that needs undoing, so a dead runner simply leaves the
next backoff window to expire on schedule. Both tracks share the reason this
is safe at all: the pipeline is idempotent per `(physician, month)` —
`saveScore` overwrites, `uploadFile` replaces by name, `logSubmission` ignores
duplicates — so a double-processed file produces exactly the same end state
either way.

**Poison file (scoring-fallback track only).** Three attempts, then `failed`,
then a Telegram alert to the admin (reusing `formatErrorMessage`) and a LINE
push to the physician (§7.2) — the one row on this whole design where success
*and* failure both need a push, since nothing else will ever notify this
physician about this file. The object is kept 7 days for diagnosis, then
removed by a cleanup step in the same workflow. A file that kills the worker
never blocks the queue: the claim filter is `attempts < 3`.

**Poison folder (archive track).** A permanently-missing Drive month folder
retries forever by design — no attempt cap exists to trip. The age-based
alert (§7.7 rec 2: an hour, escalated at 30 days per §6.5) is what turns
"will retry forever" into "someone eventually looked," not a claim-side
cutoff — and it never touches `status`, so the physician's receipt is
unaffected regardless of how long archiving takes.

**Concurrent drains.** `FOR UPDATE SKIP LOCKED` on both claim functions
(§6.5), plus a `concurrency:` group on the workflow. Two runners cannot claim
the same row on either track.

**Drive or Claude down.**
Scoring-fallback track: existing behaviour — `processBuffer` returns without
saving a score, and the row stays `pending` for the next claim.
Archive track: Drive down simply delays archiving. The score is already saved
and the physician already has their receipt; this is invisible to them by
design (§7.7 rec 2), which is exactly the point of separating the two tracks.

**Supabase Storage down at upload time.** The file never leaves the phone and
the physician sees an error immediately with a retry button. No half-state: the
queue row is only created *after* the object exists.

**The workflow is disabled or broken.** Rows accumulate — `pending` on the
scoring-fallback track, `archive_pending` on the archive track — and nothing
is lost. Worth an alert on both, not just one: a `pending` row older than 2
hours, or an `archive_pending` row older than a day, should fire the same
Telegram path the other triggers use.

**When does the storage object actually get deleted?** Only once
`archive_status` reaches `'archived'` — never merely on `status = 'done'`,
since the archive worker still needs the bytes after scoring finishes. A row
stuck in `archive_pending` keeps its object for as long as retries continue
(§6.5's 30-day escalation, not a deletion). Worth stating plainly here because
§11's "objects are deleted after processing" reads as "after scoring" if you
don't already know the two tracks are separate.

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

1. **Register LIFF app #5** in the LINE Developers console — **done**:
   `2008561527-sj7tuMLL`, on the same Login channel (`2008561527`) as the
   other four. Scopes must include `chat_message.write` alongside
   `profile` + `openid`: the first is what lets the page put the receipt in
   the chat for free (§7.5), the second is what makes `getIDToken()` — and
   therefore the opportunistic bind (§5.5 gap 1) — work at all. The id is
   not a secret (it ships in the rich menu's `uri` action and in the page's
   own HTML), so `main.js` and `drain-uploads.mjs` both carry it as a
   fallback with `UPLOAD_LIFF_ID` overriding, rather than failing silently
   when an env var is missed. The `liff.getContext()` + `sendMessages` probe
   §7.5 calls for lives at `/upload/?probe=1`.
2. Create the bucket and run the SQL in §6 — **done** (applied to the live
   project 2026-09-05, and listed as step 18 in `SUPABASE_MIGRATIONS.md`).
   Verified after the fact rather than assumed: all five function bodies
   hash-identical to the repo file, both claim functions returning a genuinely
   empty set on an empty queue, the deadline arithmetic matching
   `deadlineISO()`'s two documented cases, and the enqueue gate refusing an
   unauthenticated caller, a foreign `object_path`, and a non-roster
   `p_month`. Measured at the same time, since it decides how often the fast
   path actually fires: **178 of 222** active physicians exact-match the
   current month's roster, 0 are ambiguous, and 45 have a `line_user_id`.
3. Check the LINE Official Account's message-quota plan against the worst-case
   budget in §7.4 — a sanity floor now, not a blocking decision, since §7.7
   means only deferred-tier terminal failures ever push (open question 7). No
   new secret either way — `LINE_ACCESS_TOKEN` / `LINE_TOKEN` are already
   GitHub Actions secrets.

**Phase 1 — the synchronous score path, testable with no UI.**
This is now the core of the feature, not the worker — §7.7 moved it here.
`POST /upload/score` in `main.js`: lazy-`require("exceljs")`, the zip-guard +
parse timeout from §7.7/§11, `resolveScore()`'s confidence gate, `saveScore()`
+ `logSubmission()` via service role. Verify by POSTing a file with a
service-role-authenticated request before any page code exists. This is also
where the vendored-copy-plus-parity-test from §7.7's recommendation 5 gets
built, alongside the `automation/` copy it must never drift from.

**Phase 2 — the worker and the deferred-tier notification chain.**
The long-polling drain (§7.3) tries `claim_p4p_archive()` first on every tick
— `extractFirstSheetBuffer` → `drive.uploadFile`, retried indefinitely, never
terminal, per §7.7's recommendation 2 — and falls through to
`claim_p4p_score_fallback()` (full `processBuffer()`, three attempts) only
when that finds nothing (§6.5/§7.2). Alongside it, for the deferred tier
only: the `sendMessages`(trigger text) → free-reply-with-postback →
free-reply-with-receipt-or-failure chain from §7.5, plus its rich-menu-postback
fallback, built and tested regardless of which the `/preflight` probe from
Phase 0 recommends. The common tier's notification (§7.5: the page sends the
real receipt directly, once, as soon as Phase 1's `/upload/score` returns)
needs no chain at all and ships with Phase 1, not here.

**Phase 3 — the page.** `upload/index.html`, `upload/app.js`, the `gatedPages`
entry, the static mounts, `vercel.json`. Reachable by URL, not linked from
anywhere. Includes §5.5's three: the desktop guard, the advisory (never
blocking) `in_roster` copy, and the boot-time opportunistic bind. Test with
two or three volunteers — and make sure at least one of them is a physician
who has only ever logged in by email OTP, since that is the case §5.5's
Gap 1 is about and it is invisible when testing as a bound account.

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

**Process the *full pipeline* inside the Vercel request.** Needs
`ANTHROPIC_API_KEY`, the Google refresh token and `P4P_FOLDER_ID` copied into
Vercel, plus `exceljs`, `jszip`, `googleapis` and `@anthropic-ai/sdk` in the
**root** `package.json` — which is what production builds from (C8). It also
has to finish inside the function's execution budget while Claude and Drive
take their time (C3). Rejected on all three counts.

**This is not what §7.7 later adopts, and it's worth being explicit about
why not.** §7.7 moves only the JS-only, no-network scoring arithmetic into
Vercel — for a confidence-gated subset of files, with a hard timeout — and
Claude and Drive both stay exactly where this section leaves them, reached
only through `automation/`'s two claim functions (§6.5). None of the three
objections above apply to that narrower slice: no Anthropic or Google
credential moves, no `googleapis`/`@anthropic-ai/sdk` enters the root build
(only `exceljs`, conceded and gated in §7.7 rec 4), and the execution budget
holds because there is no Claude round-trip or Drive upload inside the
request — which is exactly why §7.7 rec 3 still wraps even that narrower
slice in its own timeout rather than trusting the absence of a network call
to bound it.

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
5. **Retention — substantially settled, one number left to pick.** §6.5/§12
   now answer the shape of it: delete on `archived_at`, not on `status='done'`
   or on a fixed 7-day timer; a stuck archive backs off for up to 30 days
   before escalating to a human, and retries (not the object) continue past
   that point until someone decides otherwise. What's left is just the
   number — is 30 days the right point to escalate, or should it be sooner,
   given the object is a physician's scorecard sitting in a bucket the whole
   time?
6. **The long-polling drain (§7.3)** gets pickup to ~10 seconds with no new
   token, at the cost of a job that idles waiting for work. Comfortable with
   that reading of GitHub's Actions policy, or fall back to a `*/5` cron and
   a 3–8 minute wait?
7. **Push or pull for the result — mostly moot now, worth confirming once.**
   §7.7 means only the low-confidence tier's *terminal failures* ever push at
   all (§7.2/§7.4/§12) — everything else is either the free instant receipt
   or a free pull. Realistic volume is close to the poison-file rate, not the
   ~200/physician/month this question originally asked about. Still worth the
   one-time plan check in §7.4 as a sanity floor — mainly to catch the case
   where the confidence gate is defeating itself and most files are landing
   in the deferred tier, which is also exactly what Phase −1's log audit is
   for.

---

## 16. Change inventory

| File | Change |
|---|---|
| `src/richmenu.svg` | **done** — `2500×1686`, fourth full-width block on a new `clay` gradient, row-2 horizontal composition, and the trophy's tofu-box star replaced with a drawn polygon (§4.2) |
| `src/richmenu_bg.png` | **done** — regenerated from the SVG (~570 KB, within LINE's 1 MB cap). Not read by any code; `setup-richmenu.mjs` renders the SVG at upload time. Kept as the checked-in preview of what actually ships |
| `scripts/setup-richmenu.mjs` | **done** — `2500×1686`, fourth area → `UPLOAD_LIFF_ID`, validated up front; a `ดูผลล่าสุด` postback area still to add *only if* §7.5's fallback submenu proves necessary |
| `upload/index.html`, `upload/app.js` | **done** — the page; calls `POST /upload/score` and `liff.sendMessages()`. Also carries the same `/Line\//` desktop guard the other three pages use, and a best-effort `line-verify` `mode:"bind"` call on boot so OTP-only physicians get a `line_user_id` (both §5.5) |
| `assets/shared.js` | **done** — month window / deadline / file-validation helpers (shared with the eventual `web/` port) |
| `package.json` (root) | **done** — new dependency `exceljs`, lazy-`require`d only inside the upload handler (§7.7 rec 4) |
| `lib/p4p-score.js` (root, **new**) | **done** — vendored copy of `resolveScore`/`extractScoreFromRows` + the zip-guard/parse-timeout wrapper — kept honest by the parity test below (§7.7 rec 5) |
| `main.js` | **done** — `gatedPages` += `"upload"`; static mounts for **both** `/upload` and `/lib` (§5.1 — nothing serves `/lib/` today); **new** `POST /upload/score` route per the §7.8 contract, with its own `express.json()` since body parsing here is per-route; `/line` handler gains the deferred-tier trigger-text / postback branch (§7.5) |
| `vercel.json` | **done** — `includeFiles` += `"upload/**"`, `"lib/**"` |
| ~~`preflight/`~~ → `?probe=1` on `/upload/` | **done** — built as the query-mode variant rather than a throwaway page: somewhere to actually run §7.5's `liff.getContext()` + `sendMessages` probe. The existing `/preflight` is in the undeployed `web/` app (C1), so the Phase 0 verification step has no reachable home until this exists. Throwaway — delete once the answer is known. |
| `scripts/line-upload-2026-09.sql` | **written and execution-tested against a real (stubbed) Postgres 16** — bucket, policies, `p4p_upload_queue` (both `status` and `archive_status` lifecycles, §6.2), `enqueue_p4p_upload`, `my_p4p_identity`, `my_p4p_uploads`, `claim_p4p_score_fallback`, `claim_p4p_archive` (§6.3–6.5). Not yet run against a real Supabase project — see the file's own header. |
| `automation/index.js` | **done** — `processBuffer()` gains `source` / `identity` / `monthKey` / `notify`; email path passes `null` and is unchanged |
| `automation/upload-queue.js` | **done** — thin wrapper over `claim_p4p_archive()` and `claim_p4p_score_fallback()` (§6.5); the archive claim retries indefinitely on backoff, the fallback claim terminates at 3 attempts (§7.7 rec 2) |
| `automation/line-push.js` | **done** — LINE push transport for the failure case only; success is a free reply (§7.5), not a push |
| `lib/line-receipt-flex.js` (root, **new**) | **done** — the success-receipt builder (§7.4's visual spec), written with no `window`/`document` reference so it loads two ways from one file: `require()`d by `main.js` (same root tree, no isolation boundary — needed for the deferred tier's postback-triggered reply, §7.5 step ④) and `<script src="/lib/line-receipt-flex.js">`'d by `upload/index.html` (needed for the common tier's own `liff.sendMessages()` call, §7.5). Root and browser can share this way because nothing isolates them from each other (unlike `automation/`, C8) — one file, one visual spec, two runtimes. |
| `automation/templates/line-receipt.js` | **done**, and **not** the same file as the row above — `automation/`'s C8 isolation means it cannot `require()` anything under root `lib/` regardless of module format. Builds the one thing this runtime ever sends: the failure bubble pushed for a terminal fallback-tier failure (§7.2/§12). A small, presentation-only duplication of the success bubble's *shape*, accepted rather than solved — lower-stakes than `resolveScore()`'s duplication (§7.7 rec 5), which is why it doesn't get the same parity-test treatment. |
| `supabase/functions/line-verify` | **unchanged** — `/upload/` reuses its existing `mode:"bind"` for the §5.5 opportunistic binding. Listed only so nobody re-implements binding; the precondition is that the new LIFF app sits under the same LINE Login channel, per §13 Phase 0 |
| `automation/telegram.js` | **done** — optional `source`/`account` block on `formatResultMessage` / `formatErrorMessage` (§7.6); email-path output unchanged |
| `automation/scripts/drain-uploads.mjs` | **done** — long-polling drain (archive first, then score fallback) (§7.3), plus the `archive_pending` age alert (§7.7 rec 2) |
| `.github/workflows/upload-drain.yml` | **done** — hourly relay + `workflow_dispatch`; the loop, not the schedule, is the trigger (§7.3) |
| `automation/test/*`, root-level test suite | **done** — `lib/__tests__/` (parity, confidence gate, zip guard + parse timeout, deadline/month-window/picker checks; `npm test` at the root) and `automation/test/` (Telegram layouts on both paths, the failure bubble). The parity guard was verified to actually fail on a one-digit drift, not just to pass. |
| `/admin/` (`AdminClient.tsx` or `admin/app.js`, `web/app/admin/api/…`) | new panel for `archive_pending` age and re-upload counts (§7.7 rec 2 and the policy question) — Phase 5, built only if usage shows it's needed |
| `SUPABASE_TABLES.md`, `DATA_EXPOSURE_ANALYSIS.md`, `SECURITY_ANALYSIS.md` | document the queue table and the bucket |
| `REACT_REWRITE_PLAN.md` | add `/upload/` to the phase list |
