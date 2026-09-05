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
 *   node scripts/drain-uploads.mjs
 */

import { processBuffer, extractFirstSheetBuffer } from "../index.js";
import {
  claimArchive, claimScoreFallback, completeScored, failScored, rejectScored,
  markArchived, markNotified, listStuckArchives, downloadObject, deleteObject,
} from "../upload-queue.js";
import { createDriveClient } from "../drive-client.js";
import { getRosterRowByIndex, matchName } from "../supabase-client.js";
import { sendTelegram, formatErrorMessage } from "../telegram.js";
import { pushLine } from "../line-push.js";
import { buildFailureBubble, displayMonth } from "../templates/line-receipt.js";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ override: true });

const POLL_MS       = parseInt(process.env.DRAIN_POLL_MS ?? "10000", 10);
const RUN_MINUTES   = parseInt(process.env.DRAIN_MINUTES ?? "60", 10);
const UPLOAD_LIFF   = process.env.UPLOAD_LIFF_ID ? `https://liff.line.me/${process.env.UPLOAD_LIFF_ID}` : "";
const STUCK_HOURS   = parseInt(process.env.DRAIN_STUCK_HOURS ?? "1", 10);

let _drive = null;
function getDrive() {
  if (!process.env.P4P_FOLDER_ID) return null;
  if (!_drive) _drive = createDriveClient();
  return _drive;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The roster row this queue row belongs to — exact first, fuzzy only if needed. */
async function resolveRoster(row) {
  if (row.roster_index !== null && row.roster_index !== undefined) {
    const exact = await getRosterRowByIndex(row.month_key, row.roster_index);
    if (exact) return exact;
  }
  return matchName(row.full_name, row.month_key);
}

// ── 1. Archive ────────────────────────────────────────────────────────────
async function handleArchive(row) {
  console.log(`│  📦  Archiving ${row.filename} (${row.month_key}) for ${row.full_name} — attempt ${row.archive_attempts}`);
  const drive = getDrive();
  if (!drive) {
    console.warn("│      ⚠️  P4P_FOLDER_ID not set — leaving archive_pending");
    return;
  }

  const buffer   = await downloadObject(row.object_path);
  const roster   = await resolveRoster(row);
  const name     = roster?.matchedName ?? row.full_name;
  const oneSheet = await extractFirstSheetBuffer(buffer);
  if (!oneSheet) throw new Error("first sheet is blank — nothing to archive");

  const { fileName, replaced } = await drive.uploadFile(oneSheet, name, row.month_key);
  console.log(`│      ✅  Drive: "${fileName}" (${replaced ? "replaced" : "new"})`);

  await markArchived(row.id);
  // The bucket is a drop box, not storage — the object goes as soon as the
  // Drive copy exists (§11).
  await deleteObject(row.object_path);
}

// ── 2. Score fallback ─────────────────────────────────────────────────────
async function handleScoreFallback(row) {
  console.log(`│  🧮  Scoring ${row.filename} (${row.month_key}) for ${row.full_name} — attempt ${row.attempts}`);

  const buffer = await downloadObject(row.object_path);

  // notify.* only RECORDS what happened; the queue semantics below are this
  // script's business, not the pipeline's.
  let failure = null;
  let success = null;
  const notify = {
    ok:   (result) => { success = result; },
    fail: (errorType, detail) => { failure = { errorType, detail }; },
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

  if (outcome === true && success) {
    // processBuffer archived to Drive in the same pass, so both lifecycles
    // normally close together here. When Drive is not configured at all it
    // did NOT archive, and the row stays archive_pending — in which case the
    // object must survive, or claim_p4p_archive() would keep claiming a row
    // whose bytes are gone.
    const archived = Boolean(getDrive());
    await completeScored(row.id, {
      score: success.score,
      scoreMethod: "claude (deferred tier)",
      archived,
    });
    if (archived) await deleteObject(row.object_path);
    // PULL ON SUCCESS: the physician already has a "ดูผลคะแนน" button in
    // their chat from the ACK reply (§7.5 step ②), and tapping it costs the
    // OA nothing. Pushing here would spend quota to tell them something they
    // can already ask for.
    console.log(`│      ✅  Scored ${Number(success.score).toFixed(2)} — receipt left for the physician to pull`);
    return;
  }

  const errorType   = failure?.errorType ?? "other";
  const errorDetail = failure?.detail ?? "processing failed";

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
    console.warn(`⚠️  stuck-archive alert failed: ${err.message}`);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────
async function main() {
  const until = Date.now() + RUN_MINUTES * 60_000;
  console.log(`┌─ P4P upload drain — polling every ${POLL_MS}ms for ${RUN_MINUTES} min`);

  await alertStuckArchives();

  let handled = 0;
  while (Date.now() < until) {
    let didWork = false;

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
          console.error(`│      ❌  Archive failed (will retry on backoff): ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`│  ❌  claim_p4p_archive failed: ${err.message}`);
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
            console.error(`│      ❌  Scoring crashed: ${err.message}`);
            await failScored(scoreRow.id, {
              errorType: "other",
              errorDetail: err.message,
              attempts: scoreRow.attempts,
            }).catch((e) => console.error(`│      ❌  failScored failed too: ${e.message}`));
            await sendTelegram(
              formatErrorMessage(err.message, scoreRow.filename, {
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
        console.error(`│  ❌  claim_p4p_score_fallback failed: ${err.message}`);
      }
    }

    // Only sleep when the queue was empty — a busy queue drains back to back.
    if (!didWork) await sleep(POLL_MS);
  }

  console.log(`└─ drain finished — ${handled} row(s) handled`);
}

main().catch((err) => {
  console.error("drain-uploads failed:", err);
  process.exit(1);
});
