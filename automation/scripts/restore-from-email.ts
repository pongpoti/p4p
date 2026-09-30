/**
 * scripts/restore-from-email.ts
 *
 * Puts the physician's own emailed file back in place of an archived Drive
 * copy that was changed after archiving — re-saved through Google Sheets,
 * or rebuilt by an early version of the pipeline — so the copy is again
 * exactly what was sent.
 *
 * Only the files named in TARGETS are touched, each paired with the Gmail
 * message it came from:
 *
 *   TARGETS="2569_01#4c825d2c=19c319d64b363df2,2569_04#dd00e6c6=19ebfee71deec9a7"
 *
 * "2569_01#4c825d2c" is the label the verification report gives a file
 * (month + a hash of its Drive file ID); after "=" is the Gmail message ID.
 *
 * For each target:
 *   1. the email must be where the copy came from: the copy still holds at
 *      least half of the values of one of its tabs, at the same cells;
 *   2. the tab restored is that one when its name or title rows say the
 *      copy's month; otherwise the tab the pipeline reads for the month
 *      (the copy holds another month's tab); when no tab says the month,
 *      the one the copy came from;
 *   3. the new copy is that tab kept the way the archive keeps it today
 *      (xlsx-package keepOneSheet) — the original file itself when it has
 *      one tab — and must compare as identical or same content with the
 *      original before it may be written;
 *   4. the Drive file is replaced IN PLACE: same file ID, name, folder and
 *      sharing, its modifiedTime written back, and skipped if it changed
 *      while the script ran. The replaced version stays in Drive's version
 *      history for 30 days.
 *
 * DRY RUN BY DEFAULT: reports what would change, writes nothing.
 * Set APPLY=true to write.
 *
 * Environment:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, P4P_FOLDER_ID
 *   TARGETS  as above
 *   APPLY    "true" to write
 */

import { google, type drive_v3 } from "googleapis";
import { createHash } from "crypto";
import { appendFileSync } from "fs";
import { Readable } from "stream";
import { config as dotenvConfig } from "dotenv";
import { compareWithOriginal } from "../xlsx-compare.js";
import { keepOneSheet, packageProblem, workbookSheetNames } from "../xlsx-package.js";
import { cellDrift, readTabs, reproduced } from "../xlsx-cells.js";
import { IN_CI, XLSX_MIME, createDrive, download, googleAuth, listChildren, md5, monthFolders, withRetry } from "./drive-walk.js";
import { partBytes, xlsxParts } from "./mail-originals.js";
import { monthSheet } from "../index.js";

dotenvConfig({ override: true });

const APPLY = process.env.APPLY === "true";
const MIN_AGREEMENT = 0.5;

interface Target { month: string; hash: string; messageId: string }

function parseTargets(raw: string): Target[] {
  return raw.split(/[,\s]+/).filter(Boolean).map((t) => {
    const m = t.match(/^(\d{4}_\d{2})#([0-9a-f]{8})=([0-9a-zA-Z]+)$/);
    if (!m) throw new Error(`Bad target "${t}" — expected 2569_01#1a2b3c4d=<gmail message id>`);
    return { month: m[1]!, hash: m[2]!, messageId: m[3]! };
  });
}

const idHash = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 8);
const pct    = (x: number): string => `${Math.round(x * 100)}%`;

async function restore(drive: drive_v3.Drive, gmail: ReturnType<typeof google.gmail>, rootId: string, t: Target): Promise<string> {
  // ── The Drive copy ─────────────────────────────────────────────────────
  const [year, mm] = t.month.split("_");
  const folders = await monthFolders(drive, rootId, year!, Number(mm));
  if (folders.length !== 1) return `skipped: month folder not found`;
  const matches = (await listChildren(drive, folders[0]!.folderId, false))
    .filter((f) => f.mimeType === XLSX_MIME && idHash(f.id!) === t.hash);
  if (matches.length !== 1) return `skipped: ${matches.length} files match #${t.hash}`;
  const file    = matches[0]!;
  const current = await download(drive, file.id!);
  const copyTab = (await readTabs(current))[0];
  if (!copyTab) return "skipped: the Drive copy has no worksheet";

  // ── The emailed workbook, and the tab for the copy's month ────────────
  const msg = (await withRetry(() => gmail.users.messages.get({ userId: "me", id: t.messageId, format: "full", fields: "id,payload" }))).data;
  type Pick = { original: Buffer; keepPos: number; tabs: number; agreement: number; byMonth: boolean; says: boolean };
  let closest: Pick | null = null;    // the tab most like the copy
  let forMonth: Pick | null = null;   // the tab the pipeline reads for this month
  for (const part of xlsxParts(msg.payload)) {
    const original = await partBytes(gmail, t.messageId, part);
    if (!original) continue;
    const names = await workbookSheetNames(original).catch(() => null);
    if (!names) continue;
    const month = await monthSheet(original, Number(mm), Number(year)).catch(() => null);
    for (const [i, tab] of (await readTabs(original)).entries()) {
      const pos  = names.indexOf(tab.name) >= 0 ? names.indexOf(tab.name) : i;
      const pick = { original, keepPos: pos, tabs: names.length, agreement: reproduced(copyTab, tab), byMonth: false, says: month?.says.includes(tab.name) ?? false };
      if (!closest || pick.agreement > closest.agreement) closest = pick;
      if (month?.matched && tab.name === month.name && (!forMonth || pick.agreement > forMonth.agreement)) forMonth = { ...pick, byMonth: true };
    }
  }
  if (!closest) return "skipped: the message has no readable .xlsx attachment";
  if (closest.agreement < MIN_AGREEMENT) return `skipped: the copy did not come from this email (it holds ${pct(closest.agreement)} of its closest tab)`;
  // The copy's own tab when it is this month's; the month's tab when the
  // copy holds another month; the copy's own tab when no tab says the month.
  const best  = closest.says ? closest : (forMonth ?? closest);
  const how   = best === closest ? (closest.says ? "the tab the copy came from, this month's" : "the tab the copy came from") : "this month's tab — the copy held another";
  const which = `tab ${best.keepPos + 1} of ${best.tabs} (${how}; the copy holds ${pct(closest.agreement)} of the email tab it came from)`;

  // ── The new copy, checked against the original ────────────────────────
  const restored = await keepOneSheet(best.original, best.keepPos);
  if (!restored) return `skipped: could not keep ${which}`;
  const check = await compareWithOriginal(restored, best.original);
  if (check.status === "differs") return `skipped: rebuilt copy does not match the email (${check.problems.join("; ")})`;
  const problem = await packageProblem(restored);
  if (problem) return `skipped: rebuilt copy does not open cleanly (${problem})`;
  if (restored.equals(current)) return "already the emailed file";

  const before = await compareWithOriginal(current, best.original);
  const drift  = cellDrift(copyTab, (await readTabs(restored))[0]!);
  const detail = `${which}; now ${before.status}, will be ${check.status}; ${drift.values} cell value(s) and ${drift.styles} cell format(s) change`;
  if (!APPLY) return `would restore — ${detail}`;

  // ── Write it ──────────────────────────────────────────────────────────
  const now = (await withRetry(() => drive.files.get({ fileId: file.id!, fields: "md5Checksum", supportsAllDrives: true }))).data;
  if (now.md5Checksum !== file.md5Checksum) return "skipped: the file changed during the run — re-run to check it";
  const res = await withRetry(() => drive.files.update({
    fileId: file.id!,
    requestBody: { modifiedTime: file.modifiedTime },
    media: { mimeType: XLSX_MIME, body: Readable.from(restored) },
    fields: "id,md5Checksum",
    supportsAllDrives: true,
  }));
  if (res.data.md5Checksum !== md5(restored)) return `error: uploaded checksum does not match — ${detail}`;
  return `restored — ${detail}`;
}

async function main(): Promise<void> {
  const rootId = process.env.P4P_FOLDER_ID;
  if (!rootId) throw new Error("Missing P4P_FOLDER_ID");
  const targets = parseTargets(process.env.TARGETS ?? "");
  if (!targets.length) throw new Error("TARGETS is empty");

  console.log(`\nP4P restore from email — ${APPLY ? "APPLY (writing)" : "DRY RUN (nothing is written)"}\n`);
  const drive = createDrive();
  const gmail = google.gmail({ version: "v1", auth: googleAuth() });

  const rows: string[] = [];
  for (const t of targets) {
    let outcome: string;
    try {
      outcome = await restore(drive, gmail, rootId, t);
    } catch (err) {
      outcome = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    // API errors can quote a file ID; public logs never show one.
    if (IN_CI) outcome = outcome.replace(/\b1[\w-]{24,}\b/g, "<file>");
    console.log(`${t.month} #${t.hash}: ${outcome}`);
    rows.push(`| ${t.month} #${t.hash} | ${outcome.replace(/\|/g, "\\|")} |`);
  }

  const report = [`## P4P restore from email — ${APPLY ? "applied" : "dry run"}`, "", "| File | Outcome |", "|---|---|", ...rows, ""].join("\n");
  console.log(`\n${report}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  if (rows.some((r) => r.includes("| error:"))) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\n❌  Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
