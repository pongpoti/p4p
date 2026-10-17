/**
 * confirmation-email.ts
 *
 * The "ได้จัดเก็บไฟล์ P4P ของท่านแล้ว" email, shared by both submission paths:
 *
 *   email path   — index.ts sends it as a reply in the physician's own thread,
 *                  and that thread is labelled เอกสาร P4P with the rest of the
 *                  handled message.
 *   LINE upload  — scripts/drain-uploads.ts sends it as a new message to the
 *                  physician's registered address, then files the sent copy
 *                  under เอกสาร P4P itself, since there is no inbound email
 *                  for it to ride along with.
 *
 * One builder so the two paths can never drift into two formats.
 */

import type { gmail_v1 } from "googleapis";
import { buildHtmlReply } from "./templates/reply.js";
import { P4P_LABEL_NAME, archiveSentToLabel, type GmailClient } from "./gmail-client.js";

const THAI_MONTHS = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน",
  "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม",
  "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

export const CONFIRMATION_SUBJECT = "องค์กรแพทย์ รพ. สค.";

/** How the physician sent the file; shown in the email as ช่องทางการส่ง. */
export type SubmissionRoute = "email" | "line";
const ROUTE_LABELS: Record<SubmissionRoute, string> = { email: "อีเมล", line: "LINE" };

export interface ConfirmationData {
  prefix: string | null | undefined;
  matchedName: string;
  department: string | null | undefined;
  /** "YYYY_MM", BE year. */
  monthKey: string;
  score: number;
  route: SubmissionRoute;
}

export interface ConfirmationEmail {
  subject: string;
  html: string;
  body: string;
}

/** The email's subject, HTML and plain-text parts. Pure, so it is testable. */
export function buildConfirmationEmail({ prefix, matchedName, department, monthKey, score, route }: ConfirmationData): ConfirmationEmail {
  const [beYear, monthNum] = monthKey.split("_");
  const thaiMonth   = THAI_MONTHS[parseInt(monthNum ?? "", 10)] || monthNum;
  const displayDate = `${thaiMonth} ${beYear}`;

  // Build display name: "prefix firstname  lastname" (1 space after prefix, 2 between names)
  const prefixPart = prefix ? `${prefix.trim()} ` : "";
  const nameParts  = matchedName.trim().split(/\s+/);
  const spacedName = nameParts.length >= 2
    ? `${nameParts[0]}  ${nameParts.slice(1).join("  ")}`
    : matchedName;
  const displayName = `${prefixPart}${spacedName}`;
  const scoreText   = score.toFixed(2);
  const routeText   = ROUTE_LABELS[route];

  // buildHtmlReply escapes every value itself before interpolating into
  // HTML (defense-in-depth against XSS) — pass raw values here, not
  // pre-escaped ones, or they'd be double-escaped ("&" -> "&amp;amp;").
  const html = buildHtmlReply({
    displayName,
    safeDepartment : department ?? "",
    safeDisplayDate: displayDate,
    safeScore      : scoreText,
    safeRoute      : routeText,
  });

  return {
    subject: CONFIRMATION_SUBJECT,
    html,
    body: `เรียน ${displayName}\n\nองค์กรแพทย์ โรงพยาบาลสมุทรสาคร ได้จัดเก็บไฟล์ P4P ของท่านแล้ว\n\nชื่อแพทย์: ${displayName}\nเดือน/ปี: ${displayDate}\nคะแนนรวม: ${scoreText}\nช่องทางการส่ง: ${routeText}\n\nขอบคุณที่ให้ความร่วมมือเป็นอย่างดี`,  // plain text — no escaping needed
  };
}

/** Send the confirmation. With replyToMessageId it threads as a reply (email path). */
export function sendConfirmationEmail(
  gmail: GmailClient,
  to: string,
  data: ConfirmationData,
  replyToMessageId?: string,
): Promise<gmail_v1.Schema$Message> {
  return gmail.sendMessage({ to, ...buildConfirmationEmail(data), replyToMessageId });
}

/**
 * LINE-upload path: send the confirmation and file the sent copy under
 * เอกสาร P4P, the same label every handled email submission ends up in.
 * Never throws — the score is already saved, and a mail failure must not
 * turn a finished upload into a failed one. Returns whether the mail went out.
 */
export async function sendUploadConfirmation(gmail: GmailClient, to: string, data: ConfirmationData): Promise<boolean> {
  if (!to) return false;
  let sent: gmail_v1.Schema$Message;
  try {
    sent = await sendConfirmationEmail(gmail, to, data);
  } catch (err) {
    console.error(`│      ❌  Confirmation email to ${to} failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  console.log(`│      📧  Confirmation email sent to ${to}`);
  await archiveSentToLabel(gmail, sent, P4P_LABEL_NAME);
  return true;
}
