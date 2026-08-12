import { createHmac } from "node:crypto"
import { beforeEach, describe, expect, it } from "vitest"
import { signAdminToken, verifyAdminToken, isAdminRequest } from "../admin/tokens"
import { filterToColumns, type RosterColumn } from "../admin/roster"
import { bangkokInputToIso, isoToBangkokInput, toRequestBody } from "../admin/fields"

// The signing key is derived from these two secrets.
beforeEach(() => {
  process.env.LINE_CHANNEL_SECRET = "channel-secret"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key"
})

const future = () => Math.floor(Date.now() / 1000) + 600
const past = () => Math.floor(Date.now() / 1000) - 10

describe("admin tokens", () => {
  it("round-trips a valid token", () => {
    expect(verifyAdminToken("session", signAdminToken("session", future()))).toBe(true)
  })

  it("rejects an expired token", () => {
    expect(verifyAdminToken("session", signAdminToken("session", past()))).toBe(false)
  })

  it("rejects a tampered signature", () => {
    const token = signAdminToken("session", future())
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")
    expect(verifyAdminToken("session", tampered)).toBe(false)
  })

  it("rejects a tampered expiry", () => {
    const [, sig] = signAdminToken("session", future()).split(".")
    expect(verifyAdminToken("session", `${future() + 99999}.${sig}`)).toBe(false)
  })

  // The signing key is `${LINE_CHANNEL_SECRET}:${SUPABASE_SERVICE_ROLE_KEY}`
  // with `?? ""` on both halves. With a secret unset that key degraded to the
  // literal ":", and since the signed payload is only `purpose:exp` — no nonce,
  // no identity — a forged cookie was trivial. Every admin route holds the
  // service-role key, so this must fail closed, not fall back.
  describe("fails closed when a signing secret is missing", () => {
    for (const missing of ["LINE_CHANNEL_SECRET", "SUPABASE_SERVICE_ROLE_KEY"]) {
      it(`refuses to sign or verify without ${missing}`, () => {
        // A token minted while the secrets WERE present must stop verifying.
        const good = signAdminToken("session", future())
        delete process.env[missing]

        expect(() => signAdminToken("session", future())).toThrow()
        expect(verifyAdminToken("session", good)).toBe(false)
      })

      it(`does not accept a token forged against the degraded key (${missing} unset)`, () => {
        delete process.env[missing]
        // Reproduce the old behaviour: HMAC over the key an attacker could
        // guess once the fallback kicked in.
        const exp = future()
        const degraded = `${exp}.${createHmac("sha256", missing === "LINE_CHANNEL_SECRET" ? ":service-role-key" : "channel-secret:")
          .update(`session:${exp}`)
          .digest("hex")}`
        expect(verifyAdminToken("session", degraded)).toBe(false)
      })
    }
  })

  it("will not let a login token be replayed as a session cookie", () => {
    // This is why "purpose" is mixed into the HMAC: a short-lived login link
    // must never become a 90-day session.
    const login = signAdminToken("login", future())
    expect(verifyAdminToken("login", login)).toBe(true)
    expect(verifyAdminToken("session", login)).toBe(false)
  })

  it("will not let a session cookie be replayed as a login token", () => {
    const session = signAdminToken("session", future())
    expect(verifyAdminToken("login", session)).toBe(false)
  })

  it("rejects malformed input rather than throwing", () => {
    for (const bad of [undefined, null, "", "nodot", "abc.def", ".", "12345"]) {
      expect(verifyAdminToken("session", bad as string | undefined)).toBe(false)
    }
  })

  it("does not validate against a different signing key", () => {
    const token = signAdminToken("session", future())
    process.env.SUPABASE_SERVICE_ROLE_KEY = "rotated-key"
    expect(verifyAdminToken("session", token)).toBe(false)
  })
})

describe("isAdminRequest", () => {
  const withCookie = (cookie: string) =>
    new Request("https://example.test/admin/api/tables", { headers: { cookie } })

  it("accepts a valid session cookie", () => {
    expect(isAdminRequest(withCookie(`p4p_admin=${signAdminToken("session", future())}`))).toBe(true)
  })

  it("finds the cookie among others", () => {
    const token = signAdminToken("session", future())
    expect(isAdminRequest(withCookie(`p4p_rt=xyz; p4p_admin=${token}; other=1`))).toBe(true)
  })

  it("rejects a request with no cookie at all", () => {
    expect(isAdminRequest(new Request("https://example.test/admin/api/tables"))).toBe(false)
  })

  it("rejects an expired or forged cookie", () => {
    expect(isAdminRequest(withCookie(`p4p_admin=${signAdminToken("session", past())}`))).toBe(false)
    expect(isAdminRequest(withCookie("p4p_admin=forged"))).toBe(false)
  })

  it("is not fooled by a similarly-named cookie", () => {
    const token = signAdminToken("session", future())
    expect(isAdminRequest(withCookie(`not_p4p_admin=${token}`))).toBe(false)
  })
})

// filterToColumns and assertRosterTable are the entire boundary between a
// client-controlled body and a service-role write.
describe("filterToColumns", () => {
  const columns: RosterColumn[] = [
    { column_name: "index", data_type: "uuid", is_pk: true },
    { column_name: "firstname", data_type: "text", is_pk: false },
    { column_name: "department", data_type: "text", is_pk: false },
  ]

  it("keeps known non-PK columns", () => {
    expect(filterToColumns(columns, { firstname: "สมชาย", department: "อายุรกรรม" })).toEqual({
      firstname: "สมชาย",
      department: "อายุรกรรม",
    })
  })

  it("drops the primary key", () => {
    expect(filterToColumns(columns, { index: "attacker-chosen", firstname: "ก" })).toEqual({
      firstname: "ก",
    })
  })

  it("drops columns that do not exist", () => {
    expect(filterToColumns(columns, { is_admin: true, "; drop table x": 1 })).toEqual({})
  })

  it("handles a null or empty body", () => {
    expect(filterToColumns(columns, null)).toEqual({})
    expect(filterToColumns(columns, {})).toEqual({})
  })

  it("preserves an explicit null (clearing a field)", () => {
    expect(filterToColumns(columns, { firstname: null })).toEqual({ firstname: null })
  })
})

describe("Bangkok timestamp round-trip", () => {
  it("renders an instant as Bangkok wall-clock time", () => {
    // 07:32 UTC == 14:32 Bangkok.
    expect(isoToBangkokInput("2026-08-05T07:32:00Z")).toBe("2026-08-05T14:32")
  })

  it("reads typed input as Bangkok time", () => {
    expect(bangkokInputToIso("2026-08-05T14:32")).toBe("2026-08-05T07:32:00.000Z")
  })

  it("round-trips losslessly", () => {
    const iso = "2026-08-05T07:32:00.000Z"
    expect(bangkokInputToIso(isoToBangkokInput(iso))).toBe(iso)
  })

  it("is independent of the device timezone", () => {
    // The regression this guards: the legacy code used getHours()/new Date(),
    // so an admin on a non-Bangkok device read AND wrote shifted times.
    const original = process.env.TZ
    try {
      for (const tz of ["UTC", "America/New_York", "Asia/Tokyo"]) {
        process.env.TZ = tz
        expect(isoToBangkokInput("2026-08-05T07:32:00Z"), tz).toBe("2026-08-05T14:32")
        expect(bangkokInputToIso("2026-08-05T14:32"), tz).toBe("2026-08-05T07:32:00.000Z")
      }
    } finally {
      process.env.TZ = original
    }
  })

  it("returns empty/null for missing or unparseable values", () => {
    expect(isoToBangkokInput(null)).toBe("")
    expect(isoToBangkokInput("nonsense")).toBe("")
    expect(bangkokInputToIso("")).toBeNull()
    expect(bangkokInputToIso("nonsense")).toBeNull()
  })
})

describe("toRequestBody", () => {
  const columns: RosterColumn[] = [
    { column_name: "index", data_type: "uuid", is_pk: true },
    { column_name: "firstname", data_type: "text", is_pk: false },
    { column_name: "score", data_type: "double precision", is_pk: false },
    { column_name: "submitted_at", data_type: "timestamp with time zone", is_pk: false },
  ]

  it("converts each column by its declared type", () => {
    expect(
      toRequestBody(columns, {
        firstname: "สมชาย",
        score: "12.5",
        submitted_at: "2026-08-05T14:32",
      }),
    ).toEqual({
      firstname: "สมชาย",
      score: 12.5,
      submitted_at: "2026-08-05T07:32:00.000Z",
    })
  })

  it("sends null for a blank field rather than an empty string", () => {
    expect(toRequestBody(columns, { firstname: "", score: "", submitted_at: "" })).toEqual({
      firstname: null,
      score: null,
      submitted_at: null,
    })
  })

  it("never emits the primary key", () => {
    expect(toRequestBody(columns, { index: "x", firstname: "ก" })).not.toHaveProperty("index")
  })
})
