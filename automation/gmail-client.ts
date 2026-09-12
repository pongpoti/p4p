/**
 * gmail-client.js — reusable, headless Gmail client.
 *
 * Reads credentials from environment variables (loaded from .env).
 * Automatically refreshes the access token as needed — no browser involved.
 */

import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { GmailAttachment, DecodedMessage, MessageWithAttachments } from "./types.js";

// ── Build a pre-authorised OAuth2 client ──────────────────────────────────
function createAuthClient(): OAuth2Client {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error(
      "Missing environment variables. Run `npm run setup` first, " +
      "then ensure .env contains GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN."
    );
  }

  const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return client;
}

export interface ListMessagesOpts {
  query?: string;
  labelIds?: string | string[];
  maxResults?: number;
}

export interface SendMessageAttachment {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface SendMessageOpts {
  to: string;
  subject: string;
  body?: string;
  html?: string;
  bcc?: string;
  from?: string;
  replyToMessageId?: string;
  attachments?: SendMessageAttachment[];
}

export interface GmailClient {
  listMessages(opts?: ListMessagesOpts): Promise<gmail_v1.Schema$Message[]>;
  getMessage(messageId: string, format?: string): Promise<gmail_v1.Schema$Message>;
  getMessageWithAttachments(messageId: string): Promise<MessageWithAttachments>;
  readMessage(messageId: string): Promise<DecodedMessage>;
  listAttachments(messageId: string): Promise<GmailAttachment[]>;
  sendMessage(opts: SendMessageOpts): Promise<gmail_v1.Schema$Message>;
  modifyMessage(messageId: string, addLabelIds?: string[], removeLabelIds?: string[]): Promise<gmail_v1.Schema$Message>;
  markAsRead(id: string): Promise<gmail_v1.Schema$Message>;
  archive(id: string): Promise<gmail_v1.Schema$Message>;
  getProfile(): Promise<gmail_v1.Schema$Profile>;
  downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  listLabels(nameFilter?: string): Promise<gmail_v1.Schema$Label[]>;
  getThreadMessages(threadId: string): Promise<MessageWithAttachments[]>;
}

// ── Exported factory ───────────────────────────────────────────────────────
export function createGmailClient(): GmailClient {
  const auth = createAuthClient();
  const gmail = google.gmail({ version: "v1", auth });

  /**
   * List messages in a label.
   */
  async function listMessages({ query = "", labelIds = "INBOX", maxResults = 10 }: ListMessagesOpts = {}): Promise<gmail_v1.Schema$Message[]> {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      // Gmail API requires labelIds as an array, not a plain string
      labelIds: Array.isArray(labelIds) ? labelIds : [labelIds],
      maxResults,
    });
    return res.data.messages ?? [];
  }

  /**
   * Fetch a single raw message resource.
   */
  async function getMessage(messageId: string, format: string = "full"): Promise<gmail_v1.Schema$Message> {
    const res = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format,
    });
    return res.data;
  }

  /**
   * Fetch a message ONCE and return both decoded fields AND attachments.
   * Use this instead of calling readMessage + listAttachments separately —
   * those would each make a full API round-trip for the same message.
   */
  async function getMessageWithAttachments(messageId: string): Promise<MessageWithAttachments> {
    const raw = await getMessage(messageId, "full");

    const headers = Object.fromEntries(
      (raw.payload?.headers ?? []).map((h) => [(h.name ?? "").toLowerCase(), h.value ?? ""])
    );

    const msg: DecodedMessage = {
      id:       raw.id!,
      threadId: raw.threadId ?? null,
      subject:  headers["subject"] ?? "(no subject)",
      from:     headers["from"]    ?? "",
      to:       headers["to"]      ?? "",
      date:     headers["date"]    ?? "",
      snippet:  raw.snippet        ?? "",
      body:     extractBody(raw.payload),
    };

    const attachments: GmailAttachment[] = [];
    collectAttachments(raw.payload, attachments);

    return { msg, attachments };
  }

  /** Convenience wrapper — decoded message fields only. */
  async function readMessage(messageId: string): Promise<DecodedMessage> {
    const { msg } = await getMessageWithAttachments(messageId);
    return msg;
  }

  /** Convenience wrapper — attachments list only. */
  async function listAttachments(messageId: string): Promise<GmailAttachment[]> {
    const { attachments } = await getMessageWithAttachments(messageId);
    return attachments;
  }

  /**
   * Send an email.
   * @param opts.to
   * @param opts.subject
   * @param opts.body                Plain-text body
   * @param opts.bcc               Blind-copy recipient(s); comma-separated for several. Gmail strips the Bcc header from the delivered message but still delivers to it.
   * @param opts.from              Defaults to authenticated account
   * @param opts.replyToMessageId  Thread reply support
   */
  async function sendMessage({ to, subject, body, html, bcc, from, replyToMessageId, attachments = [] }: SendMessageOpts): Promise<gmail_v1.Schema$Message> {
    if (!to || !subject || (!body && !html)) throw new Error("`to`, `subject`, and `body` or `html` are required.");

    // Strip CR/LF before these reach a raw header line. None of `to`,
    // `subject`, or `from` should ever legitimately contain a newline; if one
    // did (e.g. a crafted "From:" display name parsed out of a phishing-style
    // email), leaving it in would let it inject extra MIME headers (e.g. a
    // hidden Bcc:) into the raw message.
    const stripCrlf = (s: unknown) => String(s ?? "").replace(/[\r\n]+/g, " ");
    to      = stripCrlf(to);
    subject = stripCrlf(subject);
    from    = from ? stripCrlf(from) : from;
    bcc     = bcc ? stripCrlf(bcc) : bcc;

    // Encode non-ASCII header values per RFC 2047 (e.g. Thai text in subject)
    const encodeHeader = (str: string) =>
      /[^\x00-\x7F]/.test(str)
        ? `=?utf-8?B?${Buffer.from(str, "utf8").toString("base64")}?=`
        : str;

    // Encode an address header (To:/From:) correctly per RFC 2047.
    // Only the display name is encoded — the <addr> part must stay literal,
    // otherwise Gmail rejects the message with "Invalid To header".
    // e.g. "สมชาย <dr@hosp.com>" → "=?utf-8?B?...?= <dr@hosp.com>"
    // e.g. "dr@hosp.com"         → "dr@hosp.com"  (no encoding needed)
    const encodeAddressHeader = (str: string): string => {
      const m = str.match(/^(.*?)\s*<([^>]+)>\s*$/);
      if (m) {
        const name = m[1]!.trim();
        const addr = m[2]!.trim();
        return name ? `${encodeHeader(name)} <${addr}>` : `<${addr}>`;
      }
      return str; // plain address — no encoding needed
    };

    // Encode a comma-separated list of addresses (used for Bcc, which may
    // carry more than one recipient). Each entry is encoded independently.
    const encodeAddressList = (str: string) =>
      String(str).split(",").map((s) => s.trim()).filter(Boolean).map(encodeAddressHeader).join(", ");

    // Resolve thread ID and add In-Reply-To/References headers for thread replies.
    // Extracted to avoid duplicating the same fetch logic in both send paths.
    async function resolveThreadHeaders(headerLines: string[]): Promise<string | null> {
      if (!replyToMessageId) return null;
      const orig = await getMessage(replyToMessageId, "metadata");
      const origHeaders = Object.fromEntries(
        (orig.payload?.headers ?? []).map((h) => [(h.name ?? "").toLowerCase(), h.value ?? ""])
      );
      const msgId = origHeaders["message-id"];
      const refs  = origHeaders["references"];
      if (msgId) {
        headerLines.push(`In-Reply-To: ${msgId}`);
        headerLines.push(`References: ${refs ? refs + " " + msgId : msgId}`);
      }
      return orig.threadId ?? null;
    }

    // Build MIME message — multipart/mixed when attachments present,
    // multipart/alternative when both html and plain text provided,
    // single part otherwise.
    // Content-Transfer-Encoding: 8bit declares that parts contain UTF-8 (8-bit) bytes.
    // Without it the implicit encoding is 7bit (ASCII only), which can corrupt Thai text
    // in email clients that strictly follow RFC 2822.

    // ── Path: attachments → multipart/mixed wrapping multipart/alternative ──
    if (attachments.length > 0) {
      const outerBnd = `mixed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const innerBnd = `alt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const plainText = body || "กรุณาเปิดอีเมลด้วยโปรแกรมที่รองรับ HTML";

      const headerLines = [
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${outerBnd}"`,
        `To: ${encodeAddressHeader(to)}`,
        `Subject: ${encodeHeader(subject)}`,
        ...(bcc ? [`Bcc: ${encodeAddressList(bcc)}`] : []),
        ...(from ? [`From: ${encodeAddressHeader(from)}`] : []),
      ];

      const threadId = await resolveThreadHeaders(headerLines);

      let mime = headerLines.join("\r\n") + "\r\n\r\n";

      // Inner body (multipart/alternative: plain + html)
      mime += `--${outerBnd}\r\n`;
      mime += `Content-Type: multipart/alternative; boundary="${innerBnd}"\r\n\r\n`;
      mime += `--${innerBnd}\r\n`;
      mime += `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
      mime += plainText + "\r\n";
      if (html) {
        mime += `--${innerBnd}\r\n`;
        mime += `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
        mime += html + "\r\n";
      }
      mime += `--${innerBnd}--\r\n`;

      // Attachment parts — base64, line-wrapped at 76 chars per RFC 2045
      for (const att of attachments) {
        const b64    = (att.buffer.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
        const safeFilename = encodeHeader(att.filename);
        mime += `--${outerBnd}\r\n`;
        mime += `Content-Type: ${att.mimeType}; name="${safeFilename}"\r\n`;
        mime += `Content-Disposition: attachment; filename="${safeFilename}"\r\n`;
        mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
        mime += b64 + "\r\n";
      }
      mime += `--${outerBnd}--`;

      const raw = Buffer.from(mime).toString("base64")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw, ...(threadId ? { threadId } : {}) },
      });
      return res.data;
    }

    if (html) {
      const boundary = `boundary_${Date.now().toString(36)}`;
      const plainText = body || "กรุณาเปิดอีเมลด้วยโปรแกรมที่รองรับ HTML";
      const headerLines = [
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        `To: ${encodeAddressHeader(to)}`,
        `Subject: ${encodeHeader(subject)}`,
        ...(bcc ? [`Bcc: ${encodeAddressList(bcc)}`] : []),
        ...(from ? [`From: ${encodeAddressHeader(from)}`] : []),
      ];

      const threadId = await resolveThreadHeaders(headerLines);

      const mimeBody = headerLines.join("\r\n") + "\r\n\r\n"
        + `--${boundary}\r\n`
        + `Content-Type: text/plain; charset=utf-8\r\n`
        + `Content-Transfer-Encoding: 8bit\r\n\r\n`
        + plainText + "\r\n"
        + `--${boundary}\r\n`
        + `Content-Type: text/html; charset=utf-8\r\n`
        + `Content-Transfer-Encoding: 8bit\r\n\r\n`
        + html + "\r\n"
        + `--${boundary}--`;

      const raw = Buffer.from(mimeBody)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw, ...(threadId ? { threadId } : {}) },
      });
      return res.data;
    }

    // Plain-text fallback
    const headerLines = [
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: 8bit`,
      `To: ${encodeAddressHeader(to)}`,
      `Subject: ${encodeHeader(subject)}`,
    ];

    if (bcc)  headerLines.push(`Bcc: ${encodeAddressList(bcc)}`);
    if (from) headerLines.push(`From: ${encodeAddressHeader(from)}`);

    const threadId = await resolveThreadHeaders(headerLines);

    const raw = Buffer.from(headerLines.join("\r\n") + "\r\n\r\n" + body)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, ...(threadId ? { threadId } : {}) },
    });

    return res.data;
  }

  /**
   * Modify message labels.
   * @param messageId
   * @param addLabelIds     e.g. ["UNREAD"]
   * @param removeLabelIds  e.g. ["INBOX"]
   */
  async function modifyMessage(messageId: string, addLabelIds: string[] = [], removeLabelIds: string[] = []): Promise<gmail_v1.Schema$Message> {
    const res = await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { addLabelIds, removeLabelIds },
    });
    return res.data;
  }

  const markAsRead = (id: string) => modifyMessage(id, [], ["UNREAD"]);
  const archive    = (id: string) => modifyMessage(id, [], ["INBOX"]);

  async function getProfile(): Promise<gmail_v1.Schema$Profile> {
    const res = await gmail.users.getProfile({ userId: "me" });
    return res.data;
  }

  /**
   * Download a single attachment and return its raw Buffer.
   */
  async function downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    // Explicit timeout — without one, a slow/stalled response to a large
    // attachment can hang this call (and the whole run, since messages are
    // processed sequentially) indefinitely. Callers should also check the
    // attachment's advertised size before calling this (see MAX_MESSAGES /
    // config.js) — this timeout is a backstop, not a size limit.
    const res = await gmail.users.messages.attachments.get(
      { userId: "me", messageId, id: attachmentId },
      { timeout: 60_000 }
    );
    // Gmail encodes attachment data as base64url (- and _ instead of + and /)
    const base64 = (res.data.data ?? "").replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(base64, "base64");
  }

  /**
   * List Gmail labels, optionally filtered by partial case-insensitive name.
   */
  async function listLabels(nameFilter?: string): Promise<gmail_v1.Schema$Label[]> {
    const res = await gmail.users.labels.list({ userId: "me" });
    const labels = res.data.labels ?? [];
    if (!nameFilter) return labels;
    const q = nameFilter.toLowerCase();
    return labels.filter((l) => (l.name ?? "").toLowerCase().includes(q));
  }

  /**
   * Fetch all messages in a thread and return them with decoded fields and
   * attachments — same shape as getMessageWithAttachments, one entry per message.
   * Messages are returned in chronological order (oldest first).
   */
  async function getThreadMessages(threadId: string): Promise<MessageWithAttachments[]> {
    const res = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });
    return (res.data.messages ?? []).map((raw) => {
      const headers = Object.fromEntries(
        (raw.payload?.headers ?? []).map((h) => [(h.name ?? "").toLowerCase(), h.value ?? ""])
      );
      const msg: DecodedMessage = {
        id:       raw.id!,
        threadId: raw.threadId ?? null,
        subject:  headers["subject"] ?? "(no subject)",
        from:     headers["from"]    ?? "",
        date:     headers["date"]    ?? "",
        body:     extractBody(raw.payload),
      };
      const attachments: GmailAttachment[] = [];
      collectAttachments(raw.payload, attachments);
      return { msg, attachments };
    });
  }

  return {
    listMessages, getMessage, getMessageWithAttachments,
    readMessage, listAttachments,
    sendMessage, modifyMessage, markAsRead, archive,
    getProfile, downloadAttachment, listLabels, getThreadMessages,
  };
}

// ── Internal helpers ───────────────────────────────────────────────────────

function decodeBase64url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf8");
}

function collectAttachments(part: gmail_v1.Schema$MessagePart | undefined | null, result: GmailAttachment[]): void {
  if (!part) return;

  const isAttachment =
    part.filename &&
    part.filename.length > 0 &&
    part.body?.attachmentId;

  if (isAttachment) {
    result.push({
      partId:       part.partId,
      attachmentId: part.body!.attachmentId!,
      filename:     part.filename!,
      // Default mimeType to avoid undefined values in callers
      mimeType:     part.mimeType ?? "application/octet-stream",
      size:         part.body?.size ?? 0,
    });
  }

  for (const child of part.parts ?? []) {
    collectAttachments(child, result);
  }
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined | null): string {
  if (!payload) return "";

  const mimeType = payload.mimeType ?? "";

  // Plain text — best case
  if (mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64url(payload.body.data);
  }

  // Multipart — recurse into each part.
  // Do NOT re-check part.mimeType after recursion: a multipart/alternative
  // sub-part correctly returns plain text via its own recursion, but its own
  // mimeType is "multipart/alternative" — not "text/plain" — so the old
  // mimeType check would silently discard that text.
  if (mimeType.startsWith("multipart/")) {
    let htmlFallback = "";
    for (const part of payload.parts ?? []) {
      const partMime = part.mimeType ?? "";
      const text = extractBody(part);
      if (!text) continue;
      // Prefer plain text from any depth; accept HTML only as last resort
      if (partMime === "text/plain" || partMime.startsWith("multipart/")) return text;
      if (partMime === "text/html") htmlFallback = text;
    }
    return htmlFallback;
  }

  // Only decode data if this is a text type — previously this decoded ALL
  // MIME parts including attachments and binary data as UTF-8, returning garbage
  if (mimeType.startsWith("text/") && payload.body?.data) {
    return decodeBase64url(payload.body.data);
  }

  return "";
}
