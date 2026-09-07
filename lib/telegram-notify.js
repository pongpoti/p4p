/**
 * lib/telegram-notify.js
 *
 * The admin's Telegram alert, on the ONE submission path that could not reach
 * automation/telegram.js: `/upload/score` in main.js.
 *
 * Design §7.6 says every submission notifies, success and failure alike, and
 * the worker holds up its end — but after §7.7 the worker is no longer where
 * a LIFF submission is decided. The instant tier scores, saves and closes the
 * queue row inside the Vercel request, and drain-uploads' archive branch is
 * deliberately silent (it has nothing new to report). So the common case —
 * a confident score against an exact roster match — resolved with no Telegram
 * at all, and so did every rejection the instant tier issues.
 *
 * It is a vendored copy rather than an import for the same reason
 * lib/p4p-score.js is one: automation/ is C8's isolation boundary, is its own
 * ESM sub-project, and is not in vercel.json's includeFiles — main.js cannot
 * require it in production even if the module formats agreed. The four
 * formatting functions below are therefore byte-identical to their originals
 * and are held that way by lib/__tests__/parity.test.mjs; only the transport
 * differs (axios here, fetch there), which is why sendTelegram is not
 * mirrored.
 */
const axios = require("axios")

// Shorter than automation's 10 s: this send sits in front of the physician's
// receipt, so a Telegram outage must cost them a few seconds at most. The
// alert is for the admin's benefit and never worth failing a submission over.
const TELEGRAM_TIMEOUT_MS = 5000

/**
 * Warning lines shared by both formatters — appended only when the file
 * disagrees with the authenticated account. On the upload path that
 * disagreement is the ONLY class of mistake left (identity and month both
 * come from a verified session), which is the reason to send a Telegram at
 * all. See design §7.6.
 */
function uploadWarnings(upload) {
  const out = [];
  if (upload.nameInFile && upload.nameInFile !== upload.accountName) {
    out.push(`⚠️ Name in file : ${upload.nameInFile} (≠ account)`);
  }
  if (upload.monthInFile && upload.monthInFile !== upload.monthKey) {
    out.push(`⚠️ Month in file: ${upload.monthInFile} (≠ ${upload.monthKey} selected)`);
  }
  return out;
}

function accountLine(upload) {
  const email = upload.email ? ` <${upload.email}>` : "";
  return `👤 Account  : ${upload.accountName ?? "—"}${email}`;
}

/**
 * Format a result object as a readable Telegram message.
 *
 * @param {object} result  { name, date, score, matchedName, similarity, saved }
 * @param {string} filename  Source xlsx filename
 * @param {object} [upload]  LINE-upload context — omit entirely on the email
 *   path, which prints its own fixed "Email" source instead:
 *   { source, accountName, email, monthKey, rosterMatch, nameInFile, monthInFile }
 * @returns {string}
 */
function formatResultMessage(result, filename, upload = null) {
  const sim  = result.similarity != null
    ? ` (${(result.similarity * 100).toFixed(0)}% match)`
    : "";
  const saved = result.saved ? "✅ Score saved to DB" : "⚠️ Score NOT saved";

  // Plain text mode (no parseMode) — do NOT use *markdown* as it renders literally
  if (!upload) {
    return [
      `📋 P4P Workload Report`,
      ``,
      `📥 Source   : Email`,
      `👤 Name     : ${result.name ?? "—"}`,
      `🔗 Matched  : ${result.matchedName ?? "—"}${sim}`,
      `📅 Date     : ${result.date ?? "—"}`,
      `🏅 Score    : ${result.score ?? "—"}`,
      `💾 ${saved}`,
      ``,
      `📎 File: ${filename ?? "(unknown)"}`,
    ].join("\n");
  }

  // On this path there is no fuzzy match to doubt — identity came from a
  // verified session — so the interesting question changes from "did it match
  // the right person?" to "did the file agree with what they claimed?".
  return [
    `📋 P4P Workload Report`,
    ``,
    `📥 Source   : ${upload.source ?? "LINE upload"}`,
    accountLine(upload),
    `🔗 Roster   : ${result.matchedName ?? "—"}${upload.rosterMatch ? ` (${upload.rosterMatch})` : sim}`,
    `📅 Month    : ${upload.monthKey ?? result.date ?? "—"} (เลือกเอง)`,
    `🏅 Score    : ${result.score ?? "—"}`,
    `💾 ${saved}`,
    ...uploadWarnings(upload),
    ``,
    `📎 File: ${filename ?? "(unknown)"}`,
  ].join("\n");
}

/**
 * Format an error as a Telegram message.
 *
 * @param {string} error     Human-readable failure description
 * @param {string} filename  Source xlsx filename
 * @param {object} [upload]  As above, plus { errorType, attempt, maxAttempts }.
 *   Omitted on the email path, which prints its own fixed "Email" source.
 */
function formatErrorMessage(error, filename, upload = null) {
  if (!upload) {
    return [
      `❌ P4P Processing Error`,
      ``,
      `📥 Source: Email`,
      `📎 File  : ${filename ?? "(unknown)"}`,
      `💬 Error : ${error ?? "unknown error"}`,
    ].join("\n");
  }

  // "🔁 Attempt: n/3" appears only here, because only this path retries — it
  // is the difference between "this will come back" and "this is over".
  const attemptLine = upload.attempt
    ? [`🔁 Attempt: ${upload.attempt}/${upload.maxAttempts ?? 3}${
        upload.attempt >= (upload.maxAttempts ?? 3) ? " — ยุติการลองใหม่" : ""
      }`]
    : [];

  return [
    `❌ P4P Upload Error`,
    ``,
    `📥 Source : ${upload.source ?? "LINE upload"}`,
    accountLine(upload).replace("👤 Account  :", "👤 Account:"),
    `📅 Month  : ${upload.monthKey ?? "—"}`,
    ...(upload.errorType ? [`🚫 Type   : ${upload.errorType}`] : []),
    `💬 Error  : ${error ?? "unknown error"}`,
    ...attemptLine,
    ...uploadWarnings(upload),
    ``,
    `📎 File: ${filename ?? "(unknown)"}`,
  ].join("\n");
}

/**
 * Send a plain-text message to the admin chat. Returns false instead of
 * throwing on every failure mode — a missing credential, a Telegram outage,
 * a timeout — because nothing here is worth turning a saved score into an
 * error the physician sees.
 *
 * Plain text, no parse_mode: Thai names are full of characters MarkdownV2
 * would need escaped, and automation/telegram.js records the same reason.
 */
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    // Not necessarily a missing credential — Vercel deployments are immutable
    // snapshots, so adding these in the dashboard does nothing to a
    // deployment that already exists; only the next build picks them up.
    // Confirmed live 2026-09-07: the vars were set, this line still fired on
    // the build made just before, and it stopped the moment a new build ran.
    console.warn("[upload] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set on this deployment — admin alert skipped (if you just added them in Vercel, redeploy — env vars only apply to builds made after they're set)")
    return false
  }
  try {
    const r = await axios.post(
      "https://api.telegram.org/bot" + token + "/sendMessage",
      { chat_id: chatId, text: String(text == null ? "" : text).slice(0, 4096) },
      { headers: { "Content-Type": "application/json" }, timeout: TELEGRAM_TIMEOUT_MS }
    )
    if (!r.data || !r.data.ok) {
      console.warn("[upload] Telegram rejected the message: " + JSON.stringify(r.data))
      return false
    }
    return true
  } catch (e) {
    console.warn("[upload] Telegram notify failed: " + (e.response ? JSON.stringify(e.response.data) : e.message))
    return false
  }
}

module.exports = { sendTelegram, formatResultMessage, formatErrorMessage }
