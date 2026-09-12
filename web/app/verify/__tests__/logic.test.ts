import { describe, expect, it } from "vitest"
import { NAME_MAX, isValidEmail, isValidOtp, safeReturnTarget, sanitizeName } from "../logic"

/**
 * safeReturnTarget is the open-redirect guard for `?return=`. lib/gate/targets
 * never emits an unsafe value, but this page can be reached with an arbitrary
 * one from outside the app too — so every case that reads as "somewhere else"
 * must fall back to /status/, not just the ones lib/gate happens to produce.
 */
describe("safeReturnTarget", () => {
  it("accepts a same-origin path", () => {
    expect(safeReturnTarget("/status/")).toBe("/status/")
  })

  it("accepts a same-origin path carrying its own query string", () => {
    expect(safeReturnTarget("/status/?x=1")).toBe("/status/?x=1")
  })

  it("falls back to /status/ when there is nothing to return to", () => {
    expect(safeReturnTarget(null)).toBe("/status/")
    expect(safeReturnTarget(undefined)).toBe("/status/")
    expect(safeReturnTarget("")).toBe("/status/")
  })

  it("rejects a protocol-relative target", () => {
    expect(safeReturnTarget("//evil.com")).toBe("/status/")
  })

  it("rejects a backslash-prefixed target (browsers resolve \\ like /)", () => {
    expect(safeReturnTarget("/\\evil.com")).toBe("/status/")
  })

  it("rejects a bare host with no leading slash", () => {
    expect(safeReturnTarget("evil.com")).toBe("/status/")
  })

  it("rejects a full absolute URL", () => {
    expect(safeReturnTarget("https://evil.com")).toBe("/status/")
  })

  it("decodes a percent-encoded value before checking it", () => {
    expect(safeReturnTarget(encodeURIComponent("/status/?sheetname=2569_04"))).toBe(
      "/status/?sheetname=2569_04",
    )
  })

  it("decodes a percent-encoded attack rather than trusting the raw prefix", () => {
    // "%2F%2Fevil.com" decodes to "//evil.com" — must still be rejected.
    expect(safeReturnTarget(encodeURIComponent("//evil.com"))).toBe("/status/")
  })

  it("falls back on an undecodable value instead of throwing", () => {
    expect(safeReturnTarget("%")).toBe("/status/")
  })
})

/**
 * sanitizeName ported verbatim from verify/app.js. It only normalises spaces
 * and hyphens and collapses whitespace runs — it does NOT strip other control
 * or zero-width characters. These tests lock in that exact (narrower than the
 * name suggests) behaviour rather than what a stricter sanitizer might do.
 */
describe("sanitizeName", () => {
  it("collapses runs of whitespace to one space", () => {
    expect(sanitizeName("สมชาย   ใจดี")).toBe("สมชาย ใจดี")
  })

  it("treats hyphens as spaces", () => {
    expect(sanitizeName("Somchai-Jaidee")).toBe("Somchai Jaidee")
  })

  it("collapses tabs and newlines like any other whitespace", () => {
    expect(sanitizeName("Somchai\t\nJaidee")).toBe("Somchai Jaidee")
  })

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeName("  สมชาย  ")).toBe("สมชาย")
  })

  it("clamps to NAME_MAX characters", () => {
    const long = "ก".repeat(NAME_MAX + 50)
    expect(sanitizeName(long)).toHaveLength(NAME_MAX)
  })

  it("treats null, undefined and empty string as empty", () => {
    expect(sanitizeName(null)).toBe("")
    expect(sanitizeName(undefined)).toBe("")
    expect(sanitizeName("")).toBe("")
  })

  it("does not strip a NUL or zero-width character (documented gap, not a bug to fix here)", () => {
    expect(sanitizeName(`A${String.fromCharCode(0)}B`)).toBe(`A${String.fromCharCode(0)}B`)
    expect(sanitizeName(`A${String.fromCharCode(0x200b)}B`)).toBe(`A${String.fromCharCode(0x200b)}B`)
  })
})

describe("isValidEmail", () => {
  it("accepts a normal address", () => {
    expect(isValidEmail("name@example.com")).toBe(true)
  })

  it("rejects a missing domain dot, missing @, or empty string", () => {
    expect(isValidEmail("name@example")).toBe(false)
    expect(isValidEmail("name.example.com")).toBe(false)
    expect(isValidEmail("")).toBe(false)
  })
})

describe("isValidOtp", () => {
  it("accepts exactly six digits", () => {
    expect(isValidOtp("123456")).toBe(true)
  })

  it("rejects anything else", () => {
    expect(isValidOtp("12345")).toBe(false)
    expect(isValidOtp("1234567")).toBe(false)
    expect(isValidOtp("12345a")).toBe(false)
    expect(isValidOtp("")).toBe(false)
  })
})
