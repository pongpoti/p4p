/**
 * scripts/verify-drive-vs-email.ts
 *
 * READ-ONLY. Checks that every archived copy in the P4P Drive tree shows
 * exactly what the physician emailed — same sheet, styles, colours, text,
 * theme — by comparing it with the original attachment still in the Gmail
 * inbox. Nothing in Drive or Gmail is changed.
 *
 * HOW A COPY IS PAIRED WITH ITS EMAIL
 * -----------------------------------
 * Every archive path (the old extraction, today's, the repair) carries the
 * kept tab's sheet part over byte for byte. So every .xlsx attachment in the
 * mailbox is indexed by a hash of each of its sheet parts, and a Drive copy
 * is paired with the attachment(s) holding its sheet. The pair is then
 * compared part by part (xlsx-compare.ts):
 *
 *   identical     the Drive file is the attachment, byte for byte
 *   same-content  everything Excel shows is the attachment's; only the
 *                 left-out tabs, calcChain and internal link ids differ
 *   wrong-tab     same content, but of another tab of the workbook than the
 *                 month the copy is filed under (the archive used to keep
 *                 the first tab, not the one the score was read from)
 *   differs       something shown is not what was sent — listed
 *   line-upload   no email: sent through the LINE upload page, whose
 *                 original is not kept (checked only for opening cleanly)
 *   no-original   no attachment in the mailbox holds this sheet
 *
 *   npx tsx scripts/verify-drive-vs-email.ts
 *   TARGET_YEAR=2569 TARGET_MONTH=7 npx tsx scripts/verify-drive-vs-email.ts
 *
 * Environment:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, P4P_FOLDER_ID
 *   TARGET_YEAR   BE year folder, e.g. "2569" — default every year
 *   TARGET_MONTH  optional 1–12
 *   GMAIL_AFTER   optional YYYY/MM/DD — oldest mail to index (default:
 *                 1 December of the year before TARGET_YEAR)
 *   SUPABASE_URL, SUPABASE_KEY  optional — tell LINE uploads apart
 *
 * The report ends with the wrong-tab and differs copies as targets for the
 * "Restore Drive copies from the emailed originals" workflow.
 *
 * Public CI logs: files appear as month + a hash of the file ID, and nothing
 * from a message (sender, subject, filename) is printed. Run locally to see
 * names.
 */

import { google, type drive_v3, type gmail_v1 } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import JSZip from "jszip";
import { config as dotenvConfig } from "dotenv";
import { compareWithOriginal, type Comparison } from "../xlsx-compare.js";
import { packageProblem, workbookSheetNames } from "../xlsx-package.js";
import { monthSheet } from "../index.js";
import { IN_CI, XLSX_MIME, createDrive, download, googleAuth, labelOf, listChildren, md5, monthFolders, pool, withRetry } from "./drive-walk.js";
import { partBytes, xlsxParts } from "./mail-originals.js";

dotenvConfig({ override: true });

const TARGET_YEAR  = process.env.TARGET_YEAR?.trim() || null;
const TARGET_MONTH = process.env.TARGET_MONTH?.trim() ? parseInt(process.env.TARGET_MONTH, 10) : null;
const GMAIL_AFTER  = process.env.GMAIL_AFTER?.trim()
  || (TARGET_YEAR ? `${Number(TARGET_YEAR) - 543 - 1}/12/01` : "2020/01/01");
const GMAIL_CONCURRENCY = 6;
const DRIVE_CONCURRENCY = 4;
const MAX_CANDIDATES    = 5;

type Outcome = "identical" | "same-content" | "wrong-tab" | "differs" | "line-upload" | "no-original" | "unreadable" | "error";

interface FileRow {
  month  : string;
  label  : string;
  outcome: Outcome;
  detail : string;
  notes  : string[];
  restore: string | null;   // "2569_01#1a2b3c4d=<message id>" for the restore workflow
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const SHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/;

async function sheetHashes(buf: Buffer): Promise<string[] | null> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const out: string[] = [];
    for (const [p, f] of Object.entries(zip.files)) if (!f.dir && SHEET_PART.test(p)) out.push(sha256(await f.async("nodebuffer")));
    return out;
  } catch {
    return null;
  }
}

// ── Gmail: index every .xlsx attachment by its sheet parts ────────────────
interface Original { file: string; date: number; messageId: string }

interface OriginalIndex {
  byMd5  : Map<string, Original>;       // whole attachment
  bySheet: Map<string, Set<string>>;    // sheet-part hash → attachment md5s
  stats  : { messages: number; attachments: number; distinct: number; notXlsx: number };
}

async function indexOriginals(gmail: gmail_v1.Gmail, dir: string): Promise<OriginalIndex> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res: gmail_v1.Schema$ListMessagesResponse = (await withRetry(() => gmail.users.messages.list({
      userId: "me", q: `has:attachment after:${GMAIL_AFTER}`, includeSpamTrash: true, maxResults: 500, pageToken,
    }))).data;
    ids.push(...(res.messages ?? []).map((m) => m.id!));
    pageToken = res.nextPageToken ?? undefined;
  } while (pageToken);

  const index: OriginalIndex = { byMd5: new Map(), bySheet: new Map(), stats: { messages: ids.length, attachments: 0, distinct: 0, notXlsx: 0 } };
  await pool(ids, GMAIL_CONCURRENCY, async (id) => {
    const msg = (await withRetry(() => gmail.users.messages.get({ userId: "me", id, format: "full", fields: "id,internalDate,payload" }))).data;
    const date = Number(msg.internalDate ?? 0);
    for (const [n, part] of xlsxParts(msg.payload).entries()) {
      const buf = await partBytes(gmail, id, part);
      if (!buf) continue;
      index.stats.attachments++;

      const sum  = md5(buf);
      const seen = index.byMd5.get(sum);
      if (seen) {
        if (date > seen.date) Object.assign(seen, { date, messageId: id });
        continue;
      }
      const hashes = await sheetHashes(buf);
      if (!hashes) { index.stats.notXlsx++; continue; }

      const file = path.join(dir, `${id}-${n}.xlsx`);
      writeFileSync(file, buf);
      index.byMd5.set(sum, { file, date, messageId: id });
      index.stats.distinct++;
      for (const h of hashes) {
        if (!index.bySheet.has(h)) index.bySheet.set(h, new Set());
        index.bySheet.get(h)!.add(sum);
      }
    }
  });
  return index;
}

// ── Supabase: which copies came in through the LINE upload page ───────────
const normName = (s: string): string => s.normalize("NFC").replace(/\.xlsx$/i, "").replace(/\s+/g, " ").trim();

async function lineUploads(): Promise<Set<string> | null> {
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const { data, error } = await createClient(SUPABASE_URL, SUPABASE_KEY)
    .from("p4p_upload_queue")
    .select("full_name, month_key")
    .eq("archive_status", "archived");
  if (error) throw new Error(`p4p_upload_queue: ${error.message}`);
  return new Set((data ?? []).map((r) => `${r.month_key}|${normName(r.full_name ?? "")}`));
}

// ── One Drive file ────────────────────────────────────────────────────────
function summarise(c: Comparison): { detail: string; notes: string[] } {
  if (c.status === "identical") return { detail: "", notes: [] };
  const notes = c.notes.filter((n) => !/part\(s\) byte-identical$/.test(n));
  return { detail: c.status === "differs" ? c.problems.join("; ") : notes.join("; "), notes };
}

/**
 * For a copy of one tab of a multi-tab workbook: whether that tab is the
 * month the copy is filed under, by the pipeline's own choice of tab.
 * Null when it is, or when no tab of the original identifies the month.
 */
async function wrongTab(copy: Buffer, original: Buffer, monthKey: string): Promise<string | null> {
  const names = await workbookSheetNames(original).catch(() => null);
  if (!names || names.length < 2) return null;
  const [beYear, month] = monthKey.split("_").map(Number);
  const pick = await monthSheet(original, month!, beYear!).catch(() => null);
  if (!pick?.matched) return null;
  const kept = (await workbookSheetNames(copy))?.[0];
  if (kept === undefined || kept === pick.name) return null;
  return `holds tab ${names.indexOf(kept) + 1} of ${names.length}; this month is tab ${names.indexOf(pick.name) + 1}`;
}

async function checkFile(
  drive: drive_v3.Drive, month: string, file: drive_v3.Schema$File, index: OriginalIndex, line: Set<string> | null,
): Promise<FileRow> {
  const target = (o: Original): string => `${month}#${createHash("sha256").update(file.id!).digest("hex").slice(0, 8)}=${o.messageId}`;
  const row = (outcome: Outcome, detail = "", notes: string[] = [], restore: string | null = null): FileRow => ({
    month, outcome, notes, restore,
    label : labelOf(month, file),
    detail: IN_CI ? detail.split(file.id!).join("<file>") : detail,
  });
  try {
    const buf = await download(drive, file.id!);
    if (index.byMd5.has(md5(buf))) return row("identical");

    const hashes = await sheetHashes(buf);
    if (!hashes) return row("unreadable", "not a zip archive");
    let candidates: string[] | null = null;
    for (const h of hashes) {
      const has = index.bySheet.get(h) ?? new Set<string>();
      candidates = candidates === null ? [...has] : candidates.filter((c) => has.has(c));
    }
    if (!candidates?.length) {
      const problem = await packageProblem(buf).catch((e) => `not readable (${e instanceof Error ? e.message : e})`);
      const opens   = problem ? `does not open cleanly: ${problem}` : "";
      if (line?.has(`${month}|${normName(file.name ?? "")}`)) return row("line-upload", opens);
      return row("no-original", opens || "opens cleanly");
    }

    // Newest first: the Drive copy is overwritten by each re-send.
    const ordered = candidates.map((c) => index.byMd5.get(c)!).sort((a, b) => b.date - a.date).slice(0, MAX_CANDIDATES);
    let best: { c: Comparison; o: Original } | null = null;
    for (const o of ordered) {
      const original = readFileSync(o.file);
      const c = await compareWithOriginal(buf, original);
      if (c.status !== "differs") {
        const { detail, notes } = summarise(c);
        const wrong = c.status === "same-content" ? await wrongTab(buf, original, month) : null;
        return wrong ? row("wrong-tab", wrong, notes, target(o)) : row(c.status, detail, notes);
      }
      if (!best || (best.c.status === "differs" && c.problems.length < best.c.problems.length)) best = { c, o };
    }
    const { detail, notes } = summarise(best!.c);
    return row("differs", detail, notes, target(best!.o));
  } catch (err) {
    return row("error", err instanceof Error ? err.message : String(err));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const rootId = process.env.P4P_FOLDER_ID;
  if (!rootId) throw new Error("Missing P4P_FOLDER_ID");

  console.log(`\nP4P Drive copies vs the emailed originals — READ-ONLY`);
  console.log(`Scope: year ${TARGET_YEAR ?? "all"}, month ${TARGET_MONTH ?? "all"}; mail since ${GMAIL_AFTER}\n`);

  const dir = mkdtempSync(path.join(tmpdir(), "p4p-originals-"));
  try {
    const gmail = google.gmail({ version: "v1", auth: googleAuth() });
    const index = await indexOriginals(gmail, dir);
    const s = index.stats;
    console.log(`Gmail: ${s.messages} message(s) with attachments, ${s.attachments} .xlsx attachment(s), ${s.distinct} distinct${s.notXlsx ? `, ${s.notXlsx} not readable as xlsx` : ""}`);

    const line = await lineUploads();
    console.log(line ? `LINE uploads on record: ${line.size}\n` : "LINE uploads: SUPABASE_URL/KEY not set — cannot tell them apart\n");

    const drive = createDrive();
    const rows: FileRow[] = [];
    let skipped = 0;
    for (const { monthKey, folderId } of await monthFolders(drive, rootId, TARGET_YEAR, TARGET_MONTH)) {
      const files = await listChildren(drive, folderId, false);
      const xlsx  = files.filter((f) => f.mimeType === XLSX_MIME);
      skipped += files.length - xlsx.length;
      const done = await pool(xlsx, DRIVE_CONCURRENCY, (f) => checkFile(drive, monthKey, f, index, line));
      rows.push(...done);
      const n = (o: Outcome) => done.filter((r) => r.outcome === o).length;
      console.log(`${monthKey}: ${xlsx.length} xlsx — identical ${n("identical")}, same content ${n("same-content")}, WRONG TAB ${n("wrong-tab")}, DIFFERS ${n("differs")}, LINE ${n("line-upload")}, no original ${n("no-original")}, unreadable ${n("unreadable")}, errors ${n("error")}`);
    }

    // ── Report ────────────────────────────────────────────────────────────
    const outcomes: Outcome[] = ["identical", "same-content", "wrong-tab", "differs", "line-upload", "no-original", "unreadable", "error"];
    const heading: Record<Outcome, string> = {
      "identical": "Identical file", "same-content": "Same content", "wrong-tab": "Wrong month's tab", "differs": "Differs", "line-upload": "LINE upload",
      "no-original": "No email found", "unreadable": "Unreadable", "error": "Errors",
    };
    const months = [...new Set(rows.map((r) => r.month))];
    const count  = (o: Outcome, m?: string) => rows.filter((r) => r.outcome === o && (!m || r.month === m)).length;

    const md: string[] = [
      `## P4P Drive copies vs the emailed originals — ${TARGET_YEAR ?? "all years"}${TARGET_MONTH ? ` / ${TARGET_MONTH}` : ""}`,
      "",
      `Mail indexed since ${GMAIL_AFTER}: ${s.attachments} .xlsx attachment(s) (${s.distinct} distinct).`,
      "",
      `| Month | ${outcomes.map((o) => heading[o]).join(" | ")} |`,
      `|---|${outcomes.map(() => "---:").join("|")}|`,
      ...months.map((m) => `| ${m} | ${outcomes.map((o) => count(o, m)).join(" | ")} |`),
      `| **Total** | ${outcomes.map((o) => `**${count(o)}**`).join(" | ")} |`,
      "",
    ];
    if (skipped) md.push(`${skipped} non-xlsx file(s) ignored.`, "");

    const tolerated = new Map<string, number>();
    for (const r of rows.filter((r) => r.outcome === "same-content")) {
      for (const n of new Set(r.notes.map((x) => x.replace(/^\d+ /, "")))) tolerated.set(n, (tolerated.get(n) ?? 0) + 1);
    }
    if (tolerated.size) {
      md.push("### What differs in the same-content copies (nothing Excel shows)", "", "| Difference | Files |", "|---|---:|");
      for (const [n, k] of [...tolerated].sort((a, b) => b[1] - a[1])) md.push(`| ${n} | ${k} |`);
      md.push("", "Every same-content copy also differs in internal link ids, which Excel never shows.", "");
    }

    const attention = rows.filter((r) => ["wrong-tab", "differs", "no-original", "unreadable", "error"].includes(r.outcome) || (r.outcome === "line-upload" && r.detail));
    if (attention.length) {
      md.push("### Needs attention", "", "| File | Outcome | Detail |", "|---|---|---|");
      for (const r of attention) md.push(`| ${r.label} | ${r.outcome} | ${r.detail.slice(0, 600).replace(/\|/g, "\\|")} |`);
      md.push("");
    }

    const restore = rows.map((r) => r.restore).filter(Boolean);
    if (restore.length) {
      md.push("### Restore from email", "", `Paste into the "Restore Drive copies from the emailed originals" workflow (${restore.length} file(s)):`, "", "```", restore.join(","), "```", "");
    }

    const report = md.join("\n");
    console.log(`\n${report}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
    if (count("error")) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n❌  Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
