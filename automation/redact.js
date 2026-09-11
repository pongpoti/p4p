/**
 * redact.js
 *
 * Scrubs personal data out of console output before it reaches a GitHub
 * Actions job log.
 *
 * Why this exists: on a PUBLIC repository, workflow run logs are readable by
 * anyone, with no login. This pipeline prints physician full names on the
 * happy path (index.js logs "✅ Physician : <name>", roster match lines,
 * fuzzy-match candidates, Drive upload filenames — 48 sites across 12 files)
 * and sender addresses on the relay path. Published continuously on a 2-hour
 * cron, that is a rolling disclosure of exactly the name → department → score
 * join that /ranking/ gates behind a session and RLS.
 *
 * Two design choices worth keeping:
 *
 *   1. It patches `console`, not the call sites. A denylist of 48 call sites
 *      is a denylist — the next log line added leaks again. Patching the sink
 *      cannot be forgotten. (Same reasoning .gitignore and pii-guard.yml
 *      already record for the csv_2569_01-04 leak: shape-based, not
 *      filename-by-filename.)
 *
 *   2. Redaction is *salted-pseudonymous*, not blanket [REDACTED]. Each name
 *      becomes «ชื่อ#a3f9», stable within one process so you can still tell
 *      that three log lines concern the same physician — which is most of the
 *      diagnostic value — while the tag is worthless outside that run. The
 *      salt is random per process and never logged, so the tags cannot be
 *      brute-forced against a candidate name list the way a bare hash could.
 *
 * Thai script is treated as data unconditionally: no console statement in
 * automation/ or process/ contains a Thai literal, so every Thai run reaching
 * a log came from the roster, a filename or an email body. Blanket-masking it
 * therefore costs no legitimate output.
 *
 * Only console output is touched. Values written to Drive, Supabase, Telegram
 * or reply emails are untouched — those go to authenticated recipients and
 * need the real name.
 */

import crypto from "node:crypto";
import util   from "node:util";

/**
 * Random per-process salt. Never logged, never persisted. Two runs of the
 * same pipeline produce different tags for the same physician — that is
 * intentional: it makes the tags useless to anyone correlating across runs.
 */
const SALT = crypto.randomBytes(16);

function tag(value) {
  return crypto
    .createHash("sha256")
    .update(SALT)
    .update(String(value).normalize("NFC").trim().toLowerCase())
    .digest("hex")
    .slice(0, 4);
}

// Thai block, 2+ consecutive chars (incl. spaces between Thai words, so a
// full "given surname" pair masks as one unit rather than two).
const THAI_RUN = /[\u0E00-\u0E7F][\u0E00-\u0E7F\s\u200B]*[\u0E00-\u0E7F]|[\u0E00-\u0E7F]/gu;
const EMAIL    = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Mask an email as `ab***@gmail.com#a3f9` — domain kept because it is the
 * part that matters when debugging routing (skip-list, relay-list, bounce),
 * local part reduced to two characters plus a correlation tag.
 */
function maskEmail(addr) {
  const [local, domain] = addr.split("@");
  const head = local.slice(0, 2);
  return `${head}***@${domain}#${tag(addr)}`;
}

/** Replace personal data in a single string. Safe to call on any input. */
export function redactPII(input) {
  if (input == null) return input;
  let s = String(input);
  if (!s) return s;
  s = s.replace(EMAIL, maskEmail);
  s = s.replace(THAI_RUN, (m) => {
    const trimmed = m.trim();
    if (!trimmed) return m;
    return `«ชื่อ#${tag(trimmed)}»`;
  });
  return s;
}

/** Redact one console argument, preserving Error identity for stack traces. */
function redactArg(arg) {
  if (typeof arg === "string") return redactPII(arg);
  if (arg instanceof Error) {
    const e = new Error(redactPII(arg.message));
    e.name  = arg.name;
    e.stack = redactPII(arg.stack ?? "");
    return e;
  }
  if (arg === null || arg === undefined) return arg;
  if (typeof arg === "object") {
    // Objects can carry a roster row straight into the log. Render then
    // scrub, rather than walking an arbitrary shape.
    return redactPII(util.inspect(arg, { depth: 4, breakLength: 120 }));
  }
  return arg;
}

let installed = false;

/**
 * Patch console.{log,warn,error,info,debug} in place.
 *
 * Active by default under GitHub Actions / CI, where the log is the public
 * artifact. Off locally so a developer debugging a name-matching bug still
 * sees real names on their own terminal.
 *
 *   REDACT_LOGS=1  force on  (useful to check output before a release)
 *   REDACT_LOGS=0  force off (does nothing in CI unless you mean it)
 */
export function installConsoleRedaction({ force = false } = {}) {
  if (installed) return true;

  const flag = process.env.REDACT_LOGS;
  const inCI = process.env.GITHUB_ACTIONS === "true" || !!process.env.CI;
  const on   = force || flag === "1" || (inCI && flag !== "0");
  if (!on) return false;

  for (const method of ["log", "warn", "error", "info", "debug"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(...args.map(redactArg));
  }
  installed = true;
  return true;
}

// Side-effecting on import: an entry point only has to import this file for
// its logs to be safe. Nothing else to remember, nothing to call.
installConsoleRedaction();

export default { redactPII, installConsoleRedaction };
