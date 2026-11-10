/**
 * drain-uploads.mjs
 *
 * The worker behind the LINE upload path (UPLOAD_VIA_LINE_DESIGN.md §7.2/§7.3).
 * Long-polls p4p_upload_queue for the two things /upload/score deliberately
 * does not do inside a Vercel request:
 *
 *   1. ARCHIVE (the common case). The score is already saved — the browser
 *      got it synchronously — and only the Drive copy is outstanding. This is
 *      invisible to the physician by design: no LINE message is ever sent on
 *      this branch, on success or failure. A failure just leaves the row
 *      archive_pending for the next backoff-eligible attempt (§7.7 rec 2).
 *      Once the Drive copy exists, the physician is sent the same
 *      confirmation email an emailed submission gets, filed under เอกสาร P4P.
 *
 *   2. SCORE FALLBACK (the uncommon case). The confidence gate deferred this
 *      file, so it needs the full pipeline — Claude included — which means it
 *      needs credentials that only live here (C2). processBuffer() scores AND
 *      archives it in one pass.
 *
 * Why a long poll rather than a cron every N minutes: the queue-wait is the
 * dominant term in "how long until the physician hears back", and it is an
 * artifact of the trigger, not of the work (§7.3). Polling every ~10 s inside
 * one hour-long run makes the deferred tier's latency the processing time
 * (~20-40 s) rather than the cron period, using one scheduled run per hour.
 *
 *   3. SUBMISSION EMAILS. The same relay also reads the Gmail inbox every
 *      EMAIL_POLL_MS (default 60 s) by calling readSubmissionEmails() — the
 *      pass 3-1-manual-email-read-submission-emails.yml used to run on an hourly cron, which
 *      GitHub delayed by 4-6 hours under load. Riding this always-on job puts
 *      an emailed file in front of the pipeline within about a minute, with no
 *      second always-on runner. Only this job polls Gmail on a schedule now;
 *      the email workflow is manual-only so the two never read the inbox at
 *      once and double-process a message.
 *
 *   node scripts/drain-uploads.mjs
 */

import { processBuffer, extractFirstSheetBuffer, monthSheet, readSubmissionEmails, SENDER_DETAIL } from "../index.js";
import {
  claimArchive, claimScoreFallback, completeScored, failScored, rejectScored,
  markArchived, markSuperseded, markNotified, listStuckArchives, downloadObject, deleteObject,
  listLeftoverObjects, removeLeftoverObjects,
  type ArchiveQueueRow, type ScoreFallbackQueueRow,
} from "../upload-queue.js";
import { createDriveClient, type DriveClient } from "../drive-client.js";
import { getRosterRowByIndex, matchName, newerScoreSaved } from "../supabase-client.js";
import { sendTelegram, formatErrorMessage } from "../telegram.js";
import { pushLine } from "../line-push.js";
import { createGmailClient, type GmailClient } from "../gmail-client.js";
import { sendUploadConfirmation } from "../confirmation-email.js";
import { buildFailureBubble, displayMonth } from "../templates/line-receipt.js";
import { reviewCheckDue, dispatchReviewBuild, dispatchReviewPdf } from "../review-dispatch.js";
import { config as dotenvConfig } from "dotenv";
import { pathToFileURL } from "node:url";
import { errForLog, redactForLog } from "../log-safe.js";
import { ADMIN_REVIEW_ERROR_TYPE } from "../admin-review.js";
import { RetryLaterError } from "../inbound-triage.js";
import { zipProblem } from "../zip-guard.js";
import type { RosterMatch, NotifyOkPayload } from "../types.js";

dotenvConfig({ override: true });

const POLL_MS       = parseInt(process.env.DRAIN_POLL_MS ?? "10000", 10);
const RUN_MINUTES   = parseInt(process.env.DRAIN_MINUTES ?? "60", 10);
// Same public-identifier fallback as main.js — without it a terminal failure
// pushes a bubble whose "ส่งไฟล์อีกครั้ง" button degrades to "ติดต่อผู้ดูแล"
// purely because a CI secret was never added.
const UPLOAD_LIFF   = `https://liff.line.me/${process.env.UPLOAD_LIFF_ID || "2008561527-sj7tuMLL"}`;
const STUCK_HOURS   = parseInt(process.env.DRAIN_STUCK_HOURS ?? "1", 10);
// 0 turns email polling off, e.g. to run the drain alone while debugging.
const EMAIL_POLL_MS = parseInt(process.env.EMAIL_POLL_MS ?? "60000", 10);
// No new inbox pass this close to the end of the run: a burst of submissions
// can take minutes, and the job's timeout must never cut one off mid-message.
// The next relay run is already queued and picks the inbox up straight away.
const EMAIL_CUTOFF_MS = 5 * 60_000;

let _drive: DriveClient | null = null;
function getDrive(): DriveClient | null {
  if (!process.env.P4P_FOLDER_ID) return null;
  if (!_drive) _drive = createDriveClient();
  return _drive;
}

let _gmail: GmailClient | null = null;
function getGmail(): GmailClient {
  if (!_gmail) _gmail = createGmailClient();
  return _gmail;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The roster row this queue row belongs to — exact first, fuzzy only if needed. */
async function resolveRoster(row: ArchiveQueueRow): Promise<RosterMatch | null> {
  if (row.roster_index !== null && row.roster_index !== undefined) {
    const exact = await getRosterRowByIndex(row.month_key, row.roster_index);
    if (exact) return exact;
  }
  return matchName(row.full_name, row.month_key);
}

// ── 1. Archive ────────────────────────────────────────────────────────────
/** Exported for the tests, which pass their own Drive client. */
export async function handleArchive(row: ArchiveQueueRow, drive: DriveClient | null = getDrive()): Promise<void> {
  // Queue id, month and roster row only: this log is public (log-safe.ts).
  console.log(`│  📦  Archiving queue row ${row.id} (${row.month_key}, roster row #${row.roster_index ?? "?"}) — attempt ${row.archive_attempts}`);
  if (!drive) {
    console.warn("│      ⚠️  P4P_FOLDER_ID not set — leaving archive_pending");
    return;
  }

  const buffer   = await downloadObject(row.object_path);
  // /upload/score ran the same zip guard before it scored this row, so this
  // should never refuse; if it does, nothing is inflated, and the row backs
  // off and shows in the stuck-archive alert.
  const zip = zipProblem(buffer);
  if (zip) throw new Error(`archive refused by the zip guard (${zip.code})`);
  const roster   = await resolveRoster(row);
  const name     = roster?.matchedName ?? row.full_name;
  // A row backing off here must not replace the Drive copy of a submission
  // received after it whose score is saved since (an email, say: the claim
  // only knows about newer uploads). A failed read throws, and the row
  // retries on its backoff.
  if (roster && await newerScoreSaved(row.month_key, roster.index, new Date(row.received_at).toISOString())) {
    await markSuperseded(row.id);
    console.log(`│      ⏭️  A newer submission's score is saved — superseded, Drive copy left as it is`);
    return;
  }
  // The tab for this month, the same one the score was read from.
  const [beYear, month] = row.month_key.split("_").map(Number);
  const { name: monthTab } = await monthSheet(buffer, month!, beYear!);
  const oneSheet = await extractFirstSheetBuffer(buffer, monthTab);
  if (!oneSheet) throw new Error("first sheet is blank — nothing to archive");

  const { replaced } = await drive.uploadFile(oneSheet, name, row.month_key);
  console.log(`│      ✅  Drive: ${replaced ? "replaced" : "new"} file`);

  await markArchived(row.id);
  // The bucket is a drop box, not storage — the object goes as soon as the
  // Drive copy exists (§11).
  await deleteObject(row.object_path);

  // The upload is now complete on every count — score saved, file in Drive —
  // so the physician gets the same confirmation email an emailed submission
  // gets. Sent here, after markArchived, so a Drive retry never sends twice.
  // Rows the score fallback already archived never reach this branch; it
  // sends its own (see handleScoreFallback).
  if (row.status === "done" && row.score !== null && row.score !== undefined) {
    await sendUploadConfirmation(getGmail(), row.email, {
      prefix     : roster?.prefix,
      matchedName: name,
      department : roster?.department ?? row.department,
      monthKey   : row.month_key,
      score      : Number(row.score),
      route      : "line",
    });
  }
}

// ── 2. Score fallback ─────────────────────────────────────────────────────
/** A pass that reported success without the score row being written (pure, for the tests). */
export function scoreNotSaved(outcome: unknown, success: NotifyOkPayload | null): boolean {
  return outcome === true && success !== null && !success.scoreSaved;
}

/** Exported for the tests only. */
export async function handleScoreFallback(row: ScoreFallbackQueueRow): Promise<void> {
  console.log(`│  🧮  Scoring queue row ${row.id} (${row.month_key}, roster row #${row.roster_index ?? "?"}) — attempt ${row.attempts}`);

  const buffer = await downloadObject(row.object_path);

  // The zip-bomb guard before ExcelJS inflates anything, as on the email
  // path (index.ts processAttachment): a crafted workbook would otherwise
  // run this always-on runner out of memory, and the row would be claimed
  // again by the next run. A refusal is final.
  const zip = zipProblem(buffer);
  if (zip) {
    console.warn(`│      ⛔  Upload refused before parsing: ${zip.code}`);
    const errorDetail = zip.code === "NOT_A_ZIP" || zip.code === "ZIP_MALFORMED" ? SENDER_DETAIL.notAZip : SENDER_DETAIL.zipTooBig;
    await sendTelegram(formatErrorMessage(`Upload refused by the zip guard (${zip.code}): ${zip.message}`, row.filename, {
      source: "LINE upload", accountName: row.full_name, email: row.email, monthKey: row.month_key, errorType: "other",
    })).catch(() => {});
    await rejectScored(row.id, { errorType: "other", errorDetail });
    await afterOutcome("the failure notice", () => finishFailedRow(row, "other", errorDetail));
    return;
  }

  // notify.* only RECORDS what happened; the queue semantics below are this
  // script's business, not the pipeline's.
  // (Kept as one mutable object rather than two `let`s — TS's narrowing of a
  // `let` reassigned only inside a closure passed to an intervening `await`
  // call collapses to `never` at the read site below; a property on a plain
  // object narrows correctly instead.)
  const state: {
    failure: { errorType: string; detail: string } | null;
    success: NotifyOkPayload | null;
  } = { failure: null, success: null };
  const notify = {
    ok:   (result: NotifyOkPayload): void => { state.success = result; },
    fail: (errorType: string, detail: string): void => { state.failure = { errorType, detail }; },
  };

  const outcome = await processBuffer(buffer, {
    filename : row.filename,
    // The selected month, as context for Claude's own date resolution — the
    // same role an email subject plays. processBuffer's month cross-check
    // deliberately ignores this field and reads the filename/sheet instead,
    // so this cannot make the check compare the selection with itself.
    subject  : `P4P ${displayMonth(row.month_key)}`,
    body     : "",
    // THE punctuality timestamp: when the physician handed the file over,
    // never when this runner got to it (§9).
    emailDate: row.received_at,
    source   : "line-upload",
    monthKey : row.month_key,
    identity : {
      email      : row.email,
      fullName   : row.full_name,
      department : row.department,
      rosterIndex: row.roster_index,
      lineUserId : row.line_user_id,
      attempt    : row.attempts,
      queueId    : row.id,
    },
    notify,
  });

  // Never close a row as done with a score that was not written: the
  // physician's "ดูผลคะแนน" button would show it as saved. Thrown, the row
  // goes back to pending through handleScoreCrash (failScored, three
  // attempts in all) and its uploaded object is kept for that retry.
  if (scoreNotSaved(outcome, state.success)) {
    throw new Error(`score not saved for queue row ${row.id} — left for a retry`);
  }

  if (outcome === true && state.success) {
    // processBuffer archived to Drive in the same pass, so both lifecycles
    // normally close together here. When Drive is not configured at all it
    // did NOT archive, and the row stays archive_pending — in which case the
    // object must survive, or claim_p4p_archive() would keep claiming a row
    // whose bytes are gone.
    // The score (and Drive copy) are saved from here on: a failed write
    // below must not fail the row or tell the physician to resend.
    const archived = Boolean(getDrive());
    const success = state.success;
    await afterOutcome("closing the queue row", () => completeScored(row.id, {
      score: success.score,
      scoreMethod: "claude (deferred tier)",
      archived,
    }));
    if (archived) {
      await deleteObject(row.object_path);
      // Not archived means handleArchive() finishes this row later and sends
      // the confirmation email then — never both. No email when the score
      // write failed: it would tell the physician something that is not true.
      if (state.success.scoreSaved) await sendUploadConfirmation(getGmail(), row.email, {
        prefix     : state.success.prefix,
        matchedName: state.success.matchedName,
        department : state.success.department,
        monthKey   : state.success.monthKey,
        score      : state.success.score,
        route      : "line",
      });
    }
    // PULL ON SUCCESS: the physician already has a "ดูผลคะแนน" button in
    // their chat from the ACK reply (§7.5 step ②), and tapping it costs the
    // OA nothing. Pushing here would spend quota to tell them something they
    // can already ask for.
    console.log(`│      ✅  Scored — receipt left for the physician to pull`);
    return;
  }

  const errorType   = state.failure?.errorType ?? "other";
  const errorDetail = state.failure?.detail ?? "processing failed";

  // A validation refusal is terminal on both claim functions; a processing
  // failure gets three attempts before it is.
  let terminal;
  if (outcome === "rejected") {
    await rejectScored(row.id, { errorType, errorDetail });
    terminal = true;
  } else {
    terminal = await failScored(row.id, { errorType, errorDetail, attempts: row.attempts });
  }

  console.log(`│      ${terminal ? "❌" : "⏳"}  ${errorType}: ${redactForLog(errorDetail)}${terminal ? " (terminal)" : " — will retry"}`);
  if (!terminal) return;
  await afterOutcome("the failure notice", () => finishFailedRow(row, errorType, errorDetail));
}

/**
 * A failure after the row's outcome was written: the score and Drive copy
 * saved, or the refusal recorded and the physician told. handleScoreCrash
 * only reports it; it must not put the row back, fail it, or push a second,
 * contradicting failure bubble.
 */
export class AfterOutcomeError extends Error {
  readonly step: string;
  constructor(step: string, cause: unknown) {
    super(`${step} failed after the outcome was saved: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AfterOutcomeError";
    this.step = step;
  }
}

async function afterOutcome<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new AfterOutcomeError(step, err);
  }
}

/**
 * A row that has just failed for good. PUSH ON FAILURE: rare, and the one
 * case where the physician has something to do about it. A push that cannot
 * be delivered leaves notified_at null rather than failing anything.
 */
async function finishFailedRow(row: ScoreFallbackQueueRow, errorType: string, errorDetail: string): Promise<void> {
  const pushed = await pushLine(row.line_user_id, [
    buildFailureBubble({
      monthKey: row.month_key,
      errorType,
      detail: errorDetail,
      uploadLiffUrl: UPLOAD_LIFF,
    }),
  ]);
  // The bubble is delivered either way; a failed stamp must not stop the
  // delete below or be taken for a failed upload.
  if (pushed) {
    await markNotified(row.id)
      .catch((e: unknown) => console.warn(`│      ⚠️  notified_at not stamped: ${errForLog(e)}`));
  }
  // A row held for the admin keeps its file: the admin's alert says how to
  // run it again once the right roster row is set (admin-review.ts).
  if (errorType !== ADMIN_REVIEW_ERROR_TYPE) await deleteObject(row.object_path);
}

/**
 * handleScoreFallback threw. The row goes back to 'pending' (the claim
 * waits 5 minutes per attempt before it is claimed again, audit-fixes
 * PART 2), and at the third attempt it fails for good: the physician then
 * gets the failure bubble and the uploaded object is deleted, the same as a
 * failure processBuffer answered. A RetryLaterError (a temporary Drive or
 * database error, or an admin-hold alert that was not delivered) tells the
 * admin only when it gives up, as the email path does; any other crash on
 * every attempt. Never throws.
 */
export async function handleScoreCrash(row: ScoreFallbackQueueRow, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof AfterOutcomeError) {
    // The outcome stands, and the admin is told. A row left 'processing'
    // (its close failed) is claimed again after 30 minutes while it has
    // attempts left, and that pass saves the same score and closes it.
    console.error(`│      ⚠️  ${errForLog(message)} — the outcome stands`);
    await sendTelegram(formatErrorMessage(message, row.filename, {
      source: "LINE upload",
      accountName: row.full_name,
      email: row.email,
      monthKey: row.month_key,
      errorType: "other",
    })).catch(() => {});
    return;
  }
  const temporary = err instanceof RetryLaterError;
  console.error(`│      ❌  ${temporary ? "Temporary failure" : "Scoring crashed"}: ${errForLog(message)}`);
  // error_detail is shown to the physician (the LINE failure bubble); the
  // raw message goes to Telegram below, never to them.
  const errorType = "other";
  const errorDetail = SENDER_DETAIL.crashed;
  let terminal: boolean | null = null;
  try {
    terminal = await failScored(row.id, { errorType, errorDetail, attempts: row.attempts });
  } catch (e) {
    // The row stays 'processing'; the claim takes it again after 30 minutes.
    console.error(`│      ❌  failScored failed too: ${errForLog(e)}`);
  }
  if (!temporary || terminal !== false) {
    await sendTelegram(
      formatErrorMessage(temporary && terminal ? `Gave up after ${row.attempts} attempts: ${message}` : message, row.filename, {
        source: "LINE upload",
        accountName: row.full_name,
        email: row.email,
        monthKey: row.month_key,
        errorType,
        attempt: row.attempts,
        maxAttempts: 3,
      })
    ).catch(() => {});
  }
  if (terminal) {
    await finishFailedRow(row, errorType, errorDetail)
      .catch((e: unknown) => console.error(`│      ❌  Failure notice failed: ${errForLog(e)}`));
  }
}

// ── Stuck-archive alerting ────────────────────────────────────────────────
// The queue guarantees retries; it does not guarantee anyone looks (§7.7
// rec 2). Once per run, not per iteration — this is a nudge, not a firehose.
// Sent only once the queue has first gone idle, never at startup: after a
// gap between runs, a row that merely waited for a runner looks "stuck" at
// startup and is archived seconds later. Waiting for the first empty claim
// means only rows the queue could not clear (failed and backing off) remain.
async function alertStuckArchives() {
  try {
    const stuck = await listStuckArchives(STUCK_HOURS);
    if (stuck.length === 0) return;
    const lines = stuck.map((r) =>
      `• ${r.month_key} ${r.full_name} — ${r.archive_attempts} attempt(s) since ${r.received_at}`
    );
    await sendTelegram(
      [`⏰ P4P uploads scored but NOT archived (> ${STUCK_HOURS}h)`, "", ...lines].join("\n")
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  stuck-archive alert failed: ${errForLog(message)}`);
  }
}

// ── Leftover objects ──────────────────────────────────────────────────────
/**
 * Delete the uploaded objects of rows the queue will never claim again
 * (superseded, or failed as stuck in processing; see listLeftoverObjects).
 * The bucket is a drop box (§11): those workbooks carry a physician's name
 * and workload and must not stay in it for good. Once per run, beside the
 * stuck-archive alert; up to 50 rows a pass. Never throws.
 */
export async function sweepLeftoverObjects(): Promise<number> {
  try {
    const rows = await listLeftoverObjects();
    if (rows.length === 0) return 0;
    await removeLeftoverObjects(rows);
    console.log(`│  🧹  Deleted ${rows.length} uploaded file(s) of superseded or stuck queue rows`);
    return rows.length;
  } catch (err) {
    console.warn(`⚠️  leftover-object sweep skipped: ${errForLog(err)}`);
    return 0;
  }
}

// ── 3. Submission emails ──────────────────────────────────────────────────
/** Is an inbox pass due? Pure, so the timing rules are testable. */
export function emailPollDue(now: number, lastPollAt: number | null, until: number, intervalMs: number = EMAIL_POLL_MS): boolean {
  if (!(intervalMs > 0)) return false;
  if (until - now < EMAIL_CUTOFF_MS) return false;
  return lastPollAt === null || now - lastPollAt >= intervalMs;
}

let emailFailureReported = false;
async function pollEmails(): Promise<void> {
  try {
    await readSubmissionEmails();
  } catch (err) {
    // The hourly workflow used to fail its job on this and GitHub emailed the
    // owner. Here the loop must keep going (the next pass a minute later
    // usually succeeds), so the alert is one Telegram per run, not per minute.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`│  ❌  Email pass failed (retrying next poll): ${errForLog(message)}`);
    if (!emailFailureReported) {
      emailFailureReported = true;
      await sendTelegram(`⚠️ P4P email reader failed in the drain relay: ${message}`).catch(() => {});
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────
async function main() {
  const until = Date.now() + RUN_MINUTES * 60_000;
  console.log(`┌─ P4P upload drain — polling every ${POLL_MS}ms for ${RUN_MINUTES} min` +
    (EMAIL_POLL_MS > 0 ? `, Gmail every ${EMAIL_POLL_MS}ms` : ", Gmail polling off"));

  let handled = 0;
  let alerted = false;
  let lastEmailPoll: number | null = null;
  let lastReviewCheck: number | null = null;
  while (Date.now() < until) {
    let didWork = false;

    // Email first: submissions arrive here far more often than LINE uploads,
    // and one pass is a couple of Gmail calls when the inbox is empty.
    if (emailPollDue(Date.now(), lastEmailPoll, until)) {
      lastEmailPoll = Date.now();
      await pollEmails();
    }

    // The dashboard's ตรวจสอบ tab: start a requested one-month SK03 build
    // (workflow 2.2), and an approved month's PDF (workflow 2.8). Never throw.
    if (reviewCheckDue(Date.now(), lastReviewCheck)) {
      lastReviewCheck = Date.now();
      await dispatchReviewBuild();
      await dispatchReviewPdf();
    }

    // Archive first: it is the common case and the cheap one (no Claude, no
    // API cost), so a backlog of archives never sits behind one slow scoring
    // run.
    try {
      const archiveRow = await claimArchive();
      if (archiveRow) {
        didWork = true;
        handled++;
        try {
          await handleArchive(archiveRow);
        } catch (err) {
          // No terminal state on this track: the claim already stamped
          // archive_attempts/archive_last_attempt_at, so the row simply
          // becomes eligible again on the backoff schedule.
          const message = err instanceof Error ? err.message : String(err);
          console.error(`│      ❌  Archive failed (will retry on backoff): ${errForLog(message)}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`│  ❌  claim_p4p_archive failed: ${message}`);
    }

    if (!didWork) {
      try {
        const scoreRow = await claimScoreFallback();
        if (scoreRow) {
          didWork = true;
          handled++;
          try {
            await handleScoreFallback(scoreRow);
          } catch (err) {
            await handleScoreCrash(scoreRow, err);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`│  ❌  claim_p4p_score_fallback failed: ${message}`);
      }
    }

    if (!didWork && !alerted) {
      alerted = true;
      await alertStuckArchives();
      await sweepLeftoverObjects();
    }

    // Only sleep when the queue was empty — a busy queue drains back to back.
    if (!didWork) await sleep(POLL_MS);
  }

  // A run that never went idle still owes its one look.
  if (!alerted) {
    await alertStuckArchives();
    await sweepLeftoverObjects();
  }

  console.log(`└─ drain finished — ${handled} row(s) handled`);
}

// Only when run as the program, so the test can import emailPollDue().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("drain-uploads failed:", errForLog(err));
    process.exit(1);
  });
}
