/**
 * log-safe.ts
 *
 * Console output of the always-on relay (workflow 1) and the other Actions
 * jobs is readable by anyone while the repository is public, so it must not
 * carry personal data: no sender addresses or display names, subjects, body
 * text, physician names, file or sheet names, LINE ids or scores. Log Gmail
 * message ids, queue ids, roster row indexes, month keys and counts instead,
 * and, where telling two values apart helps, a short tag from logTag().
 * Telegram (the admin's private chat) keeps the full details.
 */

import { createHmac, randomBytes } from "node:crypto";

let tagKey: string | null = null;

/**
 * A short tag (8 hex characters) for a personal value, the same within one
 * process for the same value, so a log can show "these two messages came
 * from the same sender" without saying who. It is an HMAC under a key the
 * public never sees (LOG_TAG_KEY when set, so tags also match across runs;
 * otherwise a random key per process), so the tag of a name or address
 * cannot be recomputed from a list of guesses.
 */
export function logTag(value: unknown): string {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return "-";
  if (tagKey === null) tagKey = process.env.LOG_TAG_KEY || randomBytes(32).toString("hex");
  return createHmac("sha256", tagKey).update(v).digest("hex").slice(0, 8);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A month key ("2569_10") or other plain identifier is kept when quoted; anything else quoted is withheld.
const SAFE_QUOTED_RE = /^(?:\d{4}_\d{2}|[A-Za-z_]+)$/;

/**
 * Error text for a log line. Raw errors can carry Claude's output, cell values,
 * file or sheet names and addresses; this keeps the technical part and drops
 * those: Claude's output and sample values after their known prefixes, email
 * addresses, anything in quotes except a month key or a bare identifier, and
 * Thai text (the names in this system are Thai). The full message still goes
 * to Telegram where the caller sends one.
 */
export function redactForLog(text: unknown, max: number = 300): string {
  let s = text instanceof Error ? text.message : String(text ?? "");
  s = s.replace(/(Claude returned non-JSON|Missing or empty "name")[\s\S]*/, "$1 (model output withheld)");
  s = s.replace(/(Claude API returned unexpected response)[\s\S]*/, "$1 (content withheld)");
  s = s.replace(/(Sample values:)[\s\S]*/, "$1 (withheld)");
  s = s.replace(/(Could not determine score\. Claude: )"[^"]*"/, "$1(withheld)");
  s = s.replace(EMAIL_RE, "<email>");
  s = s.replace(/"([^"]*)"/g, (whole, inner: string) => (SAFE_QUOTED_RE.test(inner) ? whole : `"…"`));
  s = s.replace(/[฀-๿]+(?:[\s.]+[฀-๿]+)*/g, "<th>");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** redactForLog for a caught value of unknown type. */
export function errForLog(err: unknown): string {
  return redactForLog(err instanceof Error ? err.message : err);
}
