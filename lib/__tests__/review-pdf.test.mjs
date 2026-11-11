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
/** The text of the cover info cell after the <th> with this label. */
const cell = (html, label) => new RegExp(`<th>${label.replace(/[()]/g, "\\$&")}</th><td>([^<]*)</td>`).exec(html)?.[1]

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
  assert.equal(cell(html, "P4P ที่จ่าย (ไม่รวมค่าบริหาร)"), "3,300 บาท (คงเหลือ 700 บาท)")
  assert.match(html, /หน้า 5 \/ 5/)
  assert.equal((html.match(/อนุมัติเมื่อ 9 พฤศจิกายน พ\.ศ\. 2569 เวลา 10:05 น\./g) || []).length, pages)
  assert.match(html, /เปิดตรวจอีกครั้ง: 9 พ\.ย\. 2569 09:50 น\. \(งบผิด\)/)
  assert.ok(!html.includes("<b>ก</b>") && html.includes("นพ. &lt;b&gt;ก&lt;/b&gt; 0"), "names are escaped and spaces squashed")
  assert.equal((html.match(/class="signs"/g) || []).length, 2, "signatures on each department's last page only")
  const sections = html.split('<section class="page">').slice(1)
  assert.ok(!sections[0].includes(pdf.SK02_FORM), "no SK02 note on the cover")
  assert.ok(sections.slice(1).every((x) => x.startsWith(`<p class="form">${pdf.SK02_FORM}</p>`)), "SK02 note at the top of every department page")
})

// Department sheet columns: E งานบริหาร, F ตามสัดส่วนวิชาชีพ, G รวมเป็นเงิน = E + F.
// The budget (staff Y9) pays F only; the management stipends (E) are on top of it.
const budgetDoc = (budget, depts) => pdf.buildHtml({
  month: "2569_10", roundNo: 1, rounds: 1, approvedAt: "2026-11-09T03:05:00Z", approvedBy: "ผู้ตรวจ ทดสอบ", approvedPeople: 3, people: 3,
  submittedAt: "2026-11-09T02:20:00Z", submittedBy: "ผู้จัดทำ ทดสอบ", reopenedAt: null, reopenedBy: "", reopenReason: "",
  budget, perP4P: 9620, builtAt: "2026-11-09T01:52:00Z", sk03File: "SK03.xlsx", mergedFile: "merged.xlsx", depts,
}, { regular: "", bold: "" }).html
const sheet = (name, rows) => ({ name, header: [], rows: rows.map(([e, f], i) => [i + 1, "นพ. ทดสอบ หนึ่ง", "นายแพทย์", "ข้าราชการ", e, f, e + f, " ", ""]),
  admin: rows.reduce((s, r) => s + r[0], 0), pay: rows.reduce((s, r) => s + r[1], 0), total: rows.reduce((s, r) => s + r[0] + r[1], 0) })

test("cover: the balance is budget − P4P pay (F); management stipends (E) are outside the budget", () => {
  // As the SK03 pays it: interns 30 × 9,620, staff the rest less a 13 baht ROUNDDOWN remainder (X23 คงคืน = 13),
  // and 50,600 of management stipends on top.
  const staff = sheet("อายุรกรรม", [[50600, 1200000], [0, 1011387]])
  const intern = sheet("INTERN", [[0, 288600]])
  const html = budgetDoc(2500000, [staff, intern])
  assert.equal(cell(html, "งบประมาณทั้งหมด"), "2,500,000 บาท")
  assert.equal(cell(html, "P4P ที่จ่าย (ไม่รวมค่าบริหาร)"), "2,499,987 บาท (คงเหลือ 13 บาท)")
  assert.equal(cell(html, "ค่าตอบแทนบริหาร (นอกงบ P4P)"), "50,600 บาท")
  assert.equal(cell(html, "รวมจ่ายตามชีตกลุ่มงาน"), "2,550,587 บาท")
  assert.ok(!html.includes("เกินงบ"), "stipends do not make it over budget")
  // The summary tables still show each department's รวมเป็นเงิน (G).
  assert.match(html, /อายุรกรรม<\/td><td class="n">2<\/td><td class="n">2,261,987<\/td>/)
  assert.match(html, /รวมทั้งสิ้น<\/td><td class="n">3<\/td><td class="n">2,550,587<\/td>/)
  assert.match(html, /แพทย์ 3 คน · รวม 2,550,587 บาท/)
})

test("cover: over budget only when the P4P pay (F) is more than the budget", () => {
  const depts = [sheet("ศัลยกรรม", [[10000, 1000.5]]), sheet("INTERN", [[0, 500]])]
  const over = budgetDoc(1400, depts)
  assert.equal(cell(over, "P4P ที่จ่าย (ไม่รวมค่าบริหาร)"), "1,500.50 บาท (เกินงบ 100.50 บาท)")
  assert.equal(cell(over, "รวมจ่ายตามชีตกลุ่มงาน"), "11,500.50 บาท")
  assert.ok(!over.includes("คงเหลือ"))
  const exact = budgetDoc(1500.5, depts)
  assert.equal(cell(exact, "P4P ที่จ่าย (ไม่รวมค่าบริหาร)"), "1,500.50 บาท (คงเหลือ 0 บาท)")
  assert.ok(!exact.includes("เกินงบ"))
  assert.equal(cell(budgetDoc(1500.5 - 0.001, depts), "P4P ที่จ่าย (ไม่รวมค่าบริหาร)"), "1,500.50 บาท (คงเหลือ 0 บาท)", "no -0 from float noise")
})

test("only a definite 'not installed' code stops the PDF job quietly", () => {
  assert.equal(pdf.missing({ code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." }), false)
  assert.equal(pdf.missing({ code: "PGRST000", message: "Database connection error. Retrying the connection." }), false)
  assert.equal(pdf.missing({ code: "", message: "TypeError: fetch failed" }), false)
  assert.equal(pdf.missing({ message: "<html>503 Service Unavailable</html>" }), false)
  assert.equal(pdf.missing(null), false)
  assert.equal(pdf.missing({ code: "PGRST202", message: "Could not find the function public.claim_review_pdf without parameters in the schema cache" }), true)
  assert.equal(pdf.missing({ code: "PGRST205", message: "Could not find the table 'public.review_rounds' in the schema cache" }), true)
  assert.equal(pdf.missing({ code: "42883", message: "function public.claim_review_pdf() does not exist" }), true)
  assert.equal(pdf.missing({ code: "42703", message: "column review_rounds.pdf_status does not exist" }), true)
})
