/**
 * Anti-drift guard for the two copies of the scoring functions.
 *
 * C8 keeps `automation/` and the root as isolated sub-projects (separate
 * package.json, separate module format), so `/upload/score` cannot import
 * `automation/claude-analyst.js` — it carries a vendored copy in
 * `lib/p4p-score.js` instead. `web/lib/__tests__/parity.test.ts` already
 * establishes what this repo does about that situation: duplicate the code,
 * then fail the build loudly the moment the copies diverge.
 *
 * Two independent checks, because either alone can pass while the pair is
 * broken:
 *   • TEXT — the function bodies must still be the same code, whitespace,
 *     comments and semicolons aside. Catches a fix landing in one file only.
 *   • BEHAVIOUR — both implementations must return the same {score, method}
 *     for the same rows. Catches a divergence the text comparison would
 *     tolerate (e.g. a constant edited in one copy).
 *
 * The behavioural half needs automation/'s dependency tree installed (its
 * module imports @anthropic-ai/sdk at the top). Where that is missing the
 * test says so and skips rather than failing for an unrelated reason — the
 * textual half still runs, and it is the one that catches drift.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "../..")
const require = createRequire(import.meta.url)

const vendored = require(resolve(repoRoot, "lib/p4p-score.js"))
const canonicalSource = readFileSync(resolve(repoRoot, "automation/claude-analyst.js"), "utf8")
const vendoredSource = readFileSync(resolve(repoRoot, "lib/p4p-score.js"), "utf8")

/**
 * Compare code, not formatting: the two files follow their own project's
 * house style (automation/ uses semicolons, the root does not), and comments
 * are deliberately not identical — the vendored copy explains that it IS a
 * copy. Anything that survives this normalisation is real logic.
 */
function normalise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")     // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1") // line comments (not "://")
    .replace(/\bexport\s+/g, "")          // ESM export keyword
    // Single-parameter arrow parens: `t => …` and `(t) => …` are the same
    // code, and each project's formatter has its own opinion. Normalising
    // this keeps the guard from firing on `npm run format`.
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/g, "$1=>")
    .replace(/;/g, "")
    .replace(/\s+/g, "")
}

/**
 * Pull one top-level declaration out of a source file by delimiter matching.
 * Deliberately not a regex over the whole body: these functions contain
 * braces in strings and regexes, and a greedy match would take the rest of
 * the file.
 */
function extractDeclaration(src, name) {
  const fn = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`).exec(src)
  const cn = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*`).exec(src)

  let start, open, closer
  if (fn) {
    start = fn.index
    // The body's "{", not the parameter list's "(" — skip past the params.
    open = src.indexOf("{", src.indexOf(")", start))
    closer = "}"
  } else if (cn) {
    start = cn.index
    open = cn.index + cn[0].length
    const first = src[open]
    if (first === "[") closer = "]"
    else if (first === "{") closer = "}"
    else throw new Error(`\`${name}\` is not an array/object literal — teach this helper how to read it`)
  } else {
    throw new Error(`could not find a declaration of \`${name}\``)
  }
  if (open === -1) throw new Error(`\`${name}\` has no body`)

  const opener = closer === "]" ? "[" : "{"
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === opener) depth++
    else if (ch === closer) {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced ${opener}${closer} while reading \`${name}\``)
}

// Everything the vendored copy claims to mirror. Adding a function to
// lib/p4p-score.js that exists in automation/ means adding it here too.
const MIRRORED = [
  "extractScoreFromRows",
  "resolveScore",
  "resolveBeYear",
  "resolveBeYearFromRows",
  "resolveBeMonth",
  "resolveBeMonthFromRows",
  "monthYearFromText",
  "monthYearFromRows",
  "sheetMatchScore",
  "summaryTextCandidates",
  "collectCandidates",
  "findScoreColumn",
  "declaredScore",
  "reconstructFromDailyCells",
  "findHeaderRow",
  "numsFromText",
  "toNum",
  "isYearLike",
  "GRAND_TOTAL_LABELS",
  "SUBTOTAL_LABELS",
  "SCORE_COLUMN_LABELS",
]

for (const name of MIRRORED) {
  test(`lib/p4p-score.js's ${name} is identical to automation/claude-analyst.js's`, () => {
    assert.equal(
      normalise(extractDeclaration(vendoredSource, name)),
      normalise(extractDeclaration(canonicalSource, name)),
      `${name} has drifted between the two copies — fix BOTH, or the ` +
      `synchronous /upload/score path and the queued worker will score the ` +
      `same file differently`
    )
  })
}

// ── Behavioural parity ────────────────────────────────────────────────────
// Row fixtures covering every branch resolveScore() can land on, since the
// confidence gate in /upload/score keys off the method string specifically.
const FIXTURES = {
  "grand total, declared column": [
    { col_1: "ประเภทงาน", col_2: "กิจกรรม", col_3: "แต้ม", col_4: "จำนวนรวม", col_5: "รวมแต้ม" },
    { col_1: "บริการ", col_2: "ตรวจ OPD", col_3: 2, col_4: 100, col_5: 200 },
    { col_1: "รวมทั้งหมด", col_5: 1842.5 },
  ],
  "free-text summary line": [
    { col_1: "งานบริการ", col_2: 120 },
    { col_1: "รวม = 3260" },
  ],
  "sub-total rows only": [
    { col_1: "รวมคะแนน", col_2: 400 },
    { col_1: "รวมคะแนน", col_2: 250 },
  ],
  "largest in sheet": [
    { col_1: "งานที่ 1", col_2: 12 },
    { col_1: "งานที่ 2", col_2: 980 },
  ],
  "uncached grand total": [
    { col_1: "ประเภทงาน", col_2: "แต้ม", col_3: "รวมแต้ม" },
    { col_1: "รวมคะแนน", col_3: 600 },
    { col_1: "รวมคะแนน", col_3: 400 },
    { col_1: "รวมทั้งหมด" },
  ],
  "year-like values only": [
    { col_1: "ปี", col_2: 2569 },
  ],
  empty: [],
}

test("both copies return the same {score, method} for every fixture", async (t) => {
  let canonical
  try {
    canonical = await import(resolve(repoRoot, "automation/claude-analyst.js"))
  } catch (err) {
    t.skip(`automation/ dependencies not installed (${err.code ?? err.message}) — ` +
      `run \`npm ci\` in automation/ to include the behavioural half`)
    return
  }

  for (const [label, rows] of Object.entries(FIXTURES)) {
    assert.deepEqual(
      vendored.resolveScore(rows),
      canonical.resolveScore(rows),
      `resolveScore disagrees on the "${label}" fixture`
    )
    assert.deepEqual(
      vendored.extractScoreFromRows(rows),
      canonical.extractScoreFromRows(rows),
      `extractScoreFromRows disagrees on the "${label}" fixture`
    )
  }
})

// ── The confidence gate ───────────────────────────────────────────────────
// The gate is what makes the synchronous path safe (§7.7 rec 1): only a
// workbook that STATES its own total is scored without Claude. If a method
// string ever moves between these two lists, that is a decision, not a
// refactor — this test is where it has to be made deliberately.
test("only the labelled-total tiers count as high confidence", () => {
  for (const method of [
    "grand-total label row (all columns)",
    "free-text summary line",
  ]) {
    assert.equal(vendored.isHighConfidence(method), true, `${method} should be trusted synchronously`)
  }

  for (const method of [
    "sub-total label row (col_1-3)",
    "largest in sheet",
    "largest in sheet (exceeds sub-total label rows)",
    "largest in sheet (year-like fallback)",
    "weight × day-count computation",
    "sum of sub-total rows (grand-total formula uncached)",
    "sum of score-column data rows (sub-totals partially uncached)",
    "reconstructed from daily cells × rate (sub-totals also uncached)",
    "no candidates found",
    "no rows",
    "parse timeout (deferred to worker)",
  ]) {
    assert.equal(vendored.isHighConfidence(method), false, `${method} must be deferred to the worker`)
  }
})

test("every method resolveScore can produce is classified deliberately", () => {
  // Guards against a new tier being added to the canonical extractor and
  // silently defaulting to "deferred" — or worse, to trusted.
  const methodsInCanonical = [...canonicalSource.matchAll(/method:\s*"([^"]+)"/g)].map((m) => m[1])
  assert.ok(methodsInCanonical.length >= 8, "expected to find the method strings in the canonical extractor")
  for (const method of methodsInCanonical) {
    assert.equal(
      typeof vendored.isHighConfidence(method),
      "boolean",
      `${method} is not classified by the confidence gate`
    )
  }
})
