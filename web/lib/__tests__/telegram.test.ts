import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { validWebhookSecret, webhookSecretUsable } from "../telegram/auth"

const SECRET = "s3cr3t-webhook-token"

beforeEach(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET
  // The unset path logs an error by design; keep the test output readable.
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("telegram webhook secret", () => {
  it("accepts the configured secret", () => {
    expect(validWebhookSecret(SECRET)).toBe(true)
  })

  it("rejects a wrong secret", () => {
    expect(validWebhookSecret("not-the-secret")).toBe(false)
  })

  it("rejects a missing header", () => {
    expect(validWebhookSecret(null)).toBe(false)
    expect(validWebhookSecret(undefined)).toBe(false)
  })

  // Both sides are trimmed — a trailing space pasted into an env-var UI must
  // not present as an unexplainable mismatch.
  it("tolerates surrounding whitespace on either side", () => {
    expect(validWebhookSecret(`  ${SECRET}  `)).toBe(true)
    process.env.TELEGRAM_WEBHOOK_SECRET = ` ${SECRET}\n`
    expect(validWebhookSecret(SECRET)).toBe(true)
  })

  it("rejects a prefix of the secret", () => {
    expect(validWebhookSecret(SECRET.slice(0, -1))).toBe(false)
  })

  /**
   * The bug this file exists for.
   *
   * The check used to be `received !== expected` against a raw env read. With
   * the secret unset that is `"" !== ""` — false — so a request with NO header
   * authenticated, and the handler behind it approves/rejects access requests
   * using the service-role key. A missing env var must close the endpoint.
   */
  describe("fails closed when the secret is not configured", () => {
    for (const unset of ["", "   ", undefined] as const) {
      const label = unset === undefined ? "unset" : JSON.stringify(unset)
      it(`rejects an empty header when the env var is ${label}`, () => {
        if (unset === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET
        else process.env.TELEGRAM_WEBHOOK_SECRET = unset

        expect(webhookSecretUsable()).toBe(false)
        // The exact shape of the old bypass: no header at all.
        expect(validWebhookSecret(null)).toBe(false)
        expect(validWebhookSecret("")).toBe(false)
        expect(validWebhookSecret("   ")).toBe(false)
        // And nothing else gets in either.
        expect(validWebhookSecret("anything")).toBe(false)
      })
    }
  })

  it("reports a configured secret as usable", () => {
    expect(webhookSecretUsable()).toBe(true)
  })
})
