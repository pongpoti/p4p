/**
 * inbound-triage.ts
 *
 * Decisions about an inbound message that arrived with NO .xlsx attached —
 * the two alert replies that used to be sent unconditionally there
 * (file_link, wrong_extension) and the cases where sending one helps nobody.
 *
 * Pure functions, no I/O: index.ts owns the Gmail calls and labelling, this
 * module only answers "should this message get an alert?".
 *
 * Both rules below can only REMOVE an alert reply. Neither one reaches
 * processBuffer, Supabase or Drive, so neither can file a score under the
 * wrong month or physician. The cost of getting either one wrong is a sender
 * who is not told, which is why each is narrow and why the superseded rule
 * is additionally gated on the real file actually having been processed.
 */

import { periodsInText } from "./claude-analyst.js";
import { CORRECTION_RE, THAI_MONTH_WORDS, latinMonthsIn, plainText, senderOwnText, thaiMonthsIn, toArabicDigits } from "./period-gate.js";

// ── Automated senders ─────────────────────────────────────────────────────

// "noreply", "no-reply", "no_reply", "do-not-reply", "donotreply" as a whole
// dot/dash/underscore-delimited part of the local part, plus the two
// system mailboxes. Deliberately NOT matched: a "+noreply" plus-tag (that is a
// person's own address) or a part that merely contains the letters.
const AUTOMATED_LOCAL_RE = /(?:^|[._-])(?:no[-_.]?reply|do[-_.]?not[-_.]?reply)(?:$|[._-])|^(?:mailer-daemon|postmaster)$/i;

/**
 * True for an address nobody reads — Google's "spreadsheet shared with you"
 * notice comes from one, and a reply to it is dropped (no bounce, no human).
 * An unreadable reply is pure noise, and sending it counts as a "rejection"
 * in every tally of this system.
 */
export function isAutomatedSender(fromEmail: string | null | undefined): boolean {
  const addr = String(fromEmail ?? "").trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return false;
  return AUTOMATED_LOCAL_RE.test(addr.slice(0, at));
}

// ── What to do with a message that has no xlsx ────────────────────────────

export type NoXlsxAction =
  | "alert_file_link"       // body links to a cloud file instead of attaching it
  | "alert_wrong_extension" // attached something that is not .xlsx
  | "skip_automated"        // would have alerted, but the sender is a no-reply address
  | "skip_nothing";         // nothing actionable (no link, no foreign attachment)

interface NoXlsxInput {
  fromEmail: string;
  hasCloudLink: boolean;
  hasOtherAtts: boolean;
}

/**
 * The order is the one index.ts always used: a cloud link outranks a foreign
 * attachment. Only the automated-sender check is new, and it only applies
 * when an alert would otherwise have been sent — an automated sender with
 * nothing actionable behaves exactly as before ("skip_nothing").
 */
export function decideNoXlsx({ fromEmail, hasCloudLink, hasOtherAtts }: NoXlsxInput): NoXlsxAction {
  if (!hasCloudLink && !hasOtherAtts) return "skip_nothing";
  if (isAutomatedSender(fromEmail)) return "skip_automated";
  return hasCloudLink ? "alert_file_link" : "alert_wrong_extension";
}

/**
 * Whether the message gets marked read + starred + labelled afterwards. An
 * unmarked message is re-fetched by the next hourly run, so every action that
 * "handled" the message (alerted OR deliberately stayed silent) must mark it.
 * Only "nothing actionable" stays unmarked, as it always did.
 */
export function isHandled(action: NoXlsxAction): boolean {
  return action !== "skip_nothing";
}

// ── A link-only message the sender already re-sent as a real file ─────────

/** What isSupersededBy needs to know about one message of the batch. */
export interface TriageMessage {
  id: string;
  /** Plain lower-cased address, as parsed from the From header. */
  fromEmail: string;
  subject: string;
  body: string;
  /** Date header as epoch ms; null when it did not parse. */
  dateMs: number | null;
  /** Every attachment filename on the message. */
  attachmentNames: string[];
  /** Filenames of the attachments that are real .xlsx workbooks. */
  xlsxNames: string[];
}

const SUPERSEDE_WINDOW_MS = 30 * 60 * 1000;     // either order
const RENDITION_WINDOW_MS = 5 * 60 * 1000;      // PDF export sent AFTER the real file
// "P4P.xlsx", "report.xlsx", "Book1.xlsx": names many different people use are not evidence of the
// same file. Below MIN_STEM_LENGTH a name proves nothing. A LINK is matched to an attachment by name
// alone, so its name must also be distinctive — more than MIN_DISTINCT_LETTERS letters that are not a
// generic word, a month or a year (see distinctiveRemainder). A rendition ("<name>.xlsx.pdf") derives its
// name from the workbook, so it needs only the length.
const MIN_STEM_LENGTH      = 8;
const MIN_DISTINCT_LETTERS = 5;
// A later message may be a bare rendition: nothing but the file, a greeting and a signature.
const MAX_RENDITION_BODY_CHARS = 30;

/** Cloud-storage links — what makes a message "a link instead of the file". index.ts uses the same pattern. */
export const CLOUD_LINK_RE = /https?:\/\/(drive\.google\.com|docs\.google\.com|1drv\.ms|dropbox\.com|onedrive\.live\.com|sharepoint\.com)/i;

/** "Re: Fwd: P4P  " -> "p4p"; the "(no subject)" sentinel and blanks -> "". */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = String(subject ?? "").trim();
  for (;;) {
    const next = s.replace(/^\s*(?:re|fw|fwd|ตอบกลับ|ส่งต่อ)\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s === "(no subject)" || s === "(ไม่มีหัวเรื่อง)" ? "" : s;
}

const URL_RE = /https?:\/\/\S+/gi;
// Characters that cannot be part of a file name run into the one before it. Not "/": "Folder/P4P.xlsx"
// and a path inside a URL are a different file.
const LEFT_BOUNDARY = /[\s"'<>:()[\]]/;
// What may follow a stated file name: the end of the text, a separator, or a sentence's own full stop.
const RIGHT_BOUNDARY_RE = /^(?:$|[\s"'<>)\]},;:!?]|\.(?:\s|$))/;

function stemOf(name: string): string {
  return name.replace(/\.xlsx$/i, "").trim();
}

function trustedName(name: string): boolean {
  return stemOf(name).length >= MIN_STEM_LENGTH;
}

const GENERIC_WORDS = [
  // full month names first (longest first), so no tail of one is left behind as "letters"
  "พฤศจิกายน", "พฤษจิกายน", "กุมภาพันธ์", "มิถุนายน", "พฤษภาคม", "พฤศภาคม", "กรกฎาคม", "กรกฏาคม", "ธันวาคม", "กันยายน", "มีนาคม", "เมษายน", "สิงหาคม", "ตุลาคม", "มกราคม",
  "p4p", "internship", "intern", "template", "report", "monthly", "month", "version", "untitled", "document", "final",
  "score", "form", "file", "book", "sheet", "copy", "docs", "doc", "work", "kpi", "new", "ver", "hospital", "department", "dept", "ward",
  "medicine", "surgery", "pediatrics", "paediatrics", "obstetrics", "gynecology", "orthopedics", "orthopaedics", "emergency", "icu", "opd", "ipd",
  "ไฟล์", "รายงาน", "แบบฟอร์ม", "ฟอร์ม", "แบบ", "ผลงาน", "คะแนน", "ประจำเดือน", "เดือน", "สำเนา", "ล่าสุด", "ใหม่", "พ.ศ", "ปี",
  "โรงพยาบาล", "สมุทรสาคร", "แผนก", "ฝ่าย", "กลุ่มงาน", "หน่วย", "งาน", "ห้อง", "อายุรกรรม", "ศัลยกรรม", "กุมารเวชกรรม", "กุมาร", "สูติ", "นรีเวช", "ออร์โธปิดิกส์", "ฉุกเฉิน", "รพ",
];
const LATIN_MONTH_WORD_RE = /(?<![a-z])(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![a-z])/gi;
// two-consonant month abbreviations, dotted or not: สค. กย. ตค
const THAI_SHORT_MONTHS = ["มค", "กพ", "มีค", "เมย", "พค", "มิย", "กค", "สค", "กย", "ตค", "พย", "ธค"];

/**
 * What is left of a file-name stem after the words everybody's file names share (p4p, intern, report,
 * template, ไฟล์, รายงาน…), month words in either script, digits and punctuation are taken out — the part
 * that could be a person's name. "P4P ส.ค. 2569" and "template" leave nothing; "P4P_Somchai_Sep69" leaves
 * "somchai".
 */
export function distinctiveRemainder(stem: string): string {
  let t = toArabicDigits(stem).toLowerCase().replace(/เเ/g, "แ").replace(LATIN_MONTH_WORD_RE, " ");
  for (const w of GENERIC_WORDS) t = t.split(w).join(" ");
  for (const [, words] of THAI_MONTH_WORDS) for (const w of words) t = t.split(w).join(" ");
  t = t.replace(/[.\s]/g, "");                       // "ส.ค." -> "สค"
  for (const w of THAI_SHORT_MONTHS) t = t.split(w).join(" ");
  return t.replace(/[^\p{L}]/gu, "");               // letters only: Thai vowel and tone marks are not letters
}

/**
 * True when `a` is a PDF copy of workbook `n`: "<stem>.xlsx.pdf" (a print of the open file), or "<stem>.pdf"
 * when the name is distinctive enough to say whose it is. Any other extension (.xls, .zip, .csv…) is a
 * different file that happens to share a name, never a copy.
 */
function isRenditionOf(a: string, n: string): boolean {
  const al = a.toLowerCase(), stem = stemOf(n).toLowerCase();
  if (al === `${stem}.xlsx.pdf`) return true;
  return al === `${stem}.pdf` && distinctiveRemainder(stemOf(n)).length >= MIN_DISTINCT_LETTERS;
}

/**
 * True when a cloud link in `body` (at `linkAt`) is introduced by the name of one of `names`: the
 * name sits directly in front of it ("P4P_x.xlsx <https://…>", "P4P_x.xlsx: https://…") with only
 * quotes, brackets and whitespace between. A link that follows other words is some other file.
 */
function linkIsNamed(body: string, linkAt: number, names: string[]): boolean {
  const lead = body.slice(Math.max(0, linkAt - 300), linkAt).toLowerCase().replace(/[\s"'<>(\[:\-–]+$/, "");
  return names.some((n) => {
    const nl = n.toLowerCase();
    if (!lead.endsWith(nl)) return false;
    const before = lead[lead.length - nl.length - 1];
    return before === undefined || LEFT_BOUNDARY.test(before);
  });
}

/** True when `names` are mentioned whole (left AND right boundary) somewhere in `haystack`. */
function mentionsWhole(haystack: string, name: string): boolean {
  const h = haystack.toLowerCase(), n = name.toLowerCase();
  for (let from = 0; ;) {
    const at = h.indexOf(n, from);
    if (at < 0) return false;
    const leftOk  = at === 0 || LEFT_BOUNDARY.test(h[at - 1]!);
    const rightOk = RIGHT_BOUNDARY_RE.test(h.slice(at + n.length, at + n.length + 2));
    if (leftOk && rightOk) return true;
    from = at + 1;
  }
}

/**
 * Months a set of texts names by ANY reading — the strict reader, Thai substring (dotted, glued, truncated),
 * any Latin month word, or a month number after "เดือน"/"month" — URLs stripped (a Drive id can contain
 * month-like letters).
 */
function monthsStated(parts: string[]): Set<number> {
  const text = plainText(parts.join("\n")).replace(URL_RE, " ");
  const out = new Set<number>();
  for (const p of periodsInText(text)) out.add(p.month);
  for (const m of thaiMonthsIn(text)) out.add(m);
  for (const m of latinMonthsIn(text)) out.add(m);
  for (const m of toArabicDigits(text).matchAll(/(?:เดือน(?:ที่)?|months?)[\s:.\-]{0,3}(\d{1,2})(?!\d)/gi)) {
    const n = parseInt(m[1]!, 10);
    if (n >= 1 && n <= 12) out.add(n);
  }
  // numeric dates: "09/2569", "9-69", "30/09/2569" (the month is the middle part)
  const digits = toArabicDigits(text);
  for (const m of digits.matchAll(/(?<![\d/])(0?[1-9]|1[0-2])\s*[/.-]\s*(?:25\d{2}|20\d{2}|\d{2})(?![\d/])/g)) out.add(parseInt(m[1]!, 10));
  for (const m of digits.matchAll(/(?<!\d)\d{1,2}\s*[/.-]\s*(0?[1-9]|1[0-2])\s*[/.-]\s*\d{2,4}(?!\d)/g)) out.add(parseInt(m[1]!, 10));
  return out;
}

/** Month/year pairs a message states, URLs stripped (a Drive id can contain month-like letters). */
function statedIn(parts: string[]): { month: number; beYear: number | null }[] {
  const out: { month: number; beYear: number | null }[] = [];
  for (const p of parts) out.push(...periodsInText(p.replace(URL_RE, " ")));
  return out;
}

/**
 * True when `m1` (which has no xlsx) is just the same submission as `m2` (which
 * has one) arriving by another route — a Drive chip or a PDF export sent
 * seconds before or after the real attachment. Alerting m1 then tells the
 * sender "attach the file" about a file that was already received.
 *
 * Every condition must hold; each closes a way for this to swallow a message
 * that DOES need an answer (a different month, an older correction, a
 * different file):
 *   1. same non-empty sender, different message;
 *   2. m2 really carries an .xlsx;
 *   3. identical, non-empty subjects (the subject is where the month is);
 *   4. the Date headers parsed and are within 30 minutes — and a message that is
 *      NEWER than the file is only skipped when it is nothing but a rendition of
 *      it (a PDF export, no link) within 5 minutes, never a later link that
 *      might be a correction;
 *   5. m1 offers nothing but the file: EVERY URL in its body is introduced by the
 *      name of an m2 workbook, and EVERY attachment it has is a rendition of one.
 *      The name has at least 8 characters of stem, is mentioned whole, and — when
 *      it is a link that carries the match — is distinctive (not "P4P.xlsx",
 *      "template.xlsx", "P4P ส.ค. 2569.xlsx": see distinctiveRemainder);
 *   6. neither message uses correction wording (แก้ไข, ผิด, ใหม่, corrected,
 *      replaced…), and a message sent at or after the file is a bare rendition —
 *      no link, and next to no text of its own;
 *   7. the periods m1 states are a subset of the ones m2 states — m1 saying
 *      September beside an August file is a second submission, not a copy.
 */
export function isSupersededBy(m1: TriageMessage, m2: TriageMessage): boolean {
  if (m1.id === m2.id) return false;
  if (!m1.fromEmail || m1.fromEmail !== m2.fromEmail) return false;
  if (m1.xlsxNames.length > 0 || m2.xlsxNames.length === 0) return false;

  const s1 = normalizeSubject(m1.subject);
  if (s1 === "" || s1 !== normalizeSubject(m2.subject)) return false;

  if (m1.dateMs === null || m2.dateMs === null) return false;
  const gap = Math.abs(m1.dateMs - m2.dateMs);
  if (gap > SUPERSEDE_WINDOW_MS) return false;

  // A sender who is correcting, replacing or retiring something is not repeating it.
  if (CORRECTION_RE.test(plainText(`${m1.subject}\n${m1.body}`)) || CORRECTION_RE.test(plainText(`${m2.subject}\n${m2.body}`))) return false;
  // The subject has to say which month this is about — otherwise "identical subject" proves nothing about the file.
  if (monthsStated([m1.subject]).size === 0) return false;

  const candidates = m2.xlsxNames.filter(trustedName);
  if (candidates.length === 0) return false;

  // What m1 offers must be nothing but that file: every URL in it introduced by the file's name, every
  // attachment a copy of it.
  const named = candidates.filter((n) => mentionsWhole(m1.body, n));
  const urls  = [...m1.body.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map((m) => m.index!);
  if (!urls.every((at) => linkIsNamed(m1.body, at, named))) return false;
  const renditions = candidates.filter((n) => m1.attachmentNames.some((a) => isRenditionOf(a, n)));
  if (!m1.attachmentNames.every((a) => candidates.some((n) => isRenditionOf(a, n)))) return false;
  const viaLink      = urls.length > 0 && named.length > 0;
  const viaRendition = m1.attachmentNames.length > 0 && renditions.length > 0;
  if (!viaLink && !viaRendition) return false;
  // A link is matched to a workbook by its name alone: the name has to be one only that file would have.
  if (viaLink && !named.some((n) => distinctiveRemainder(stemOf(n)).length >= MIN_DISTINCT_LETTERS)) return false;

  // A rendition message — before or after the file — is a bare copy: no link, next to no text of its own.
  if (viaRendition) {
    let rest = senderOwnText(m1.body);
    for (const n of renditions) rest = rest.split(n).join(" ").split(stemOf(n)).join(" ");
    if (rest.replace(/[\s\p{P}\p{S}]/gu, "").length > MAX_RENDITION_BODY_CHARS) return false;
  }
  // The later message (equal Date headers count as later) is only ever such a bare rendition.
  if (m1.dateMs >= m2.dateMs && (urls.length > 0 || !viaRendition || gap > RENDITION_WINDOW_MS)) return false;

  // The periods m1 states must be ones m2 states too: September beside an August file is a second submission.
  const months2 = monthsStated([m2.subject, m2.body, ...m2.xlsxNames]);
  for (const m of monthsStated([m1.subject, m1.body, ...m1.attachmentNames])) if (!months2.has(m)) return false;
  const p1 = statedIn([m1.subject, m1.body, ...m1.attachmentNames]);
  if (p1.length > 0) {
    const p2 = statedIn([m2.subject, m2.body, ...m2.xlsxNames]);
    const covered = p1.every((a) =>
      p2.some((b) => b.month === a.month && (a.beYear === null || b.beYear === null || a.beYear === b.beYear))
    );
    if (!covered) return false;
  }
  return true;
}

/** The first message of `others` that supersedes `m1`, or null. */
export function findSupersedingPeer(m1: TriageMessage, others: TriageMessage[]): TriageMessage | null {
  return others.find((m2) => isSupersededBy(m1, m2)) ?? null;
}

/**
 * After the run: does a held alert go out? Only a peer workbook that ran to completion (the sender was
 * answered about it) lets the alert be dropped. Anything else — rejected, replied to with an error,
 * threw, never reached (`undefined`) — sends it, exactly as it would have been sent without the hold.
 */
export function shouldSendHeldAlert(peerProcessedToCompletion: boolean | undefined): boolean {
  return peerProcessedToCompletion !== true;
}

/** Run `fn` up to `attempts` times; true as soon as one attempt succeeds. `onFail` hears every failure. */
export async function withRetry(
  fn: () => Promise<void>,
  attempts: number,
  delayMs: number,
  onFail: (attempt: number, err: unknown) => void,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fn();
      return true;
    } catch (err) {
      onFail(attempt, err);
      if (attempt < attempts && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

export interface HeldAlert { id: string; peerId: string }

/**
 * Did a message run to completion — for deciding whether another message's alert can be dropped on its
 * account? At least one workbook processed, EVERY workbook of it came back clean (none rejected, replied to
 * with an error, or thrown), and every reply owed to the sender was sent.
 */
export function messageRanToCompletion(a: { processedAny: boolean; answered: boolean; workbooks: { outcome: unknown }[] }): boolean {
  return a.processedAny && a.answered && a.workbooks.every((w) => w.outcome === true);
}

/**
 * After the whole run: every held alert is either dropped (its peer workbook ran to completion and the
 * sender was answered about it) or sent after all. The held message is then marked as handled — unmarked,
 * the next hourly run would fetch it again, by when its peer is read and nothing would hold the alert back —
 * EXCEPT when the alert itself could not be sent: then it stays unmarked and is tried again next run. If the
 * marking fails, the admin hears about it.
 */
export async function settleHeldAlerts<H extends HeldAlert>(
  held: H[],
  peerCompleted: Map<string, boolean>,
  io: { resend: (h: H) => Promise<boolean>; mark: (h: H) => Promise<boolean>; log: (line: string) => void; report?: (line: string) => Promise<void> },
): Promise<void> {
  for (const h of held) {
    if (!shouldSendHeldAlert(peerCompleted.get(h.peerId))) {
      io.log(`🤝  Message ${h.id}: the workbook(s) in message ${h.peerId} were processed — alert not sent`);
    } else {
      io.log(`🤝  Message ${h.id}: message ${h.peerId} was NOT processed to completion — sending the held alert after all`);
      let sent = false;
      try {
        sent = await io.resend(h);
      } catch (err) {
        io.log(`❌  Held alert for ${h.id} could not be sent: ${err instanceof Error ? err.message : err}`);
      }
      if (!sent) {
        io.log(`⚠️  Held alert for ${h.id} was not delivered — message left unmarked, to be retried next run`);
        continue;
      }
    }
    if (!(await io.mark(h))) {
      await io.report?.(`⚠️ ทำเครื่องหมายอีเมล ${h.id} ไม่สำเร็จ — รอบถัดไปอาจส่งการแจ้งเตือนซ้ำ`).catch(() => undefined);
    }
  }
}
