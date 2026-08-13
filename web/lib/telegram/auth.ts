import crypto from "node:crypto"
import { serverEnv } from "../config"

/**
 * Authenticating Telegram's webhook callbacks.
 *
 * Telegram echoes the secret registered via setWebhook back in the
 * x-telegram-bot-api-secret-token header. That header is the only proof a
 * request came from Telegram rather than from someone who guessed the URL, and
 * the handler behind it calls approve_access_request / reject_access_request
 * with the SERVICE ROLE key — so this check is the whole boundary.
 *
 * The comparison lives here, apart from the route, so every branch of it is
 * unit-testable without standing up a request.
 */

/**
 * True only when a non-empty secret is configured.
 *
 * This is what makes the empty case explicit. Comparing the header against an
 * unset env var comes out as `"" === ""` — a request carrying NO header at all
 * authenticates successfully, and the endpoint becomes an open approve/reject
 * button for anyone who finds the URL. Same failure the admin signing key
 * guards against with adminKeyUsable(): a missing env var on a preview
 * deployment or a renamed secret is an ordinary mistake, and silently
 * degrading to "accept everything" because of one is not an acceptable
 * outcome. Fail closed instead.
 */
export function webhookSecretUsable(): boolean {
  return Boolean((serverEnv.telegramWebhookSecret() ?? "").trim())
}

/**
 * Whether the request's secret header matches the configured secret.
 *
 * Both sides are trimmed: an accidental trailing space is easy to introduce
 * pasting a long value into an env-var UI, and would otherwise present as an
 * unexplainable mismatch. The compare itself is constant-time, matching the
 * LINE signature check — a byte-by-byte early exit on a shared secret is
 * needlessly generous to anyone probing it.
 */
export function validWebhookSecret(received: string | null | undefined): boolean {
  const expected = (serverEnv.telegramWebhookSecret() ?? "").trim()
  if (!expected) {
    console.error(
      "[tg-webhook] TELEGRAM_WEBHOOK_SECRET is not set — rejecting every callback " +
        "(refusing to treat a missing secret as a match)",
    )
    return false
  }

  const a = Buffer.from((received ?? "").trim())
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
