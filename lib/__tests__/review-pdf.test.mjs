/**
 * The ตรวจสอบ tab's approval document (process/review-pdf.ts): page layout,
 * Thai dates in Bangkok time, money, and the cover's page numbers. Rendering
 * itself needs Chrome and runs in workflow 2.8 only.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const pdf = require(resolve(repoRoot, "process/review-pdf"))

test("pages: at most 13 rows, at most 8 on a department's last page, nothing lost", () => {
  for (let n = 0; n <= 150; n++) {
    const sizes = pdf.paginate(n)
    assert.equal(sizes.reduce((a, b) => a + b, 0), n, `n=${n}`)
    assert.ok(sizes.at(-1) <= 8, `n=${n} last ${sizes.at(-1)}`)
    assert.ok(sizes.every((s) => s <= 13), `n=${n} ${sizes}`)
    if (n > 0) assert.ok(sizes.every((s) => s >= 1), `n=${n} ${sizes}`)
    assert.equal(sizes.length, n <= 8 ? 1 : 1 + Math.ceil((n - 8) / 13), `n=${n} uses the fewest pages`)
  }
  assert.deepEqual(pdf.paginate(21), [13, 8])
  assert.deepEqual(pdf.paginate(9), [5, 4])
})

test("Thai date and time in Bangkok, and money", () => {
  assert.equal(pdf.thaiDateTime("2026-11-09T03:05:00Z"), "9 พฤศจิกายน พ.ศ. 2569 เวลา 10:05 น.")
  assert.equal(pdf.thaiDateTime("2026-11-08T17:30:00Z", true), "9 พ.ย. 2569 00:30 น.")
  assert.equal(pdf.monthTitle("2569_10"), "ตุลาคม พ.ศ. 2569")
  assert.equal(pdf.money(9620), "9,620")
  assert.equal(pdf.money(2158709.06), "2,158,709.06")
  assert.equal(pdf.money("1,000"), "1,000")
  assert.equal(pdf.money(0), "0")
  assert.equal(pdf.money(null), "")
  assert.equal(pdf.money(" "), "")
})

test("document: cover page numbers, totals, escaping", () => {
  const row = (i, name, pay) => [i, name, "นายแพทย์", "ข้าราชการ", 0, pay, pay, " ", ""]
  const dept = (name, n) => ({ name, header: [["หลักฐาน"], ["ประจำเดือน  ตุลาคม  พ.ศ.  2569"], ["หน่วยงาน  " + name]],
    rows: Array.from({ length: n }, (_, i) => row(i + 1, "นพ. <b>ก</b>  " + i, 100)), admin: 0, pay: n * 100, total: n * 100 })
  const { html, pages } = pdf.buildHtml({
    month: "2569_10", roundNo: 2, rounds: 2, approvedAt: "2026-11-09T03:05:00Z", approvedBy: "Pong", approvedPeople: 33, people: 33,
    submittedAt: "2026-11-09T02:20:00Z", submittedBy: "Pong", reopenedAt: "2026-11-09T02:50:00Z", reopenedBy: "Pong", reopenReason: "งบผิด",
    budget: 4000, perP4P: 10, builtAt: "2026-11-09T01:52:00Z", sk03File: "SK03.xlsx", mergedFile: "merged.xlsx",
    depts: [dept("อายุรกรรม", 21), dept("INTERN", 12)],
  }, { regular: "", bold: "" })
  assert.equal(pages, 1 + 2 + 2)
  assert.equal((html.match(/<section class="page">/g) || []).length, pages)
  assert.match(html, /อายุรกรรม<\/td><td class="n">21<\/td><td class="n">2,100<\/td><td class="n">2<\/td>/)
  assert.match(html, /อินเทิร์น<\/td><td class="n">12<\/td><td class="n">1,200<\/td><td class="n">4<\/td>/)
  assert.match(html, /คงเหลือ 700 บาท/)
  assert.match(html, /หน้า 5 \/ 5/)
  assert.equal((html.match(/อนุมัติเมื่อ 9 พฤศจิกายน พ\.ศ\. 2569 เวลา 10:05 น\./g) || []).length, pages)
  assert.match(html, /เปิดตรวจอีกครั้ง: 9 พ\.ย\. 2569 09:50 น\. \(งบผิด\)/)
  assert.ok(!html.includes("<b>ก</b>") && html.includes("นพ. &lt;b&gt;ก&lt;/b&gt; 0"), "names are escaped and spaces squashed")
  assert.equal((html.match(/class="signs"/g) || []).length, 2, "signatures on each department's last page only")
})
