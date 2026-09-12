/**
 * assets/browser-globals.d.ts
 *
 * Ambient type declarations for the globals the P4P browser pages
 * (verify/status/list/ranking/admin/upload) share across plain <script> tags
 * with no module system (see tsconfig.browser.json: "module": "none",
 * "types": []). Nothing here emits any JS — it only describes shapes that
 * already exist at runtime:
 *
 *   - `window.P4P` / bare `P4P`  — published by assets/shared.ts, then
 *     extended in place (`P4P.db`, `P4P.ready`) by assets/auth-guard.ts and
 *     (`P4P.receipt`) by lib/line-receipt-flex.ts's browser branch.
 *   - `supabase`                — the @supabase/supabase-js UMD bundle
 *     loaded from a CDN <script> tag (see e.g. verify/index.html).
 *   - `liff`                    — the LINE LIFF SDK loaded from
 *     https://static.line-scdn.net/liff/edge/2/sdk.js.
 *
 * Both `supabase` and `liff` are typed loosely and only for the call sites
 * actually used in this file set — not the full SDK surface — since this is
 * a mechanical typing pass over legacy code, not a from-scratch SDK binding.
 */

// ── window.P4P ──────────────────────────────────────────────────────────

/** Return shape of assets/shared.ts's validateUploadFile(). */
interface UploadFileCheck {
  ok: boolean
  error?: string
  message?: string
}

interface SupabaseClientOptions {
  auth?: {
    persistSession?: boolean
    autoRefreshToken?: boolean
  }
}

/**
 * The Flex-message builder module lib/line-receipt-flex.ts's browser branch
 * publishes at P4P.receipt (upload/app.ts is the only reader). Kept in sync
 * by hand with that file's returned object — see its own local FlexMessage/
 * FlexComponent types for the JSON shapes these functions build.
 */
interface FlexReceiptModule {
  THAI_MONTHS_SHORT: string[]
  displayMonth(monthKey: string): string
  formatScore(score: unknown): string
  formatSubmittedAt(iso: string): string
  errorText(errorType: string): string
  buildScoreReceipt(args: {
    displayName: string
    department: string
    monthKey: string
    score: unknown
    receivedAt: string
    isLate: boolean
  }): unknown
  buildPendingBubble(args: { monthKey: string; queueId?: string; ack?: boolean }): unknown
  buildFailureBubble(args: {
    monthKey: string
    errorType: string
    detail?: string
    uploadLiffUrl?: string
  }): unknown
}

/**
 * The shared window.P4P object. Every field here comes from assets/shared.ts
 * except `db` and `ready` (assets/auth-guard.ts) and `receipt` (this file's
 * browser branch, upload-only — hence optional).
 */
interface P4PGlobal {
  SUPABASE_URL: string
  SUPABASE_KEY: string
  SUPABASE_OPTS: SupabaseClientOptions
  COLOR_ARRAY: [string, string][]
  THAI_MONTHS: string[]
  THAI_MONTHS_SHORT: string[]
  DEPARTMENTS: string[]
  escHtml(s: unknown): string
  MAX_UPLOAD_BYTES: number
  recentMonthKeys(count?: number, now?: Date): string[]
  monthKeyDisplay(key: string): string
  deadlineDate(key: string): Date | null
  deadlineDisplay(key: string): string
  deadlineDueDisplay(key: string): string
  isLateFor(key: string, when?: string | number | Date | null): boolean
  shortDateTime(iso: string): string
  shortDate(iso: string): string
  validateUploadFile(file: File | null | undefined): UploadFileCheck
  checkMagicBytes(file: File): Promise<boolean>

  // Added in place by assets/auth-guard.ts, AFTER assets/shared.ts has
  // already published this object — optional here because shared.ts's own
  // object literal predates both fields; every consumer runs later in the
  // page's <script> order, once auth-guard.ts has set them, and casts
  // accordingly (see e.g. status/app.ts, list/app.ts).
  db?: SupabaseClientLike | null
  ready?: Promise<boolean>

  // Added in place by lib/line-receipt-flex.ts's browser branch (upload
  // page only — every other consumer never sets or reads it).
  receipt?: FlexReceiptModule
}

interface Window {
  P4P: P4PGlobal
}

// status/app.ts, list/app.ts and ranking/app.ts read `P4P.xxx` as a bare
// identifier (no `window.` prefix) since they run as plain global scripts
// after assets/shared.ts has run — this is the same binding as `window.P4P`
// at runtime, declared again here so the bare form type-checks too.
declare var P4P: P4PGlobal

// ── supabase (the @supabase/supabase-js UMD global) ────────────────────
//
// Modeled loosely: only createClient() plus the auth/from/rpc call shapes
// actually used across verify/status/list/ranking/upload's app.ts and
// assets/auth-guard.ts. Row shapes vary per page/table, so query results are
// typed `any` rather than forcing per-table precision onto a shared client.

interface SupabaseError {
  message: string
  code?: string
  [key: string]: unknown
}

interface SupabaseResult<T = any> {
  data: T
  error: SupabaseError | null
}

/**
 * Minimal chainable query builder covering exactly the methods called in
 * this file set (select/not/eq/lte/order/limit) — it is also a thenable, so
 * `await db.from(t).select(...)` and `.select(...).then(...)` both work, as
 * the real supabase-js query builder supports.
 */
interface SupabaseFilterBuilder<T = any> extends PromiseLike<SupabaseResult<T>> {
  select(columns?: string): SupabaseFilterBuilder<T>
  not(column: string, operator: string, value: unknown): SupabaseFilterBuilder<T>
  eq(column: string, value: unknown): SupabaseFilterBuilder<T>
  lte(column: string, value: unknown): SupabaseFilterBuilder<T>
  order(column: string, options?: { ascending?: boolean }): SupabaseFilterBuilder<T>
  limit(count: number): SupabaseFilterBuilder<T>
}

interface SupabaseAuthSession {
  access_token: string
  refresh_token: string
  [key: string]: unknown
}

interface SupabaseAuth {
  signInWithOtp(args: {
    email: string
    options?: Record<string, unknown>
  }): Promise<{ data: unknown; error: SupabaseError | null }>
  verifyOtp(args: {
    email: string
    token: string
    type: string
  }): Promise<{ data: { session: SupabaseAuthSession | null }; error: SupabaseError | null }>
}

interface SupabaseClientLike {
  auth: SupabaseAuth
  from(table: string): SupabaseFilterBuilder
  // A real Promise (not just PromiseLike) — some call sites chain
  // `.then(...).catch(...)` off it directly (see e.g.
  // assets/liff-access-log.ts, upload/app.ts) rather than awaiting it.
  rpc(fn: string, params?: Record<string, unknown>): Promise<SupabaseResult>
}

interface SupabaseStatic {
  createClient(url: string, key: string, options?: SupabaseClientOptions | Record<string, unknown>): SupabaseClientLike
}

declare var supabase: SupabaseStatic

// ── liff (the LINE LIFF SDK global) ─────────────────────────────────────
//
// Only the methods actually called across this file set are declared —
// grep the file set for `liff.` before adding another one.

interface LiffProfile {
  userId: string
  displayName: string
  [key: string]: unknown
}

interface LiffStatic {
  init(config: { liffId: string }): Promise<void>
  isLoggedIn(): boolean
  isInClient(): boolean
  getIDToken(): string | null
  getProfile(): Promise<LiffProfile>
  sendMessages(messages: unknown[]): Promise<void>
  getOS(): string
  getVersion(): string
  getLineVersion(): string | null
  getContext(): unknown
}

declare var liff: LiffStatic
