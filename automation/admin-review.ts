/**
 * admin-review.ts
 *
 * Submissions the pipeline will not decide on its own, and holds for the
 * admin instead:
 *
 *   ambiguous_name  -> the physician name fits two or more roster rows
 *                      equally well (the same name twice in the roster, or
 *                      a partial name that fits several physicians), so any
 *                      choice could write one physician's score onto
 *                      another's row (supabase-client.ts pickRosterMatch).
 *   score_conflict  -> Claude's total and the deterministic JS total
 *                      disagree, and the JS method is not one trusted on its
 *                      own (claude-analyst.ts chooseScore).
 *
 * Nothing is saved and no Drive file is replaced. The admin gets the details
 * on Telegram (a private chat, so names and scores are fine there); the
 * sender gets a short, polite notice that names no physician and no score.
 * Pure text builders; index.ts sends them.
 */

import type { RosterMatch } from "./types.js";

export type AdminReviewReason = "ambiguous_name" | "score_conflict";

/** The queue's error_type, and the LINE bubble's reason key, for a held upload. */
export const ADMIN_REVIEW_ERROR_TYPE = "admin_review";

const REASON_FOR_SENDER: Record<AdminReviewReason, string> = {
  ambiguous_name: "ชื่อแพทย์ในไฟล์ตรงกับรายชื่อแพทย์ในระบบได้มากกว่าหนึ่งท่าน ระบบจึงยังไม่บันทึกคะแนน เพื่อไม่ให้บันทึกคะแนนผิดคน",
  score_conflict: "ระบบอ่านคะแนนรวมจากไฟล์ได้ไม่ชัดเจน จึงยังไม่บันทึกคะแนนจนกว่าเจ้าหน้าที่จะตรวจสอบ",
};

/** The sender-facing explanation: the email notice's middle line, and the LINE bubble's detail. */
export function adminReviewDetail(reason: AdminReviewReason): string {
  return `${REASON_FOR_SENDER[reason]} เจ้าหน้าที่จะตรวจสอบและบันทึกคะแนนให้ ท่านไม่ต้องส่งไฟล์ใหม่`;
}

export const ADMIN_REVIEW_REPLY_SUBJECT = "ได้รับไฟล์ P4P แล้ว — รอเจ้าหน้าที่ตรวจสอบก่อนบันทึกคะแนน";

/** The email notice for a held submission. Fixed text: no physician, no score. */
export function adminReviewReplyBody(reason: AdminReviewReason): string {
  return [
    `เรียนผู้ส่ง`,
    ``,
    `องค์กรแพทย์ โรงพยาบาลสมุทรสาคร ได้รับไฟล์ P4P ที่ท่านส่งมาแล้ว`,
    ``,
    adminReviewDetail(reason),
    `หากต้องการข้อมูลเพิ่มเติม เจ้าหน้าที่จะติดต่อท่าน`,
    ``,
    `ขอบคุณที่ให้ความร่วมมือ`,
    ``,
    `อีเมลนี้เป็นระบบตอบกลับอัตโนมัติ`,
  ].join("\n");
}

export interface AdminReviewAlertData {
  reason: AdminReviewReason;
  /** The sender address (email path) or the verified account (LINE path). */
  sender: string;
  /** LINE path: the account's own name, which is what was looked up. */
  accountName?: string | null;
  source: "email" | "line-upload";
  nameInFile: string | null;
  monthKey: string;
  score: number;
  scoreMethod?: string | null;
  filename?: string | null;
  /** Gmail message id (email path). */
  messageId?: string | null;
  /** p4p_upload_queue row id (LINE path). */
  queueId?: string | null;
  /** ambiguous_name: the rows that fit equally well. */
  candidates?: RosterMatch[];
  /** score_conflict: the roster row the file matched, when one did. */
  match?: RosterMatch | null;
  /** score_conflict: the two readings. */
  conflict?: { claudeScore: number; jsScore: number; jsMethod: string } | null;
}

const row = (m: RosterMatch) => `#${m.index} ${m.matchedName}${m.department ? ` (${m.department})` : ""} — ${(m.similarity * 100).toFixed(0)}%`;

/** Telegram: a submission held for the admin, with what to do about it. */
export function formatAdminReviewAlert(d: AdminReviewAlertData, labelName: string): string {
  const title = d.reason === "ambiguous_name"
    ? `🔀 P4P: ชื่อแพทย์ตรงกับรายชื่อมากกว่าหนึ่งคน — ยังไม่บันทึกคะแนน`
    : `⚖️ P4P: คะแนนจาก Claude ไม่ตรงกับคะแนนที่ระบบอ่านได้ — ยังไม่บันทึกคะแนน`;
  const lines = [
    title,
    ``,
    `📥 Source   : ${d.source === "email" ? "Email" : "LINE upload"}`,
    `📧 ${d.source === "email" ? "Sender" : "Account"}   : ${d.sender}${d.accountName ? ` (${d.accountName})` : ""}`,
    `🔤 Name     : ${d.nameInFile ? `"${d.nameInFile}"` : "—"}${d.source === "email" ? " (อ่านจากไฟล์/อีเมล)" : " (ในไฟล์)"}`,
    `📅 Month    : ${d.monthKey}`,
  ];
  if (d.reason === "ambiguous_name") {
    lines.push(`🏅 Score    : ${d.score.toFixed(2)} (ในไฟล์${d.scoreMethod ? `, ${d.scoreMethod}` : ""})`);
    lines.push(`👥 Rows     :`, ...(d.candidates ?? []).map((m) => `   • ${row(m)}`));
  } else {
    if (d.match) lines.push(`👤 Physician: ${row(d.match)}`);
    if (d.conflict) {
      lines.push(`🧮 JS score : ${d.conflict.jsScore.toFixed(2)} (${d.conflict.jsMethod})`);
      lines.push(`🤖 Claude   : ${d.conflict.claudeScore.toFixed(2)}`);
    }
  }
  if (d.messageId) lines.push(`✉️ Gmail id : ${d.messageId}`);
  if (d.queueId)   lines.push(`🧾 Queue row: ${d.queueId}`);
  lines.push(``, `ระบบไม่บันทึกคะแนนและไม่อัปโหลดไฟล์ไปที่ Drive ผู้ส่งได้รับแจ้งว่าไฟล์รอเจ้าหน้าที่ตรวจสอบ`);
  lines.push(`วิธีดำเนินการ:`);
  if (d.reason === "ambiguous_name") {
    lines.push(`• ตรวจไฟล์ แล้วบันทึกคะแนนให้แถวที่ถูกต้องในตาราง ${d.monthKey} เอง`);
    if (d.source === "email") {
      lines.push(`• หรือแก้ชื่อในตาราง roster ให้ไม่ซ้ำกัน แล้วให้ระบบอ่านอีเมลใหม่: ย้ายกลับเข้า Inbox เอาป้าย "${labelName}" ออก และทำเครื่องหมายว่ายังไม่อ่าน`);
    } else if (d.queueId) {
      lines.push(`• หรือให้ระบบประมวลผลใหม่: ใน p4p_upload_queue แถว ${d.queueId} ตั้ง roster_index เป็นแถวที่ถูกต้อง แล้วตั้ง status='pending', attempts=0 (ไฟล์ยังเก็บไว้ให้)`);
    }
  } else {
    lines.push(`• เปิดไฟล์ตรวจคะแนนรวม แล้วบันทึกคะแนนที่ถูกต้องในตาราง ${d.monthKey} เอง`);
  }
  lines.push(``, `📎 File: ${d.filename ?? "(unknown)"}`);
  return lines.join("\n");
}
