import { describe, expect, it, vi, afterEach } from "vitest"
import {
  EARLIEST_MONTH_KEY,
  deadlineISO,
  formatBangkokTime,
  isMonthKey,
  monthKey,
  parseMonthKey,
  rankingMonths,
  recentMonthKeys,
  thaiLabel,
  thaiLabelFromKey,
  thaiLabelShort,
  toBE,
  toGregorian,
} from "../months"

afterEach(() => {
  vi.useRealTimers()
})

/** Pin "now" so results don't change with the calendar. */
function freeze(iso: string): void {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso))
}

describe("BE conversion", () => {
  it("converts both ways", () => {
    expect(toBE(2026)).toBe(2569)
    expect(toGregorian(2569)).toBe(2026)
  })

  it("round-trips", () => {
    expect(toGregorian(toBE(1999))).toBe(1999)
  })
})

describe("monthKey / parseMonthKey", () => {
  it("zero-pads the month", () => {
    expect(monthKey(2569, 4)).toBe("2569_04")
    expect(monthKey(2569, 12)).toBe("2569_12")
  })

  it("round-trips", () => {
    expect(parseMonthKey(monthKey(2570, 7))).toEqual({ beYear: 2570, month: 7 })
  })

  it("returns null for anything that is not a month key", () => {
    for (const bad of [null, undefined, 42, "2569", "2569_", "2569_1", "2569_00", "2569_13"]) {
      expect(parseMonthKey(bad)).toBeNull()
    }
  })
})

describe("isMonthKey", () => {
  it("accepts every valid month", () => {
    for (let m = 1; m <= 12; m++) {
      expect(isMonthKey(monthKey(2569, m))).toBe(true)
    }
  })

  it("rejects out-of-range months", () => {
    expect(isMonthKey("2569_00")).toBe(false)
    expect(isMonthKey("2569_13")).toBe(false)
  })

  it("rejects the shapes that could reach db.from() from a URL", () => {
    const hostile = [
      "",
      "physician_directory",
      "2569_04; drop table x",
      "2569_04 --",
      "../2569_04",
      "2569_4",
      "12569_04",
      "2569_040",
      "2569-04",
    ]
    for (const value of hostile) {
      expect(isMonthKey(value), value).toBe(false)
    }
  })

  it("rejects non-strings", () => {
    expect(isMonthKey(null)).toBe(false)
    expect(isMonthKey(undefined)).toBe(false)
    expect(isMonthKey({ toString: () => "2569_04" })).toBe(false)
  })
})

describe("labels", () => {
  it("formats full and short Thai labels", () => {
    expect(thaiLabel(2569, 3)).toBe("มีนาคม 2569")
    expect(thaiLabelShort(2569, 3)).toBe("มี.ค. 2569")
  })

  it("labels from a key, or null when invalid", () => {
    expect(thaiLabelFromKey("2569_01")).toBe("มกราคม 2569")
    expect(thaiLabelFromKey("nope")).toBeNull()
  })
})

describe("recentMonthKeys", () => {
  it("returns the current month first, then five back", () => {
    freeze("2026-08-08T03:00:00Z")
    expect(recentMonthKeys(6, new Date())).toEqual([
      "2569_08",
      "2569_07",
      "2569_06",
      "2569_05",
      "2569_04",
      "2569_03",
    ])
  })

  it("crosses the year boundary, decrementing the BE year", () => {
    expect(recentMonthKeys(4, new Date("2026-02-15T00:00:00+07:00"))).toEqual([
      "2569_02",
      "2569_01",
      "2568_12",
      "2568_11",
    ])
  })

  it("handles January, where every earlier month is last year", () => {
    const keys = recentMonthKeys(3, new Date("2026-01-10T00:00:00+07:00"))
    expect(keys).toEqual(["2569_01", "2568_12", "2568_11"])
  })
})

describe("rankingMonths", () => {
  it("marks only the first month as current", () => {
    const months = rankingMonths(new Date("2026-08-08T00:00:00+07:00"))
    expect(months[0]).toEqual({ key: "2569_08", label: "ส.ค. 2569", current: true })
    expect(months.slice(1).every((m) => !m.current)).toBe(true)
  })

  it("stops at the earliest month rather than inventing older tabs", () => {
    const months = rankingMonths(new Date("2026-08-08T00:00:00+07:00"))
    expect(months.at(-1)?.key).toBe(EARLIEST_MONTH_KEY)
    // Apr..Aug 2569 inclusive.
    expect(months).toHaveLength(5)
  })

  it("caps at max once enough months have elapsed", () => {
    const months = rankingMonths(new Date("2030-08-08T00:00:00+07:00"))
    expect(months).toHaveLength(24)
    expect(months[0]?.key).toBe("2573_08")
  })

  it("never produces a duplicate key", () => {
    const months = rankingMonths(new Date("2030-01-01T00:00:00+07:00"))
    expect(new Set(months.map((m) => m.key)).size).toBe(months.length)
  })

  it("walks strictly backwards one month at a time", () => {
    const months = rankingMonths(new Date("2030-03-15T00:00:00+07:00"))
    for (let i = 1; i < months.length; i++) {
      const prev = parseMonthKey(months[i - 1]!.key)!
      const cur = parseMonthKey(months[i]!.key)!
      const gap = (prev.beYear - cur.beYear) * 12 + (prev.month - cur.month)
      expect(gap).toBe(1)
    }
  })
})

describe("deadlineISO", () => {
  it("is the 5th of the following month, Bangkok time", () => {
    expect(deadlineISO("2569_04")).toBe("2026-05-05T23:59:59+07:00")
  })

  it("rolls December into the next Gregorian year", () => {
    expect(deadlineISO("2569_12")).toBe("2027-01-05T23:59:59+07:00")
  })

  it("throws rather than building a nonsense filter", () => {
    expect(() => deadlineISO("garbage")).toThrow()
  })
})

describe("formatBangkokTime", () => {
  it("formats in Bangkok time regardless of the host timezone", () => {
    // 2026-08-05 07:32 UTC == 14:32 in Bangkok.
    expect(formatBangkokTime("2026-08-05T07:32:00Z")).toBe("5 ส.ค. · 14:32")
  })

  it("uses the Bangkok calendar day, not the UTC one", () => {
    // 2026-08-05 18:00 UTC is already the 6th in Bangkok (01:00).
    expect(formatBangkokTime("2026-08-05T18:00:00Z")).toBe("6 ส.ค. · 01:00")
  })

  it("renders midnight as 00:00, never 24:00", () => {
    expect(formatBangkokTime("2026-08-05T17:00:00Z")).toBe("6 ส.ค. · 00:00")
  })

  it("returns a dash for an unparseable timestamp", () => {
    expect(formatBangkokTime("not a date")).toBe("—")
  })

  it("is stable when the process timezone is not Bangkok", () => {
    // The regression this guards: ranking/app.js used getDate()/getHours(),
    // which would render this differently on a UTC device than a +07 one.
    const original = process.env.TZ
    try {
      process.env.TZ = "UTC"
      expect(formatBangkokTime("2026-08-05T07:32:00Z")).toBe("5 ส.ค. · 14:32")
      process.env.TZ = "America/New_York"
      expect(formatBangkokTime("2026-08-05T07:32:00Z")).toBe("5 ส.ค. · 14:32")
    } finally {
      process.env.TZ = original
    }
  })
})
