/**
 * The names the dashboard shows for its users (Pong, 2026-11-18: "Dada =
 * กานดา, Pongsit = ปองสิทธิ์"). A user's name comes from their LINE profile
 * at sign-in; these replace it in the session, so everything saved from now
 * on (rounds, budgets, notes, the History log) carries the Thai name. Rows
 * saved before keep the LINE name in the database and are shown through the
 * same map: dashboard/app.ts and dashboard/review.ts hold a copy of it (they
 * are plain browser scripts), and process/review-pdf.ts uses this one.
 */
export const STAFF_NAMES: ReadonlyMap<string, string> = new Map([
  ["pongsit", "ปองสิทธิ์"],
  ["dada", "กานดา"],
])

/** The shown name for a LINE display name (matched without case or spaces). */
export function staffName(name: unknown): string {
  const s = String(name ?? "").trim()
  return STAFF_NAMES.get(s.toLowerCase()) || s
}
