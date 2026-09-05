/**
 * upload-queue.js
 *
 * The worker's half of p4p_upload_queue (scripts/line-upload-2026-09.sql):
 * claim a row, read its object out of Storage, write the outcome back, drop
 * the object. Nothing here decides anything — drain-uploads.mjs owns the
 * policy, this file owns the SQL/REST calls.
 *
 * Two claim functions, not one, because the two lifecycles on that row are
 * genuinely independent (design §6.5/§7.7 rec 2):
 *
 *   claim_p4p_archive()         the common case — the score is already saved
 *                               (/upload/score did it synchronously), only
 *                               the Drive copy is outstanding. Retries
 *                               forever on a backoff; never terminal, never
 *                               visible to the physician.
 *   claim_p4p_score_fallback()  the uncommon case — the confidence gate
 *                               deferred this file, so it still needs the
 *                               full Claude pipeline. Gives up at 3 attempts.
 *
 * Both are RPCs rather than PostgREST queries for one reason: FOR UPDATE SKIP
 * LOCKED is not expressible through PostgREST, and without it two overlapping
 * drains would claim the same row.
 */

import { createClient } from "@supabase/supabase-js";

const BUCKET = "p4p-uploads";

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY in .env");
  _supabase = createClient(url, key);
  return _supabase;
}

/**
 * Both claim functions `returns setof`, so "nothing to do" is a genuinely
 * empty result set rather than one row of nulls — see the SQL file's Part 5
 * comment for why that distinction cost a bug once already.
 */
async function claim(fn) {
  const { data, error } = await getSupabase().rpc(fn);
  if (error) throw new Error(`${fn} RPC error: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

export const claimArchive       = () => claim("claim_p4p_archive");
export const claimScoreFallback = () => claim("claim_p4p_score_fallback");

async function patch(id, fields) {
  const { error } = await getSupabase()
    .from("p4p_upload_queue")
    .update(fields)
    .eq("id", id);
  if (error) throw new Error(`p4p_upload_queue update error: ${error.message}`);
}

/**
 * The fallback tier finished: it scored AND archived in one pass, so both
 * lifecycles close together. (The instant tier closes `status` in
 * /upload/score and leaves `archive_status = 'archive_pending'` for
 * claimArchive() — this is the other shape.)
 */
export async function completeScored(id, { score, scoreMethod, archived }) {
  const now = new Date().toISOString();
  await patch(id, {
    status: "done",
    score,
    score_method: scoreMethod ?? null,
    finished_at: now,
    ...(archived
      ? { archive_status: "archived", archived_at: now }
      : { archive_status: "archive_pending" }),
  });
}

/**
 * A processing failure. Terminal only at the third attempt — before that the
 * row goes back to 'pending' so the next drain can retry it (the claim
 * already incremented `attempts`, so this cannot loop forever).
 */
export async function failScored(id, { errorType, errorDetail, attempts }) {
  const terminal = (attempts ?? 0) >= 3;
  await patch(id, {
    status: terminal ? "failed" : "pending",
    error_type: errorType ?? "other",
    error_detail: errorDetail ? String(errorDetail).slice(0, 2000) : null,
    ...(terminal ? { finished_at: new Date().toISOString() } : {}),
  });
  return terminal;
}

/** A validation refusal — never retried, on either claim function. */
export async function rejectScored(id, { errorType, errorDetail }) {
  await patch(id, {
    status: "rejected",
    error_type: errorType ?? "other",
    error_detail: errorDetail ? String(errorDetail).slice(0, 2000) : null,
    finished_at: new Date().toISOString(),
  });
}

export async function markArchived(id) {
  await patch(id, { archive_status: "archived", archived_at: new Date().toISOString() });
}

export async function markNotified(id) {
  await patch(id, { notified_at: new Date().toISOString() });
}

/**
 * Rows whose Drive copy has been outstanding for longer than `hours`. The
 * queue guarantees retries; it does not guarantee anyone looks (§7.7 rec 2),
 * so the drain alerts on these rather than letting them age silently.
 */
export async function listStuckArchives(hours = 1) {
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await getSupabase()
    .from("p4p_upload_queue")
    .select("id, email, full_name, month_key, filename, received_at, archive_attempts")
    .eq("archive_status", "archive_pending")
    .lt("received_at", cutoff)
    .order("received_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`stuck-archive query error: ${error.message}`);
  return data ?? [];
}

export async function downloadObject(objectPath) {
  const { data, error } = await getSupabase().storage.from(BUCKET).download(objectPath);
  if (error) throw new Error(`storage download error (${objectPath}): ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

/**
 * The bucket is a transient drop box, not storage: the object goes as soon as
 * it has reached Drive (§11's retention posture). Best-effort — a failed
 * delete is a leftover object, not a failed submission.
 */
export async function deleteObject(objectPath) {
  const { error } = await getSupabase().storage.from(BUCKET).remove([objectPath]);
  if (error) console.warn(`│        ⚠️  storage delete failed (${objectPath}): ${error.message}`);
}
