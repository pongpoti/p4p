/**
 * The nightly 2.2 job (process/preprocess-drive.ts, process/process.ts and
 * the merge.py it runs) and the every-minute 2.1 report write to the public
 * Actions log of this public repository. A Drive file, and the merged sheet
 * made from it, is named after its physician, so no log line may carry a
 * file's or a roster row's name: counts, positions, Drive file ids and
 * roster row numbers only. Static checks, so a later edit that logs a name
 * again fails here.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8")

/** Each log statement in a TS file: from `log(` or `console.x(` to the end of its line. */
function logLines(source) {
  return source.split("\n").filter((l) => /\blog\(|console\.(log|warn|error)\(/.test(l))
}

test("process.ts logs no physician or file name", () => {
  for (const line of logLines(read("process/process.ts"))) {
    assert.doesNotMatch(line, /origName|nameKey|\.fullname|\.firstname|\.lastname|normName|"\$\{n\}"|"\$\{s[12]\[i\]\}"/, line.trim())
  }
})

test("preprocess-drive.ts logs no file name", () => {
  for (const line of logLines(read("process/preprocess-drive.ts"))) {
    assert.doesNotMatch(line, /\$\{name\}|\.name\b|fullname/, line.trim())
  }
})

test("merge.py prints sheets and files by number only", () => {
  const prints = read("process/merge.py").split("\n").filter((l) => /\bprint\(/.test(l))
  assert.ok(prints.length > 0)
  for (const line of prints) {
    assert.doesNotMatch(line, /ws\.title|sheet_name|src_path|\{e\}/, line.trim())
  }
})
