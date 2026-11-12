import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  bangkokMinute, inBuildHours, timedBuildReason, lastFullBuildStart, isFullRun,
  dispatchTimedBuild, resetTimedBuildForTests, FULL_RUN_TITLE, type BuildState,
} from "../timed-build.js";
import { BUILD_WORKFLOW } from "../review-dispatch.js";

const workflows = resolve(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows");
const MIN = 60_000;
const HOUR = 60 * MIN;
/** 2026-11-12 at hh:mm Bangkok time, in ms. */
const bkk = (hh: number, mm = 0): number => Date.UTC(2026, 10, 12, hh - 7, mm);

test("office hours are 07:30 to 15:30 Bangkok time", () => {
  assert.equal(bangkokMinute(Date.UTC(2026, 10, 12, 0, 30)), 7 * 60 + 30, "00:30 UTC is 07:30 Bangkok");
  assert.equal(inBuildHours(bkk(7, 29)), false);
  assert.equal(inBuildHours(bkk(7, 30)), true);
  assert.equal(inBuildHours(bkk(12, 0)), true);
  assert.equal(inBuildHours(bkk(15, 29)), true);
  assert.equal(inBuildHours(bkk(15, 30)), false, "a run started now would end after 16:00");
  assert.equal(inBuildHours(bkk(0, 37)), false, "the night is the cron's");
  assert.equal(inBuildHours(Date.UTC(2026, 10, 12, 17, 0)), false, "00:00 Bangkok");
});

test("builds in the morning only when no full build ran in the last 12 hours", () => {
  const quiet = (lastFullStart: number | null): BuildState => ({ lastFullStart, newestSave: bkk(1), archiving: false });
  assert.equal(timedBuildReason(bkk(7, 30), quiet(bkk(5, 31))), null, "tonight's cron already ran");
  assert.match(timedBuildReason(bkk(7, 30), quiet(bkk(15, 30) - 24 * HOUR)) ?? "", /12 hours/, "cron dropped or still hours late");
  assert.match(timedBuildReason(bkk(7, 30), quiet(null)) ?? "", /12 hours/);
  assert.equal(timedBuildReason(bkk(7, 0), quiet(null)), null, "not before 07:30");
});

test("builds for new scores at most once an hour, once the uploads have settled", () => {
  const last = bkk(9, 0);
  const s = (newestSave: number | null, archiving = false, oldestNewSave?: number): BuildState =>
    ({ lastFullStart: last, newestSave, archiving, oldestNewSave });
  assert.equal(timedBuildReason(bkk(10, 30), s(bkk(8, 50))), null, "nothing new since the last build");
  assert.equal(timedBuildReason(bkk(10, 30), s(null)), null, "save times unknown: wait for the night");
  assert.equal(timedBuildReason(bkk(9, 40), s(bkk(9, 10))), null, "less than an hour since the last build");
  assert.match(timedBuildReason(bkk(10, 0), s(bkk(9, 10))) ?? "", /new scores/, "an hour on, a save is waiting");
  assert.equal(timedBuildReason(bkk(10, 0), s(bkk(9, 58))), null, "a save 2 min ago: more may be coming");
  assert.match(timedBuildReason(bkk(10, 3), s(bkk(9, 58))) ?? "", /new scores/, "5 quiet minutes on, it goes");
  assert.equal(timedBuildReason(bkk(10, 30), s(bkk(9, 10), true)), null, "a LINE upload still on its way to Drive");
  assert.equal(timedBuildReason(bkk(10, 0), s(bkk(9, 59), false, bkk(9, 40))), null, "forms keep coming, the first waited 20 min");
  assert.match(timedBuildReason(bkk(10, 10), s(bkk(10, 9), false, bkk(9, 40))) ?? "", /new scores/, "30 min on, it stops waiting for a quiet moment");
  assert.equal(timedBuildReason(bkk(9, 0) + 13 * HOUR, s(null, true)), null, "an upload on its way holds even the morning build (for at most 30 min)");
});

test("a full run is a cron run or one titled for the latest 2 months", () => {
  const runs = [
    { event: "workflow_dispatch", display_title: "2.2 SK03 build: 2569_08 only", created_at: "2026-11-12T05:00:00Z" },
    { event: "workflow_dispatch", display_title: FULL_RUN_TITLE, created_at: "2026-11-12T03:00:00Z", run_started_at: "2026-11-12T03:20:00Z" },
    { event: "schedule", display_title: "2.2 Nightly: build SK03 files and notify department heads", created_at: "2026-11-11T23:41:27Z" },
    // Before run-name: a dispatch could be one month, so it never counts.
    { event: "workflow_dispatch", display_title: "2.2 Nightly: build SK03 files and notify department heads", created_at: "2026-11-12T04:00:00Z" },
  ];
  assert.deepEqual(runs.map(isFullRun), [false, true, true, false]);
  assert.equal(lastFullBuildStart(runs), Date.parse("2026-11-12T03:20:00Z"), "a run that waited its turn counts from when it started");
  assert.equal(lastFullBuildStart(runs.slice(0, 1)), null);
  assert.equal(lastFullBuildStart([]), null);
});

test("2.2's run-name gives full runs the title the relay looks for", () => {
  const yml = readFileSync(resolve(workflows, BUILD_WORKFLOW), "utf8");
  const runName = /^run-name:\s*(.+)$/m.exec(yml)?.[1] ?? "";
  assert.ok(runName.includes(`'${FULL_RUN_TITLE}'`), runName);
  assert.match(runName, /inputs\.month && format\('[^']*\{0\}[^']*', inputs\.month\)/, "one-month runs get their own title");
  assert.doesNotMatch(runName.replace(`'${FULL_RUN_TITLE}'`, ""), new RegExp(FULL_RUN_TITLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "only full runs carry the full title");
});

/**
 * A working day replayed through the same rules: forms arrive at the given
 * times, a started build takes 25 min, and nothing starts while one runs.
 * Returns each build's start, and for every form the minutes until a build
 * that read it had finished.
 */
function simulateDay(saves: number[], nightly: number | null, checkEvery = 2 * MIN, buildTakes = 25 * MIN) {
  const starts: number[] = [];
  let lastFull = nightly;
  let busyUntil = nightly === null ? 0 : nightly + buildTakes;
  for (let now = bkk(7, 0); now <= bkk(16, 0); now += checkEvery) {
    if (now < busyUntil) continue;
    const seen = saves.filter((t) => t <= now);
    const fresh = seen.filter((t) => lastFull === null || t > lastFull);
    const state: BuildState = {
      lastFullStart: lastFull, newestSave: seen.length ? Math.max(...seen) : null, archiving: false,
      oldestNewSave: fresh.length ? Math.min(...fresh) : null,
    };
    if (timedBuildReason(now, state)) { starts.push(now); lastFull = now; busyUntil = now + buildTakes; }
  }
  const waits = saves.map((t) => {
    const s = starts.find((x) => x >= t);
    return s === undefined ? Infinity : (s + buildTakes - t) / MIN;
  });
  return { starts, waits };
}

test("a quiet day costs no builds; a busy one about one an hour", () => {
  // No forms all day, the cron ran at 05:31: nothing to do.
  assert.equal(simulateDay([], bkk(5, 31)).starts.length, 0);
  // Same, but the cron was dropped: one morning build, done by about 07:56.
  assert.deepEqual(simulateDay([], null).starts, [bkk(7, 30)]);

  // A form every 10 minutes from 08:00 to 15:20.
  const steady: number[] = [];
  for (let t = bkk(8, 0); t <= bkk(15, 20); t += 10 * MIN) steady.push(t);
  const { starts, waits } = simulateDay(steady, bkk(5, 31));
  assert.ok(starts.length <= 8, `${starts.length} builds`);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= HOUR, "never two within an hour");
  const before1520 = waits.filter((_, i) => steady[i] <= bkk(14, 0));
  assert.ok(Math.max(...before1520) <= 2 * 60, `a form waits at most ${Math.max(...before1520)} min for a finished build`);

  // A burst of 30 forms in half an hour: one build.
  const burst = Array.from({ length: 30 }, (_, i) => bkk(9, i));
  assert.deepEqual(simulateDay(burst, bkk(5, 31)).starts, [bkk(9, 30)], "built once the first form had waited 30 min");

  // A few forms: each one shows within about half an hour.
  const few = simulateDay([bkk(9, 12), bkk(11, 40), bkk(14, 5)], bkk(5, 31));
  assert.equal(few.starts.length, 3);
  assert.ok(Math.max(...few.waits) <= 32, `${Math.max(...few.waits)} min`);
});

// ── The relay call itself, against fake GitHub and Supabase answers ───────
interface World {
  newestSave: string | null;
  archiving: boolean;
  tabWaiting: boolean;
  runs: Array<Record<string, string>>;
  dispatched: unknown[];
  calls: string[];
}

function fakeFetch(world: World): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    world.calls.push(url.replace(/\?.*/, ""));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/rest/v1/p4p_score_saves")) return json(world.newestSave ? [{ saved_at: world.newestSave }] : []);
    if (url.includes("/rest/v1/p4p_upload_queue")) return json(world.archiving ? [{ id: "q1" }] : []);
    if (url.includes("/rest/v1/review_requests")) return json(world.tabWaiting ? [{ id: 7 }] : []);
    if (url.endsWith(`/actions/workflows/${BUILD_WORKFLOW}/runs?per_page=30`)) return json({ workflow_runs: world.runs });
    if (url.endsWith(`/actions/workflows/${BUILD_WORKFLOW}/dispatches`) && init?.method === "POST") {
      world.dispatched.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    return json({ message: "unexpected " + url }, 404);
  }) as typeof fetch;
}

test("the relay starts a full 2.2 run when due, and only then", async () => {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  const world: World = {
    newestSave: new Date(bkk(9, 10)).toISOString(), archiving: false, tabWaiting: false,
    runs: [{ event: "schedule", display_title: "x", status: "completed", created_at: new Date(bkk(5, 31)).toISOString() }],
    dispatched: [], calls: [],
  };
  globalThis.fetch = fakeFetch(world);
  Object.assign(process.env, { SUPABASE_URL: "http://supabase.test", SUPABASE_KEY: "k", GH_TOKEN: "t", GITHUB_REPOSITORY: "example/p4p", TIMED_BUILDS: "" });
  resetTimedBuildForTests();
  try {
    // Outside office hours: not even a look.
    assert.equal(await dispatchTimedBuild(bkk(6, 0)), false);
    assert.equal(world.calls.length, 0);

    // A ตรวจสอบ tab request is waiting: it goes first.
    world.tabWaiting = true;
    assert.equal(await dispatchTimedBuild(bkk(10, 0)), false);
    assert.equal(world.dispatched.length, 0);

    // A one-month run is going: wait for it.
    world.tabWaiting = false;
    world.runs.unshift({ event: "workflow_dispatch", display_title: "2.2 SK03 build: 2569_08 only", status: "in_progress", created_at: new Date(bkk(9, 55)).toISOString() });
    assert.equal(await dispatchTimedBuild(bkk(10, 1)), false, "checks every 2 min, not every 30 s");
    assert.equal(await dispatchTimedBuild(bkk(10, 2)), false);
    assert.equal(world.dispatched.length, 0);

    // It finished: start the full run, with no month.
    world.runs[0].status = "completed";
    assert.equal(await dispatchTimedBuild(bkk(10, 4)), true);
    assert.deepEqual(world.dispatched, [{ ref: "main" }]);

    // GitHub has not listed the new run yet: no second start.
    world.newestSave = new Date(bkk(10, 5)).toISOString();
    world.calls.length = 0;
    assert.equal(await dispatchTimedBuild(bkk(10, 20)), false);
    assert.equal(world.dispatched.length, 1);
    assert.ok(!world.calls.some((u) => u.includes("api.github.com")), "an hour has not passed: GitHub is not even asked");

    // An hour on, the 10:05 save gets its build.
    world.runs.unshift({ event: "workflow_dispatch", display_title: FULL_RUN_TITLE, status: "completed", created_at: new Date(bkk(10, 4)).toISOString() });
    assert.equal(await dispatchTimedBuild(bkk(11, 4)), true);
    assert.equal(world.dispatched.length, 2);

    // TIMED_BUILDS=0 turns it off.
    resetTimedBuildForTests();
    process.env.TIMED_BUILDS = "0";
    world.calls.length = 0;
    assert.equal(await dispatchTimedBuild(bkk(13, 0)), false);
    assert.equal(world.calls.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    process.env = env;
    resetTimedBuildForTests();
  }
});
