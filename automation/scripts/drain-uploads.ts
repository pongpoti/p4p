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
 *      pass 1-read-submission-emails.yml used to run on an hourly cron, which
 *      GitHub delayed by 4-6 hours under load. Riding this always-on job puts
 *      an emailed file in front of the pipeline within about a minute, with no
 *      second always-on runner. Only this job polls Gmail on a schedule now;
 *      the email workflow is manual-only so the two never read the inbox at
 *      once and double-process a message.
 *
 *   node scripts/drain-uploads.mjs
 */

import { processBuffer, extractFirstSheetBuffer, monthSheet, readSubmissionEmails } from "../index.js";
import {
  claimArchive, claimScoreFallback, completeScored, failScored, rejectScored,
  markArchived, markNotified, listStuckArchives, downloadObject, deleteObject,
  type ArchiveQueueRow, type ScoreFallbackQueueRow,
} from "../upload-queue.js";
import { createDriveClient, type DriveClient } from "../drive-client.js";
import { getRosterRowByIndex, matchName } from "../supabase-client.js";
import { sendTelegram, formatErrorMessage } from "../telegram.js";
import { pushLine } from "../line-push.js";
import { createGmailClient, type GmailClient } from "../gmail-client.js";
import { sendUploadConfirmation } from "../confirmation-email.js";
import { buildFailureBubble, displayMonth } from "../templates/line-receipt.js";
import { config as dotenvConfig } from "dotenv";
import { pathToFileURL } from "node:url";
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
async function handleArchive(row: ArchiveQueueRow): Promise<void> {
  console.log(`│  📦  Archiving ${row.filename} (${row.month_key}) for ${row.full_name} — attempt ${row.archive_attempts}`);
  const drive = getDrive();
  if (!drive) {
    console.warn("│      ⚠️  P4P_FOLDER_ID not set — leaving archive_pending");
    return;
  }

  const buffer   = await downloadObject(row.object_path);
  const roster   = await resolveRoster(row);
  const name     = roster?.matchedName ?? row.full_name;
  // The tab for this month, the same one the score was read from.
  const [beYear, month] = row.month_key.split("_").map(Number);
  const { name: monthTab } = await monthSheet(buffer, month!, beYear!);
  const oneSheet = await extractFirstSheetBuffer(buffer, monthTab);
  if (!oneSheet) throw new Error("first sheet is blank — nothing to archive");

  const { fileName, replaced } = await drive.uploadFile(oneSheet, name, row.month_key);
  console.log(`│      ✅  Drive: "${fileName}" (${replaced ? "replaced" : "new"})`);

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
async function handleScoreFallback(row: ScoreFallbackQueueRow): Promise<void> {
  console.log(`│  🧮  Scoring ${row.filename} (${row.month_key}) for ${row.full_name} — attempt ${row.attempts}`);

  const buffer = await downloadObject(row.object_path);

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
    },
    notify,
  });

  if (outcome === true && state.success) {
    // processBuffer archived to Drive in the same pass, so both lifecycles
    // normally close together here. When Drive is not configured at all it
    // did NOT archive, and the row stays archive_pending — in which case the
    // object must survive, or claim_p4p_archive() would keep claiming a row
    // whose bytes are gone.
    const archived = Boolean(getDrive());
    await completeScored(row.id, {
      score: state.success.score,
      scoreMethod: "claude (deferred tier)",
      archived,
    });
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
    console.log(`│      ✅  Scored ${Number(state.success.score).toFixed(2)} — receipt left for the physician to pull`);
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

  console.log(`│      ${terminal ? "❌" : "⏳"}  ${errorType}: ${errorDetail}${terminal ? " (terminal)" : " — will retry"}`);
  if (!terminal) return;

  // PUSH ON FAILURE: rare, and the one case where the physician has something
  // to do about it. A push that cannot be delivered leaves notified_at null
  // rather than failing anything.
  const pushed = await pushLine(row.line_user_id, [
    buildFailureBubble({
      monthKey: row.month_key,
      errorType,
      detail: errorDetail,
      uploadLiffUrl: UPLOAD_LIFF,
    }),
  ]);
  if (pushed) await markNotified(row.id);
  await deleteObject(row.object_path);
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
    console.warn(`⚠️  stuck-archive alert failed: ${message}`);
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
    console.error(`│  ❌  Email pass failed (retrying next poll): ${message}`);
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
  while (Date.now() < until) {
    let didWork = false;

    // Email first: submissions arrive here far more often than LINE uploads,
    // and one pass is a couple of Gmail calls when the inbox is empty.
    if (emailPollDue(Date.now(), lastEmailPoll, until)) {
      lastEmailPoll = Date.now();
      await pollEmails();
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
          console.error(`│      ❌  Archive failed (will retry on backoff): ${message}`);
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
            const message = err instanceof Error ? err.message : String(err);
            console.error(`│      ❌  Scoring crashed: ${message}`);
            await failScored(scoreRow.id, {
              errorType: "other",
              errorDetail: message,
              attempts: scoreRow.attempts,
            }).catch((e: unknown) => console.error(`│      ❌  failScored failed too: ${e instanceof Error ? e.message : String(e)}`));
            await sendTelegram(
              formatErrorMessage(message, scoreRow.filename, {
                source: "LINE upload",
                accountName: scoreRow.full_name,
                email: scoreRow.email,
                monthKey: scoreRow.month_key,
                errorType: "other",
                attempt: scoreRow.attempts,
                maxAttempts: 3,
              })
            ).catch(() => {});
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
    }

    // Only sleep when the queue was empty — a busy queue drains back to back.
    if (!didWork) await sleep(POLL_MS);
  }

  // A run that never went idle still owes its one look.
  if (!alerted) await alertStuckArchives();

  console.log(`└─ drain finished — ${handled} row(s) handled`);
}

// Only when run as the program, so the test can import emailPollDue().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("drain-uploads failed:", err);
    process.exit(1);
  });
}
