// Drive's post-create duplicate check: of same-named files every writer keeps the same one (the oldest,
// ties by id), a writer only ever removes its OWN new file, and it trashes it, never deletes it. The
// Drive API is an in-memory fake of the few calls drive-client.ts makes.
import { test } from "node:test";
import assert   from "node:assert/strict";
import { createDriveClient, pickDriveWinner } from "../drive-client.js";

process.env.P4P_FOLDER_ID = "root";

interface FakeFile { id: string; name: string; parent: string; folder: boolean; createdTime: string; trashed: boolean; content: string }

function fakeDrive(initial: FakeFile[] = []) {
  const files: FakeFile[] = [...initial];
  let clock = Date.parse("2026-11-07T03:00:00.000Z");
  let seq = 0;
  const calls: string[] = [];
  const read = async (body: unknown): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const c of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString("utf8");
  };
  const api = {
    files: {
      async list({ q }: { q: string }) {
        calls.push("list");
        const name   = q.match(/name='((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\(.)/g, "$1");
        const parent = q.match(/'([^']+)' in parents/)?.[1];
        const wantFolder = q.includes("mimeType='application/vnd.google-apps.folder'");
        const hits = files.filter((f) => !f.trashed && f.parent === parent && (name === undefined || f.name === name) && (!wantFolder || f.folder));
        return { data: { files: hits.map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime })) } };
      },
      async create({ requestBody, media }: { requestBody: { name: string; parents: string[] }; media: { body: unknown } }) {
        calls.push("create");
        const content = await read(media.body);
        const f: FakeFile = { id: `f${++seq}`, name: requestBody.name, parent: requestBody.parents[0]!, folder: false, createdTime: new Date(clock += 1000).toISOString(), trashed: false, content };
        files.push(f);
        return { data: { id: f.id, name: f.name, createdTime: f.createdTime } };
      },
      async update({ fileId, media, requestBody }: { fileId: string; media?: { body: unknown }; requestBody?: { trashed?: boolean } }) {
        const f = files.find((x) => x.id === fileId);
        if (!f) throw Object.assign(new Error("not found"), { status: 404 });
        if (media) { calls.push(`update-content ${fileId}`); f.content = await read(media.body); }
        if (requestBody?.trashed) { calls.push(`trash ${fileId}`); f.trashed = true; }
        return { data: { id: f.id } };
      },
      async delete({ fileId }: { fileId: string }) {
        calls.push(`delete ${fileId}`);
        throw new Error("files.delete must never be called");
      },
    },
  };
  const folders: FakeFile[] = [
    { id: "y2569", name: "2569", parent: "root", folder: true, createdTime: "2026-01-01T00:00:00.000Z", trashed: false, content: "" },
    { id: "m10", name: "10 - ตุลาคม", parent: "y2569", folder: true, createdTime: "2026-01-01T00:00:00.000Z", trashed: false, content: "" },
  ];
  files.push(...folders);
  return { api, files, calls, live: (name: string) => files.filter((f) => f.name === name && !f.trashed) };
}

test("the winner is the oldest file, ties broken by the smaller id", () => {
  assert.equal(pickDriveWinner([
    { id: "b", createdTime: "2026-11-07T03:00:02.000Z" },
    { id: "a", createdTime: "2026-11-07T03:00:01.000Z" },
  ])?.id, "a");
  assert.equal(pickDriveWinner([
    { id: "z", createdTime: "2026-11-07T03:00:01.000Z" },
    { id: "c", createdTime: "2026-11-07T03:00:01.000Z" },
  ])?.id, "c");
  assert.equal(pickDriveWinner([{ id: "a", createdTime: null }, { id: "b", createdTime: "2026-11-07T03:00:01.000Z" }])?.id, "b", "an unknown time never wins over a known one");
  assert.equal(pickDriveWinner([]), undefined);
});

test("two writers that both create: one file survives, the other is trashed, nothing deleted", async () => {
  const d = fakeDrive();
  const client = createDriveClient(d.api as never);
  const [a, b] = await Promise.all([
    client.uploadFile(Buffer.from("from A"), "ทดสอบ ตัวอย่าง", "2569_10"),
    client.uploadFile(Buffer.from("from B"), "ทดสอบ ตัวอย่าง", "2569_10"),
  ]);
  assert.equal(d.calls.filter((c) => c === "create").length, 2, "the race really happened: both created");
  const live = d.live("ทดสอบ ตัวอย่าง");
  assert.equal(live.length, 1, "exactly one file left");
  assert.equal(live[0]!.id, "f1", "the older file is the one kept");
  assert.equal(live[0]!.content, "from B", "the later writer's content is in it, as on the update path");
  assert.equal(a.fileId, "f1");
  assert.equal(b.fileId, "f1");
  assert.ok(d.files.some((f) => f.id === "f2" && f.trashed), "the loser trashed its own file (restorable)");
  assert.ok(!d.calls.some((c) => c.startsWith("delete")), "never a permanent delete");
  assert.ok(!d.calls.includes("trash f1"), "no writer removes another writer's file");
});

test("an existing file is replaced in place, and with two existing the oldest is the one replaced", async () => {
  const d = fakeDrive([
    { id: "x9", name: "ทดสอบ ตัวอย่าง", parent: "m10", folder: false, createdTime: "2026-10-01T00:00:00.000Z", trashed: false, content: "old" },
    { id: "x1", name: "ทดสอบ ตัวอย่าง", parent: "m10", folder: false, createdTime: "2026-10-02T00:00:00.000Z", trashed: false, content: "older dup" },
  ]);
  const r = await createDriveClient(d.api as never).uploadFile(Buffer.from("new"), "ทดสอบ ตัวอย่าง", "2569_10");
  assert.deepEqual(r, { fileId: "x9", fileName: "ทดสอบ ตัวอย่าง", replaced: true });
  assert.equal(d.files.find((f) => f.id === "x9")!.content, "new");
  assert.ok(!d.calls.includes("create"));
});

test("a lone new file is kept as it is", async () => {
  const d = fakeDrive();
  const r = await createDriveClient(d.api as never).uploadFile(Buffer.from("only"), "ทดสอบ ตัวอย่าง", "2569_10");
  assert.deepEqual(r, { fileId: "f1", fileName: "ทดสอบ ตัวอย่าง", replaced: false });
  assert.ok(!d.calls.some((c) => c.startsWith("trash") || c.startsWith("update")));
});
