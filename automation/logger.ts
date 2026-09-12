/**
 * logger.js
 *
 * Lightweight structured logger that prefixes every message with a
 * timestamp and level tag, making CI/CD logs easier to parse and grep.
 *
 * Usage:
 *   import log from "./logger.js";
 *   log.info("Processing started");
 *   log.warn("Telegram truncated");
 *   log.error("Drive upload failed", err.message);
 *
 * Pipeline tree lines (│ └ ┌) are passed through unchanged — this logger
 * is for top-level and module-level messages only.
 */

function ts(): string {
  return new Date().toISOString();
}

const log = {
  info : (...args: unknown[]) => console.log(`[INFO]  ${ts()}`, ...args),
  warn : (...args: unknown[]) => console.warn(`[WARN]  ${ts()}`, ...args),
  error: (...args: unknown[]) => console.error(`[ERROR] ${ts()}`, ...args),
  debug: (...args: unknown[]) => {
    if (process.env.DEBUG) console.log(`[DEBUG] ${ts()}`, ...args);
  },
};

export default log;
