/**
 * supabase-client.js
 *
 * Exports:
 *   matchName(name, date)       — fuzzy-match physician name in Supabase table,
 *                                 returns { matchedName, index, similarity } or null
 *   saveScore(date, index, score) — write score (float8) to the matched row
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SIMILARITY_THRESHOLD, SUPABASE_ROW_LIMIT } from "./config.js";
import type { RosterMatch } from "./types.js";

// ── Singleton client ───────────────────────────────────────────────────────
let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY in .env");
  _supabase = createClient(url, key);
  return _supabase;
}

// ── Text normaliser ────────────────────────────────────────────────────────
export const normalise = (s: unknown): string =>
  String(s ?? "")
    .replace(/[\s ​  　﻿]+/g, " ")
    .trim()
    .toLowerCase();

// ── Levenshtein distance ───────────────────────────────────────────────────
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

/**
 * Similarity score 0–1 between two name strings.
 * 1.0 = exact match, 0 = completely different.
 * Also awards partial credit when all tokens of the shorter name appear in the longer.
 */
export function similarity(a: unknown, b: unknown): number {
  const na = normalise(a);
  const nb = normalise(b);
  if (na === nb) return 1.0;

  // Token overlap bonus — handles missing last name
  const tokA = na.split(" ").filter(Boolean);
  const tokB = nb.split(" ").filter(Boolean);
  const shorter = tokA.length <= tokB.length ? tokA : tokB;
  const longer  = tokA.length <= tokB.length ? tokB : tokA;
  // A token matches if it's an exact hit OR a prefix of a longer token (min 3 chars).
  // This handles abbreviated lastnames in filenames, e.g. "หยิบ" → "หยิบทรงศิริกุล".
  const tokenMatches = (t: string) =>
    longer.includes(t) || (t.length >= 3 && longer.some((l) => l.startsWith(t)));
  const allMatch = shorter.every(tokenMatches);
  // Require ≥ 2 tokens to avoid a single first-name token matching any physician
  // with the same first name but a different last name (false-positive at 0.9).
  if (allMatch && shorter.length >= 2) return 0.9;

  // Levenshtein-based similarity
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(na, nb) / maxLen;
}

// ── Date validator ─────────────────────────────────────────────────────────
/**
 * Returns true only for well-formed date keys: BE year 2400–2700, month 01–12.
 * Catches "0000_01", "2569_13", "9999_99", etc.
 */
export function isValidDate(date: unknown): boolean {
  if (!date) return false;
  const m = String(date).match(/^(\d{4})_(\d{2})$/);
  if (!m) return false;
  const yr = parseInt(m[1]!, 10), mo = parseInt(m[2]!, 10);
  return yr >= 2400 && yr <= 2700 && mo >= 1 && mo <= 12;
}

interface RosterRow {
  index: number | string;
  firstname: string | null;
  lastname: string | null;
  prefix: string | null;
  department: string | null;
}

// ── Exports ────────────────────────────────────────────────────────────────

/**
 * Fuzzy-match a physician name against all rows in the date table.
 * Returns the best match above the similarity threshold, or null.
 *
 * @param name   Physician name from Claude, e.g. "สมชาย ใจดี"
 * @param date   Table name, e.g. "2569_02"
 * @param threshold  Minimum similarity to accept (0–1)
 */
export async function matchName(name: string, date: string, threshold: number = SIMILARITY_THRESHOLD): Promise<RosterMatch | null> {
  if (!isValidDate(date)) return null;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(date)
    .select("index, firstname, lastname, prefix, department")
    .limit(SUPABASE_ROW_LIMIT);

  if (error) throw new Error(`Supabase query error on table "${date}": ${error.message}`);
  if (!data || data.length === 0) return null;
  const rows = data as unknown as RosterRow[];

  // ── Single-token (firstname-only) fast path ──────────────────────────────
  // When the extracted name is a single token (no last name supplied), check
  // whether exactly one row shares that first name.  If unambiguous, auto-
  // assign the last name from the database record.
  //   • Exactly 1 row matches → safe to use (unique firstname in this table)
  //   • 2+ rows match         → ambiguous, return null (safer than wrong match)
  //   • 0 rows match          → fall through to Levenshtein
  const normName = normalise(name);
  const tokens   = normName.split(" ").filter(Boolean);
  if (tokens.length === 1) {
    const hits = rows.filter((row) => normalise(row.firstname ?? "") === normName);
    if (hits.length === 1) {
      const row      = hits[0]!;
      const fullName = `${row.firstname ?? ""} ${row.lastname ?? ""}`.trim();
      console.log(`│        🔤  Single-token firstname match: "${normName}" → "${fullName}" (unique)`);
      return {
        matchedName: fullName,
        prefix     : row.prefix     ?? "",
        department : row.department ?? "",
        index      : row.index,
        similarity : 0.95, // high-confidence — unique firstname in this table
      };
    }
    if (hits.length > 1) {
      console.warn(`│        ⚠️  Single-token "${normName}" matches ${hits.length} rows — ambiguous, skipping`);
      return null;
    }
    // 0 exact firstname matches → fall through to Levenshtein
  }

  // ── Normal fuzzy matching ──────────────────────────────────────────────────
  let best: RosterMatch | null = null;

  for (const row of rows) {
    const fullName = `${row.firstname ?? ""} ${row.lastname ?? ""}`.trim();
    const sim = similarity(name, fullName);
    if (sim > (best?.similarity ?? -1)) {
      best = {
        matchedName: fullName,
        prefix     : row.prefix      ?? "",
        department : row.department  ?? "",
        index      : row.index,
        similarity : sim,
      };
      if (sim === 1.0) break; // exact match — no need to scan remaining rows
    }
  }

  if (!best || best.similarity < threshold) return null;
  return best;
}

/**
 * Fetch one roster row by its primary key, in the same shape matchName()
 * returns. The upload path already knows which row it is writing to —
 * enqueue_p4p_upload() resolved it from the authenticated identity — so it
 * needs the row's canonical spelling and department, not a fuzzy search.
 * `similarity: 1` records that this was an exact, server-resolved hit rather
 * than a guess.
 */
export async function getRosterRowByIndex(date: string, index: number | string | null | undefined): Promise<RosterMatch | null> {
  if (!isValidDate(date)) return null;
  if (index === null || index === undefined) return null;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(date)
    .select("index, firstname, lastname, prefix, department")
    .eq("index", index)
    .limit(1);

  if (error) throw new Error(`Supabase query error on table "${date}": ${error.message}`);
  const row = (data as unknown as RosterRow[] | null)?.[0];
  if (!row) return null;

  return {
    matchedName: `${row.firstname ?? ""} ${row.lastname ?? ""}`.trim(),
    prefix     : row.prefix     ?? "",
    department : row.department ?? "",
    index      : row.index,
    similarity : 1,
  };
}

export interface SubmissionInput {
  physicianName: string;
  department?: string | null;
  workMonth: string;
  submittedAt: string;
  threadId?: string | null;
  filename?: string | null;
}

/**
 * Log a successful P4P submission to the p4p_submissions table.
 * Uses ON CONFLICT DO NOTHING so re-processing the same email never overwrites
 * the first (earliest) submission row for a given physician + work month.
 */
export async function logSubmission({ physicianName, department, workMonth, submittedAt, threadId, filename }: SubmissionInput): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("p4p_submissions")
    .upsert(
      {
        physician_name: physicianName,
        department    : department ?? null,
        work_month    : workMonth,
        submitted_at  : submittedAt,
        thread_id     : threadId  ?? null,
        filename      : filename  ?? null,
      },
      { onConflict: "physician_name,work_month", ignoreDuplicates: true }
    );
  if (error) throw new Error(`p4p_submissions insert error: ${error.message}`);
}

/**
 * Fetch the department → head email map from the dept_heads table.
 * Replaces the DEPT_HEADS_JSON GitHub secret — this is readable/editable
 * (Supabase Table Editor or SQL) instead of write-only, and heads change
 * often enough that a single-row edit beats re-pasting a whole JSON blob.
 * Returns {} on error (callers treat a missing/null entry as "no email").
 */
export async function getDeptHeads(): Promise<Record<string, string>> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("dept_heads").select("department, head_email");
  if (error) { console.warn(`⚠️  dept_heads read failed: ${error.message}`); return {}; }
  return Object.fromEntries((data as { department: string; head_email: string }[]).map((r) => [r.department, r.head_email]));
}

export interface SaveSenderMatchInput {
  senderEmail: string;
  senderDisplayName?: string | null;
  emailCount: number;
  extractedName?: string | null;
  nameSource: string;
  matchedPhysician?: string | null;
  department?: string | null;
  similarity: number | string;
  matched: "yes" | "no" | boolean;
}

/**
 * Upsert one sender → physician match result into sender_physician_match.
 * Replaces the sender-physician-match.csv file previously committed to the repo.
 */
export async function saveSenderMatch({
  senderEmail, senderDisplayName, emailCount,
  extractedName, nameSource, matchedPhysician, department, similarity, matched,
}: SaveSenderMatchInput): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("sender_physician_match")
    .upsert(
      {
        sender_email        : senderEmail,
        sender_display_name : senderDisplayName ?? null,
        email_count         : emailCount,
        extracted_name      : extractedName || null,
        name_source         : nameSource,
        matched_physician   : matchedPhysician || null,
        department          : department || null,
        similarity          : Number(similarity),
        matched             : matched === "yes" || matched === true,
        updated_at          : new Date().toISOString(),
      },
      { onConflict: "sender_email" }
    );
  if (error) throw new Error(`sender_physician_match upsert error: ${error.message}`);
}

export interface BumpSenderMatchInput {
  senderEmail: string;
  senderDisplayName?: string | null;
  extractedName?: string | null;
  matchedPhysician?: string | null;
  department?: string | null;
  similarity: number | string;
}

/**
 * Record one successful live submission against sender_physician_match.
 * Unlike saveSenderMatch() (used by the historical batch scan, which sets an
 * absolute email_count from a full mailbox re-scan), this increments the
 * existing count by 1 — called once per successfully-processed email from
 * the live pipeline, so the count reflects submissions-seen-so-far rather
 * than a re-derived total.
 *
 * Delegates to the bump_sender_match RPC (automation/sql/bump_sender_match.sql)
 * so the increment happens atomically in one INSERT ... ON CONFLICT statement.
 * A JS-side read-then-upsert would race when attachments from the same email
 * (or overlapping pipeline runs) call this concurrently for the same sender,
 * silently losing increments.
 */
export async function bumpSenderMatch({
  senderEmail, senderDisplayName, extractedName, matchedPhysician, department, similarity,
}: BumpSenderMatchInput): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc("bump_sender_match", {
    p_sender_email        : senderEmail,
    p_sender_display_name : senderDisplayName || null,
    p_extracted_name      : extractedName || null,
    p_matched_physician   : matchedPhysician || null,
    p_department          : department || null,
    p_similarity          : Number(similarity),
  });
  if (error) throw new Error(`bump_sender_match RPC error: ${error.message}`);
}

/**
 * Update the score column for a specific row identified by its primary key.
 *
 * @param date          Table name, e.g. "2569_02"
 * @param index         Primary key value (column "index")
 * @param score         Score to save (float8)
 * @param submittedAt ISO timestamp. When omitted, the existing
 *                                      submitted_at value is left untouched (used
 *                                      by the score-only backfill).
 */
export async function saveScore(date: string, index: number | string, score: number, submittedAt?: string): Promise<void> {
  if (!isValidDate(date)) {
    throw new Error(`Cannot save score — invalid date key: "${date}"`);
  }
  if (index === null || index === undefined) {
    throw new Error(`Cannot save score — index is ${index}`);
  }
  if (!Number.isFinite(score)) {
    throw new Error(`Cannot save score — value is not a finite number: ${score}`);
  }

  // Only overwrite submitted_at when a timestamp is supplied. Passing
  // `submitted_at: undefined` happens to be dropped by JSON.stringify today, but
  // relying on that is fragile — build the patch explicitly instead.
  const patch: { score: number; submitted_at?: string } = { score };
  if (submittedAt !== undefined) patch.submitted_at = submittedAt;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(date)
    .update(patch)
    .eq("index", index)
    .select("index");

  if (error) throw new Error(`Supabase update error on table "${date}": ${error.message}`);
  // Supabase returns success with 0 affected rows when the filter matches
  // nothing (stale match, wrong table) — without checking this, the caller
  // believes the score was saved and reports success while nothing changed.
  if (!data || data.length === 0) {
    throw new Error(`Supabase update on table "${date}" matched no row for index ${index} — score was NOT saved`);
  }
}
