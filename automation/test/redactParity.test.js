/**
 * Guards the two things that make the redaction trustworthy:
 *
 *  1. automation/redact.js (ESM) and process/redact.js (CJS) are duplicated
 *     because the two packages use different module systems. A fix applied to
 *     one and not the other would silently leave half the pipeline leaking,
 *     so their behaviour is compared here.
 *
 *  2. Every entry point a workflow actually runs pulls the module in. The
 *     redaction is installed on import; an entry point that forgets it logs
 *     raw names into a world-readable job log. This is the check that makes
 *     "don't forget" unnecessary.
 */
import { test }          from "node:test";
import assert            from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path              from "node:path";
import { fileURLToPath } from "node:url";

import { redactPII as esmRedact } from "../redact.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const require_ = createRequire(import.meta.url);
const { redactPII: cjsRedact } = require_(path.join(ROOT, "process", "redact.js"));

// Salts are per-process and differ between the two modules by design, so
// compare with the correlation tags normalised away.
const norm = (s) => String(s).replace(/#[0-9a-f]{4}/g, "#____");

test("ESM and CJS redaction agree on every shape that matters", () => {
  for (const input of [
    "✅  Physician : สมชาย ใจดี",
    "original sender: somchai.jaidee@example.com",
    'Uploading as "กานดา มีสุข_2569_03.xlsx"…',
    "Total missing : 12 physician-month entries",
    "mixed สมชาย and a@b.co and 2569_03",
    "",
  ]) {
    assert.equal(norm(esmRedact(input)), norm(cjsRedact(input)), `diverged on: ${input}`);
  }
});

test("every workflow entry point installs redaction", () => {
  const wfDir = path.join(ROOT, ".github", "workflows");
  const entries = new Set();

  for (const f of readdirSync(wfDir).filter((f) => f.endsWith(".yml"))) {
    const yml = readFileSync(path.join(wfDir, f), "utf8");
    // working-directory sets the base for the `node <file>` invocations below.
    const dirs = [...yml.matchAll(/working-directory:\s*(\S+)/g)].map((m) => m[1]);
    for (const m of yml.matchAll(/\bnode\s+([A-Za-z0-9_./-]+\.(?:js|mjs))\b/g)) {
      const file = m[1];
      for (const d of [...dirs, "."]) {
        const p = path.join(ROOT, d, file);
        if (existsSync(p)) { entries.add(path.relative(ROOT, p)); break; }
      }
    }
  }

  assert.ok(entries.size >= 15, `expected to find the entry points, found ${entries.size}`);

  const missing = [...entries].filter((rel) => {
    // Root scripts/ are LINE card/menu tooling: they never read roster data
    // and have no name/email log site. Exempt by location, and the exemption
    // is asserted below rather than assumed.
    if (rel.startsWith("scripts/")) return false;
    return !/redact\.js/.test(readFileSync(path.join(ROOT, rel), "utf8"));
  });

  assert.deepEqual(missing, [], `entry points missing redaction: ${missing.join(", ")}`);
});

test("the exempt root scripts/ really do not log names or addresses", () => {
  const dir = path.join(ROOT, "scripts");
  const offenders = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))) {
    const src = readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/console\.(log|warn|error|info)\([^\n]*/g)) {
      if (/\$\{[^}]*(fullName|matchedName|physician|\bemail\b|sender|roster)[^}]*\}/i.test(m[0])) {
        offenders.push(`${f}: ${m[0].slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `root scripts/ started logging personal data:\n${offenders.join("\n")}`);
});
