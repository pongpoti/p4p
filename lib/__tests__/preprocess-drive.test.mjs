/**
 * The nightly Drive cleanup (process/preprocess-drive.ts) trashes files that
 * match no roster row. It must never trash on a roster read that came back
 * empty, and must refuse when the misses are too many to be stray files.
 * Skips when process/'s dependencies are not installed.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
let pre = null
try {
  pre = require(resolve(repoRoot, "process/preprocess-drive"))
} catch {
  pre = null
}
const skip = pre ? false : "process/ dependencies not installed"

/** A Drive stand-in that records every file it is asked to trash. */
function fakeDrive() {
  const trashed = []
  return {
    trashed,
    files: { update: async ({ fileId, requestBody }) => { if (requestBody.trashed) trashed.push(fileId) } },
  }
}

/** A Supabase stand-in whose month table read returns `result`. */
const fakeSupabase = (result) => ({ from: () => ({ select: async () => result }) })

const files = (...names) => names.map((name, i) => ({ id: "f" + i, name: name + ".xlsx" }))

test("an empty or failed roster read is unknown, never 'everything is unrelated'", { skip }, async () => {
  assert.equal(await pre.getSupabaseNames(fakeSupabase({ data: [], error: null }), "2569_10"), null)
  assert.equal(await pre.getSupabaseNames(fakeSupabase({ data: null, error: null }), "2569_10"), null)
  assert.equal(await pre.getSupabaseNames(fakeSupabase({ data: null, error: { message: "missing" } }), "2569_10"), null)
  assert.deepEqual(
    await pre.getSupabaseNames(fakeSupabase({ data: [{ firstname: "Test", lastname: "Doctor" }], error: null }), "2569_10"),
    ["test doctor"]
  )

  const drive = fakeDrive()
  const folder = files("Alpha One", "Beta Two", "Gamma Three")
  for (const names of [null, []]) {
    const r = await pre.trashUnrelated(drive, folder, names)
    assert.deepEqual(r, { kept: folder, trashed: 0 })
  }
  assert.deepEqual(drive.trashed, [])
})

test("a stray file or two is trashed", { skip }, async () => {
  const drive = fakeDrive()
  const roster = ["alpha one", "beta two", "gamma three", "delta four", "epsilon five", "zeta six", "eta seven", "theta eight", "iota nine"]
  const folder = files("Alpha One", "Beta Two", "Gamma Three", "Delta Four", "Epsilon Five", "Zeta Six", "Eta Seven", "Theta Eight", "Iota Nine", "old copy")
  const r = await pre.trashUnrelated(drive, folder, roster)
  assert.equal(r.trashed, 1)
  assert.equal(r.kept.length, 9)
  assert.deepEqual(drive.trashed, ["f9"])
})

test("more than 3 files or 20% of the folder: nothing is trashed", { skip }, async () => {
  // 4 of 30 unrelated: over the 3-file cap.
  const roster = Array.from({ length: 26 }, (_, i) => "doctor " + i)
  const many = files(...roster.map((n) => n.toUpperCase()), "x1", "x2", "x3", "x4")
  const d1 = fakeDrive()
  assert.deepEqual(await pre.trashUnrelated(d1, many, roster), { kept: many, trashed: 0 })
  assert.deepEqual(d1.trashed, [])

  // 2 of 5 unrelated: over 20%.
  const small = files("Doctor 0", "Doctor 1", "Doctor 2", "y1", "y2")
  const d2 = fakeDrive()
  assert.deepEqual(await pre.trashUnrelated(d2, small, roster), { kept: small, trashed: 0 })
  assert.deepEqual(d2.trashed, [])

  // A roster that matches nothing at all (the wrong table, a renamed column).
  const d3 = fakeDrive()
  assert.deepEqual(await pre.trashUnrelated(d3, small, ["someone else"]), { kept: small, trashed: 0 })
  assert.deepEqual(d3.trashed, [])

  // Exactly 3 of 15 (20%) is still within both limits.
  const edge = files(...roster.slice(0, 12), "z1", "z2", "z3")
  const d4 = fakeDrive()
  assert.equal((await pre.trashUnrelated(d4, edge, roster)).trashed, 3)
})
