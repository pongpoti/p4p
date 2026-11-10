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

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "p4p-uploads";

let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY in .env");
  _supabase = createClient(url, key);
  return _supabase;
}

export interface ArchiveQueueRow {
  id: string;
  filename: string;
  month_key: string;
  full_name: string;
  email: string;
  department: string | null;
  roster_index: number | string | null;
  line_user_id: string;
  object_path: string;
  received_at: string;
  archive_attempts: number;
  /** 'done' once a score is saved — by /upload/score or the score fallback. */
  status: string;
  /** The saved score; numeric in Postgres, so it may arrive as a string. */
  score: number | string | null;
}

export interface ScoreFallbackQueueRow extends ArchiveQueueRow {
  attempts: number;
}

export interface StuckArchiveRow {
  id: string;
  email: string;
  full_name: string;
  month_key: string;
  filename: string;
  received_at: string;
  archive_attempts: number;
}

/**
 * Both claim functions `returns setof`, so "nothing to do" is a genuinely
 * empty result set rather than one row of nulls — see the SQL file's Part 5
 * comment for why that distinction cost a bug once already.
 */
async function claim<T>(fn: string): Promise<T | null> {
  const { data, error } = await getSupabase().rpc(fn);
  if (error) throw new Error(`${fn} RPC error: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0] as T;
}

export const claimArchive       = () => claim<ArchiveQueueRow>("claim_p4p_archive");
export const claimScoreFallback = () => claim<ScoreFallbackQueueRow>("claim_p4p_score_fallback");

async function patch(id: string, fields: Record<string, unknown>): Promise<void> {
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
export async function completeScored(
  id: string,
  { score, scoreMethod, archived }: { score: number; scoreMethod?: string | null; archived: boolean }
): Promise<void> {
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
export async function failScored(
  id: string,
  { errorType, errorDetail, attempts }: { errorType?: string | null; errorDetail?: unknown; attempts?: number }
): Promise<boolean> {
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
export async function rejectScored(
  id: string,
  { errorType, errorDetail }: { errorType?: string | null; errorDetail?: unknown }
): Promise<void> {
  await patch(id, {
    status: "rejected",
    error_type: errorType ?? "other",
    error_detail: errorDetail ? String(errorDetail).slice(0, 2000) : null,
    finished_at: new Date().toISOString(),
  });
}

export async function markArchived(id: string): Promise<void> {
  await patch(id, { archive_status: "archived", archived_at: new Date().toISOString() });
}

export async function markNotified(id: string): Promise<void> {
  await patch(id, { notified_at: new Date().toISOString() });
}

/**
 * Rows whose Drive copy has been outstanding for longer than `hours`. The
 * queue guarantees retries; it does not guarantee anyone looks (§7.7 rec 2),
 * so the drain alerts on these rather than letting them age silently.
 */
export async function listStuckArchives(hours = 1): Promise<StuckArchiveRow[]> {
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await getSupabase()
    .from("p4p_upload_queue")
    .select("id, email, full_name, month_key, filename, received_at, archive_attempts")
    .eq("archive_status", "archive_pending")
    .lt("received_at", cutoff)
    .order("received_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`stuck-archive query error: ${error.message}`);
  return (data ?? []) as StuckArchiveRow[];
}

export async function downloadObject(objectPath: string): Promise<Buffer> {
  const { data, error } = await getSupabase().storage.from(BUCKET).download(objectPath);
  // No object path in the message: it starts with the uploader's account id, and it reaches the public log.
  if (error) throw new Error(`storage download error: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

export interface LeftoverObjectRow {
  id: string;
  object_path: string;
}

/**
 * Rows that will never be claimed again but may still hold their uploaded
 * object: superseded by a newer upload for the same month (audit F17), or
 * failed as stuck in processing (F09). Both are set inside the claim
 * functions, in SQL, where no object can be deleted. object_deleted_at
 * (scripts/audit-fixes-2026-11.sql PART 3) says which are done; a read error
 * (that column not there yet, say) throws.
 */
export async function listLeftoverObjects(limit = 50): Promise<LeftoverObjectRow[]> {
  const { data, error } = await getSupabase()
    .from("p4p_upload_queue")
    .select("id, object_path")
    .is("object_deleted_at", null)
    .or("archive_status.eq.superseded,and(status.eq.failed,error_type.eq.stuck_processing)")
    .order("received_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`leftover-object query error: ${error.message}`);
  return (data ?? []) as LeftoverObjectRow[];
}

/**
 * Delete these rows' objects, then stamp object_deleted_at on them. Unlike
 * deleteObject this throws, so a row is stamped only once its object is gone
 * (removing an object that is already gone is not an error).
 */
export async function removeLeftoverObjects(rows: LeftoverObjectRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await getSupabase().storage.from(BUCKET).remove(rows.map((r) => r.object_path));
  if (error) throw new Error(`storage delete error: ${error.message}`);
  const { error: stampError } = await getSupabase()
    .from("p4p_upload_queue")
    .update({ object_deleted_at: new Date().toISOString() })
    .in("id", rows.map((r) => r.id));
  if (stampError) throw new Error(`p4p_upload_queue update error: ${stampError.message}`);
}

/**
 * The bucket is a transient drop box, not storage: the object goes as soon as
 * it has reached Drive (§11's retention posture). Best-effort — a failed
 * delete is a leftover object, not a failed submission.
 */
export async function deleteObject(objectPath: string): Promise<void> {
  const { error } = await getSupabase().storage.from(BUCKET).remove([objectPath]);
  if (error) console.warn(`│        ⚠️  storage delete failed: ${error.message}`);
}
