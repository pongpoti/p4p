import { test } from "node:test";
import assert   from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { earlierFormatted, refilledCopy, type Original } from "../scripts/blank-copies.js";
import { refillValues } from "../xlsx-refill.js";
import { blankCorrection, formatted } from "./fixtures.js";

// One physician's July report, sent formatted on 31 July and corrected on a
// blank copy on 29 September — among files that must not be taken for it.

const DAY = 86_400_000;
const at  = (iso: string): number => Date.parse(iso);

async function mailbox() {
  const dir  = mkdtempSync(path.join(tmpdir(), "blank-copies-"));
  const save = (name: string, buf: Buffer, date: number, from = "doctor@example.com"): Original => {
    const file = path.join(dir, `${name}.xlsx`);
    writeFileSync(file, buf);
    return { file, date, messageId: name, from };
  };
  const july       = await formatted();
  const correction = await blankCorrection();
  const box = {
    dir, july, correction,
    julySent  : save("july", july, at("2026-07-31")),
    augustSent: save("august", await formatted("ส.ค.69", "สิงหาคม"), at("2026-08-29")),
    otherSent : save("other", july, at("2026-08-01"), "someone@example.com"),
    laterSent : save("later", july, at("2026-09-30")),
    fixSent   : save("fix", correction, at("2026-09-29")),
  };
  return { ...box, all: [box.julySent, box.augustSent, box.otherSent, box.laterSent, box.fixSent] };
}

test("the earlier file is the same sender's latest earlier one for the month", async () => {
  const m = await mailbox();
  try {
    const found = await earlierFormatted(m.correction, m.fixSent, "2569_07", m.all);
    assert.equal(found?.messageId, "july");
    assert.equal(await earlierFormatted(m.correction, m.fixSent, "2569_07", [m.augustSent, m.otherSent, m.laterSent, m.fixSent]), null,
      "not another month, another sender, a later file or the correction itself");
  } finally {
    rmSync(m.dir, { recursive: true, force: true });
  }
});

test("a copy refilled from the correction is recognised; the files it came from are not", async () => {
  const m = await mailbox();
  try {
    const refilled = (await refillValues(m.july, m.correction))!.buffer;
    assert.equal(await refilledCopy(refilled, "2569_07", [m.fixSent], m.all), true);
    assert.equal(await refilledCopy(m.july, "2569_07", [m.fixSent], m.all), false, "the earlier file lacks the correction");
    assert.equal(await refilledCopy(refilled, "2569_07", [m.fixSent], [m.augustSent, m.fixSent]), false, "no earlier July file to rebuild from");
  } finally {
    rmSync(m.dir, { recursive: true, force: true });
  }
});
