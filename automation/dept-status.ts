/**
 * dept-status.js
 *
 * Shared helpers used by score-tracker.mjs and resend-month.mjs — previously
 * each script carried its own near-identical copy of maskEmail/createSB/
 * getDeptStatus. That drift already caused a real bug: resend-month.mjs's
 * copy of getDeptStatus was missing the "table doesn't exist" tolerance that
 * score-tracker.mjs's copy had, so resend-month.mjs would crash instead of
 * reporting "no data" when run against a month whose Supabase table doesn't
 * exist yet. This module is now the one place that logic lives.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DeptStatus } from "./types.js";

export function createSB(): SupabaseClient {
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// This workflow can run on GitHub Actions in a PUBLIC repo — never print or
// persist a full recipient address to console/$GITHUB_STEP_SUMMARY, both of
// which are publicly readable job output.
export function maskEmail(email: unknown): string {
  const [user, domain] = String(email ?? "").split("@");
  if (!domain) return "***";
  const masked = user.length <= 2 ? `${user[0] ?? "*"}*` : `${user[0]}${"*".repeat(user.length - 2)}${user.slice(-1)}`;
  return `${masked}@${domain}`;
}

interface RosterScoreRow {
  firstname: string | null;
  lastname: string | null;
  score: number | null;
}

/**
 * Per-department score status for one month table.
 * @param sb
 * @param tableKey   e.g. "2569_06"
 * @param dept
 * @param driveFileMap  physician full name -> Drive file ID
 */
export async function getDeptStatus(
  sb: SupabaseClient,
  tableKey: string,
  dept: string,
  driveFileMap: Map<string, string> | null = null
): Promise<DeptStatus | null> {
  const { data, error } = await sb
    .from(tableKey)
    .select("firstname, lastname, score")
    .eq("department", dept);
  if (error) {
    // A window that reaches back further than a department/table's history
    // is expected — treat "table doesn't exist" as "no data" rather than a
    // fatal error (same pattern as process/report.js's getSupabasePersons).
    if (error.code === "42P01" || /does not exist|schema cache/i.test(error.message)) return null;
    throw new Error(`[${tableKey}/${dept}] Supabase: ${error.message}`);
  }
  const rowsData = data as RosterScoreRow[] | null;
  if (!rowsData?.length) return null;

  const total   = rowsData.length;
  const filled  = rowsData.filter(r => r.score !== null).length;
  const missing = total - filled;

  // Sort: score DESC, nulls last
  const rows = [...rowsData]
    .sort((a, b) => {
      if (a.score === null && b.score === null) return 0;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score;
    })
    .map(r => {
      const name = `${r.firstname ?? ""} ${r.lastname ?? ""}`.trim();
      return { name, score: r.score, driveFileId: driveFileMap?.get(name) ?? null };
    });

  const missingNames = rows.filter(r => r.score === null).map(r => r.name);
  return { total, filled, missing, complete: missing === 0, missingNames, rows };
}
