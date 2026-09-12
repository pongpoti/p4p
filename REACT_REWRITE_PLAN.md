# React Rewrite Plan — P4P LIFF Front End

> **2026-08 update — the auth model this plan targets has changed.**
> Everywhere below that says "transcribed from `main.js`, no behaviour
> changes" for the gate/bind/verify logic no longer applies: `main.js`
> itself was rewritten (see `scripts/auth-rewrite-2026-08.sql`,
> `supabase/functions/line-verify`, and `SECURITY_ANALYSIS.md`'s
> superseded-notice) to drop `LINE_BIND_ENFORCE`, the bind-attempt/fail-open
> machinery, the bind-loop cookie, and `/line/bind` + `/line/silent-auth` as
> routes on this server — LINE verification and the `physicians` write now
> live in a Supabase Edge Function, called directly from the browser. Phase
> 1 and Phase 5 below should port the **new**, simpler design (one boolean
> gate check, no bind step in `/verify/`'s UI, LINE identity captured once on
> load and reused) rather than reproduce the old state machine this plan
> describes in detail. The URL-shape and CSP contracts in §1 are unaffected.

**Status:** Phases 0–4 implemented in [`web/`](web/). Phase 5 (`/verify/`) implemented
2026-09. Phases 6–7 still proposed, and now blocked on the gap documented in §1b below.
**Scope:** the four physician pages (`/verify/`, `/status/`, `/list/`, `/ranking/`), the
**`/admin/` roster dashboard** (§1a), the shared browser helpers in `assets/`, and the HTTP
surface of `main.js` (gate, session, admin API, webhooks).
**Explicitly out of scope:** `automation/`, `process/`, `scripts/`, and every SQL migration.
No database schema changes. The LINE Flex-message builders move file but keep their logic
byte-for-byte.

> **2026-09 update — a real gap found while resuming this plan, and one open question
> about Phase 6 that a previous attempt left unanswered.**
>
> 1. **`/upload/` is not in this plan's scope anywhere above, and has no `web/` port.**
>    It was added to `main.js` (see `UPLOAD_VIA_LINE_DESIGN.md`, commit `c972703`) after this
>    plan was written: a fifth gated page (LINE rich-menu file upload), plus the
>    `POST /upload/score` route (main.js's single largest handler — synchronous Excel
>    scoring, the confidence gate, Supabase Storage read, roster write, Telegram alert) and
>    postback/message handling in the `/line` webhook (`buildUploadResultMessage`, the
>    "ส่งไฟล์ P4P"/"ดูผลคะแนน" triggers). None of it is mentioned in §1's table, §2's target
>    architecture, or §7's phasing. **Phase 6 cannot retire `main.js` until `/upload/` either
>    gets its own phase (design + build + the same staging-LIFF verification every other
>    physician page needed) or a hybrid routing plan is worked out that leaves it on
>    Express indefinitely.** Treat this as a real scoping gap, not an oversight to route
>    around silently.
> 2. **One dual-routing attempt exists in git history with no recorded reason for its
>    revert.** Commit `2928626` ("Route /admin/\* and /_next/\* to the Next.js rewrite,
>    alongside Express") added a second `@vercel/next` build to `vercel.json` and routed
>    `/admin`, `/admin/*`, `/_next/*` to it while leaving Express as the catch-all for
>    everything else; it was reverted 81 seconds later by commit `2bcf93b`, whose message is
>    the bare auto-generated revert text — no PR discussion, no follow-up note anywhere in
>    this repo explaining why. Before Phase 6 attempts anything resembling that dual-build
>    routing again, reproduce it on a preview deployment and find out what actually broke
>    (build failure? routing swallowing non-admin paths? doubled cold starts? or simply an
>    abandoned experiment?) rather than assuming it is safe to redo.
> 3. **The Telegram webhook path in §1's contract is stale.** `/telegram/webhook` does not
>    exist in `main.js` today (grep finds none) — Telegram is outbound-alert-only now
>    (`lib/telegram-notify.ts`), the old inline-button approve/reject flow having been
>    replaced by the `/admin/` dashboard. Nothing to port there; §1 point 2's file list can
>    drop it whenever this doc is next revised.

---

## 0. Decisions taken

Three questions were open in the first draft. All three are now answered **yes**, and they
reshape the plan considerably:

| # | Decision | Consequence |
|---|---|---|
| 1 | **Next.js is the target**, not a later option | The Express server is replaced, not preserved. The gate becomes middleware. This is now the largest and riskiest part of the work, so it moves early rather than being avoided. |
| 2 | **Visual redesign is in scope** | No pixel-faithful CSS port. The four pages get one shared design system instead of four divergent stylesheets. Styling recommendation flips from CSS Modules to Tailwind (§4). |
| 3 | **`/verify/` can take a maintenance window** | A single clean cutover beats a hybrid Express/Next deployment. Combined with staging LIFF apps (§5), this removes most of the deployment risk. |

Decision 1 removes the main argument the first draft made for Vite, and decision 2 removes
the main argument it made for CSS Modules. Both recommendations are therefore reversed here
on purpose — the reasoning behind them was conditional, and the conditions changed.

One thing does **not** change: the gate rewrite stays its own phase, separate from the view
layer. It is the code with the incident history, and it should be reviewable on its own.

---

## 1. What exists today

| Area | Files | Size | Notes |
|---|---|---|---|
| Server / gate | `main.js` | 823 lines | Express on Vercel. Session cookie, token refresh, LINE-bind gate, page templating, LINE + Telegram webhooks. |
| Verify page | `verify/index.html` + `verify/app.js` | 313 + 552 | OTP login, access-request form, silent LINE-bind flow. |
| Status page | `status/index.html` + `status/app.js` | 385 + 344 | Per-month sent/pending roster, search, group-by-department. |
| List page | `list/index.html` + `list/app.js` | 337 + 318 | Month picker, sortable/paginated physician table. |
| Ranking page | `ranking/index.html` + `ranking/app.js` | 325 + 152 | 24 month tabs, on-time submission timeline. |
| **Admin dashboard** | `admin/index.html` + `admin/app.js` | 336 + 405 | Roster CRUD. Separate auth, no LIFF — see §1a. |
| Shared browser | `assets/shared.js`, `assets/auth-guard.js` | 75 + 51 | Constants, `escHtml`, the client half of the auth gate. |
| Shared server | `src/constants.cjs` | — | Month names + colors, duplicated from `assets/shared.js`. |

No build step, no front-end tests, ~1,600 lines of CSS with the same design tokens
copy-pasted into five files.

### 1a. The admin dashboard is a different kind of page

Added after the first version of this plan, so it is called out separately: `/admin/` shares
almost none of the assumptions the other four pages are built on.

| | The four physician pages | `/admin/` |
|---|---|---|
| Who | ~200 physicians | exactly one admin |
| Opened in | LINE's webview only | **any mobile browser** — the gate is `/Mobi\|Android\|iPhone/`, not `Line/` |
| LIFF | one registered LIFF app each | **none** |
| Auth | Supabase OTP + session cookie + LINE bind | LINE DM → signed link → `p4p_admin` HMAC cookie |
| Talks to Supabase | yes, from the browser, under RLS | **no** — browser only calls same-origin `/admin/api/*` |
| Service-role key | never involved | held server-side by every `/admin/api/*` route |

The auth flow: the admin DMs `admin` to the LINE bot; the webhook signature authenticates
`event.source.userId` against `ADMIN_LINE_USER_ID`; the bot replies with a short-lived signed
link; visiting `/admin/login?token=…` sets a 90-day HMAC session cookie. The tokens are
stateless, signed with `LINE_CHANNEL_SECRET + ":" + SUPABASE_SERVICE_ROLE_KEY`, with the
purpose mixed into the HMAC so a login token cannot be replayed as a session cookie.

Two consequences that matter for the migration, both good:

1. **It needs no staging LIFF app.** It can be built *and fully verified* on a plain Vercel
   preview URL in a phone browser, today, with nothing pending in the LINE console. That
   makes it the one page that can proceed while §5 is blocked — see §7.
2. **It never touches Supabase from the browser**, so it is unaffected by the auth-guard,
   token-injection and RLS machinery that dominates the other four pages. Its port is a
   straight UI conversion plus six route handlers.

The generic CRUD is driven by live column introspection (`admin_table_columns`), so the
rewrite must stay schema-agnostic — the form fields are generated from `data_type`, not
hardcoded. Do not "improve" this into a typed form for today's columns; new months are
provisioned with whatever shape `provision_month()` gives them.

### The contract — behaviours that must survive the rewrite

These have incident history behind them (see the comment blocks in `main.js` and
`verify/app.js`, and the `2026-08` notes). They are requirements, not implementation detail:

1. **URL shapes.** `/status/`, `/list/`, `/ranking/` serve at the trailing-slash form, with a
   302 from the bare path that appends **a fragment of our own** — this stops LINE's iOS
   webview carrying forward a stale fragment left by a *different* LIFF app. `/verify` and
   `/verify/` are both served directly with **no redirect between them**, because that
   redirect destroyed LIFF's `#access_token=…` login fragment and produced an infinite
   reload loop.

   **Implementation note (Phase 1).** The Express app used a bare `#`. Next will not emit
   one: `NextResponse.redirect()` serialises through NextURL and drops an empty fragment;
   a relative `Location` on a plain `Response` is rejected with `ERR_INVALID_URL`; and
   absolutising it first still loses the fragment when Next re-normalises the header. All
   three were measured against the emitted bytes, not assumed. The fragment is therefore
   `#_` — inert (`liff.init()` looks for `access_token=`, which it does not contain), and
   behaviourally identical in the webview. See `web/lib/gate/targets.ts`, which exists
   purely so this is unit-testable.
2. **Webhook and API paths.** `/line`, `/telegram/webhook`, `/auth/session`, `/line/bind`,
   plus the admin surface: `/admin/login`, `/admin/logout`, and
   `/admin/api/tables[/:table/{columns,rows[/:index]}]`. These are registered with LINE and
   Telegram externally; keeping them identical means no re-registration at cutover, which is
   one less thing to get wrong during the window.

   `ADMIN_BASE_URL` (default `https://p4p-sakhonmso.vercel.app`) is baked into the login link
   the bot sends. It must point at whichever deployment is live, so it is a **cutover
   checklist item**, and it must NOT be pointed at a preview while production is still on
   Express — that would send the admin's login link to the wrong app.
3. **LIFF app identity.** Each entry point is a separate LIFF app whose registered Endpoint
   URL must match the page it runs on: `2008561527-BXrxUUDb` and `2008561527-wyje9amz`
   (rich menu), `2008561527-a0xP1XmY` (month picker → `/status/`), `2008561527-AShTrJz0`
   (`/verify/`).
4. **Token never persists client-side.** LINE's in-app webview is unreliable at it. The
   server resolves the access token per request and hands it to the page.
5. **The bind flow's fail-open.** Three recorded failures then let the user through; a
   `mismatch` never counts toward that limit; a retry re-uses the same access token and never
   re-runs `verifyOtp` (OTP codes are single-use).
6. **The `p4p_bindloop` cookie backstop.** Pure server state, deliberately independent of
   Supabase, LINE, and client JS. Port it as-is.
7. **`LINE_BIND_ENFORCE` staged rollout semantics**, including the detect-only fail-open.
8. **No `unsafe-inline` on `script-src`.** See §6 — Next.js makes this harder, not easier.
9. **Thai copy.** Wording is reviewed and in production use. A redesign changes layout and
   visual language; it does not silently reword the UI.

---

## 2. Target architecture

**Next.js (App Router) + TypeScript, deployed on Vercel, replacing the Express server.**

```
app/
  layout.tsx
  verify/page.tsx           → /verify   (+ /verify/ via middleware rewrite)
  status/page.tsx           → /status/
  list/page.tsx             → /list/
  ranking/page.tsx          → /ranking/
  admin/page.tsx            → /admin/   (own auth, no LIFF — §1a)
  admin/login/route.ts      → GET  /admin/login
  admin/logout/route.ts     → POST /admin/logout
  admin/api/…/route.ts      → the six roster CRUD endpoints
  auth/session/route.ts     → POST /auth/session
  line/route.ts             → POST /line            (LINE bot webhook)
  line/bind/route.ts        → POST /line/bind
  telegram/webhook/route.ts → POST /telegram/webhook
middleware.ts               ← the gate + CSP nonce + URL canonicalisation
lib/
  gate/                     cookies, token refresh, gate RPC, bind-loop backstop
  admin/                    HMAC token sign/verify, service-role RPC helper
  line/                     LIFF helpers, Flex builders (moved from main.js verbatim)
  months.ts colors.ts departments.ts
components/                 the design system (§4)
```

### The gate becomes middleware

`servePage()` maps almost one-to-one onto a Next middleware. The order of operations is
identical, which is the point — this should read as a transcription, not a redesign:

| `main.js` today | Next equivalent |
|---|---|
| trailing-slash redirect with literal `#` | `NextResponse.redirect` in middleware, same literal `#` |
| `resolveAccessToken` (cached `at`, refresh near expiry, rotate cookie) | same logic in `lib/gate`, `fetch` instead of `axios` |
| `getLineBindGateStatus` RPC | same, `fetch` |
| `is_blocked` / `session_revoked` / `wantsBindRedirect` branches | same, unchanged |
| `p4p_bindloop` cookie backstop | same, `NextResponse.cookies` |
| `pageTemplates[name].replace(PAGE_TOKEN_PLACEHOLDER, at)` | **deleted** — middleware forwards the token as an `x-p4p-access-token` request header; the Server Component reads it via `headers()` and passes it to the client component as a prop |

Dropping the string-replace placeholder is the one genuine improvement the migration buys on
the server side: no `__P4P_ACCESS_TOKEN__` sentinel, no risk of an un-replaced placeholder
reaching the browser, and no `fs.readFileSync` of HTML at module load.

**Runtime note.** Middleware must resolve the token and call the gate RPC — both plain
`fetch`, both Edge-safe. The JWT payload read is `atob` + `JSON.parse`, also Edge-safe. The
service-role key stays out of middleware entirely; it is only needed in
`app/line/bind/route.ts`, `app/telegram/webhook/route.ts` and every `app/admin/api/*`
route — all Node runtime.

**The admin routes do not go through the physician gate.** `requireAdmin` is its own check
against the `p4p_admin` cookie, and the middleware matcher must exclude `/admin/*` so an
admin is never bounced to `/verify/`. Keep the two auth systems textually separate in
`lib/gate/` and `lib/admin/`; they answer different questions and share nothing but the
cookie-parsing helper. The admin HMAC needs `crypto.timingSafeEqual`, which is Node-only —
another reason those routes are not Edge.

### `/verify` and `/verify/` with no redirect

Next's `trailingSlash` config canonicalises with a 308 either way, which is exactly the
redirect that broke LIFF login. The fix is a middleware **rewrite** (internal, no navigation,
no `Location` header) so both paths render the same route. *This needs confirming on staging
before Phase 5 — it is the single most likely place for the old bug to reappear.*

### Webhook handlers

`line.middleware(config)` from `@line/bot-sdk` is Express-shaped and does not survive.
Replace it with the SDK's standalone `validateSignature(rawBody, channelSecret, signature)`
against the `x-line-signature` header, reading the raw body via `await req.text()` before
parsing. `export const runtime = "nodejs"` on that route.

The Telegram handler already does its own secret-header comparison and needs no signature
work — but keep the comment explaining why it responds only *after* all outbound calls
finish. That comment documents a real Vercel freeze-on-response bug and applies equally to
route handlers.

---

## 3. Dependencies

| Package | Why |
|---|---|
| `next`, `react`, `react-dom`, `typescript` | The rewrite. |
| `@supabase/supabase-js` | **npm, not the jsDelivr UMD bundle.** Removes a CDN origin and the SRI-pinning maintenance. |
| `@line/liff` | **npm, not `static.line-scdn.net`.** Removes the one CDN script that *cannot* be SRI-pinned, because LINE requires its unversioned auto-updating URL. Needs a compatibility check against the real LINE client in Phase 0 — if it diverges, keep the CDN tag and leave that origin in the CSP. |
| `@line/bot-sdk` | Kept, for `validateSignature` and `MessagingApiClient`. |
| `tailwindcss` | See §4. |
| `@radix-ui/react-{select,tabs,collapsible}` | Three genuinely fiddly widgets, correct keyboard/ARIA behaviour for free. Not a full component framework. |
| `@tanstack/react-query` | Ranking has 24 month tabs and refetches on every tab click today. |
| `vitest`, `@testing-library/react`, `jsdom` | Front-end tests, which currently do not exist. |
| `zod` | Validating the `sheetname` URL param and webhook payload shapes. |

`express` and `axios` are dropped.

---

## 4. Design system (redesign in scope)

Today the four pages look like three different products: `/status/` has a bare header,
`/list/` has a brand header with a live clock and a footer, `/ranking/` has a hero band with
scrolling tabs. Unifying them is most of the value of decision 2.

**Tailwind, not CSS Modules.** The first draft recommended CSS Modules specifically so a
pixel-faithful port would keep visual regressions attributable. With a redesign in scope
there is no port to be faithful to — every rule is being rewritten regardless — and
Tailwind's constraint-based scale is the better fit for building one consistent system
across four pages. `design.md`'s tokens become the Tailwind theme, so the palette,
type scale and radius have exactly one definition:

```
--color-primary: #A68966    --font-display: Manrope
--color-secondary: #4B3D33  --font-body: Work Sans / Noto Sans Thai Looped
--color-tertiary: #F5F5F0   --radius: 4px
--color-neutral: #FAF9F6
```

**Shared shell.** One `AppHeader` (brand, month context, live status dot), one page frame,
one `BackToTop`, one `StateBox` covering loading/empty/error, one skeleton treatment. These
exist four times today in four slightly different forms.

**Constraints the design must respect.** Mobile-only, portrait, inside LINE's webview.
Thai text sets taller than Latin, so line-height and touch targets need to be checked in
Thai, not in English lorem. Bundle size matters more than usual — the audience is on hospital
wifi and mobile data.

**What needs sign-off before Phase 2 starts.** The redesign direction itself. This plan
commits to *one coherent system built on the existing tokens*; it does not choose a new
visual language unilaterally. Suggested deliverable: a single annotated screen (the
`/status/` page, the densest one) reviewed before the other three are built.

**Deliberately not doing:** dark mode. `design.md` specifies a light-optimised system, and
LINE's webview does not reliably signal theme. Revisit separately if asked.

**Deduplication.** `COLOR_ARRAY` and the Thai month names currently exist in both
`src/constants.cjs` and `assets/shared.js`. They collapse into one TypeScript module imported
by both the pages and the Flex builders. `escHtml` disappears entirely — React escapes by
default, and every call site is a template-string `innerHTML` becoming JSX.

---

## 5. Staging LIFF apps — the thing that makes this safe

A Vercel preview deployment cannot be opened from LINE, because a LIFF app only runs at its
registered Endpoint URL. Without solving that, every change is verified for the first time in
production, in front of ~200 physicians.

**Register four staging LIFF apps** in the LINE Developers console pointing at a stable
Vercel preview alias (e.g. `p4p-next.vercel.app`), mirroring the four production ones. They
cost nothing, live alongside the existing apps, and mean every page is exercised in the real
LINE client — real webview, real ID tokens, real `openid` scope behaviour — before cutover.

This is a Phase 0 task and everything downstream depends on it — **except `/admin/`**, which
uses no LIFF app at all and can be verified on the preview URL in any phone browser (§1a).
That is why it moves ahead of the physician pages in §7.

**Webhooks stay pointed at production during staging.** Do not re-register the LINE bot or
Telegram webhook at the preview URL; that would double-handle live events. Exercise those two
route handlers with synthetic signed requests in tests instead. Because their paths are
unchanged, cutover needs no webhook re-registration at all.

---

## 6. CSP: Next.js makes this harder, and it needs handling deliberately

Today's `script-src 'self' https://cdn.jsdelivr.net https://static.line-scdn.net` has **no
`unsafe-inline`**, and the comment in `main.js` is explicit that all page JS was moved to
external files to earn that. Next.js emits inline bootstrap and RSC-payload scripts, so a
naive migration would force `'unsafe-inline'` back in and quietly undo it.

The supported fix is a **per-request nonce generated in middleware**: middleware sets both
the `Content-Security-Policy` and an `x-nonce` header, and Next applies that nonce to the
scripts it injects. Two documented consequences, both acceptable here:

- **It forces dynamic rendering.** Static optimisation and ISR are disabled. The gated pages
  already must be dynamic — they carry a per-request access token — so nothing is lost.
- **The middleware matcher should exclude static assets and prefetches**, or every image
  request pays for CSP processing.

End state, once both CDN script origins are gone (§3):

```
script-src 'self' 'nonce-<per-request>'
```

Strictly better than today. But it is a Phase 1 requirement, not a cleanup task — shipping
without it is a security regression against the current app.

Sources: [Next.js CSP guide](https://nextjs.org/docs/app/guides/content-security-policy) ·
[nonce setup walkthrough](https://centralcsp.com/articles/how-to-setup-nonce-with-nextjs)

---

## 7. Phasing

**Phase 0 — foundations.** Next scaffold, TypeScript, Tailwind theme from `design.md`, shared
`lib/` ported with unit tests, Vitest in CI alongside the existing `automation-tests.yml`,
`@line/liff` npm compatibility check, **four staging LIFF apps + stable preview alias**.
*Exit: a placeholder page opens inside LINE from a staging LIFF app.*

**Phase 1 — gate and API surface.** Middleware (canonicalisation, session, gate RPC,
bind-loop backstop, CSP nonce) and the four route handlers. Logic transcribed from `main.js`
with comments carried across; no behaviour changes, no view work. *Exit: unit tests cover
every gate branch, and the nonce CSP is verified in a browser with no `unsafe-inline`.*

**Phase 1a — `/admin/` (unblocked; can run in parallel).** The admin dashboard needs no
staging LIFF app and no redesign sign-off, so it is the one page that can be built and fully
verified while Phase 0's LINE-console task and Phase 2's design gate are both outstanding.
Six route handlers plus a schema-agnostic CRUD form. It also exercises the CSP nonce, the
Node-runtime routes and the service-role plumbing end to end on a real deployment, which
de-risks Phase 1 for everything else. *Exit: full CRUD against a real roster table from a
phone browser on the preview URL.*

Two things to settle during this phase rather than carry across silently:

- The `p4p_admin` cookie is a stateless 90-day bearer token. There is no revocation short of
  rotating `LINE_CHANNEL_SECRET` or `SUPABASE_SERVICE_ROLE_KEY`, which would break the rest of
  the system. For a single-admin internal tool that is a defensible trade, but a lost or
  handed-down phone keeps write access to every roster table for up to 90 days. A shorter
  expiry, or a revocable server-side session, is cheap to add while the code is being
  rewritten anyway. **Needs a decision, not a default.**
- `admin/app.js` hardcodes its own copy of the department list and its own `escHtml`. Both
  are already covered by the parity guard in Phase 0; they simply disappear here.

**Phase 2 — design system + `/status/`.** The densest physician page, built first so the
system is exercised properly rather than designed against the easiest case. Includes the
redesign sign-off gate from §4. *Exit: reviewed on a real device in LINE via staging LIFF.*

Whether `/admin/` adopts the same redesign is a separate question — it has one user, a
different information density, and is not opened in LINE. Porting it as-is in Phase 1a and
revisiting the styling later is the cheaper order.

**Phase 3 — `/list/`.** Pagination, sorting, search. Removes the largest concentration of
`innerHTML` in the codebase.

**Phase 4 — `/ranking/`.** 24 month tabs, on-time timeline. React Query earns its place here.
Fix the timezone bug (§8).

**Phase 5 — `/verify/`.** Last, still. OTP, access requests, and the LIFF bind flow with its
retry/fail-open/mismatch branches, ported as an explicit `email → code → request → bind`
state machine. This is also where the `/verify` vs `/verify/` rewrite gets confirmed.
*Exit: a real end-to-end bind on a device via staging LIFF, confirmed by a row in
`line_verified_sessions`.*

**Carry forward: silent LINE reauth (added 2026-08, production hotfix).** Bound physicians
were being sent through the full email+OTP form on every visit, because the session cookie
does not reliably survive a fresh LIFF launch (evidence: production auth logs showed the same
bound account creating a brand-new session every reopen, sometimes hours after its previous
one had refreshed fine — strongly suggesting LINE gives each chat-triggered LIFF launch its
own non-persistent webview storage, which no cookie attribute can work around). The fix, live
in `main.js`/`verify/app.js` ahead of this rewrite: before showing the email form at all,
attempt `liff.getIDToken()` → `POST /line/silent-auth` → look up the existing
`line_user_bindings` row for that LINE userId → if found, mint a fresh Supabase session
server-side (`admin/generate_link` → redeem the returned `email_otp` via the same
`{email, token, type:"email"}` shape `verifyOtp` already uses) with no email sent and no OTP
typed. Only resumes a binding that the real flow already established; never creates one.
Skipped for `reason=blocked` / `reason=gate_unavailable` client-side, and independently
refused server-side for a denylisted email, so a client that ignored the skip can't loop.

This is a genuine behavior change, not an implementation detail — build it into Phase 5's
state machine from the start rather than porting the old form-first flow and adding it back
later. See `main.js`'s `/line/silent-auth` handler and the comment block above it for the
full reasoning.

**Phase 6 — cutover.** See §9. **Blocked** until the `/upload/` gap (see the 2026-09 update
above) has its own plan, and until the unexplained `2928626`/`2bcf93b` revert is understood
on a preview deployment.

**Phase 7 — decommission.** Delete `main.js`, `verify/`, `status/`, `list/`, `ranking/`,
`admin/`, `upload/`, `assets/`, `src/constants.ts` (formerly `.cjs`). Rewrite
`eslint.config.mjs` (its browser-globals block and `supabase`/`liff`/`P4P` globals become
meaningless). Delete the parity guard in `web/lib/__tests__/parity.test.ts` along with the
legacy sources it watches. Retire the staging LIFF apps.

---

## 8. Bugs to fix during the rewrite

Found while reading the current code. Each should land as its own commit inside the relevant
phase, so it is visible in review rather than buried in a rewrite diff:

- **`status/app.js:23`** — `par_sheetname` goes straight from the URL into `db.from()` with no
  validation. Validate against `/^\d{4}_\d{2}$/` (this is the `zod` line item in §3).
- **`ranking/app.js:34`** — `formatTime` renders `submitted_at` in the *device's* timezone.
  Every user is in Thailand, but a device set to another zone silently shows wrong times on a
  page whose entire purpose is ordering by time. Format in `Asia/Bangkok` explicitly.
- **`list/app.js:37`** — `toBE(year, month)` is called with two arguments; `toBE` takes one.
  Harmless today, but the month-window code reads as if it does something it doesn't.
- **`status/app.js:54`** — `arr` and `count_true` are module-level mutable state, never reset.
  Single-load pages today; a bug the moment components mount and unmount.
- **`list/app.js:69`** — the clock `setInterval` is never cleared.
- **`admin/app.js:119,166,204`** — timestamps are shown in the *device's* timezone
  (`toLocalInputValue` and `toLocaleString("th-TH")`) and parsed back from it
  (`new Date(v).toISOString()`). Those two are exact inverses, so a field the admin does not
  touch round-trips losslessly — no silent corruption. The bug is narrower: on a non-Bangkok
  device the admin *reads* `submitted_at` shifted by their offset, and if they then type a
  time meaning Bangkok, it is stored shifted. Read-only on the ranking page, but here it can
  be written, so fix it with the same `Asia/Bangkok` formatting.
- **`admin/app.js`** — a third hardcoded copy of the department list, and a third copy of
  `escHtml`. Both are covered by the Phase 0 parity guard until they are deleted in Phase 1a.

---

## 9. Cutover runbook

Uses the maintenance window from decision 3. Target a date outside the 1st–15th submission
window, when `/verify/` traffic is lowest.

**Before:** all five phases merged and verified on staging; a rich-menu message announcing the
window; `LINE_BIND_ENFORCE` left at its current value (do not combine a rollout switch with a
cutover).

1. Point the production Vercel project at the Next build; deploy without promoting.
2. Verify on the preview alias one last time — all four pages, in LINE.
3. Promote to production.
4. Update the four **production** LIFF Endpoint URLs only if any path changed. It should not
   have; if step 4 is a no-op, the migration is correct.
5. Point `ADMIN_BASE_URL` at production (it should already be — confirm rather than assume).
6. Smoke test in this order: `/verify/` OTP → bind → redirect to `/status/`; then `/list/`,
   `/ranking/`; then a real LINE bot `status` message; then DM `admin` to the bot, follow the
   link, and do one read plus one edit in the dashboard; then a Telegram approve button.
7. Watch Vercel logs for `[gate]`, `[line-bind]`, `[bind-loop]`, `[tg-webhook]` and `[admin]`
   lines for the first hour — the existing log prefixes are preserved specifically so this
   step works.
8. Confirm fresh rows in `line_verified_sessions`.

**Rollback:** promote the previous Vercel deployment. Because the paths and webhook
registrations are unchanged, rollback is one click and needs no LINE-console edits. That
property is worth protecting — it is the main reason §2 insists the paths stay identical.

---

## 10. Testing

| Layer | Tool | What |
|---|---|---|
| Gate | Vitest | Every branch of the middleware: no cookie, expired refresh, blocked, revoked, bind-required under/over the limit, loop-backstop tripped, gate RPC unreachable in both `LINE_BIND_ENFORCE` modes. Zero coverage today; the branches that lock people out. |
| Webhooks | Vitest | LINE signature valid/invalid/missing; Telegram secret mismatch; `callback_query` parsing. |
| Admin auth | Vitest | HMAC sign/verify round-trip; expired token; tampered signature; a `login` token rejected as a `session` cookie and vice versa (the purpose separation); `requireAdmin` with no cookie. |
| Admin API | Vitest | `assertRosterTable` rejecting a non-roster table name; `filterToColumns` dropping unknown keys and the PK. These two are the only thing standing between a client-controlled body and a service-role write. |
| Pure logic | Vitest | `months.ts` (BE conversion, 6- and 24-month windows, the `2569_04` floor, deadlines), department sort order, filter/sort/pagination. |
| Components | Vitest + RTL | `OtpInput` (type, paste, backspace, arrows, bulk autofill), status view-mode transitions, list pagination edges. |
| Bind flow | Vitest + RTL | Mocked `/line/bind`: success, `403 mismatch`, failure under the limit, failure at the limit. |
| End to end | Playwright | Non-LIFF paths: desktop block, missing-token redirect to `/verify/`, CSP header shape. Chromium is already available in CI. |
| Real device | Manual | Every phase, in LINE, via staging LIFF. Not optional — the webview is where this app's bugs live. |

The existing `automation/test/*` suite (`node:test`) is untouched and keeps running.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| The `/verify` vs `/verify/` redirect bug returns via Next's routing. | Middleware rewrite, not `trailingSlash`. Explicitly re-tested in Phase 5 on a real device. |
| Next's inline scripts force `unsafe-inline` back into the CSP. | §6. Treated as a Phase 1 requirement, not cleanup. |
| Middleware Edge runtime can't do something the gate needs. | Everything it needs is `fetch` + `atob`. If that proves wrong, the middleware can be pinned to the Node runtime. |
| `@line/liff` npm diverges from the CDN "edge" SDK. | Checked in Phase 0. Fallback is the existing CDN tag, at the cost of one CSP origin. |
| Redesign scope creeps and delays the migration. | One sign-off gate on one screen (§4), before three of the four pages are built. |
| Cutover lands mid-submission-window. | Scheduled outside the 1st–15th; rollback is a single Vercel promotion (§9). |
| Rewriting the gate reintroduces a lockout. | It is transcribed, not redesigned; comments carried across; every branch unit-tested; `LINE_BIND_ENFORCE` untouched during the cutover. |
| An admin API route ends up reachable without `requireAdmin`. | Every one of them holds the service-role key. Unit-test each route's unauthenticated path, and keep the middleware matcher's `/admin/*` exclusion covered by a test so it cannot be widened by accident. |
| `ADMIN_BASE_URL` points at the wrong deployment. | The bot's login link is built from it. Cutover checklist item (§9); never set it to a preview while production is on Express. |

---

## 12. Effort

| Phase | Estimate |
|---|---|
| 0 — scaffold, Tailwind theme, lib, staging LIFF, CI | 2 days |
| 1 — gate, middleware, CSP nonce, webhooks | 2–3 days |
| 1a — `/admin/` + six route handlers | 2 days |
| 2 — design system + `/status/` (incl. sign-off) | 3 days |
| 3 — `/list/` | 1.5 days |
| 4 — `/ranking/` | 1 day |
| 5 — `/verify/` | 2 days |
| 6 — cutover + monitoring | 0.5 day |
| 7 — decommission, lint config | 0.5 day |
| **Total** | **~14–15 days** |

The first draft estimated ~6–7 days for a Vite-only port. The increase is the gate rewrite
(~3 days), the redesign (~3 days) and now the admin dashboard (~2 days) — all three are
consequences of decisions or of scope that already exists, not scope creep.

Note that 1a is **not on the critical path**: it is the only phase that can start
immediately, so in elapsed time it costs nothing if it runs while the LINE-console and
design-sign-off tasks are outstanding.

---

## 13. Open decisions

Everything else in this plan is settled. These two are not, and both are cheap now and
awkward later:

1. **How long should an admin session last?** The `p4p_admin` cookie is a stateless 90-day
   bearer token with no revocation path short of rotating a secret the rest of the system
   depends on (§7, Phase 1a). A shorter expiry or a revocable server-side session is a small
   change while the code is being rewritten anyway.
2. **Does `/admin/` adopt the redesign?** One user, different density, not opened in LINE.
   Porting it as-is in Phase 1a and revisiting later is the cheaper order, but that is a
   preference, not a constraint.
