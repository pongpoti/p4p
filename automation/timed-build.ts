/**
 * timed-build.ts
 *
 * Keeps workflow 2.2's SK03 files current during office hours. Pong,
 * 2026-11-12: the secretary works 08:00-16:00 Bangkok time and should always
 * see up-to-date results. 2.2's own cron (00:37 Bangkok) is started by GitHub
 * 3-7 hours late, and a scheduled run can be dropped, so the always-on relay
 * starts a full 2.2 run itself: a workflow_dispatch with no month, which
 * GitHub starts at once, like the ตรวจสอบ tab's one-month builds.
 *
 * Between 07:30 and 15:30 Bangkok time (a run takes 20-30 min, so the last
 * one is done before 16:00) it starts one when
 *   - no full build has started in the last 12 hours (the morning build when
 *     the nightly cron was dropped or has not come yet), or
 *   - a score was saved after the last full build started (p4p_score_saves:
 *     every emailed and LINE submission is saved through save_p4p_score) and
 *     the last full build started at least 60 minutes ago.
 * It waits until no LINE upload is still on its way to Drive (at most 30
 * min), so the build sees every file, and until the newest save is 5 minutes
 * old, so a burst of forms makes one build, not one per form; once the first
 * new save has waited 30 minutes it stops waiting for that quiet moment.
 * and never while any 2.2 run is queued or running, or a ตรวจสอบ tab request
 * is waiting (the tab goes first). So with no new forms there is no build,
 * and with a steady flow there is at most one an hour.
 *
 * A run is "full" when cron started it or its run-name is FULL_RUN_TITLE
 * (2.2's run-name gives one-month runs a different title). Quiet when its
 * credentials are missing, and never throws into the drain loop.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { BUILD_WORKFLOW, buildBusy, missingTable } from "./review-dispatch.js";

/** 2.2's run-name for a run over the latest 2 months (no `month` input). */
export const FULL_RUN_TITLE = "2.2 SK03 build: latest 2 months";

const BANGKOK_OFFSET_MS = 7 * 3600_000;           // UTC+7, no daylight saving
export const START_MINUTE = 7 * 60 + 30;          // 07:30 Bangkok
export const END_MINUTE   = 15 * 60 + 30;         // last start before 15:30
const CHECK_MS      = 2 * 60_000;
const FRESH_MS      = 12 * 3600_000;
const MIN_GAP_MS    = 60 * 60_000;
const SETTLE_MS     = 5 * 60_000;
const SETTLE_CAP_MS = 30 * 60_000;
/** A LINE upload this old without its Drive copy is stuck, not on its way. */
const ARCHIVE_WAIT_MS = 30 * 60_000;

/** Minutes since midnight, Bangkok time. */
export function bangkokMinute(now: number): number {
  return Math.floor(((now + BANGKOK_OFFSET_MS) % 86_400_000) / 60_000);
}

export function inBuildHours(now: number): boolean {
  const m = bangkokMinute(now);
  return m >= START_MINUTE && m < END_MINUTE;
}

export interface BuildState {
  /** When the newest full 2.2 run was started (ms), null when none is listed. */
  lastFullStart: number | null;
  /** The newest p4p_score_saves.saved_at (ms), null when unknown. */
  newestSave: number | null;
  /** The oldest save after lastFullStart (ms); null when not looked up. */
  oldestNewSave?: number | null;
  /** A LINE upload is still waiting for its Drive copy. */
  archiving: boolean;
}

/** Why a full build is due now, or null. Pure, so the rules are testable. */
export function timedBuildReason(now: number, s: BuildState): string | null {
  if (!inBuildHours(now) || s.archiving) return null;
  if (s.lastFullStart === null || now - s.lastFullStart >= FRESH_MS) return "no full build in the last 12 hours";
  if (s.newestSave === null || s.newestSave <= s.lastFullStart) return null;
  if (now - s.lastFullStart < MIN_GAP_MS) return null;
  const waitedLongEnough = s.oldestNewSave != null && now - s.oldestNewSave >= SETTLE_CAP_MS;
  if (now - s.newestSave < SETTLE_MS && !waitedLongEnough) return null;
  return "new scores since the last full build";
}

export interface RunInfo {
  event?: string | null;
  display_title?: string | null;
  status?: string | null;
  created_at?: string | null;
  run_started_at?: string | null;
}

export const isFullRun = (r: RunInfo): boolean => r.event === "schedule" || r.display_title === FULL_RUN_TITLE;

/** Start time of the newest full run, from a list of 2.2 runs. */
export function lastFullBuildStart(runs: RunInfo[]): number | null {
  let best: number | null = null;
  for (const r of runs) {
    if (!isFullRun(r)) continue;
    // A run that waited its turn starts later than it was created; the later
    // of the two is when it began reading the data.
    const t = Math.max(Date.parse(r.created_at ?? "") || 0, Date.parse(r.run_started_at ?? "") || 0);
    if (t > 0 && (best === null || t > best)) best = t;
  }
  return best;
}

let _supabase: SupabaseClient | null = null;
let disabled = false;
let lastCheck: number | null = null;
/** Never older than the truth, so skipping on it is always safe. */
let knownLastFull: number | null = null;
let lastDispatch: number | null = null;

function supabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  _supabase = createClient(url, key);
  return _supabase;
}

async function github(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
}

/** The newest save, or with `after` the oldest one after that time. */
async function scoreSave(db: SupabaseClient, after?: number): Promise<number | null> {
  let q = db.from("p4p_score_saves").select("saved_at");
  if (after !== undefined) q = q.gt("saved_at", new Date(after).toISOString());
  const { data, error } = await q.order("saved_at", { ascending: after !== undefined }).limit(1);
  if (error) {
    if (missingTable(error)) return null;
    throw new Error(`p4p_score_saves: ${error.message}`);
  }
  const t = Date.parse((data?.[0] as { saved_at?: string } | undefined)?.saved_at ?? "");
  return Number.isFinite(t) ? t : null;
}

/** Fills in oldestNewSave when only it can turn a "wait" into a "go". */
async function withOldestNewSave(db: SupabaseClient, now: number, s: BuildState): Promise<BuildState> {
  const settling = s.lastFullStart !== null && s.newestSave !== null && s.newestSave > s.lastFullStart && now - s.newestSave < SETTLE_MS;
  return settling ? { ...s, oldestNewSave: await scoreSave(db, s.lastFullStart!) } : s;
}

async function archiveWaiting(db: SupabaseClient, now: number): Promise<boolean> {
  const { data, error } = await db.from("p4p_upload_queue").select("id")
    .eq("archive_status", "archive_pending")
    .gt("received_at", new Date(now - ARCHIVE_WAIT_MS).toISOString())
    .limit(1);
  if (error) {
    if (missingTable(error)) return false;
    throw new Error(`p4p_upload_queue: ${error.message}`);
  }
  return !!data?.length;
}

async function tabRequestWaiting(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.from("review_requests").select("id").eq("status", "queued").limit(1);
  if (error) {
    if (missingTable(error)) return false;
    throw new Error(`review_requests: ${error.message}`);
  }
  return !!data?.length;
}

/** Starts a full 2.2 run when one is due. True when it started one. */
export async function dispatchTimedBuild(now: number = Date.now()): Promise<boolean> {
  if (disabled || !inBuildHours(now)) return false;
  if (lastCheck !== null && now - lastCheck < CHECK_MS) return false;
  lastCheck = now;
  const db = supabase();
  if (!db || !process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY || process.env.TIMED_BUILDS === "0") {
    disabled = true;
    console.log("│  ℹ️  Office-hours SK03 builds: off" + (process.env.TIMED_BUILDS === "0" ? " (TIMED_BUILDS=0)" : " (needs SUPABASE_*, GH_TOKEN, GITHUB_REPOSITORY)"));
    return false;
  }
  try {
    let state: BuildState = {
      lastFullStart: knownLastFull,
      newestSave: await scoreSave(db),
      archiving: await archiveWaiting(db, now),
    };
    // Skip on what this run already knows: the newest full start is only
    // ever later than knownLastFull, and a later one never turns a "no" into
    // a "yes", so GitHub is asked only when a build may be due.
    if (knownLastFull !== null && !timedBuildReason(now, await withOldestNewSave(db, now, state))) return false;

    const runsRes = await github(`/actions/workflows/${BUILD_WORKFLOW}/runs?per_page=30`);
    if (!runsRes.ok) throw new Error(`list runs: HTTP ${runsRes.status}`);
    const runs = ((await runsRes.json()) as { workflow_runs?: RunInfo[] }).workflow_runs ?? [];
    const listed = lastFullBuildStart(runs);
    // A run started a moment ago may not be listed yet.
    knownLastFull = Math.max(listed ?? 0, lastDispatch ?? 0) || null;
    state = await withOldestNewSave(db, now, { ...state, lastFullStart: knownLastFull });
    const reason = timedBuildReason(now, state);
    if (!reason || buildBusy(runs) || await tabRequestWaiting(db)) return false;

    const res = await github(`/actions/workflows/${BUILD_WORKFLOW}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: "main" }),
    });
    if (res.status !== 204) throw new Error(`start 2.2: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    lastDispatch = knownLastFull = now;
    console.log(`│  🕗  Office-hours SK03 build: started 2.2 for the latest 2 months (${reason})`);
    return true;
  } catch (err) {
    console.error(`│  ❌  Office-hours SK03 build: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Tests only: forget what this run has seen. */
export function resetTimedBuildForTests(): void {
  _supabase = null; disabled = false; lastCheck = null; knownLastFull = null; lastDispatch = null;
}
