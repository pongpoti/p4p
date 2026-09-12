/**
 * Compares Google Drive month folder contents against Supabase physician table.
 * Usage: TARGET_DATE=2569_03 node scripts/check-month.mjs
 *
 * Prints:
 *   ✅  physicians found in Drive AND Supabase (with score status)
 *   ❌  Drive files with NO matching row in Supabase
 *   ⚠️   Supabase rows with NO file in Drive (score=NULL = never submitted)
 */

import { createDriveClient } from "../drive-client.js";
import { createClient }      from "@supabase/supabase-js";

const TARGET_DATE = process.env.TARGET_DATE ?? "2569_03";

/** One row of a per-month physician table, as selected below. */
interface PhysicianRow {
  index: number | string;
  firstname: string | null;
  lastname: string | null;
  prefix: string | null;
  department: string | null;
  score: number | null;
}

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY in .env");
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getSupabasePhysicians(date: string): Promise<PhysicianRow[]> {
  const { data, error } = await supabase
    .from(date)
    .select("index, firstname, lastname, prefix, department, score")
    .order("index");
  if (error) throw new Error(`Supabase error on table "${date}": ${error.message}`);
  return (data ?? []) as PhysicianRow[];
}

// ── Drive ─────────────────────────────────────────────────────────────────────
async function getDriveFiles(date: string): Promise<string[]> {
  const { listMonthFiles } = createDriveClient();
  const map = await listMonthFiles(date);   // Map<name, fileId>
  return [...map.keys()];                   // array of physician names
}

// ── Name normaliser ───────────────────────────────────────────────────────────
function normalise(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}
function fullName(row: PhysicianRow): string {
  return `${row.firstname ?? ""} ${row.lastname ?? ""}`.trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`\n📋  Drive vs Supabase — ${TARGET_DATE}\n`);

let driveNames: string[];
let sbRows: PhysicianRow[];
try {
  [driveNames, sbRows] = await Promise.all([
    getDriveFiles(TARGET_DATE),
    getSupabasePhysicians(TARGET_DATE),
  ]);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`❌  Fatal: ${message}`);
  process.exit(1);
}

console.log(`📂  Drive files  : ${driveNames.length}`);
console.log(`🗄️   Supabase rows: ${sbRows.length}\n`);

// Build normalised Supabase name map
const sbByNorm = new Map(sbRows.map((r) => [normalise(fullName(r)), r]));
const sbMatched = new Set();
const matched   = [];
const driveOnly = [];

for (const name of driveNames) {
  const normName = normalise(name);
  // Exact match, then substring containment
  let hit = sbByNorm.get(normName)
    ?? [...sbByNorm.entries()].find(([k]) => k.includes(normName) || normName.includes(k))?.[1];

  if (hit) {
    sbMatched.add(normalise(fullName(hit)));
    matched.push({ driveName: name, sbName: fullName(hit), score: hit.score });
  } else {
    driveOnly.push(name);
  }
}

const supabaseOnly = sbRows.filter((r) => !sbMatched.has(normalise(fullName(r))));

// ── Output ────────────────────────────────────────────────────────────────────
console.log(`✅  MATCHED (${matched.length})`);
console.log("─".repeat(72));
for (const m of matched) {
  const scoreStr = m.score != null ? `score=${m.score}` : `score=NULL ⚠️`;
  console.log(`  ✅  ${m.driveName.padEnd(36)} → ${m.sbName}  (${scoreStr})`);
}

if (driveOnly.length > 0) {
  console.log(`\n❌  IN DRIVE — NO SUPABASE MATCH (${driveOnly.length})`);
  console.log("─".repeat(72));
  for (const n of driveOnly) console.log(`  ❌  ${n}`);
}

if (supabaseOnly.length > 0) {
  console.log(`\n⚠️   IN SUPABASE — NO DRIVE FILE (${supabaseOnly.length})`);
  console.log("─".repeat(72));
  for (const r of supabaseOnly) {
    const scoreStr = r.score != null ? `score=${r.score}` : `score=NULL (never submitted)`;
    console.log(`  ⚠️   ${fullName(r).padEnd(36)}  ${scoreStr}`);
  }
}

console.log("\n✅  Done.");
