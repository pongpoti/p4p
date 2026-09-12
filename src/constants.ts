// Shared month/color constants used by the server (main.js) and the rich-menu
// build script (scripts/update-month-picker.mts).
//
// CommonJS-compiled so main.js can require() it directly; the ESM script
// imports it directly too. Keeping it here means a month/color tweak is a
// single edit.
//
// A compiled src/constants.js twin is committed alongside this source (run
// `npm run build:constants` to regenerate). It exists only because
// lib/line-receipt-flex.js — itself a compiled artifact, kept for the /upload/
// page's <script src> — does an extensionless `require("../src/constants")`;
// without a .js sibling here, Node's (and Vercel's bundler's) default
// extension-resolution order would look for constants.js, not find it, and
// only a tsx-patched resolver would fall back to this .ts file. Keep both in
// sync; nothing here changes often enough for that to be a real burden.

// Month accent colors, index 0 = January: [tailwindClass, hex]
export const COLOR_ARRAY: [string, string][] = [
  ["bg-red-300", "#ffa2a2"],
  ["bg-orange-300", "#ffb86a"],
  ["bg-yellow-300", "#ffdf20"],
  ["bg-lime-300", "#bbf451"],
  ["bg-green-300", "#7bf1a8"],
  ["bg-teal-300", "#46ecd5"],
  ["bg-cyan-300", "#53eafd"],
  ["bg-sky-300", "#74d4ff"],
  ["bg-blue-300", "#8ec5ff"],
  ["bg-indigo-300", "#a3b3ff"],
  ["bg-violet-300", "#c4b4ff"],
  ["bg-fuchsia-300", "#f4a8ff"],
]

// Full Thai month names, index 0 = January.
export const MONTH_NAMES: string[] = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
]

// For a given current month (0-11), the six months to display (most recent
// first), as [monthIndex, yearOffset] pairs.
//
// Derived rather than hand-written: this used to be a manually-maintained
// 12x6 matrix of tuples (72 numbers) — easy to typo on an edit and hard to
// verify by eye. It's fully determined by one rule: the i-th most-recent
// month before month `m` is (m - i) mod 12, crossing into the previous
// calendar year (yearOffset -1) whenever m - i is negative.
export const MONTH_ITERATOR: [number, number][][] = Array.from({ length: 12 }, (_, m) =>
  Array.from({ length: 6 }, (_, i) => [
    ((m - i) % 12 + 12) % 12,
    (m - i) < 0 ? -1 : 0,
  ] as [number, number])
)
