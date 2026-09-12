import type { Metadata } from "next"
import VerifyClient from "./VerifyClient"

/**
 * OTP login + access-request + silent LINE reauth.
 *
 * Served at BOTH /verify and /verify/ via a middleware rewrite (see
 * ../../middleware.ts) — no redirect between them, because that redirect
 * used to destroy LIFF's `#access_token=…` login fragment and looped a
 * physician forever inside LINE's webview (see lib/gate/targets.ts).
 *
 * No server-side gating and no access token to resolve here, unlike
 * /status/, /list/ and /ranking/: LINE identity capture and the `physicians`
 * write live entirely in the browser plus a Supabase Edge Function (see
 * scripts/auth-rewrite-2026-08.sql and supabase/functions/line-verify). The
 * page is the same for every visitor, every time — dynamic only because
 * static optimisation is disabled app-wide for the CSP nonce (middleware.ts).
 */
export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "ยืนยันอีเมล — SAKHONMSO P4P" }

export default function VerifyPage() {
  return <VerifyClient />
}
