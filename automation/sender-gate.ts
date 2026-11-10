/**
 * sender-gate.ts
 *
 * Who may change a physician's score by email. An email submission names
 * its physician through text the sender controls (file name, subject, body,
 * sheet), so the name alone proves nothing. A sender is KNOWN for roster
 * physician P when their address is an active row of public.physicians (the
 * login allow-list) whose full_name is P's roster name. Relay mailboxes
 * (SKIP_SENDERS / THREAD_RELAY_SENDERS) are never anyone's identity; on the
 * relay path the original sender's address is the one checked.
 *
 *   known         -> processed exactly as before.
 *   new_unscored  -> unknown sender, P has no score this month yet: accepted
 *                    as before (Drive, score, confirmation), and the admin is
 *                    told a new address submitted for P and waits in the
 *                    access requests.
 *   hold          -> unknown sender, P already has a score this month: no
 *                    score saved, no Drive file replaced. The sender is told
 *                    the file waits for the admin; the admin is told how to
 *                    release it. The message is marked handled.
 *
 * The database side (scripts/, not this folder) makes sure a matched sender
 * is only ever added to physicians by an admin approving its access
 * request; this module only reads.
 */

export type SenderGate = "known" | "new_unscored" | "hold";

/** A physicians row, as getPhysicianByEmail() returns it. */
export interface PhysicianAccount {
  email: string;
  fullName: string | null;
  active: boolean;
}

/** Equal after trimming and collapsing runs of whitespace (NBSP and zero-width spaces included). */
export function sameRosterName(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => String(s ?? "").replace(/[\s ​ - 　﻿]+/g, " ").trim();
  const na = norm(a);
  return na !== "" && na === norm(b);
}

/** Is this account the roster physician's own? Only an active row with that exact name is. */
export function isKnownSender(account: PhysicianAccount | null, rosterName: string): boolean {
  return account !== null && account.active && sameRosterName(account.fullName, rosterName);
}

/** A roster row "has a score" once any number is saved on it. */
export function hasScore(score: number | null | undefined): boolean {
  return typeof score === "number" && Number.isFinite(score);
}

export interface SenderGateDeps {
  lookupAccount: (email: string) => Promise<PhysicianAccount | null>;
  lookupScore: (monthKey: string, rosterIndex: number | string) => Promise<number | null>;
  /** Addresses that are mailboxes of this system, never a physician (SKIP_SENDERS, THREAD_RELAY_SENDERS). */
  relaySenders: ReadonlySet<string>;
}

export interface SenderGateResult {
  gate: SenderGate;
  account: PhysicianAccount | null;
  /** The score already on the roster row; only looked up for an unknown sender. */
  rosterScore: number | null;
}

/**
 * The gate for one submission. Throws when a lookup fails: the caller leaves
 * the message unread for the next poll rather than guess either way.
 */
export async function decideSenderGate(senderEmail: string, rosterName: string, monthKey: string, rosterIndex: number | string, deps: SenderGateDeps): Promise<SenderGateResult> {
  const addr = String(senderEmail ?? "").trim().toLowerCase();
  const account = addr && !deps.relaySenders.has(addr) ? await deps.lookupAccount(addr) : null;
  if (isKnownSender(account, rosterName)) return { gate: "known", account, rosterScore: null };
  const rosterScore = await deps.lookupScore(monthKey, rosterIndex);
  return { gate: hasScore(rosterScore) ? "hold" : "new_unscored", account, rosterScore };
}

/** What the admin is told about the sender address, in a word or two. */
function accountStatus(account: PhysicianAccount | null): string {
  if (!account) return "ยังไม่มีในรายชื่อแพทย์ (physicians)";
  if (!account.active) return "มีในรายชื่อแต่ถูกปิดใช้งาน";
  return `ลงทะเบียนเป็นชื่อ "${account.fullName ?? "—"}" (ไม่ใช่แพทย์คนนี้)`;
}

export interface SenderAlertData {
  senderEmail: string;
  account: PhysicianAccount | null;
  physicianName: string;
  department?: string | null;
  monthKey: string;
  score: number;
  filename?: string | null;
  messageId: string;
  /** Did bump_sender_match run, i.e. does an access request for this address now wait for the admin? */
  requestRecorded: boolean;
}

const RELEASE_STEPS = (labelName: string, messageId: string) => [
  `วิธีปล่อยไฟล์ (เมื่อยืนยันแล้วว่าเป็นอีเมลของแพทย์คนนี้):`,
  `1) อนุมัติคำขอเข้าใช้ของอีเมลนี้ในแท็บ Roster ของ dashboard หรือใน LINE admin`,
  `2) ใน Gmail เปิดอีเมล ${messageId} ย้ายกลับเข้า Inbox เอาป้าย "${labelName}" ออก และทำเครื่องหมายว่ายังไม่อ่าน — ระบบจะอ่านใหม่ภายในประมาณหนึ่งนาที`,
  `หากไม่ใช่อีเมลของแพทย์คนนี้ ให้ปฏิเสธคำขอเข้าใช้ ไม่ต้องทำอย่างอื่น`,
];

/** Telegram: a held submission (unknown sender, physician already scored). Names are fine here: the admin chat is private. */
export function formatHoldAlert(d: SenderAlertData, existingScore: number | null, labelName: string): string {
  return [
    `⏸️ P4P: ไฟล์รอยืนยันอีเมลผู้ส่ง — ยังไม่บันทึกคะแนน`,
    ``,
    `📧 Sender   : ${d.senderEmail}`,
    `🔎 Address  : ${accountStatus(d.account)}`,
    `👤 Physician: ${d.physicianName}${d.department ? ` (${d.department})` : ""}`,
    `📅 Month    : ${d.monthKey}`,
    `🏅 Score    : ${d.score.toFixed(2)} (ในไฟล์) · คะแนนเดิม ${existingScore !== null ? existingScore.toFixed(2) : "—"}`,
    `✉️ Gmail id : ${d.messageId}`,
    ``,
    `แพทย์คนนี้มีคะแนนเดือนนี้อยู่แล้ว และอีเมลผู้ส่งยังไม่ได้ลงทะเบียนเป็นของแพทย์คนนี้ ระบบจึงไม่บันทึกคะแนนและไม่แทนที่ไฟล์ใน Drive ผู้ส่งได้รับแจ้งว่าไฟล์รอผู้ดูแลยืนยันแล้ว`,
    d.requestRecorded
      ? `คำขอเข้าใช้ของอีเมลนี้รออยู่ในรายการคำขอ`
      : `⚠️ บันทึกคำขอเข้าใช้ไม่สำเร็จ — ต้องเพิ่มอีเมลนี้ให้แพทย์คนนี้เองในแท็บ Roster`,
    ``,
    ...RELEASE_STEPS(labelName, d.messageId),
    ``,
    `📎 File: ${d.filename ?? "(unknown)"}`,
  ].join("\n");
}

/** Telegram: a new address submitted for a physician with no score yet; the submission was accepted. */
export function formatNewSenderAlert(d: SenderAlertData, scoreSaved: boolean): string {
  return [
    `🆕 P4P: อีเมลผู้ส่งใหม่ส่งไฟล์แทนแพทย์`,
    ``,
    `📧 Sender   : ${d.senderEmail}`,
    `🔎 Address  : ${accountStatus(d.account)}`,
    `👤 Physician: ${d.physicianName}${d.department ? ` (${d.department})` : ""}`,
    `📅 Month    : ${d.monthKey}`,
    `🏅 Score    : ${d.score.toFixed(2)} ${scoreSaved ? "(บันทึกแล้ว)" : "(บันทึกไม่สำเร็จ)"}`,
    `✉️ Gmail id : ${d.messageId}`,
    ``,
    `แพทย์คนนี้ยังไม่มีคะแนนเดือนนี้ ระบบจึงรับไฟล์ตามปกติ`,
    d.requestRecorded
      ? `อีเมลนี้รออนุมัติในคำขอเข้าใช้ (แท็บ Roster ของ dashboard หรือ LINE admin)`
      : `⚠️ บันทึกคำขอเข้าใช้ไม่สำเร็จ — หากเป็นอีเมลของแพทย์คนนี้ ให้เพิ่มเองในแท็บ Roster`,
    `หากไม่ใช่อีเมลของแพทย์คนนี้ ให้ปฏิเสธคำขอ และตรวจคะแนนกับไฟล์ใน Drive ของเดือนนี้`,
    ``,
    `📎 File: ${d.filename ?? "(unknown)"}`,
  ].join("\n");
}

export const HOLD_REPLY_SUBJECT = "ได้รับไฟล์ P4P แล้ว — รอผู้ดูแลระบบยืนยันอีเมลผู้ส่ง";

/**
 * The sender's reply for a held submission. Says nothing about which
 * physician the file was matched to, or any score: the sender is not yet
 * known to be that physician.
 */
export function holdReplyBody(): string {
  return [
    `เรียนผู้ส่ง`,
    ``,
    `องค์กรแพทย์ โรงพยาบาลสมุทรสาคร ได้รับไฟล์ P4P ที่ท่านส่งมาแล้ว`,
    ``,
    `อีเมลนี้ยังไม่ได้ลงทะเบียนในระบบเป็นอีเมลของแพทย์ที่ระบุในไฟล์ ไฟล์จึงรอผู้ดูแลระบบยืนยันอีเมลผู้ส่งก่อน และยังไม่ได้บันทึกคะแนน`,
    `เมื่อผู้ดูแลระบบยืนยันแล้ว ระบบจะประมวลผลไฟล์นี้ให้ ท่านไม่ต้องส่งไฟล์ใหม่`,
    ``,
    `ขอบคุณที่ให้ความร่วมมือ`,
    ``,
    `อีเมลนี้เป็นระบบตอบกลับอัตโนมัติ`,
  ].join("\n");
}
