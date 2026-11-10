/**
 * Runs the shell steps of a few workflows for real, with stand-ins for the
 * outside world (gh, curl, npx and the clock), so a change to the YAML is
 * checked without GitHub, Supabase or LINE.
 *
 *   4.1  the personal-data guard, against throwaway git repositories.
 *
 * Personal-looking strings are assembled at run time, so this file itself
 * passes the 4.1 guard.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const workflowDir = resolve(repoRoot, ".github/workflows")
const workflow = (file) => readFileSync(join(workflowDir, file), "utf8")
const realDate = spawnSync("bash", ["-c", "command -v date"], { encoding: "utf8" }).stdout.trim()

/** The `run: |` script of the step named `name`, dedented as YAML would. */
function stepScript(file, name) {
  const lines = workflow(file).split("\n")
  const indent = (l) => l.length - l.trimStart().length
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`)
  assert.ok(start >= 0, `step "${name}" not found in ${file}`)
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() && indent(lines[i]) <= indent(lines[start])) break
    if (!/^\s*run: \|\s*$/.test(lines[i])) continue
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && indent(lines[j]) <= indent(lines[i])) break
      body.push(lines[j])
    }
    const pad = Math.min(...body.filter((l) => l.trim()).map(indent))
    return body.map((l) => l.slice(pad)).join("\n").trimEnd() + "\n"
  }
  assert.fail(`step "${name}" in ${file} has no run: | block`)
}

/**
 * Runs a step script the way GitHub does (`bash -e`), with `stubs` placed
 * first on PATH. Returns the exit status, output, and what it wrote to
 * $GITHUB_OUTPUT.
 */
function runStep(script, { cwd, env = {}, stubs = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wf-step-"))
  try {
    const bin = join(dir, "bin")
    mkdirSync(bin)
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
    }
    const output = join(dir, "github_output")
    const log = join(dir, "stub.log")
    writeFileSync(output, "")
    writeFileSync(log, "")
    writeFileSync(join(dir, "step.sh"), script)
    const r = spawnSync("bash", ["-e", join(dir, "step.sh")], {
      cwd: cwd ?? dir,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: process.env.HOME ?? dir,
        LC_ALL: "C.UTF-8",
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "example/repo",
        STUB_LOG: log,
        REAL_DATE: realDate,
        ...env,
      },
    })
    const outputs = {}
    for (const line of readFileSync(output, "utf8").split("\n").filter(Boolean)) {
      const at = line.indexOf("=")
      outputs[line.slice(0, at)] = line.slice(at + 1)
    }
    return { status: r.status, stdout: r.stdout + r.stderr, outputs, log: readFileSync(log, "utf8") }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── 4.1 personal-data guard ─────────────────────────────────────────────────

const AT = "@"
const personalEmail = ["person.one", "hospital.go.th"].join(AT)
const lineUserId = "U" + "0123456789abcdef".repeat(2)

function git(cwd, ...args) {
  const r = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  )
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

function writeIn(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), content)
}

/** A repo with a base commit (`base` files) and a head commit made by `change`. */
function repo(base, change) {
  const dir = mkdtempSync(join(tmpdir(), "wf-pii-"))
  git(dir, "init", "-q")
  for (const [path, content] of Object.entries(base)) writeIn(dir, path, content)
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "--allow-empty", "-m", "base")
  const baseSha = git(dir, "rev-parse", "HEAD")
  change(dir)
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "--allow-empty", "-m", "head")
  return { dir, baseSha, headSha: git(dir, "rev-parse", "HEAD") }
}

function scan(base, change, sha = {}) {
  const r = repo(base, change)
  try {
    return runStep(stepScript("4-1-check-no-personal-data.yml", "Scan"), {
      cwd: r.dir,
      env: { BASE_SHA: sha.base ?? r.baseSha, HEAD_SHA: sha.head ?? r.headSha },
    })
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
}

const filler = Array.from({ length: 20 }, (_, i) => `select ${i};`).join("\n") + "\n"

test("4.1 passes placeholders, reserved example domains and the project's own mailboxes", () => {
  const allowed = [
    "x@example.com",
    "a@mail.example.org",
    "b@clinic.test",
    "X@Y.com",
    "sakhonmso@gmail.com",
    "drive-shares-dm-noreply@google.com",
  ]
  const r = scan({}, (d) => writeIn(d, "src/a.ts", allowed.map((e) => `// ${e}`).join("\n")))
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /PII guard passed/)
})

test("4.1 flags an email address at any other domain", () => {
  const r = scan({}, (d) => writeIn(d, "notes.md", `Contact: ${personalEmail}\n`))
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /::error file=notes\.md::Email address/)
  assert.ok(r.stdout.includes(personalEmail))
})

test("4.1 flags a LINE user id without printing it", () => {
  const r = scan({}, (d) => writeIn(d, "src/config.ts", `// admin\nconst id = "${lineUserId}"\n`))
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /::error file=src\/config\.ts::LINE user id/)
  assert.match(r.stdout, /line 2: U0123\.\.\./)
  assert.ok(!r.stdout.includes(lineUserId), "the full id must not reach the log")
})

test("4.1 scans a renamed file", () => {
  const r = scan({ "scripts/x.sql": filler }, (d) => {
    git(d, "mv", "scripts/x.sql", "scripts/x-old.sql")
    writeIn(d, "scripts/x-old.sql", `${filler}-- ${personalEmail}\n`)
  })
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /::error file=scripts\/x-old\.sql::Email address/)
})

test("4.1 scans files with Thai names instead of skipping them", () => {
  const r = scan({}, (d) => {
    writeIn(d, "รายชื่อ.csv", "a,b\n")
    writeIn(d, "บันทึก.txt", `${personalEmail}\n`)
  })
  assert.equal(r.status, 1, r.stdout)
  assert.ok(r.stdout.includes("::error file=รายชื่อ.csv::Spreadsheet/CSV added"), r.stdout)
  assert.ok(r.stdout.includes("::error file=บันทึก.txt::Email address"), r.stdout)
})

test("4.1 scans every tracked file when there is no base to diff against", () => {
  const base = { "old.md": `${personalEmail}\n` }
  const change = (d) => writeIn(d, "new.md", "fine\n")
  assert.equal(scan(base, change).status, 0, "a normal diff only sees new.md")
  const r = scan(base, change, { base: "0".repeat(40) })
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /scanning every tracked file/)
  assert.match(r.stdout, /::error file=old\.md::Email address/)
})

test("4.1 ignores npm's deprecation notices in package-lock.json, nothing else", () => {
  const maintainer = ["maintainer", "registry-author.dev"].join(AT)
  const notice = `{\n  "deprecated": "Old versions are unsupported, contact ${maintainer}"\n}\n`
  assert.equal(scan({}, (d) => writeIn(d, "package-lock.json", notice)).status, 0)
  const r = scan({}, (d) => writeIn(d, "package-lock.json", `${notice}"author": "${personalEmail}"\n`))
  assert.equal(r.status, 1, r.stdout)
  assert.ok(r.stdout.includes(personalEmail) && !r.stdout.includes(maintainer), r.stdout)
})

test("4.1 fails closed when the changed files cannot be listed", () => {
  const r = scan({}, (d) => writeIn(d, "a.md", "x\n"), { head: "f".repeat(40) })
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /Could not list the changed files/)
})

test("4.1 runs on pushes to main as well as pull requests, and sees renames", () => {
  const text = workflow("4-1-check-no-personal-data.yml")
  assert.match(text, /\n {2}pull_request:\n {4}branches: \[main\]/)
  assert.match(text, /\n {2}push:\n {4}branches: \[main\]/)
  assert.match(text, /--diff-filter=ACMR/)
})
