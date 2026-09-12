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

function getConfig(): { token: string; chatId: string } {
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
 * @param text         Message text (supports MarkdownV2)
 * @param opts.parseMode  "MarkdownV2" | "HTML" | undefined
 */
export async function sendTelegram(
  text: unknown,
  { parseMode }: { parseMode?: string } = {}
): Promise<unknown> {
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

  try {
    const res = await fetch(`${BASE}/bot${token}/sendMessage`, {
      method  : "POST",
      headers : { "Content-Type": "application/json" },
      body    : JSON.stringify(body),
      signal  : controller.signal,
    });
    let json: { ok: boolean; description?: string };
    try {
      json = (await res.json()) as { ok: boolean; description?: string };
    } catch (parseErr) {
      // A proxy/outage can return a non-JSON body (e.g. an HTML error page)
      // on a 502/503 — without this, res.json() throws a raw SyntaxError
      // instead of the descriptive error callers expect.
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      throw new Error(`Telegram API returned a non-JSON response (HTTP ${res.status}): ${msg}`);
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
 * Shared shape of the LINE-upload context passed to formatResultMessage()/
 * formatErrorMessage() — omit entirely on the email path, which prints its
 * own fixed "Email" source instead.
 */
export interface UploadContext {
  source?: string | null;
  accountName?: string | null;
  email?: string | null;
  monthKey?: string | null;
  rosterMatch?: string | null;
  nameInFile?: string | null;
  monthInFile?: string | null;
  errorType?: string | null;
  attempt?: number | null;
  maxAttempts?: number | null;
}

/** The result object formatResultMessage() renders. */
export interface ResultMessageData {
  name?: string | null;
  matchedName?: string | null;
  similarity?: number | null;
  date?: string | null;
  score?: string | number | null;
  saved?: boolean;
}

/**
 * Warning lines shared by both formatters — appended only when the file
 * disagrees with the authenticated account. On the upload path that
 * disagreement is the ONLY class of mistake left (identity and month both
 * come from a verified session), which is the reason to send a Telegram at
 * all. See design §7.6.
 */
function uploadWarnings(upload: UploadContext): string[] {
  const out = [];
  if (upload.nameInFile && upload.nameInFile !== upload.accountName) {
    out.push(`⚠️ Name in file : ${upload.nameInFile} (≠ account)`);
  }
  if (upload.monthInFile && upload.monthInFile !== upload.monthKey) {
    out.push(`⚠️ Month in file: ${upload.monthInFile} (≠ ${upload.monthKey} selected)`);
  }
  return out;
}

function accountLine(upload: UploadContext): string {
  const email = upload.email ? ` <${upload.email}>` : "";
  return `👤 Account  : ${upload.accountName ?? "—"}${email}`;
}

/**
 * Format a result object as a readable Telegram message.
 *
 * @param result  { name, date, score, matchedName, similarity, saved }
 * @param filename  Source xlsx filename
 * @param upload  LINE-upload context — omit entirely on the email
 *   path, which prints its own fixed "Email" source instead:
 *   { source, accountName, email, monthKey, rosterMatch, nameInFile, monthInFile }
 */
export function formatResultMessage(result: ResultMessageData, filename: string | null | undefined, upload: UploadContext | null = null): string {
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
 * @param error     Human-readable failure description
 * @param filename  Source xlsx filename
 * @param upload  As above, plus { errorType, attempt, maxAttempts }.
 *   Omitted on the email path, which prints its own fixed "Email" source.
 */
export function formatErrorMessage(error: unknown, filename: string | null | undefined, upload: UploadContext | null = null): string {
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
