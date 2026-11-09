/**
 * review-dispatch.ts
 *
 * The dashboard's ตรวจสอบ tab asks for "build this month now" (the
 * สร้างไฟล์ใหม่ button, or a changed budget, or a score edited in the tab) by adding a row to
 * review_requests (scripts/review-tab-2026-11.sql). Vercel has no GitHub
 * token, so the always-on relay picks the request up here and starts
 * workflow 2.2 for that month with this run's own GITHUB_TOKEN. 2.2 then
 * marks the request running → done/failed itself (process/review-build.ts).
 *
 * One build at a time: nothing is started while any 2.2 run is queued or
 * running (the nightly one included), so 2.2's concurrency group never has
 * two runs waiting, which would cancel one of them.
 *
 * The same loop starts workflow 2.8 (process/review-pdf.ts) when the auditor
 * has approved a month and its approval PDF is waiting; 2.8 claims the round
 * itself (claim_review_pdf), so a lost dispatch is simply tried again.
 *
 * Quiet until the review tables exist, and never throws into the drain loop.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const BUILD_WORKFLOW = "2-2-nightly-build-sk03-and-notify-heads.yml";
export const PDF_WORKFLOW = "2-8-on-request-build-review-approval-pdf.yml";
/** A PDF claim this old means the 2.8 run died; claim_review_pdf takes it again. */
const PDF_STALE_MS = 20 * 60_000;
const CHECK_MS = 30_000;
const MAX_ATTEMPTS = 3;

/** Is a look at review_requests due? Pure, so the timing rule is testable. */
export function reviewCheckDue(now: number, lastAt: number | null, intervalMs: number = CHECK_MS): boolean {
  if (!(intervalMs > 0)) return false;
  return lastAt === null || now - lastAt >= intervalMs;
}

/** Is any run of the workflow still waiting or working? `runs` newest first. */
export function buildBusy(runs: { status?: string | null }[]): boolean {
  return runs.some((r) => r.status != null && r.status !== "completed");
}

let _supabase: SupabaseClient | null = null;
let disabled = false;
let warned = false;
let pdfDisabled = false;
let pdfNextTry = 0;

function supabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  _supabase = createClient(url, key);
  return _supabase;
}

/**
 * The review tables, columns or functions are not installed: only a definite
 * "not there" answer, by its code. Anything else, PGRST002 ("Could not query
 * the database for the schema cache. Retrying." while PostgREST or the
 * database restarts), PGRST000/001, a 5xx page or a network error, is passing
 * and takes the normal retry path instead of turning the relay off for the run.
 */
const NOT_INSTALLED = new Set([
  "PGRST205",  // table not in the schema cache
  "PGRST202",  // function not in the schema cache
  "42P01",     // undefined table
  "42883",     // undefined function
  "42703",     // undefined column (the part-3 columns)
]);
export const missingTable = (e: { code?: string | null; message?: string } | null | undefined): boolean =>
  !!e && NOT_INSTALLED.has(String(e.code ?? ""));

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

/** Starts at most one requested build. True when it started one. */
export async function dispatchReviewBuild(): Promise<boolean> {
  if (disabled) return false;
  const db = supabase();
  if (!db || !process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY) {
    if (!warned) { warned = true; console.log("│  ℹ️  ตรวจสอบ tab builds: off (needs SUPABASE_*, GH_TOKEN, GITHUB_REPOSITORY)"); }
    disabled = true;
    return false;
  }
  try {
    // Cheap look first: GitHub is only asked when someone is waiting.
    const { data: waiting, error: peekErr } = await db.from("review_requests").select("id").eq("status", "queued").limit(1);
    if (peekErr) {
      if (missingTable(peekErr)) { disabled = true; console.log("│  ℹ️  ตรวจสอบ tab builds: off (review tables not installed yet)"); return false; }
      throw new Error(peekErr.message);
    }
    if (!waiting?.length) return false;

    const runsRes = await github(`/actions/workflows/${BUILD_WORKFLOW}/runs?per_page=10`);
    if (!runsRes.ok) throw new Error(`list runs: HTTP ${runsRes.status}`);
    const runs = ((await runsRes.json()) as { workflow_runs?: { status?: string }[] }).workflow_runs ?? [];
    if (buildBusy(runs)) return false;

    const { data: claimed, error: claimErr } = await db.rpc("claim_review_request");
    if (claimErr) throw new Error(`claim_review_request: ${claimErr.message}`);
    const row = (Array.isArray(claimed) ? claimed[0] : claimed) as { id: number; month: string; attempts: number } | null;
    if (!row?.id) return false;

    const res = await github(`/actions/workflows/${BUILD_WORKFLOW}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: "main", inputs: { month: row.month, request_id: String(row.id) } }),
    });
    if (res.status === 204) {
      console.log(`│  🧾  ตรวจสอบ tab: started the ${row.month} build (request ${row.id})`);
      return true;
    }
    const why = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
    const retry = row.attempts < MAX_ATTEMPTS;
    console.error(`│  ❌  ตรวจสอบ tab: could not start the ${row.month} build: ${why}${retry ? " — will retry" : ""}`);
    await db.from("review_requests").update(retry
      ? { status: "queued", dispatched_at: null }
      : { status: "failed", finished_at: new Date().toISOString(), error: `เริ่มสร้างไฟล์ไม่ได้ (${why})`.slice(0, 500) },
    ).eq("id", row.id);
    return false;
  } catch (err) {
    console.error(`│  ❌  ตรวจสอบ tab dispatcher: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Starts workflow 2.8 when an approved month's PDF is waiting. True when it did. */
export async function dispatchReviewPdf(now: number = Date.now()): Promise<boolean> {
  if (disabled || pdfDisabled || now < pdfNextTry) return false;
  const db = supabase();
  if (!db || !process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY) return false;
  try {
    const stale = new Date(now - PDF_STALE_MS).toISOString();
    const { data: waiting, error } = await db.from("review_rounds").select("id")
      .eq("status", "approved")
      .or(`pdf_status.eq.queued,and(pdf_status.eq.building,pdf_claimed_at.lt.${stale})`)
      .limit(1);
    if (error) {
      // 42703 here: the part-3 columns are not there yet.
      if (missingTable(error)) { pdfDisabled = true; console.log("│  ℹ️  ตรวจสอบ tab PDFs: off (part 3 of the review SQL not installed yet)"); return false; }
      throw new Error(error.message);
    }
    if (!waiting?.length) return false;

    const runsRes = await github(`/actions/workflows/${PDF_WORKFLOW}/runs?per_page=5`);
    if (!runsRes.ok) throw new Error(`list runs: HTTP ${runsRes.status}`);
    const runs = ((await runsRes.json()) as { workflow_runs?: { status?: string }[] }).workflow_runs ?? [];
    if (buildBusy(runs)) return false;

    const res = await github(`/actions/workflows/${PDF_WORKFLOW}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: "main" }),
    });
    if (res.status === 204) {
      console.log("│  🧾  ตรวจสอบ tab: started the approval PDF run");
      pdfNextTry = now + 60_000;   // give the run a minute to show up as queued
      return true;
    }
    throw new Error(`start 2.8: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    pdfNextTry = now + 5 * 60_000;
    console.error(`│  ❌  ตรวจสอบ tab PDF dispatcher: ${err instanceof Error ? err.message : String(err)} — trying again in 5 min`);
    return false;
  }
}
