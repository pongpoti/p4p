/**
 * scripts/backfill-drive-scores.mjs
 *
 * Reads every Excel file from a P4P Google Drive month folder,
 * extracts the physician score, matches the physician in Supabase,
 * updates the score row, and writes a markdown results table to
 * $GITHUB_STEP_SUMMARY (or stdout when run locally).
 *
 * Environment variables (from GitHub Secrets):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   P4P_FOLDER_ID   — root "P4P" folder ID on Drive
 *   SUPABASE_URL, SUPABASE_KEY
 *
 * Job inputs (set by the workflow):
 *   TARGET_YEAR   e.g. "2569"
 *   TARGET_MONTH  e.g. "3"
 *   DRY_RUN       "true" → skip saveScore (read-only preview)
 */

import { google, type drive_v3 } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { appendFileSync } from "fs";
import { config as dotenvConfig } from "dotenv";
import { resolveScore }          from "../claude-analyst.js";
import { matchName, saveScore }  from "../supabase-client.js";
import { MONTH_FOLDER_NAMES, MONTH_TOKENS_BY_NUM } from "../months.js";
import { parseExcel }            from "../excel-parse.js";

dotenvConfig({ override: true });

const TARGET_YEAR  = process.env.TARGET_YEAR  || "2569";
const TARGET_MONTH = parseInt(process.env.TARGET_MONTH || "3", 10);
const DRY_RUN      = process.env.DRY_RUN === "true";
const DATE_KEY     = `${TARGET_YEAR}_${String(TARGET_MONTH).padStart(2, "0")}`;

// ── Google Drive auth ─────────────────────────────────────────────────────
function createDrive() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN");
  }
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth });
}

function esc(s: string): string { return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

async function findFolder(drive: drive_v3.Drive, name: string, parentId: string): Promise<string | null> {
  const res = await drive.files.list({
    q: `name='${esc(name)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)", pageSize: 5,
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function listFiles(drive: drive_v3.Drive, parentId: string): Promise<drive_v3.Schema$File[]> {
  const all: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const res: drive_v3.Schema$FileList = (await drive.files.list({
      q: `'${parentId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
      fields: "nextPageToken,files(id,name,mimeType,size)",
      pageSize: 100, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    })).data;
    all.push(...(res.files ?? []));
    pageToken = res.nextPageToken ?? undefined;
  } while (pageToken);
  return all;
}

async function downloadBuffer(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data as ArrayBuffer);
}

// parseExcel now lives in ../excel-parse.js (shared with match-sender-emails.mjs
// — was independently duplicated in both scripts, risking the two drifting
// apart as fixes landed in only one copy).

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const monthFolderName = MONTH_FOLDER_NAMES[TARGET_MONTH];
  if (!monthFolderName) throw new Error(`Invalid month number: ${TARGET_MONTH}`);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  P4P Backfill — ${monthFolderName} ${TARGET_YEAR}  ${DRY_RUN ? "[DRY RUN]" : ""}`);
  console.log(`  Supabase table: ${DATE_KEY}`);
  console.log(`${"═".repeat(60)}\n`);

  const drive = createDrive();

  // Navigate P4P root → year folder → month folder
  const rootId = process.env.P4P_FOLDER_ID;
  if (!rootId) throw new Error("Missing P4P_FOLDER_ID");

  const yearFolderId = await findFolder(drive, TARGET_YEAR, rootId);
  if (!yearFolderId) throw new Error(`Year folder "${TARGET_YEAR}" not found inside P4P root`);

  const monthFolderId = await findFolder(drive, monthFolderName, yearFolderId);
  if (!monthFolderId) throw new Error(`Month folder "${monthFolderName}" not found inside "${TARGET_YEAR}"`);

  const files = await listFiles(drive, monthFolderId);
  console.log(`📂  ${files.length} file(s) found in  ${monthFolderName}\n`);

  if (!files.length) {
    console.log("No files to process.");
    return;
  }

  // ── Process each file ──────────────────────────────────────────────────
  // NOTE: scores for rows NOT reprocessed this run are cleared AFTER the loop
  // below, not before it. Clearing every score upfront (the previous
  // behaviour) left a real data-loss window: if this run crashed, rate-
  // limited, or hit a Drive outage partway through the file list, every
  // physician whose file hadn't been reached yet was left with score=null
  // and no automatic recovery. Deferring the clear to the end means a
  // partial run only ever loses freshness for files it didn't get to —
  // it never destroys data for files it simply hasn't processed yet.
  interface ResultEntry {
    fileName: string;
    status: string;
    score: number | null;
    matchedName: string;
    similarity: number | null;
    error: string;
  }

  const results: ResultEntry[] = [];
  const matchedIndices = new Set<number | string>();

  for (const file of files) {
    const entry: ResultEntry = {
      fileName   : file.name ?? "(unnamed)",
      status     : "",
      score      : null,
      matchedName: "",
      similarity : null,
      error      : "",
    };

    console.log(`┌─ ${file.name}`);

    if (!file.id) {
      entry.status = "❌ error";
      entry.error  = "Drive file has no id";
      console.error(`└─ ❌ ${entry.error}\n`);
      results.push(entry);
      continue;
    }

    try {
      // 1. Download
      const buffer = await downloadBuffer(drive, file.id);

      // 2. Parse Excel
      const { rows, sheetName, sheetCount } = await parseExcel(buffer, TARGET_MONTH, MONTH_TOKENS_BY_NUM);
      if (sheetCount > 1) console.log(`│  📋 ${sheetCount} sheets — using "${sheetName}"`);
      console.log(`│  📄 Rows: ${rows.length}`);

      // 3. Extract score — use resolveScore (same as the live index.js hook) so
      //    files with uncached =SUM(...) formulas fall through the two-tier
      //    fallback instead of returning the largest plain number.
      const { score, method } = resolveScore(rows);
      entry.score = score;
      console.log(`│  🔢 Score: ${score != null ? score.toFixed(2) : "none"} (${method})`);

      if (!score || score <= 0) {
        entry.status = "⚠️ no score";
        entry.error  = method;
        console.log(`└─ ⚠️  Skipped — no score found\n`);
        results.push(entry);
        continue;
      }

      // 4. Match physician name in Supabase
      //    Drive filenames = physician name (saved by uploadFile as matchedName)
      const physicianName = (file.name ?? "").replace(/\.[^.]+$/, "").trim();
      console.log(`│  👤 Looking up: "${physicianName}"`);

      const match = await matchName(physicianName, DATE_KEY);

      if (!match) {
        entry.status = "❌ not found";
        entry.error  = `"${physicianName}" not matched in ${DATE_KEY}`;
        console.log(`└─ ❌ No match — ${entry.error}\n`);
        results.push(entry);
        continue;
      }

      entry.matchedName = match.matchedName;
      entry.similarity  = match.similarity;
      console.log(`│  ✅ Matched: "${match.matchedName}" (${(match.similarity * 100).toFixed(0)}%, row ${match.index})`);

      // 5. Save to Supabase
      if (DRY_RUN) {
        entry.status = "🔍 dry run";
        console.log(`└─ 🔍 Dry run — score NOT saved\n`);
      } else {
        await saveScore(DATE_KEY, match.index, score);
        matchedIndices.add(match.index);
        entry.status = "✅ saved";
        console.log(`└─ 💾 Saved ${score.toFixed(2)} → "${DATE_KEY}" row ${match.index}\n`);
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.status = "❌ error";
      entry.error  = message;
      console.error(`└─ ❌ ${message}\n`);
    }

    results.push(entry);
  }

  // ── Clear stale scores for rows NOT reprocessed this run ────────────────
  // Deliberately done here (after every file has been attempted), not before
  // the loop — see the comment above the loop for why.
  if (DRY_RUN) {
    console.log("🔍 Dry run — skipping stale-score clear\n");
  } else if (matchedIndices.size === 0) {
    console.log("⚠️  No files were successfully matched/saved this run — skipping stale-score clear so the whole table isn't wiped.\n");
  } else {
    const { SUPABASE_URL, SUPABASE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { error: clearError } = await sb
      .from(DATE_KEY)
      .update({ score: null })
      .not("index", "in", `(${[...matchedIndices].join(",")})`);
    if (clearError) throw new Error(`Failed to clear stale scores in "${DATE_KEY}": ${clearError.message}`);
    console.log(`🧹 Cleared scores for rows not reprocessed this run in table "${DATE_KEY}"\n`);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const saved    = results.filter(r => r.status.startsWith("✅")).length;
  const dryRuns  = results.filter(r => r.status.startsWith("🔍")).length;
  const noScore  = results.filter(r => r.status.startsWith("⚠️")).length;
  const failed   = results.filter(r => r.status.startsWith("❌")).length;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Results: ${results.length} files | ✅ ${saved} saved | ⚠️ ${noScore} no score | ❌ ${failed} failed${DRY_RUN ? ` | 🔍 ${dryRuns} dry-run` : ""}`);
  console.log(`${"═".repeat(60)}\n`);

  // ── GitHub Step Summary (markdown) ──────────────────────────────────────
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  let md = `# 📊 P4P Score Backfill — ${monthFolderName} ${TARGET_YEAR}${DRY_RUN ? " *(Dry Run)*" : ""}\n\n`;
  md += `**Supabase table:** \`${DATE_KEY}\`\n\n`;
  md += `| Stat | Count |\n|---|---|\n`;
  md += `| Total files | ${results.length} |\n`;
  md += `| ✅ Saved | ${saved + dryRuns} |\n`;
  md += `| ⚠️ No score found | ${noScore} |\n`;
  md += `| ❌ Failed / Not matched | ${failed} |\n\n`;

  md += `## File Details\n\n`;
  md += `| # | Drive Filename | Score | Matched Name | Sim% | Status |\n`;
  md += `|---|---|---|---|---|---|\n`;

  results.forEach((r, i) => {
    const score = r.score != null ? r.score.toFixed(2) : "—";
    const sim   = r.similarity != null ? `${(r.similarity * 100).toFixed(0)}%` : "—";
    const note  = r.error ? `<br><sub>${r.error.replace(/\|/g, "╎")}</sub>` : "";
    md += `| ${i + 1} | ${r.fileName} | ${score} | ${r.matchedName || "—"} | ${sim} | ${r.status}${note} |\n`;
  });

  md += `\n---\n_Run at ${new Date().toISOString()}_\n`;

  if (summaryPath) {
    appendFileSync(summaryPath, md, "utf8");
    console.log("📊 Step summary written to $GITHUB_STEP_SUMMARY");
  } else {
    // Local run: just print the markdown
    console.log(md);
  }
}

main().catch((err: unknown) => {
  console.error("\n❌ Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
