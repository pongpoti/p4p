/**
 * types.ts
 *
 * Shared type declarations used across the automation pipeline. Nothing here
 * changes runtime behaviour — it exists only to give a name to shapes that
 * would otherwise be repeated (and drift) across every file that touches
 * them: a spreadsheet row, a roster match, a decoded Gmail message, and so
 * on.
 */

/** One cell's value after excel-parse.js/index.js have flattened a sheet. */
export type CellValue = string | number | boolean | null | undefined;

/** One spreadsheet row, keyed "col_1", "col_2", … (1-based column number). */
export type Row = Record<string, CellValue>;

/** Result of extractScoreFromRows()/resolveScore(). */
export interface ScoreResult {
  score: number | null;
  method: string;
}

/** Result of monthYearFromText()/monthYearFromRows(). */
export interface MonthYear {
  month: number | null;
  beYear: number | null;
}

/** One period a piece of text states — see periodsInText(). */
export interface Period {
  month: number;
  beYear: number | null;
}

/** Result of statedPeriods(). */
export interface StatedPeriods {
  periods: Period[];
  source: "email" | "filename" | "none";
}

/** Result of analyseJson(). */
export interface AnalysisResult {
  name: string;
  date: string;
  score: number;
}

/** A fuzzy or exact roster row match — matchName()/getRosterRowByIndex(). */
export interface RosterMatch {
  matchedName: string;
  prefix: string;
  department: string;
  index: number | string;
  similarity: number;
}

/** One Gmail attachment, as gmail-client.js exposes it. */
export interface GmailAttachment {
  partId?: string | null;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** A decoded Gmail message, as gmail-client.js exposes it. */
export interface DecodedMessage {
  id: string;
  threadId: string | null;
  subject: string;
  from: string;
  to?: string;
  date: string;
  snippet?: string;
  body: string;
}

/** getMessageWithAttachments()/getThreadMessages() entry shape. */
export interface MessageWithAttachments {
  msg: DecodedMessage;
  attachments: GmailAttachment[];
}

/** One row of getDeptStatus()'s per-physician table. */
export interface DeptStatusRow {
  name: string;
  score: number | null;
  driveFileId: string | null;
}

/** Result of dept-status.js's getDeptStatus(). */
export interface DeptStatus {
  total: number;
  filled: number;
  missing: number;
  complete: boolean;
  missingNames: string[];
  rows: DeptStatusRow[];
}

/** One month's worth of a department's status, as score-report-email.js expects. */
export interface MonthSummary {
  displayName: string;
  status: DeptStatus | null;
}

/** One department's block, as score-report-email.js expects. */
export interface DeptSection {
  dept: string;
  monthsSummary: MonthSummary[];
}

/** The already-verified physician identity a LINE upload carries into processBuffer(). */
export interface UploadIdentity {
  email: string;
  fullName: string;
  department: string | null;
  rosterIndex: number | string | null;
  lineUserId: string;
  attempt?: number | null;
}

/** What processBuffer() reports back to the caller on the upload path. */
export interface NotifyOkPayload {
  matchedName: string;
  prefix: string;
  department: string;
  monthKey: string;
  score: number;
  scoreSaved: boolean;
  receivedAt: string;
}

/**
 * Replaces the inline Gmail replies when identity is set — the pipeline
 * stops knowing which channel (LINE bubble, nothing at all) it is talking to.
 */
export interface NotifyHooks {
  ok?: (result: NotifyOkPayload) => void | Promise<void>;
  fail?: (errorType: string, detail: string) => void | Promise<void>;
}

/** processBuffer() either fully succeeds (true), sent a reply (email path
 * failure already handled), or rejected the submission outright without
 * even attempting a reply-worthy failure path. */
export type ProcessOutcome = true | "replied" | "rejected";
