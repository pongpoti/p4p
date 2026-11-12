/**
 * review-email.ts
 *
 * Pong, 2026-11-12: when the ผู้จัดทำ presses ส่ง in the dashboard's ตรวจสอบ
 * tab, the month goes to the auditor by email, the way the secretary has
 * sent it by hand: from sakhonmso to p4pskh and the usual people, filed under
 * the Gmail label เอกสาร อกพ, with the round's SK03 and รวมค่าคะแนน
 * attached. A later round of the same month is a reply in that thread,
 * marked แก้ไขครั้งที่ N, naming the people whose numbers changed.
 *
 * scripts/review-email-2026-11.sql queues one review_emails row per round
 * sent (and per press of the tab's ส่งอีเมล button). The always-on relay
 * (scripts/drain-uploads.ts, with the 2.2 and 2.8 starts) calls
 * sendQueuedReviewEmail() every 30 s; it claims one row, attaches the two
 * files exactly as the round's build stored them (Storage, review-files),
 * sends, labels, writes the result back and tells the admin on Telegram.
 *
 * Recipients, greeting and signature come from review_email_settings, never
 * from this public repository. While that row has no recipients and no
 * test_to, nothing is claimed: the emails wait, queued. With test_to set,
 * every mail goes to that one address only, subject marked [ทดสอบ], and it
 * neither counts as the month's thread nor is labelled.
 *
 * Never twice: each mail carries X-P4P-Review-Email: <row id>. A retry (an
 * error after Gmail may have taken the mail, or a claim 15 minutes old) first
 * looks for that tag in Sent and only records the result when it is there.
 *
 * Quiet until the SQL is installed, and never throws into the drain loop.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { archiveSentToLabel, createGmailClient, type GmailClient } from "./gmail-client.js";
import { sendTelegram } from "./telegram.js";
import { MONTH_TOKENS_BY_NUM } from "./months.js";
import { missingTable } from "./review-dispatch.js";

export const REVIEW_LABEL = "เอกสาร อกพ";
export const AUTO_NOTE = "(อีเมลฉบับนี้ส่งจากระบบอัตโนมัติ)";
export const TAG_HEADER = "X-P4P-Review-Email";
export const MAX_TRIES = 3;
export const RETRY_MS = 5 * 60_000;
/** The changed people named in a correction mail; the rest are counted. */
export const NAMES_SHOWN = 30;
const BUCKET = "review-files";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

export interface EmailSettings {
  recipients: string[];
  greeting: string;
  signature: string[];
  test_to: string;
}

export interface EmailRow {
  id: number;
  month: string;
  round_id: number | null;
  round_no: number;
  build_id: string | null;
  status: string;
  attempts: number;
}

export interface SentRow {
  id: number;
  round_id: number | null;
  build_id: string | null;
  gmail_id: string;
  thread_id: string;
}

export interface PersonSnap {
  roster_index: string;
  name: string;
  department: string;
  is_intern: boolean;
  sk03_score: number | string | null;
  sk03_pay: number | string | null;
}

// ── The mail itself (pure, so it is testable) ──────────────────────────────

/** "2569_08" → "สิงหาคม 2569" (the month key is the Buddhist year). */
export function thaiMonth(month: string): string {
  const m = /^(\d{4})_(\d{2})$/.exec(month);
  const name = m ? MONTH_TOKENS_BY_NUM[Number(m[2])]?.[0] : undefined;
  if (!m || !name) throw new Error(`bad month ${month}`);
  return `${name} ${m[1]}`;
}

export function emailSubject(month: string, o: { test: boolean; reply: boolean }): string {
  return (o.reply ? "Re: " : "") + (o.test ? "[ทดสอบ] " : "") + "เอกสาร P4P เดือน" + thaiMonth(month);
}

/** "แก้ไข 3 คน: a, b, c", the first NAMES_SHOWN named. */
export function changedLine(names: string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).join(", ");
  const more = names.length > NAMES_SHOWN ? ` และอีก ${names.length - NAMES_SHOWN} คน` : "";
  return `แก้ไข ${names.length} คน: ${shown}${more}`;
}

/**
 * Pong's wording (2026-11-12). fixNo 0 is the month's first mail; a
 * correction names who changed when that is known (changed null: the earlier
 * build is gone, so the line is left out).
 */
export function emailBody(o: { month: string; greeting: string; signature: string[]; fixNo: number; changed: string[] | null }): string {
  const lead = "ขอจัดส่ง เอกสาร P4P เดือน" + thaiMonth(o.month)
    + (o.fixNo > 0 ? " แก้ไขครั้งที่ " + o.fixNo : "")
    + " รายละเอียดตามไฟล์แนบ เพื่อใช้ประกอบการตรวจสอบความถูกต้องของข้อมูลค่ะ";
  const lines: string[] = [];
  if (o.greeting.trim()) lines.push(o.greeting.trim(), "");
  lines.push(lead);
  if (o.fixNo > 0 && o.changed && o.changed.length) lines.push(changedLine(o.changed));
  lines.push("");
  const sig = o.signature.map((s) => s.trim()).filter(Boolean);
  if (sig.length) lines.push(...sig, "");
  lines.push(AUTO_NOTE);
  return lines.join("\n");
}

export function attachmentNames(month: string): { sk03: string; merged: string } {
  const my = thaiMonth(month);
  return {
    sk03: `แบบฟอร์ม SK03 องค์กรแพทย์ เดือน${my}.xlsx`,
    merged: `รวมค่าคะแนนองค์กรแพทย์ เดือน${my}.xlsx`,
  };
}

const num = (v: number | string | null): number | null => (v === null || v === "" ? null : Number(v));

/**
 * Who changed between the build last mailed and this one: a new person, one
 * gone, or a different name, department, staff/intern, SK03 score or pay.
 * Names in Thai order.
 */
export function changedPeople(before: PersonSnap[], now: PersonSnap[]): string[] {
  const old = new Map(before.map((p) => [p.roster_index, p]));
  const seen = new Set<string>();
  const names: string[] = [];
  for (const p of now) {
    seen.add(p.roster_index);
    const q = old.get(p.roster_index);
    if (!q || q.name !== p.name || q.department !== p.department || q.is_intern !== p.is_intern
        || num(q.sk03_score) !== num(p.sk03_score) || num(q.sk03_pay) !== num(p.sk03_pay)) names.push(p.name);
  }
  for (const q of before) if (!seen.has(q.roster_index)) names.push(q.name);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, "th"));
}

/** The To line: test_to alone in test mode, else the recipients that look like addresses. */
export function recipientsOf(s: EmailSettings): { to: string; test: boolean } | null {
  const test = s.test_to.trim();
  if (test) return EMAIL_RE.test(test) ? { to: test, test: true } : null;
  const list = s.recipients.map((r) => r.trim()).filter((r) => EMAIL_RE.test(r));
  return list.length ? { to: list.join(", "), test: false } : null;
}

/**
 * The month's earlier mails decide the thread and the number: reply to the
 * newest one, and count the ones that were for another round (a test only
 * counts tests, a real mail only real ones).
 */
export function threadOf(row: Pick<EmailRow, "round_id">, earlier: SentRow[]): { replyTo: string | null; fixNo: number; compareBuild: string | null } {
  const last = earlier.at(-1) ?? null;
  const others = earlier.filter((e) => e.round_id === null || e.round_id !== row.round_id);
  return {
    replyTo: last && last.gmail_id ? last.gmail_id : null,
    fixNo: others.length,
    compareBuild: others.at(-1)?.build_id ?? null,
  };
}

// ── Sending ─────────────────────────────────────────────────────────────────

export interface ReviewEmailDeps {
  db: SupabaseClient;
  gmail: Pick<GmailClient, "sendMessage" | "listMessages" | "getMessage" | "ensureLabel" | "modifyMessage">;
  telegram(text: string): Promise<unknown>;
  now(): number;
}

let disabled = false;
let warnedSetup = false;
let _deps: ReviewEmailDeps | null = null;

function defaultDeps(): ReviewEmailDeps | null {
  if (_deps) return _deps;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  let gmail: GmailClient | null = null;
  const g = (): GmailClient => (gmail ??= createGmailClient());
  _deps = {
    db: createClient(url, key),
    gmail: {
      sendMessage: (o) => g().sendMessage(o),
      listMessages: (o) => g().listMessages(o),
      getMessage: (id, f) => g().getMessage(id, f),
      ensureLabel: (n) => g().ensureLabel(n),
      modifyMessage: (id, a, r) => g().modifyMessage(id, a, r),
    },
    telegram: (t) => sendTelegram(t),
    now: () => Date.now(),
  };
  return _deps;
}

/** Tests: forget the "turned off" and "not set up" notes. */
export function resetReviewEmailForTests(): void { disabled = false; warnedSetup = false; _deps = null; }

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function tell(d: ReviewEmailDeps, text: string): Promise<void> {
  try { await d.telegram(text); } catch (e) { console.error(`│  ⚠️  ตรวจสอบ tab email: Telegram failed: ${msg(e)}`); }
}

/** Is the mail tagged with this row already in Sent? Its ids if so. */
async function findSent(d: ReviewEmailDeps, id: number): Promise<{ id: string; threadId: string } | null> {
  const list = await d.gmail.listMessages({ query: "newer_than:3d has:attachment filename:xlsx", labelIds: "SENT", maxResults: 50 });
  for (const m of list) {
    if (!m.id) continue;
    const full = await d.gmail.getMessage(m.id, "metadata");
    const tag = (full.payload?.headers ?? []).find((h) => (h.name ?? "").toLowerCase() === TAG_HEADER.toLowerCase());
    if (tag && String(tag.value ?? "").trim() === String(id)) return { id: m.id, threadId: full.threadId ?? "" };
  }
  return null;
}

async function download(d: ReviewEmailDeps, path: string): Promise<Buffer> {
  const { data, error } = await d.db.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`ดาวน์โหลดไฟล์ไม่ได้ (${error ? error.message : "no data"})`);
  return Buffer.from(await data.arrayBuffer());
}

async function people(d: ReviewEmailDeps, buildId: string): Promise<PersonSnap[] | null> {
  const { data, error } = await d.db.from("review_build_people")
    .select("roster_index, name, department, is_intern, sk03_score, sk03_pay").eq("build_id", buildId);
  if (error) throw new Error(`review_build_people: ${error.message}`);
  return (data ?? []) as PersonSnap[];
}

/** A failure the next try cannot fix: the round's files are gone. */
class Permanent extends Error {}

/** Sends at most one queued email. True when it sent (or found) one. */
export async function sendQueuedReviewEmail(deps?: ReviewEmailDeps): Promise<boolean> {
  if (disabled) return false;
  const d = deps ?? defaultDeps();
  if (!d) return false;
  let row: EmailRow | null = null;
  try {
    // Cheap look first: one query every 30 s while nothing waits.
    const now = new Date(d.now()).toISOString();
    const stale = new Date(d.now() - 15 * 60_000).toISOString();
    const { data: waiting, error: peekErr } = await d.db.from("review_emails").select("id")
      .or(`and(status.eq.queued,or(next_try_at.is.null,next_try_at.lte.${now})),and(status.eq.sending,claimed_at.lt.${stale})`)
      .limit(1);
    if (peekErr) {
      if (missingTable(peekErr)) { disabled = true; console.log("│  ℹ️  ตรวจสอบ tab email: off (scripts/review-email-2026-11.sql not run yet)"); return false; }
      throw new Error(peekErr.message);
    }
    if (!waiting?.length) return false;

    const { data: set, error: setErr } = await d.db.from("review_email_settings").select("recipients, greeting, signature, test_to").eq("id", 1).maybeSingle();
    if (setErr) throw new Error(`review_email_settings: ${setErr.message}`);
    const settings: EmailSettings = {
      recipients: (set?.recipients as string[] | null) ?? [], greeting: String(set?.greeting ?? ""),
      signature: (set?.signature as string[] | null) ?? [], test_to: String(set?.test_to ?? ""),
    };
    const to = recipientsOf(settings);
    if (!to) {
      if (!warnedSetup) { warnedSetup = true; console.log("│  ℹ️  ตรวจสอบ tab email: waiting (review_email_settings has no recipients yet)"); }
      return false;
    }

    const { data: claimed, error: claimErr } = await d.db.rpc("claim_review_email");
    if (claimErr) throw new Error(`claim_review_email: ${claimErr.message}`);
    row = ((Array.isArray(claimed) ? claimed[0] : claimed) ?? null) as EmailRow | null;
    if (!row?.id) return false;
    const r = row;
    const label = `${thaiMonth(r.month)} รอบที่ ${r.round_no}`;

    // A retry: the last try may have reached Gmail. Record it, never resend.
    let sent: { id: string; threadId: string } | null = r.attempts > 1 ? await findSent(d, r.id) : null;
    let fixNo = 0;
    if (!sent) {
      if (r.attempts > MAX_TRIES) throw new Permanent(`ลองส่งครบ ${MAX_TRIES} ครั้งแล้ว`);
      if (!r.build_id) throw new Permanent("ไม่พบไฟล์ของรอบนี้ (ระบบลบไฟล์ไปแล้ว)");
      const { data: b, error: bErr } = await d.db.from("review_builds").select("sk03_path, merged_path").eq("id", r.build_id).maybeSingle();
      if (bErr) throw new Error(`review_builds: ${bErr.message}`);
      if (!b) throw new Permanent("ไม่พบไฟล์ของรอบนี้ (ระบบลบไฟล์ไปแล้ว)");

      const { data: before, error: eErr } = await d.db.from("review_emails")
        .select("id, round_id, build_id, gmail_id, thread_id")
        .eq("month", r.month).eq("status", "sent").eq("test", to.test).neq("id", r.id).order("sent_at", { ascending: true });
      if (eErr) throw new Error(`review_emails: ${eErr.message}`);
      const th = threadOf(r, (before ?? []) as SentRow[]);
      fixNo = th.fixNo;
      let changed: string[] | null = null;
      if (th.fixNo > 0 && th.compareBuild) {
        const [a, z] = await Promise.all([people(d, th.compareBuild), people(d, r.build_id)]);
        changed = a && a.length && z ? changedPeople(a, z) : null;
      }

      const names = attachmentNames(r.month);
      const [sk03, merged] = await Promise.all([download(d, String(b.sk03_path)), download(d, String(b.merged_path))]);
      const res = await d.gmail.sendMessage({
        to: to.to,
        subject: emailSubject(r.month, { test: to.test, reply: !!th.replyTo }),
        body: emailBody({ month: r.month, greeting: settings.greeting, signature: settings.signature, fixNo, changed }),
        replyToMessageId: th.replyTo ?? undefined,
        attachments: [
          { buffer: sk03, filename: names.sk03, mimeType: XLSX },
          { buffer: merged, filename: names.merged, mimeType: XLSX },
        ],
        headers: { [TAG_HEADER]: String(r.id) },
      });
      sent = { id: res.id ?? "", threadId: res.threadId ?? "" };
      // Kanda's label for the month's mails; a test stays out of it.
      if (!to.test) await archiveSentToLabel(d.gmail as GmailClient, { id: sent.id }, REVIEW_LABEL);
    } else {
      const { data: before } = await d.db.from("review_emails").select("id, round_id, build_id, gmail_id, thread_id")
        .eq("month", r.month).eq("status", "sent").eq("test", to.test).neq("id", r.id);
      fixNo = threadOf(r, (before ?? []) as SentRow[]).fixNo;
    }

    const done = {
      status: "sent", gmail_id: sent.id, thread_id: sent.threadId, sent_at: new Date(d.now()).toISOString(),
      sent_to: to.to, test: to.test, fix_no: fixNo, error: "", next_try_at: null,
    };
    let saved = false;
    for (let i = 0; i < 3 && !saved; i++) {
      const { error } = await d.db.from("review_emails").update(done).eq("id", r.id);
      saved = !error;
      if (error) console.error(`│  ❌  ตรวจสอบ tab email: could not record email ${r.id} as sent: ${error.message}`);
    }
    const n = to.to.split(",").length;
    console.log(`│  📧  ตรวจสอบ tab: emailed ${r.month} round ${r.round_no}${to.test ? " (test)" : ""} to ${n} address(es)`);
    await tell(d, to.test
      ? `🧪 ส่งอีเมลทดสอบ P4P ${label} แล้ว (ถึงที่อยู่ทดสอบเท่านั้น)`
      : `📧 ส่งอีเมล P4P ${label} ถึงผู้ตรวจสอบแล้ว (${n} คน)${fixNo > 0 ? ` · แก้ไขครั้งที่ ${fixNo}` : ""}` +
        (saved ? "" : "\n⚠️ บันทึกผลในระบบไม่สำเร็จ ระบบจะตรวจซ้ำและไม่ส่งซ้ำ"));
    return true;
  } catch (err) {
    console.error(`│  ❌  ตรวจสอบ tab email: ${msg(err)}`);
    if (!row?.id) return false;
    const r = row;
    const final = err instanceof Permanent || r.attempts >= MAX_TRIES;
    const why = msg(err).slice(0, 500);
    const { error } = await d.db.from("review_emails").update(final
      ? { status: "failed", error: why, next_try_at: null }
      : { status: "queued", error: why, next_try_at: new Date(d.now() + RETRY_MS).toISOString() },
    ).eq("id", r.id);
    if (error) console.error(`│  ❌  ตรวจสอบ tab email: could not record the failure: ${error.message}`);
    if (final) {
      await tell(d, `❌ ส่งอีเมล P4P ${(() => { try { return thaiMonth(r.month); } catch { return r.month; } })()} รอบที่ ${r.round_no} ไม่สำเร็จ: ${why}\nกด "ส่งอีเมล" ในแท็บตรวจสอบเพื่อลองอีกครั้ง`);
    }
    return false;
  }
}
