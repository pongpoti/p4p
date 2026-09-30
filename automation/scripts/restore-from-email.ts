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
 * A correction made on a copy that opened blank (the physician downloaded a
 * damaged Drive copy, fixed numbers they could see, and sent it back without
 * any text or formatting) names the earlier, formatted email after a "+":
 *
 *   TARGETS="2569_07#7f7be144=<correction message id>+<earlier message id>"
 *
 * The new copy is then the earlier file's tab with every number and formula
 * of the correction (xlsx-refill.ts). The correction must hold no text at
 * all, the earlier file must share at least half its cells with it, and the
 * result must carry every one of the correction's values and every format
 * of the earlier file.
 *
 * For each target:
 *   1. the email must be where the copy came from: the copy still holds at
 *      least half of the values of one of its tabs, at the same cells;
 *   2. the tab restored is that one when its name or title rows say the
 *      copy's month; otherwise the tab the pipeline reads for the month in
 *      the same attachment (the copy holds another month's tab); when that
 *      workbook has no tab for the month, the one the copy came from;
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
import { keepOneSheet, packageProblem } from "../xlsx-package.js";
import { cellDrift, readTabs, reproduced } from "../xlsx-cells.js";
import { hasNoText, refillValues } from "../xlsx-refill.js";
import { pickRestoreTab } from "../restore-pick.js";
import { IN_CI, XLSX_MIME, createDrive, download, googleAuth, listChildren, md5, monthFolders, withRetry } from "./drive-walk.js";
import { partBytes, xlsxParts } from "./mail-originals.js";

dotenvConfig({ override: true });

const APPLY = process.env.APPLY === "true";
const MIN_AGREEMENT = 0.5;

interface Target { month: string; hash: string; messageId: string; styleId: string | null }

function parseTargets(raw: string): Target[] {
  return raw.split(/[,\s]+/).filter(Boolean).map((t) => {
    const m = t.match(/^(\d{4}_\d{2})#([0-9a-f]{8})=([0-9a-zA-Z]+)(?:\+([0-9a-zA-Z]+))?$/);
    if (!m) throw new Error(`Bad target "${t}" — expected 2569_01#1a2b3c4d=<gmail message id>[+<earlier message id>]`);
    return { month: m[1]!, hash: m[2]!, messageId: m[3]!, styleId: m[4] ?? null };
  });
}

async function emailWorkbooks(gmail: ReturnType<typeof google.gmail>, messageId: string): Promise<Buffer[]> {
  const msg = (await withRetry(() => gmail.users.messages.get({ userId: "me", id: messageId, format: "full", fields: "id,payload" }))).data;
  const out: Buffer[] = [];
  for (const part of xlsxParts(msg.payload)) {
    const bytes = await partBytes(gmail, messageId, part);
    if (bytes) out.push(bytes);
  }
  return out;
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
  const pick = await pickRestoreTab(copyTab, await emailWorkbooks(gmail, t.messageId), Number(mm), Number(year));
  if (!pick) return "skipped: the message has no readable .xlsx attachment";
  const { closest, best } = pick;
  if (closest.agreement < MIN_AGREEMENT) return `skipped: the copy did not come from this email (it holds ${pct(closest.agreement)} of its closest tab)`;
  const how   = best === closest ? (closest.says ? "the tab the copy came from, this month's" : "the tab the copy came from") : "this month's tab — the copy held another";
  const which = `tab ${best.keepPos + 1} of ${best.tabs} (${how}; the copy holds ${pct(closest.agreement)} of the email tab it came from)`;

  // ── The new copy, checked against the original ────────────────────────
  const emailed = await keepOneSheet(best.original, best.keepPos);
  if (!emailed) return `skipped: could not keep ${which}`;
  const check = await compareWithOriginal(emailed, best.original);
  if (check.status === "differs") return `skipped: rebuilt copy does not match the email (${check.problems.join("; ")})`;

  let restored = emailed;
  let detail: string;
  if (t.styleId) {
    // A correction made on a copy that opened blank: its numbers into the
    // formatted workbook sent earlier (xlsx-refill.ts).
    if (!(await hasNoText(emailed))) return "skipped: this email's file has its own text, so it is not a blank re-save — restore it without \"+\"";
    const valuesTab = (await readTabs(emailed))[0]!;
    const earlier   = await pickRestoreTab(valuesTab, await emailWorkbooks(gmail, t.styleId), Number(mm), Number(year));
    if (!earlier) return "skipped: the earlier message has no readable .xlsx attachment";
    if (earlier.closest.agreement < MIN_AGREEMENT) return `skipped: the earlier file is not the one corrected (the correction holds ${pct(earlier.closest.agreement)} of its closest tab)`;
    if (!earlier.best.says) return "skipped: no tab of the earlier file says this month";
    const styled = await keepOneSheet(earlier.best.original, earlier.best.keepPos);
    const refill = styled && (await refillValues(styled, emailed));
    if (!styled || !refill) return "skipped: could not combine the two files";
    const styledTab = (await readTabs(styled))[0]!;
    const outTab    = (await readTabs(refill.buffer))[0]!;
    if (reproduced(outTab, valuesTab) < 1) return "skipped: the combined file lost some of the correction's values";
    const formats = cellDrift(styledTab, outTab).styles;
    if (formats > refill.added) return `skipped: the combined file changed ${formats} cell format(s) of the earlier file`;
    restored = refill.buffer;
    const corrected = cellDrift(styledTab, outTab).values;
    detail = `formatting and text from tab ${earlier.best.keepPos + 1} of ${earlier.best.tabs} of the earlier email, every number and formula from this one ` +
             `(${corrected} cell value(s) differ from the earlier file; ${refill.added} cell(s) had no format there)`;
  } else {
    detail = which;
  }
  const problem = await packageProblem(restored);
  if (problem) return `skipped: rebuilt copy does not open cleanly (${problem})`;
  if (restored.equals(current)) return t.styleId ? "already refilled" : "already the emailed file";

  const before = await compareWithOriginal(current, best.original);
  const drift  = cellDrift(copyTab, (await readTabs(restored))[0]!);
  detail = `${detail}; now ${before.status}${t.styleId ? "" : `, will be ${check.status}`}; ${drift.values} cell value(s) and ${drift.styles} cell format(s) change`;
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
