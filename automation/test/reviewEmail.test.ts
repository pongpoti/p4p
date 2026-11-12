import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  thaiMonth, emailSubject, emailBody, changedLine, changedPeople, recipientsOf, threadOf, attachmentNames,
  sendQueuedReviewEmail, resetReviewEmailForTests, AUTO_NOTE, TAG_HEADER, REVIEW_LABEL, NAMES_SHOWN, RETRY_MS,
  type ReviewEmailDeps, type PersonSnap,
} from "../review-email.js";

// ── The mail itself ─────────────────────────────────────────────────────────

test("month words: the key's Buddhist year, July spelled กรกฎาคม", () => {
  assert.equal(thaiMonth("2569_08"), "สิงหาคม 2569");
  assert.equal(thaiMonth("2569_07"), "กรกฎาคม 2569");
  assert.throws(() => thaiMonth("2569_13"));
  assert.throws(() => thaiMonth("x"));
});

test("subject as the secretary writes it; a reply and a test are marked", () => {
  assert.equal(emailSubject("2569_08", { test: false, reply: false }), "เอกสาร P4P เดือนสิงหาคม 2569");
  assert.equal(emailSubject("2569_08", { test: false, reply: true }), "Re: เอกสาร P4P เดือนสิงหาคม 2569");
  assert.equal(emailSubject("2569_08", { test: true, reply: false }), "[ทดสอบ] เอกสาร P4P เดือนสิงหาคม 2569");
  assert.equal(emailSubject("2569_08", { test: true, reply: true }), "Re: [ทดสอบ] เอกสาร P4P เดือนสิงหาคม 2569");
});

test("body: Pong's wording, greeting and signature from the settings, the automatic-mail note last", () => {
  const first = "ขอจัดส่ง เอกสาร P4P เดือนสิงหาคม 2569 รายละเอียดตามไฟล์แนบ เพื่อใช้ประกอบการตรวจสอบความถูกต้องของข้อมูลค่ะ";
  const body = emailBody({ month: "2569_08", greeting: "Dear team", signature: ["Regards", "", "Office 1234"], fixNo: 0, changed: null });
  assert.equal(body, ["Dear team", "", first, "", "Regards", "Office 1234", "", AUTO_NOTE].join("\n"));
  assert.equal(AUTO_NOTE, "(อีเมลฉบับนี้ส่งจากระบบอัตโนมัติ)");

  const fix = "ขอจัดส่ง เอกสาร P4P เดือนสิงหาคม 2569 แก้ไขครั้งที่ 2 รายละเอียดตามไฟล์แนบ เพื่อใช้ประกอบการตรวจสอบความถูกต้องของข้อมูลค่ะ";
  const again = emailBody({ month: "2569_08", greeting: "Dear team", signature: ["Regards"], fixNo: 2, changed: ["Doctor A", "Doctor B"] });
  assert.equal(again, ["Dear team", "", fix, "แก้ไข 2 คน: Doctor A, Doctor B", "", "Regards", "", AUTO_NOTE].join("\n"));
  // Who changed is not known (the earlier build is gone): no names line.
  assert.ok(!emailBody({ month: "2569_08", greeting: "", signature: [], fixNo: 1, changed: null }).includes("คน:"));
});

test("a long list of changed people names the first 30 and counts the rest", () => {
  const names = Array.from({ length: 33 }, (_, i) => `Doctor ${i + 1}`);
  const line = changedLine(names);
  assert.ok(line.startsWith("แก้ไข 33 คน: Doctor 1, Doctor 2"));
  assert.ok(line.includes(`Doctor ${NAMES_SHOWN}`) && !line.includes(`Doctor ${NAMES_SHOWN + 1},`));
  assert.ok(line.endsWith(" และอีก 3 คน"));
});

test("attachment names follow the secretary's files", () => {
  assert.deepEqual(attachmentNames("2569_08"), {
    sk03: "แบบฟอร์ม SK03 องค์กรแพทย์ เดือนสิงหาคม 2569.xlsx",
    merged: "รวมค่าคะแนนองค์กรแพทย์ เดือนสิงหาคม 2569.xlsx",
  });
});

const person = (i: string, over: Partial<PersonSnap> = {}): PersonSnap => ({
  roster_index: i, name: "Doctor " + i, department: "MED", is_intern: false, sk03_score: 2500, sk03_pay: 12000, ...over,
});

test("changed people: new, gone, or a different score, pay, department or name", () => {
  const before = [person("A"), person("B"), person("C"), person("D"), person("E")];
  const now = [person("A"), person("B", { sk03_score: "2600.00" }), person("C", { department: "SUR" }),
    person("E", { sk03_pay: 12000.5 }), person("F")];
  assert.deepEqual(changedPeople(before, now), ["Doctor B", "Doctor C", "Doctor D", "Doctor E", "Doctor F"]);
  // Numbers as text from PostgREST compare as numbers.
  assert.deepEqual(changedPeople([person("A", { sk03_score: "2500.00" })], [person("A")]), []);
});

test("recipients: the settings' addresses, or the test address alone", () => {
  assert.deepEqual(recipientsOf({ recipients: ["a@example.com", " b@example.org ", "not an address"], greeting: "", signature: [], test_to: "" }),
    { to: "a@example.com, b@example.org", test: false });
  assert.deepEqual(recipientsOf({ recipients: ["a@example.com"], greeting: "", signature: [], test_to: "me@example.net" }),
    { to: "me@example.net", test: true });
  assert.equal(recipientsOf({ recipients: [], greeting: "", signature: [], test_to: "" }), null);
  assert.equal(recipientsOf({ recipients: ["a@example.com"], greeting: "", signature: [], test_to: "oops" }), null);
});

test("thread: reply to the newest mail; only other rounds count as corrections", () => {
  assert.deepEqual(threadOf({ round_id: 1 }, []), { replyTo: null, fixNo: 0, compareBuild: null });
  const r1 = { id: 1, round_id: 1, build_id: "b1", gmail_id: "g1", thread_id: "t" };
  const r2 = { id: 2, round_id: 2, build_id: "b2", gmail_id: "g2", thread_id: "t" };
  assert.deepEqual(threadOf({ round_id: 2 }, [r1]), { replyTo: "g1", fixNo: 1, compareBuild: "b1" });
  assert.deepEqual(threadOf({ round_id: 3 }, [r1, r2]), { replyTo: "g2", fixNo: 2, compareBuild: "b2" });
  // The same round mailed again (a test, or after a withdrawn mail): not a correction of itself.
  assert.deepEqual(threadOf({ round_id: 2 }, [r1, r2]), { replyTo: "g2", fixNo: 1, compareBuild: "b1" });
  // A round taken back after its mail went: the next one is a correction.
  assert.deepEqual(threadOf({ round_id: 5 }, [{ ...r1, round_id: null }]), { replyTo: "g1", fixNo: 1, compareBuild: "b1" });
});

// ── Sending, with Supabase, Gmail and Telegram faked ───────────────────────

type Row = Record<string, any>;
interface World {
  emails: Row[];
  builds: Row[];
  people: Row[];
  settings: Row | null;
  installed: boolean;
  files: Record<string, string>;
  sent: any[];
  inSent: { id: string; threadId: string; tag: string }[];
  labelled: [string, string[], string[]][];
  telegrams: string[];
  failSend: number;
  now: number;
}
let w: World;

/** Just enough of supabase-js for review-email.ts: filters are applied, the rest is ignored. */
function fakeDb(): any {
  const table = (name: string): Row[] => ({ review_emails: w.emails, review_builds: w.builds, review_build_people: w.people,
    review_email_settings: w.settings ? [w.settings] : [] } as Record<string, Row[]>)[name] ?? [];
  const from = (name: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let update: Row | null = null;
    let single = false;
    let orderBy: string | null = null;
    const run = () => {
      if (!w.installed && name.startsWith("review_email")) return { data: null, error: { code: "PGRST205", message: "no table" } };
      const rows = table(name).filter((r) => filters.every((f) => f(r)));
      if (update) { for (const r of rows) Object.assign(r, update); return { data: null, error: null }; }
      if (orderBy) rows.sort((a, b) => String(a[orderBy!]).localeCompare(String(b[orderBy!])));
      return { data: single ? rows[0] ?? null : rows.map((r) => ({ ...r })), error: null };
    };
    const q: any = {
      select: () => q,
      update: (u: Row) => { update = u; return q; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return q; },
      or: (expr: string) => {
        // The peek: queued and due, or sending for 15 minutes.
        const due = /next_try_at\.lte\.([^,)]+)/.exec(expr)![1]!;
        const stale = /claimed_at\.lt\.([^,)]+)/.exec(expr)![1]!;
        filters.push((r) => (r.status === "queued" && (!r.next_try_at || r.next_try_at <= due))
          || (r.status === "sending" && r.claimed_at < stale));
        return q;
      },
      order: (c: string) => { orderBy = c; return q; },
      limit: () => q,
      maybeSingle: () => { single = true; return q; },
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return q;
  };
  return {
    from,
    async rpc(fn: string) {
      assert.equal(fn, "claim_review_email");
      const iso = new Date(w.now).toISOString();
      const stale = new Date(w.now - 15 * 60_000).toISOString();
      const r = w.emails.filter((e) => (e.status === "queued" && (!e.next_try_at || e.next_try_at <= iso))
        || (e.status === "sending" && e.claimed_at < stale)).sort((a, b) => a.id - b.id)[0];
      if (!r) return { data: [], error: null };
      Object.assign(r, { status: "sending", claimed_at: iso, attempts: r.attempts + 1 });
      return { data: [{ ...r }], error: null };
    },
    storage: {
      from: () => ({
        async download(path: string) {
          const t = w.files[path];
          return t === undefined ? { data: null, error: { message: "Object not found" } }
            : { data: new Blob([t]), error: null };
        },
      }),
    },
  };
}

function deps(): ReviewEmailDeps {
  return {
    db: fakeDb(),
    gmail: {
      async sendMessage(o: any) {
        if (w.failSend > 0) { w.failSend--; throw new Error("Gmail 500"); }
        w.sent.push(o);
        const id = "g" + w.sent.length;
        const threadId = o.replyToMessageId ? "t1" : "t" + w.sent.length;
        w.inSent.push({ id, threadId, tag: o.headers[TAG_HEADER] });
        return { id, threadId };
      },
      async listMessages(o: any) {
        assert.equal(o.labelIds, "SENT");
        return w.inSent.map((m) => ({ id: m.id }));
      },
      async getMessage(id: string) {
        const m = w.inSent.find((x) => x.id === id)!;
        return { id, threadId: m.threadId, payload: { headers: [{ name: "Subject", value: "x" }, { name: TAG_HEADER, value: m.tag }] } };
      },
      async ensureLabel(name: string) { return "L:" + name; },
      async modifyMessage(id: string, add: string[] = [], remove: string[] = []) { w.labelled.push([id, add, remove]); return {}; },
    } as any,
    async telegram(t: string) { w.telegrams.push(t); },
    now: () => w.now,
  };
}

const T0 = Date.parse("2026-11-12T05:00:00Z");
const SETTINGS = { id: 1, recipients: ["auditor@example.com", "two@example.org"], greeting: "Dear team", signature: ["Regards", "Office"], test_to: "" };
const email = (id: number, over: Row = {}): Row => ({
  id, month: "2569_08", round_id: id, round_no: id, build_id: "b" + id, status: "queued", attempts: 0, next_try_at: null,
  claimed_at: null, test: false, fix_no: null, sent_to: "", gmail_id: "", thread_id: "", sent_at: null, error: "",
  created_at: new Date(T0 - 60_000).toISOString(), ...over,
});
const build = (id: string): Row => ({ id, sk03_path: `builds/${id}/SK03.xlsx`, merged_path: `builds/${id}/merged.xlsx` });

beforeEach(() => {
  resetReviewEmailForTests();
  w = {
    emails: [], builds: [build("b1"), build("b2")], people: [], settings: { ...SETTINGS }, installed: true,
    files: { "builds/b1/SK03.xlsx": "sk03-one", "builds/b1/merged.xlsx": "merged-one", "builds/b2/SK03.xlsx": "sk03-two", "builds/b2/merged.xlsx": "merged-two" },
    sent: [], inSent: [], labelled: [], telegrams: [], failSend: 0, now: T0,
  };
});

test("not installed: turned off for the run, quietly", async () => {
  w.installed = false;
  assert.equal(await sendQueuedReviewEmail(deps()), false);
  w.installed = true;
  w.emails.push(email(1));
  assert.equal(await sendQueuedReviewEmail(deps()), false, "stays off until the relay restarts");
  assert.equal(w.sent.length, 0);
});

test("no recipients yet: nothing is claimed, the email waits", async () => {
  w.settings = null;
  w.emails.push(email(1));
  assert.equal(await sendQueuedReviewEmail(deps()), false);
  assert.equal(w.emails[0]!.status, "queued");
  assert.equal(w.emails[0]!.attempts, 0);
});

test("first mail of the month: the round's two files, the tag, the label, recorded, Telegram", async () => {
  w.emails.push(email(1));
  assert.equal(await sendQueuedReviewEmail(deps()), true);
  const m = w.sent[0];
  assert.equal(m.to, "auditor@example.com, two@example.org");
  assert.equal(m.subject, "เอกสาร P4P เดือนสิงหาคม 2569");
  assert.equal(m.replyToMessageId, undefined);
  assert.ok(m.body.startsWith("Dear team\n\nขอจัดส่ง เอกสาร P4P เดือนสิงหาคม 2569 รายละเอียดตามไฟล์แนบ"));
  assert.ok(m.body.endsWith("Regards\nOffice\n\n" + AUTO_NOTE));
  assert.deepEqual(m.attachments.map((a: any) => [a.filename, a.buffer.toString()]), [
    ["แบบฟอร์ม SK03 องค์กรแพทย์ เดือนสิงหาคม 2569.xlsx", "sk03-one"],
    ["รวมค่าคะแนนองค์กรแพทย์ เดือนสิงหาคม 2569.xlsx", "merged-one"],
  ]);
  assert.deepEqual(m.headers, { [TAG_HEADER]: "1" });
  assert.deepEqual(w.labelled, [["g1", ["L:" + REVIEW_LABEL], ["INBOX"]]]);
  const e = w.emails[0]!;
  assert.equal(e.status, "sent");
  assert.equal(e.gmail_id, "g1");
  assert.equal(e.thread_id, "t1");
  assert.equal(e.fix_no, 0);
  assert.equal(e.test, false);
  assert.equal(e.sent_to, "auditor@example.com, two@example.org");
  assert.match(w.telegrams[0]!, /ส่งอีเมล P4P สิงหาคม 2569 รอบที่ 1 ถึงผู้ตรวจสอบแล้ว \(2 คน\)/);
  assert.equal(await sendQueuedReviewEmail(deps()), false, "nothing more to send");
});

test("round 2: a reply in the month's thread, แก้ไขครั้งที่ 1, naming who changed", async () => {
  w.emails.push(email(1, { status: "sent", gmail_id: "g0", thread_id: "t0", sent_at: new Date(T0 - 3600_000).toISOString(), fix_no: 0 }));
  w.emails.push(email(2));
  w.people.push({ build_id: "b1", ...person("A") }, { build_id: "b1", ...person("B") });
  w.people.push({ build_id: "b2", ...person("A") }, { build_id: "b2", ...person("B", { sk03_score: 2700 }) });
  w.inSent.push({ id: "g0", threadId: "t0", tag: "1" });
  assert.equal(await sendQueuedReviewEmail(deps()), true);
  const m = w.sent[0];
  assert.equal(m.replyToMessageId, "g0");
  assert.equal(m.subject, "Re: เอกสาร P4P เดือนสิงหาคม 2569");
  assert.ok(m.body.includes("เดือนสิงหาคม 2569 แก้ไขครั้งที่ 1 รายละเอียด"));
  assert.ok(m.body.includes("\nแก้ไข 1 คน: Doctor B\n"));
  assert.deepEqual(m.attachments.map((a: any) => a.buffer.toString()), ["sk03-two", "merged-two"]);
  assert.equal(w.emails[1]!.fix_no, 1);
  assert.match(w.telegrams[0]!, /แก้ไขครั้งที่ 1/);
});

test("test mode: only the test address, marked [ทดสอบ], not labelled, not the month's thread", async () => {
  w.settings = { ...SETTINGS, test_to: "me@example.net" };
  w.emails.push(email(1, { status: "sent", gmail_id: "g0", sent_at: new Date(T0 - 3600_000).toISOString() }));
  w.emails.push(email(2));
  assert.equal(await sendQueuedReviewEmail(deps()), true);
  const m = w.sent[0];
  assert.equal(m.to, "me@example.net");
  assert.equal(m.subject, "[ทดสอบ] เอกสาร P4P เดือนสิงหาคม 2569");
  assert.equal(m.replyToMessageId, undefined, "a test never replies into the real thread");
  assert.equal(w.labelled.length, 0);
  assert.equal(w.emails[1]!.test, true);
  assert.match(w.telegrams[0]!, /ทดสอบ/);
});

test("a failed send waits 5 minutes and tries again; the third failure is final and alerts", async () => {
  w.emails.push(email(1));
  w.failSend = 3;
  assert.equal(await sendQueuedReviewEmail(deps()), false);
  let e = w.emails[0]!;
  assert.equal(e.status, "queued");
  assert.equal(e.next_try_at, new Date(T0 + RETRY_MS).toISOString());
  assert.match(e.error, /Gmail 500/);
  assert.equal(await sendQueuedReviewEmail(deps()), false, "not due yet");
  assert.equal(e.attempts, 1);
  w.now = T0 + RETRY_MS;
  await sendQueuedReviewEmail(deps());
  w.now = T0 + 2 * RETRY_MS;
  await sendQueuedReviewEmail(deps());
  e = w.emails[0]!;
  assert.equal(e.attempts, 3);
  assert.equal(e.status, "failed");
  assert.equal(w.telegrams.length, 1);
  assert.match(w.telegrams[0]!, /ส่งอีเมล P4P สิงหาคม 2569 รอบที่ 1 ไม่สำเร็จ: Gmail 500/);
  assert.equal(w.sent.length, 0);
});

test("never twice: a retry finds the tagged mail in Sent and only records it", async () => {
  // The last try reached Gmail, then the relay stopped: the row stayed sending.
  w.emails.push(email(1, { status: "sending", attempts: 1, claimed_at: new Date(T0 - 16 * 60_000).toISOString() }));
  w.inSent.push({ id: "gX", threadId: "tX", tag: "1" });
  assert.equal(await sendQueuedReviewEmail(deps()), true);
  assert.equal(w.sent.length, 0);
  const e = w.emails[0]!;
  assert.equal(e.status, "sent");
  assert.equal(e.gmail_id, "gX");
  assert.equal(e.thread_id, "tX");
  assert.equal(e.attempts, 2);
});

test("a stale claim whose mail never reached Gmail is sent then", async () => {
  w.emails.push(email(1, { status: "sending", attempts: 1, claimed_at: new Date(T0 - 16 * 60_000).toISOString() }));
  w.inSent.push({ id: "gY", threadId: "tY", tag: "99" });
  assert.equal(await sendQueuedReviewEmail(deps()), true);
  assert.equal(w.sent.length, 1);
  assert.equal(w.emails[0]!.status, "sent");
});

test("a round whose files are gone fails at once, with an alert", async () => {
  w.emails.push(email(1, { build_id: "gone" }));
  assert.equal(await sendQueuedReviewEmail(deps()), false);
  assert.equal(w.emails[0]!.status, "failed");
  assert.match(w.emails[0]!.error, /ไม่พบไฟล์/);
  assert.equal(w.telegrams.length, 1);
  w.emails.push(email(2, { build_id: null }));
  await sendQueuedReviewEmail(deps());
  assert.equal(w.emails[1]!.status, "failed");
  assert.equal(w.sent.length, 0);
});
