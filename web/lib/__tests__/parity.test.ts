/**
 * Anti-drift guard for the migration.
 *
 * Month names and accent colours currently exist in three places:
 *
 *   ../../src/constants.ts    the Express server's Flex month picker, and
 *                             scripts/update-month-picker.mts (rich menu)
 *   ../../assets/shared.js    the three legacy browser pages
 *   ../colors.ts, ../months.ts  this app
 *
 * The first two cannot be deleted until the Express server is retired at
 * cutover, so for the length of the migration all three must agree. A colour
 * changed in one place and not the others would show up as a month tab whose
 * accent does not match the LINE message that linked to it — visible, confusing
 * and easy to miss in review.
 *
 * These tests fail loudly the moment they diverge. Delete this file in Phase 7,
 * together with the two legacy sources.
 */
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { MONTH_COLORS } from "../colors"
import { DEPARTMENTS } from "../departments"
import { THAI_MONTHS, THAI_MONTHS_SHORT, recentMonthKeys, toBE } from "../months"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "../../..")
const require = createRequire(import.meta.url)

interface LegacyConstants {
  COLOR_ARRAY: [string, string][]
  MONTH_NAMES: string[]
  MONTH_ITERATOR: [number, number][][]
}

// A plain createRequire() can't load .ts (it's Node's native CJS loader, not
// Vite's transform pipeline) — dynamic import() is, and Vitest's SSR module
// runner transforms any .ts file it loads this way, static or computed path.
const serverConstants = (await import(
  resolve(repoRoot, "src/constants.ts")
)) as LegacyConstants

/**
 * assets/shared.js is an IIFE that assigns to `window`, so it cannot be
 * required. Execute it against a stub global and read what it published.
 */
function loadBrowserShared(): {
  COLOR_ARRAY: [string, string][]
  THAI_MONTHS: string[]
  THAI_MONTHS_SHORT: string[]
} {
  const source = readFileSync(resolve(repoRoot, "assets/shared.js"), "utf8")
  const fakeWindow: Record<string, unknown> = {}
  new Function("window", source)(fakeWindow)
  const p4p = fakeWindow.P4P as ReturnType<typeof loadBrowserShared> | undefined
  if (!p4p) throw new Error("assets/shared.js did not define window.P4P")
  return p4p
}

const browserShared = loadBrowserShared()

/**
 * Extract a top-level `const <name> = [ ... ]` array literal from a legacy
 * page script. status/app.js and admin/app.js both hardcode the department
 * list inside an IIFE with no export, so there is nothing to import — but the
 * ordering is load-bearing (it is a hand-maintained Thai dictionary order that
 * localeCompare does not reproduce), and a third copy of it is exactly the kind
 * of thing that drifts silently.
 *
 * If the regex stops matching because the declaration was reformatted, this
 * throws and the test fails loudly. That is the intended behaviour: re-point it
 * at the new shape, or delete the copy.
 */
function extractArrayLiteral(relativePath: string, name: string): string[] {
  const source = readFileSync(resolve(repoRoot, relativePath), "utf8")
  const match = new RegExp(`const\\s+${name}\\s*=\\s*(\\[[^\\]]*\\])`).exec(source)
  if (!match?.[1]) {
    throw new Error(`could not find \`const ${name} = [...]\` in ${relativePath}`)
  }
  return JSON.parse(match[1]) as string[]
}

describe("src/constants.ts (Express server + rich menu)", () => {
  it("has the same accent colours, in the same order", () => {
    expect(serverConstants.COLOR_ARRAY).toEqual(MONTH_COLORS.map((c) => [c.tw, c.hex]))
  })

  it("has the same full Thai month names", () => {
    expect(serverConstants.MONTH_NAMES).toEqual([...THAI_MONTHS])
  })

  it("produces the same six-month window as recentMonthKeys", () => {
    // MONTH_ITERATOR encodes the window as [monthIndex, yearOffset] pairs
    // relative to a given current month. recentMonthKeys computes it from a
    // Date. They must describe the same six months for every starting month,
    // or the LINE month picker and the /list/ dropdown disagree about which
    // months exist.
    for (let m = 0; m < 12; m++) {
      const now = new Date(Date.UTC(2026, m, 15))
      const fromTs = recentMonthKeys(6, now)

      const iterator = serverConstants.MONTH_ITERATOR[m]!
      const fromIterator = iterator.map(([monthIndex, yearOffset]) => {
        const beYear = toBE(2026) + yearOffset
        return `${beYear}_${String(monthIndex + 1).padStart(2, "0")}`
      })

      expect(fromIterator, `starting month index ${m}`).toEqual(fromTs)
    }
  })
})

describe("department list (three hardcoded copies)", () => {
  // status/app.js drives the physician-facing grouping; admin/app.js drives the
  // admin dashboard's department dropdown, where a mismatch would let an admin
  // save a spelling the status page then fails to group.
  it.each([
    ["status/app.js", "dep_array"],
    ["admin/app.js", "dep_array"],
  ])("%s matches lib/departments.ts", (path, name) => {
    expect(extractArrayLiteral(path, name)).toEqual([...DEPARTMENTS])
  })
})

describe("assets/shared.js (legacy browser pages)", () => {
  it("has the same accent colours, in the same order", () => {
    expect(browserShared.COLOR_ARRAY).toEqual(MONTH_COLORS.map((c) => [c.tw, c.hex]))
  })

  it("has the same full Thai month names", () => {
    expect(browserShared.THAI_MONTHS).toEqual([...THAI_MONTHS])
  })

  it("has the same abbreviated Thai month names", () => {
    expect(browserShared.THAI_MONTHS_SHORT).toEqual([...THAI_MONTHS_SHORT])
  })
})
