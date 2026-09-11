'use strict';
/**
 * redact.js — CommonJS twin of automation/redact.js.
 *
 * Same purpose and same behaviour; duplicated because this package is CJS and
 * automation/ is ESM. automation/test/redactParity.test.js asserts the two
 * implementations agree, so a fix to one that is not mirrored fails CI.
 * Read automation/redact.js for the full rationale.
 *
 * process/ leaks less than automation/ — its own log lines print counts, not
 * names — but it builds per-physician reports, so an error path can still put
 * a roster row or a Drive filename into a world-readable job log.
 */

const crypto = require('node:crypto');
const util   = require('node:util');

const SALT = crypto.randomBytes(16);

function tag(value) {
  return crypto
    .createHash('sha256')
    .update(SALT)
    .update(String(value).normalize('NFC').trim().toLowerCase())
    .digest('hex')
    .slice(0, 4);
}

const THAI_RUN = /[\u0E00-\u0E7F][\u0E00-\u0E7F\s\u200B]*[\u0E00-\u0E7F]|[\u0E00-\u0E7F]/gu;
const EMAIL    = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function maskEmail(addr) {
  const [local, domain] = addr.split('@');
  return `${local.slice(0, 2)}***@${domain}#${tag(addr)}`;
}

function redactPII(input) {
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

function redactArg(arg) {
  if (typeof arg === 'string') return redactPII(arg);
  if (arg instanceof Error) {
    const e = new Error(redactPII(arg.message));
    e.name  = arg.name;
    e.stack = redactPII(arg.stack ?? '');
    return e;
  }
  if (arg === null || arg === undefined) return arg;
  if (typeof arg === 'object') {
    return redactPII(util.inspect(arg, { depth: 4, breakLength: 120 }));
  }
  return arg;
}

let installed = false;

function installConsoleRedaction(opts) {
  const force = !!(opts && opts.force);
  if (installed) return true;

  const flag = process.env.REDACT_LOGS;
  const inCI = process.env.GITHUB_ACTIONS === 'true' || !!process.env.CI;
  const on   = force || flag === '1' || (inCI && flag !== '0');
  if (!on) return false;

  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(...args.map(redactArg));
  }
  installed = true;
  return true;
}

installConsoleRedaction();

module.exports = { redactPII, installConsoleRedaction };
