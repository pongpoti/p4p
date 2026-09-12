import { test } from "node:test";
import assert   from "node:assert/strict";
import { computeMonthKeys, monthKey, bangkokYearMonth } from "../scripts/provision-next-month.js";

test("mid-year month: new = this month, old = last month", () => {
  // July 2026 = BE 2569_07, previous = 2569_06
  assert.deepEqual(computeMonthKeys({ ceYear: 2026, month: 7 }), {
    newKey: "2569_07",
    oldKey: "2569_06",
  });
});

test("January rolls old back to December of the previous year (CE + BE)", () => {
  // Jan 2026 = BE 2569_01, previous = Dec 2025 = BE 2568_12
  assert.deepEqual(computeMonthKeys({ ceYear: 2026, month: 1 }), {
    newKey: "2569_01",
    oldKey: "2568_12",
  });
});

test("December: old = November, same year", () => {
  assert.deepEqual(computeMonthKeys({ ceYear: 2026, month: 12 }), {
    newKey: "2569_12",
    oldKey: "2569_11",
  });
});

test("monthKey zero-pads the month and adds 543 to the year", () => {
  assert.equal(monthKey(2026, 3), "2569_03");
  assert.equal(monthKey(2025, 11), "2568_11");
});

test("bangkokYearMonth resolves the Bangkok calendar month near UTC midnight", () => {
  // 23:00 UTC on 2026-06-30 is already 06:00 on 2026-07-01 in Bangkok (+7).
  const be = bangkokYearMonth(new Date("2026-06-30T23:00:00Z"));
  assert.deepEqual(be, { ceYear: 2026, month: 7 });
});
