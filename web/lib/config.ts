/**
 * Deployment configuration.
 *
 * The Supabase URL and publishable key are hardcoded in main.js and
 * assets/shared.js today. They are not secrets — the publishable key is meant
 * to be in page source, and the data behind it is protected by RLS — so they
 * keep the same defaults here, with env overrides so a preview deployment can
 * be pointed elsewhere without a code change.
 *
 * Everything that IS a secret is read from the environment with no default and
 * must never be imported into a client component.
 */

export const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://zjeizbrzcltkgtlmkbji.supabase.co"

export const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? "sb_publishable_TcCSpznim4fi0Y7E_zuAsg_op19VZQ-"

/** Cookie holding {at, rt} for the physician session. */
export const SESSION_COOKIE = "p4p_rt"

/** Admin dashboard session cookie. */
export const ADMIN_COOKIE = "p4p_admin"

/** Shared cookie attributes. Path=/ so one cookie covers every route. */
export const COOKIE_BASE = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
} as const

/**
 * Server-only secrets. Throwing here would break the whole app at import
 * time, so these return undefined and each caller decides what that means.
 *
 * Physician auth (email OTP + LINE binding) does not appear here at all —
 * LINE ID-token verification and the `physicians` write happen in the
 * Supabase Edge Function (supabase/functions/line-verify), which is called
 * directly from the browser and gets its own service-role key injected by
 * the Edge Functions runtime. See scripts/auth-rewrite-2026-08.sql.
 */
export const serverEnv = {
  lineAccessToken: () => process.env.LINE_ACCESS_TOKEN,
  lineChannelSecret: () => process.env.LINE_CHANNEL_SECRET,
  supabaseServiceRoleKey: () => process.env.SUPABASE_SERVICE_ROLE_KEY,
  telegramBotToken: () => process.env.TELEGRAM_BOT_TOKEN,
  /** The single LINE userId allowed into /admin/. Not a secret in itself — a
   *  LINE userId identifies an account but cannot authenticate as one. */
  adminLineUserId: () =>
    process.env.ADMIN_LINE_USER_ID ?? "Ub5c3e37b54e59f479fbf450e2df60d18",
  /** Baked into the one-time admin login link the bot sends over DM, so it must
   *  point at whichever deployment is live. Cutover checklist item. */
  adminBaseUrl: () => process.env.ADMIN_BASE_URL ?? "https://p4p-sakhonmso.vercel.app",
} as const
