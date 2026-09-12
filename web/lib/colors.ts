/**
 * Month accent colours.
 *
 * These currently live in TWO places: ../../src/constants.ts (used by the
 * Express server for Flex messages and by scripts/update-month-picker.mts) and
 * ../../assets/shared.js (used by the browser pages). This module is the
 * replacement for both, but it cannot delete either one until the Express
 * server is retired at cutover.
 *
 * Until then the copies must not drift, so lib/__tests__/parity.test.ts reads
 * src/constants.ts directly and asserts it still matches this file. If you
 * change a colour here and that test fails, change it there too — the rich menu
 * and the Flex month picker are generated from this copy.
 */

/** A month's accent colour. `tw` is the Tailwind v3 class name that the LINE
 *  rich-menu/Flex builders pass around as a `color` URL parameter; it is not a
 *  class this app uses to style anything. `hex` is what the UI renders. */
export interface MonthColor {
  readonly tw: string
  readonly hex: string
}

/** Index 0 = January. */
export const MONTH_COLORS: readonly MonthColor[] = [
  { tw: "bg-red-300", hex: "#ffa2a2" },
  { tw: "bg-orange-300", hex: "#ffb86a" },
  { tw: "bg-yellow-300", hex: "#ffdf20" },
  { tw: "bg-lime-300", hex: "#bbf451" },
  { tw: "bg-green-300", hex: "#7bf1a8" },
  { tw: "bg-teal-300", hex: "#46ecd5" },
  { tw: "bg-cyan-300", hex: "#53eafd" },
  { tw: "bg-sky-300", hex: "#74d4ff" },
  { tw: "bg-blue-300", hex: "#8ec5ff" },
  { tw: "bg-indigo-300", hex: "#a3b3ff" },
  { tw: "bg-violet-300", hex: "#c4b4ff" },
  { tw: "bg-fuchsia-300", hex: "#f4a8ff" },
] as const

/**
 * Accent hex for a 1-based month number (1 = January).
 *
 * Wraps rather than throwing, matching the existing `COLOR_ARRAY[(month-1)%12]`
 * in list/app.js. Callers that need validation should use isMonthKey() first.
 */
export function monthColorHex(month: number): string {
  const entry = MONTH_COLORS[(((month - 1) % 12) + 12) % 12]
  // Unreachable — the modulo above always lands in range — but
  // noUncheckedIndexedAccess cannot know that, and a silent `undefined`
  // reaching a style attribute would be worse than an obvious fallback.
  return entry?.hex ?? "#E8E3DC"
}
