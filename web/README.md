# `web/` — Next.js rewrite of the P4P LIFF front end

Implements [`../REACT_REWRITE_PLAN.md`](../REACT_REWRITE_PLAN.md). **Nothing here is
deployed yet.** Production is still served by `../main.js` (Express), and this directory is
built and tested in isolation until the cutover in Phase 6.

**2026-08:** `../main.js`'s auth was rewritten to a much simpler design — email OTP is the
sole login factor, LINE binding is traceability only (no bind step, no fail-open, no staged
enforcement flag), and LINE ID-token verification now happens in a Supabase Edge Function
(`../supabase/functions/line-verify`), not in this app's own server. `lib/gate/`, `middleware.ts`,
and the `/admin/` access-request flow here were updated to match — see
`../scripts/auth-rewrite-2026-08.sql` and `../REACT_REWRITE_PLAN.md`'s 2026-08 update note.
`app/line/bind/`, `app/telegram/webhook/`, and `lib/line/verify.ts` were deleted: that logic no
longer exists as a route on this server at all.

It is a self-contained sub-project with its own `package.json`, matching the existing
convention in `../automation/` and `../process/`. That isolation is deliberate: the live
Vercel deployment builds from the repo root, so adding a framework there could change how
production is built. Nothing in this directory can affect it.

## Commands

```bash
cd web
npm install
npm run dev        # http://localhost:3000
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # production build
```

No lint script yet: Next 16 removed `next lint`, and the root `eslint.config.mjs` ignores this
directory (no TypeScript parser). `typecheck` plus `build` cover the same ground for now;
wiring up `typescript-eslint` is worth doing but has not been done.

## Status

| Phase | State |
|---|---|
| 0 — scaffold, tokens, shared lib, tests | **done** |
| 1 — gate, middleware, CSP nonce, webhooks | **done** |
| 1a — `/admin/` dashboard | **done** |
| 2 — design system + `/status/` | **done** (design not yet signed off) |
| 3 — `/list/` | **done** |
| 4 — `/ranking/` | **done** |
| 5 — `/verify/` | not started — placeholder page only |
| 6 — cutover | not started |
| 7 — decommission Express | not started |

**Nothing is deployed.** Production is still Express from the repo root.

`/verify/` is a placeholder that renders a "Phase 5" notice. It exists because the gate
redirects there, so without it the redirect chain could not be tested end to end. Until it is
built, this app cannot log anybody in — which is fine, because it is not serving anyone.

### Blocked on someone with LINE Developers console access

Phase 0 cannot be *verified* without this, and every later phase depends on it:

**Register four staging LIFF apps** whose Endpoint URLs point at a stable Vercel preview
alias, mirroring the four production apps. A LIFF app only runs at its registered URL, so
without these the first real test of any change is in production, in front of every
physician. See plan §5.

Once they exist, open `https://<preview>/preflight?liffId=<staging-liff-id>` inside LINE.
That page reports whether `liff.init()` succeeds with the npm SDK and — the check that
matters most — whether `liff.getIDToken()` returns a token. It returns `null` unless the
LIFF app has the **`openid`** scope, and that one missing scope is what broke the bind flow
in 2026-08.

### Blocked on a design decision

Phase 2 needs sign-off on the redesign direction before three of the four pages get built.
Suggested gate: one annotated `/status/` screen. See plan §4.

## What is here

```
middleware.ts          the gate: canonicalisation, session, CSP nonce
app/
  layout.tsx           html lang="th", self-hosted fonts, viewport
  globals.css          design tokens from ../design.md — one definition, not five
  status/ list/ ranking/   the three physician pages
  admin/               roster CRUD + access-request approval + their API route handlers
  verify/              PLACEHOLDER — Phase 5
  auth/ line/              session cookie, LINE bot messaging webhook
  preflight/           Phase 0 diagnostic page (delete in Phase 7)
components/            DesktopBlock, StateBox, Spinner, BackToTop, Notice
lib/
  gate/                cookies, JWT claims, token refresh, one-boolean gate decision, redirect targets
  admin/               HMAC tokens, service-role roster + access-request access, form-field typing
  line/                Flex month picker only — LINE ID-token verification moved to
                        ../supabase/functions/line-verify, called directly from the browser
  months.ts colors.ts departments.ts pagination.ts
  __tests__/           101 tests, including the parity guard below
```

### The parity guard

`lib/__tests__/parity.test.ts` reads the legacy sources directly and asserts they still agree
with `lib/`:

| Legacy source | What is duplicated |
|---|---|
| `../src/constants.cjs` | month colours, Thai month names, the 6-month window |
| `../assets/shared.js` | month colours, Thai month names (long + short) |
| `../status/app.js` | the department list and its Thai ordering |
| `../admin/app.js` | the department list again — a third copy |

None of these can be deleted until Express is retired. A colour changed in one place would
show up as a month tab whose accent no longer matches the LINE message that linked to it; a
department spelled differently in `admin/app.js` would let the admin save a value the status
page then fails to group.

If that test fails, the fix is to change all three, not to loosen the test. Delete the file
in Phase 7 along with the legacy sources.

## Findings

**Next.js emits inline `<script>` tags**, two per page, with no `src`. The current app's CSP
has *no* `unsafe-inline` on `script-src` — a deliberate property earned by moving all page JS
to external files — so a naive migration would silently weaken it. Fixed with the
per-request nonce in `middleware.ts`; verified against a running server that both inline
scripts carry it and the header is
`script-src 'self' 'nonce-…'` with no `unsafe-inline`.

**Next will not emit a bare `#` in a `Location` header**, which the Express gate relied on to
stop LINE's webview carrying a stale LIFF fragment forward. Three approaches were measured
and all three dropped it (see the header comment in `lib/gate/targets.ts`). The fragment is
now `#_` — inert and behaviourally identical. This is the kind of thing that would have
shipped silently and resurfaced as the 2026-08 redirect loop, so it has its own test file.

**`next/font` works and removes two CSP origins.** Manrope, Work Sans and Noto Sans Thai
Looped are downloaded at build time and served from our own origin, so
`fonts.googleapis.com` and `fonts.gstatic.com` drop out of the CSP along with two
preconnects and a render-blocking round trip.

**TypeScript is pinned to 5.x, not 7.** TypeScript 7 (the Go-based compiler) is released but
not something to bet a migration on mid-flight. Revisit after cutover.

**`@line/liff` installs cleanly from npm**, but that only proves it builds. Whether it
behaves like the CDN "edge" SDK inside LINE's webview is exactly what `/preflight` is for,
and that answer needs the staging LIFF apps above.
