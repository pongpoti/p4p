/**
 * Runs the shell steps of a few workflows for real, with stand-ins for the
 * outside world (gh, curl, npx and the clock), so a change to the YAML is
 * checked without GitHub, Supabase or LINE.
 *
 *   4.1  the personal-data guard, against throwaway git repositories;
 *   3.5  the carousel version check (input pasted into shell before);
 *   3.1  the refusal to read the inbox while relay 1 is alive;
 *   2.4  which month tables a run creates, by Bangkok date;
 *   2.5  when the LINE month picker is rebuilt.
 *
 * Personal-looking strings are assembled at run time, so this file itself
 * passes the 4.1 guard.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
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

// `date` frozen at $FAKE_NOW; calls with -d (date arithmetic) use the real one.
const fakeDate = `for a in "$@"; do case "$a" in -d|-d*|--date|--date=*) exec "$REAL_DATE" "$@";; esac; done
exec "$REAL_DATE" -d "$FAKE_NOW" "$@"`

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

// ── 3.5 carousel version ────────────────────────────────────────────────────

test("3.5 only accepts a version that names an existing carousel", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wf-carousel-"))
  try {
    writeIn(cwd, "assets/cards/feature-carousel.v1.flex.json", "{}")
    const check = (VERSION) => runStep(stepScript("3-5-manual-line-send-carousel.yml", "Check version input"), { cwd, env: { VERSION } })
    assert.equal(check("v1").status, 0)
    assert.equal(check("v9").status, 1, "no such carousel")
    assert.equal(check("../../etc/passwd").status, 1)
    const injected = check('v1"; touch pwned; echo "')
    assert.equal(injected.status, 1)
    assert.ok(!existsSync(join(cwd, "pwned")), "the input must never run as shell")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("3.5 passes the version only through env and reads the repo only", () => {
  const text = workflow("3-5-manual-line-send-carousel.yml")
  const uses = text.split("\n").filter((l) => l.includes("inputs.version"))
  assert.equal(uses.length, 4)
  for (const line of uses) assert.match(line, /^\s+VERSION: \$\{\{ inputs\.version \}\}$/)
  assert.match(text, /\npermissions:\n {2}contents: read\n/)
})

// ── 3.1 manual inbox read vs relay 1 ────────────────────────────────────────

// gh stand-in: logs its arguments and prints $FAKE_RUNS through --jq.
const fakeGh = `echo "$*" >> "$STUB_LOG"
[ "\${FAKE_GH_FAIL:-}" = 1 ] && { echo "HTTP 502" >&2; exit 1; }
q=.
while [ $# -gt 0 ]; do [ "$1" = --jq ] && { q=$2; shift; }; shift; done
printf '%s' "$FAKE_RUNS" | jq -c "$q"`

function relayCheck(runs, env = {}) {
  return runStep(stepScript("3-1-manual-email-read-submission-emails.yml", "Refuse while relay 1 is queued or running"), {
    env: { RELAY: "1-always-on-process-line-uploads-and-emails.yml", FAKE_RUNS: JSON.stringify(runs), ...env },
    stubs: { gh: fakeGh },
  })
}

test("3.1 reads the inbox only when relay 1 has nothing queued or running", () => {
  const done = { status: "completed", url: "https://github.invalid/run/1" }
  const ok = relayCheck([done, done])
  assert.equal(ok.status, 0, ok.stdout)
  assert.match(ok.log, /--workflow 1-always-on-process-line-uploads-and-emails\.yml/)

  for (const status of ["in_progress", "queued", "pending", "waiting"]) {
    const r = relayCheck([{ status, url: "https://github.invalid/run/2" }, done])
    assert.equal(r.status, 1, `${status}: ${r.stdout}`)
    assert.match(r.stdout, /Relay 1 has 1 run\(s\) queued or running/)
  }
})

test("3.1 refuses when it cannot tell whether relay 1 is alive", () => {
  const r = relayCheck([], { FAKE_GH_FAIL: "1" })
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /Could not list the runs/)
})

test("3.1 reads the inbox inside relay 1's concurrency group, after the check", () => {
  const relay = workflow("1-always-on-process-line-uploads-and-emails.yml")
  assert.match(relay, /concurrency:\n {2}group: upload-drain\n {2}cancel-in-progress: false/)
  const manual = workflow("3-1-manual-email-read-submission-emails.yml")
  assert.match(manual, /\n {2}process:\n {4}needs: relay-check\n[\s\S]*?\n {4}concurrency:\n {6}group: upload-drain\n {6}cancel-in-progress: false\n/)
})

// ── 2.4 month tables ────────────────────────────────────────────────────────

// curl stand-in for Supabase: HTTP 200 for tables in $FAKE_TABLES, otherwise
// $FAKE_CODE (404 by default). Logs the URL.
const fakeSupabase = `url="\${!#}"; echo "$url" >> "$STUB_LOG"
t="\${url##*/rest/v1/}"; t="\${t%%\\?*}"
case " \${FAKE_TABLES:-} " in *" $t "*) printf 200 ;; *) printf "\${FAKE_CODE:-404}" ;; esac`

function planMonths(now, tables, env = {}) {
  const r = runStep(stepScript("2-4-monthly-create-roster-table.yml", "Find month tables to create"), {
    env: {
      FAKE_NOW: now,
      FAKE_TABLES: tables,
      SUPABASE_URL: "https://db.example.test/",
      SUPABASE_KEY: "service-key",
      NEW_KEY_INPUT: "",
      OLD_KEY_INPUT: "",
      ...env,
    },
    stubs: { date: fakeDate, curl: fakeSupabase },
  })
  assert.equal(r.status, 0, r.stdout)
  return r
}

test("2.4 creates next month's table on the last Bangkok day, an hour before it starts", () => {
  // 16:07 UTC on 31 Oct = 23:07 on 31 Oct in Bangkok.
  assert.equal(planMonths("2026-10-31T16:07:00Z", "2569_10").outputs.todo, "2569_11:2569_10")
  assert.equal(planMonths("2026-10-31T16:07:00Z", "2569_10 2569_11").outputs.todo, "")
  // The year turns over in both calendars.
  assert.equal(planMonths("2026-12-31T16:07:00Z", "2569_12").outputs.todo, "2570_01:2569_12")
  // Last day of a leap February.
  assert.equal(planMonths("2028-02-29T16:07:00Z", "2571_02").outputs.todo, "2571_03:2571_02")
})

test("2.4 catches up a month whose table is still missing, on any later day", () => {
  // 18:07 UTC on 31 Oct = 01:07 on 1 Nov in Bangkok: the 23:07 run was missed.
  assert.equal(planMonths("2026-10-31T18:07:00Z", "2569_10").outputs.todo, "2569_11:2569_10")
  // A run that GitHub started hours late, in the next UTC day.
  assert.equal(planMonths("2026-10-31T23:40:00Z", "2569_10").outputs.todo, "2569_11:2569_10")
  assert.equal(planMonths("2026-11-15T18:07:00Z", "2569_10").outputs.todo, "2569_11:2569_10")
  assert.equal(planMonths("2026-12-31T18:07:00Z", "2569_12").outputs.todo, "2570_01:2569_12")
})

test("2.4 does nothing on an ordinary day once the month's table exists", () => {
  const r = planMonths("2026-11-15T16:07:00Z", "2569_10 2569_11")
  assert.equal(r.outputs.todo, "")
  assert.equal(r.log.trim(), "https://db.example.test/rest/v1/2569_11?select=*&limit=1")
})

test("2.4 still runs the script when Supabase gives no clear answer", () => {
  assert.equal(planMonths("2026-11-15T16:07:00Z", "", { FAKE_CODE: "503" }).outputs.todo, "2569_11:2569_10")
})

test("2.4 manual keys go straight to the script, and must look like month keys", () => {
  const r = planMonths("2026-11-15T16:07:00Z", "", { NEW_KEY_INPUT: "2569_08", OLD_KEY_INPUT: "2569_07" })
  assert.equal(r.outputs.todo, "2569_08:2569_07")
  assert.equal(r.log, "", "no lookup for a manual repair")
  assert.equal(planMonths("2026-11-15T16:07:00Z", "", { OLD_KEY_INPUT: "2569_07" }).outputs.todo, ":2569_07")

  const bad = runStep(stepScript("2-4-monthly-create-roster-table.yml", "Find month tables to create"), {
    env: { NEW_KEY_INPUT: "2569_08 x:y", OLD_KEY_INPUT: "" },
  })
  assert.equal(bad.status, 1)
})

test("2.4 runs the provisioning script once per month, in order", () => {
  const r = runStep(stepScript("2-4-monthly-create-roster-table.yml", "Provision new month table"), {
    env: { TODO: "2569_11:2569_10 2569_12:2569_11" },
    stubs: { npx: 'echo "NEW_KEY=$NEW_KEY OLD_KEY=$OLD_KEY $*" >> "$STUB_LOG"' },
  })
  assert.equal(r.status, 0, r.stdout)
  assert.deepEqual(r.log.trim().split("\n"), [
    "NEW_KEY=2569_11 OLD_KEY=2569_10 tsx scripts/provision-next-month.ts",
    "NEW_KEY=2569_12 OLD_KEY=2569_11 tsx scripts/provision-next-month.ts",
  ])
})

test("2.4 and 2.5 are scheduled every day", () => {
  for (const file of ["2-4-monthly-create-roster-table.yml", "2-5-monthly-update-line-menu-month.yml"]) {
    const crons = [...workflow(file).matchAll(/- cron: '([^']+)'/g)].map((m) => m[1])
    assert.ok(crons.length >= 2, file)
    for (const cron of crons) assert.match(cron, /^\d+ \d+ \* \* \*$/, `${file}: ${cron}`)
  }
})

// ── 2.5 LINE month picker ───────────────────────────────────────────────────

/** The live menu as LINE returns it: one URI per month, plus the back button. */
function menu(sheets) {
  return JSON.stringify({
    richMenuId: "richmenu-0123abcd",
    areas: [
      ...sheets.map((s) => ({ action: { type: "uri", uri: `https://liff.line.me/x?sheetname=${s}&color=red` } })),
      { action: { type: "richmenuswitch", richMenuAliasId: "status", data: "back_to_main" } },
    ],
  })
}

// curl stand-in for the LINE API. Exit 22 is what curl -f gives on an HTTP error.
const fakeLine = `url="\${!#}"; echo "$url" >> "$STUB_LOG"
case "$url" in
  */richmenu/alias/month-picker) [ -n "\${FAKE_ALIAS:-}" ] || exit 22; printf '%s' "$FAKE_ALIAS" ;;
  */richmenu/richmenu-0123abcd) printf '%s' "$FAKE_MENU" ;;
  *) exit 22 ;;
esac`

function pickerGuard(now, sheets, env = {}) {
  const r = runStep(stepScript("2-5-monthly-update-line-menu-month.yml", "Skip if the menu already offers this month"), {
    env: {
      FAKE_NOW: now,
      LINE_TOKEN: "line-token",
      EVENT_NAME: "schedule",
      FAKE_ALIAS: JSON.stringify({ richMenuAliasId: "month-picker", richMenuId: "richmenu-0123abcd" }),
      FAKE_MENU: menu(sheets),
      ...env,
    },
    stubs: { date: fakeDate, curl: fakeLine },
  })
  assert.equal(r.status, 0, r.stdout)
  return r
}

const october = ["2569_10", "2569_09", "2569_08", "2569_07", "2569_06", "2569_05"]
const november = ["2569_11", ...october.slice(0, 5)]

test("2.5 rebuilds the month picker on the 1st, then leaves it alone", () => {
  // 23:07 UTC on 31 Oct = 06:07 on 1 Nov in Bangkok.
  assert.equal(pickerGuard("2026-10-31T23:07:00Z", october).outputs.run, "true")
  assert.equal(pickerGuard("2026-10-31T23:07:00Z", november).outputs.run, "false")
  assert.equal(pickerGuard("2026-11-12T05:07:00Z", november).outputs.run, "false")
  // A month later than planned: still rebuilt.
  assert.equal(pickerGuard("2026-11-12T05:07:00Z", october).outputs.run, "true")
  // January 2570 after December 2569.
  assert.equal(pickerGuard("2026-12-31T23:07:00Z", ["2569_12", "2569_11"]).outputs.run, "true")
  assert.equal(pickerGuard("2026-12-31T23:07:00Z", ["2570_01", "2569_12"]).outputs.run, "false")
})

test("2.5 rebuilds when the live menu cannot be read, and on every manual run", () => {
  assert.equal(pickerGuard("2026-11-12T05:07:00Z", november, { FAKE_ALIAS: "" }).outputs.run, "true")
  const manual = pickerGuard("2026-11-12T05:07:00Z", november, { EVENT_NAME: "workflow_dispatch" })
  assert.equal(manual.outputs.run, "true")
  assert.equal(manual.log, "", "a manual run does not need to look first")
})
