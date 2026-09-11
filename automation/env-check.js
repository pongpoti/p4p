/**
 * env-check.js
 *
 * Call checkEnv() once at application startup to fail fast with a clear
 * error message if any required environment variable is missing, rather
 * than discovering the gap mid-pipeline.
 */

const REQUIRED = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "ANTHROPIC_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  // Was a hardcoded default in config.js. Removed when this repo went
  // public — the addresses are real mailboxes. Required rather than
  // optional because an empty skip-list makes the pipeline process and
  // reply to its own automated mail.
  "SKIP_SENDERS",
];

const OPTIONAL = [
  "P4P_FOLDER_ID",     // Drive upload disabled if absent
  "CLAUDE_MODEL",      // Falls back to default Sonnet model
  "MAX_MESSAGES",      // Falls back to 10
  "SIMILARITY_THRESHOLD", // Falls back to 0.6
  "THREAD_RELAY_SENDERS", // No relay handling if absent
];

export function checkEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}\n` +
      `See .env.example for the full list of required variables.`
    );
  }

  const presentOptional = OPTIONAL.filter((k) => process.env[k]);
  const absentOptional  = OPTIONAL.filter((k) => !process.env[k]);

  return { missing: [], presentOptional, absentOptional };
}
