/**
 * scripts/repair-drive-rels.ts
 *
 * Repairs the P4P Drive copies that open in Excel with every text cell blank
 * and no formatting.
 *
 * THE PROBLEM
 * -----------
 * extractFirstSheetBuffer() (index.ts) used to archive each submission with an
 * xl/_rels/workbook.xml.rels that linked only the worksheet — not styles,
 * sharedStrings or the theme, which Excel can only find through that file.
 * The data, formulas and totals are all still in every copy; only the links
 * are missing. See xlsx-package.ts for the repair itself.
 *
 * WHAT THIS DOES
 * --------------
 * Walks  P4P root / <year> / <month> / <physician file>, downloads each .xlsx
 * and puts it into one of these buckets:
 *
 *   ok          links intact — left alone (includes every file saved before
 *               the pipeline started, and every copy archived since the fix)
 *   repair      missing links — restored, sheet contents untouched
 *   manual      damaged in a way this will not guess at — left alone, listed
 *   unreadable  not an xlsx package — left alone, listed
 *
 * A repaired file replaces the Drive file IN PLACE: same file ID, name,
 * folder and sharing, and its original modifiedTime is written back (month-end
 * dedupe keeps the newest of two same-named files, so a repair must not
 * reorder them). The damaged version stays in Drive's version history for 30
 * days as the rollback.
 *
 * DRY RUN BY DEFAULT: downloads and checks everything, writes nothing.
 * Set APPLY=true to write.
 *
 *   npx tsx scripts/repair-drive-rels.ts
 *   APPLY=true npx tsx scripts/repair-drive-rels.ts
 *   TARGET_YEAR=2569 TARGET_MONTH=8 npx tsx scripts/repair-drive-rels.ts
 *
 * Environment:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, P4P_FOLDER_ID
 *   TARGET_YEAR   optional BE year, e.g. "2569" — default every year folder
 *   TARGET_MONTH  optional 1–12 — default every month folder
 *   APPLY         "true" to write the repairs
 *
 * On GitHub Actions the logs of this public repository are public, so files
 * are identified by month + a short hash of the file ID, never by the
 * physician name that is the Drive filename. Run locally to see names.
 */

import type { drive_v3 } from "googleapis";
import { appendFileSync } from "fs";
import { Readable } from "stream";
import { config as dotenvConfig } from "dotenv";
import { repairWorkbookPackage, type RepairResult } from "../xlsx-package.js";
import { IN_CI, XLSX_MIME, createDrive, download, labelOf, listChildren, md5, monthFolders, pool, withRetry } from "./drive-walk.js";

dotenvConfig({ override: true });

const APPLY        = process.env.APPLY === "true";
const TARGET_YEAR  = process.env.TARGET_YEAR?.trim() || null;
const TARGET_MONTH = process.env.TARGET_MONTH?.trim() ? parseInt(process.env.TARGET_MONTH, 10) : null;
const CONCURRENCY  = 4;

type Outcome = RepairResult["status"] | "changed" | "error";

interface FileRow {
  month  : string;
  label  : string;
  outcome: Outcome;
  detail : string;
}

// ── One file ──────────────────────────────────────────────────────────────
async function processFile(drive: drive_v3.Drive, month: string, file: drive_v3.Schema$File): Promise<FileRow> {
  // API errors can quote the file ID; keep it out of public logs too.
  const row = (outcome: Outcome, detail = ""): FileRow => ({
    month, outcome,
    label : labelOf(month, file),
    detail: IN_CI ? detail.split(file.id!).join("<file>") : detail,
  });
  try {
    const result = await repairWorkbookPackage(await download(drive, file.id!));
    if (result.status === "ok") return row("ok");
    if (result.status === "manual" || result.status === "unreadable") return row(result.status, result.reason);
    const changes = result.changes.join("; ");
    if (!APPLY) return row("repaired", changes);

    // A physician re-sending between the download and now would have
    // replaced this file; writing the repair of the old bytes would undo it.
    const now = (await withRetry(() => drive.files.get({ fileId: file.id!, fields: "md5Checksum", supportsAllDrives: true }))).data;
    if (now.md5Checksum !== file.md5Checksum) return row("changed", "file changed during the run — re-run to check it");

    const res = await withRetry(() => drive.files.update({
      fileId: file.id!,
      requestBody: { modifiedTime: file.modifiedTime },
      media: { mimeType: XLSX_MIME, body: Readable.from(result.buffer) },
      fields: "id,md5Checksum",
      supportsAllDrives: true,
    }));
    if (res.data.md5Checksum !== md5(result.buffer)) return row("error", "uploaded checksum does not match the repaired file");
    return row("repaired", changes);
  } catch (err) {
    return row("error", err instanceof Error ? err.message : String(err));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const rootId = process.env.P4P_FOLDER_ID;
  if (!rootId) throw new Error("Missing P4P_FOLDER_ID");

  console.log(`\nP4P Drive repair — ${APPLY ? "APPLY (writing repairs)" : "DRY RUN (nothing is written)"}`);
  console.log(`Scope: year ${TARGET_YEAR ?? "all"}, month ${TARGET_MONTH ?? "all"}\n`);

  const drive = createDrive();
  const rows: FileRow[] = [];
  let skipped = 0;

  for (const { monthKey, folderId } of await monthFolders(drive, rootId, TARGET_YEAR, TARGET_MONTH)) {
    const files = await listChildren(drive, folderId, false);
    const xlsx  = files.filter((f) => f.mimeType === XLSX_MIME);
    skipped += files.length - xlsx.length;

    const done = await pool(xlsx, CONCURRENCY, (f) => processFile(drive, monthKey, f));
    rows.push(...done);
    const n = (o: Outcome) => done.filter((r) => r.outcome === o).length;
    console.log(`${monthKey}: ${xlsx.length} xlsx — ok ${n("ok")}, ${APPLY ? "repaired" : "to repair"} ${n("repaired")}, manual ${n("manual")}, unreadable ${n("unreadable")}, changed ${n("changed")}, errors ${n("error")}`);
  }

  // ── Report ──────────────────────────────────────────────────────────────
  const outcomes: Outcome[] = ["ok", "repaired", "manual", "unreadable", "changed", "error"];
  const heading: Record<Outcome, string> = {
    ok: "OK", repaired: APPLY ? "Repaired" : "To repair", manual: "Manual", unreadable: "Unreadable", changed: "Changed mid-run", error: "Errors",
  };
  const monthsSeen = [...new Set(rows.map((r) => r.month))];
  const count = (o: Outcome, m?: string) => rows.filter((r) => r.outcome === o && (!m || r.month === m)).length;

  const md: string[] = [
    `## P4P Drive repair — ${APPLY ? "applied" : "dry run"}`,
    "",
    `| Month | ${outcomes.map((o) => heading[o]).join(" | ")} |`,
    `|---|${outcomes.map(() => "---:").join("|")}|`,
    ...monthsSeen.map((m) => `| ${m} | ${outcomes.map((o) => count(o, m)).join(" | ")} |`),
    `| **Total** | ${outcomes.map((o) => `**${count(o)}**`).join(" | ")} |`,
    "",
  ];
  if (skipped) md.push(`${skipped} non-xlsx file(s) ignored.`, "");
  const attention = rows.filter((r) => r.outcome !== "ok" && r.outcome !== "repaired");
  if (attention.length) {
    md.push("### Needs attention", "", "| File | Outcome | Detail |", "|---|---|---|");
    for (const r of attention) md.push(`| ${r.label} | ${r.outcome} | ${r.detail.replace(/\|/g, "\\|")} |`);
    md.push("");
  }
  if (!APPLY && count("repaired")) md.push(`Dry run — re-run with APPLY=true to repair ${count("repaired")} file(s).`);

  const report = md.join("\n");
  console.log(`\n${report}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

  if (count("error")) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\n❌  Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
