/**
 * telegram.js
 *
 * Sends a message to a Telegram chat via the Bot API.
 * Requires in .env:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   TELEGRAM_CHAT_ID    — your chat/group/channel ID
 */

import { TELEGRAM_TIMEOUT_MS } from "./config.js";

const BASE = "https://api.telegram.org";

function getConfig() {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  }
  return { token, chatId };
}

/**
 * Send a plain-text or Markdown message to Telegram.
 *
 * @param {string} text         Message text (supports MarkdownV2)
 * @param {object} [opts]
 * @param {string} [opts.parseMode]  "MarkdownV2" | "HTML" | undefined
 */
export async function sendTelegram(text, { parseMode } = {}) {
  const { token, chatId } = getConfig();

  // Guard against null/undefined — avoids TypeError on .length and .slice
  const safeText = String(text ?? "");

  if (safeText.length > 4096) {
    console.warn(`Telegram message truncated: ${safeText.length} → 4096 chars`);
  }
  const body = {
    chat_id : chatId,
    text    : safeText.slice(0, 4096),   // Telegram hard limit
    ...(parseMode ? { parse_mode: parseMode } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${BASE}/bot${token}/sendMessage`, {
      method  : "POST",
      headers : { "Content-Type": "application/json" },
      body    : JSON.stringify(body),
      signal  : controller.signal,
    });
    let json;
    try {
      json = await res.json();
    } catch (parseErr) {
      // A proxy/outage can return a non-JSON body (e.g. an HTML error page)
      // on a 502/503 — without this, res.json() throws a raw SyntaxError
      // instead of the descriptive error callers expect.
      throw new Error(`Telegram API returned a non-JSON response (HTTP ${res.status}): ${parseErr.message}`);
    }
    if (!json.ok) {
      throw new Error(`Telegram API error: ${json.description ?? JSON.stringify(json)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

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
export function formatResultMessage(result, filename, upload = null) {
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
export function formatErrorMessage(error, filename, upload = null) {
  if (!upload) {
    return [
      `❌ P4P Processing Error`,
      ``,
      `📥 Source: Email`,
      `💬 Error : ${error ?? "unknown error"}`,
      ``,
      `📎 File: ${filename ?? "(unknown)"}`,
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
