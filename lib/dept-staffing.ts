/**
 * lib/dept-staffing.ts
 *
 * Each STAFF department's physician staffing (FTE, doctors on staff, doctors
 * hired by the month and by the day) and the department multiplier worked
 * out from it, shared by the SK03 build (process/sk03-formula.ts, in GitHub
 * Actions) and the Vercel app (lib/staffing-server.ts, the dashboard's
 * อัตรากำลัง tab). No network, no dependencies.
 *
 *   lack       = max(0, 1 − (on staff + monthly hires + daily hires) ÷ FTE)
 *   multiplier = 1 + LACK_K × lack
 *
 * Monthly hires (ลูกจ้างชั่วคราว รายเดือน) have their own column since
 * 2026-11-17 (Pong: "add column จ้างรายเดือน"). The 13-11-69 sheet's
 * รวมอัตราตามจริง already counted them, so on staff was that less the
 * monthly hires (MED 37 = 36 + 1, EYE 8 = 7 + 1) and no multiplier changed.
 *
 * FTE is from the physician staffing sheet of 13 Nov 2026 (13-11-69,
 * ข้อมูลอัตรากำลังภารกิจบริการทุติยภูมิและตติยภูมิ ระดับโรงพยาบาลตาม Service Plan
 * ขนาด a, 691 เตียง). On staff, monthly and daily hires are from the staffing
 * report of 25 Nov 2026 (อัตรากำลัง 25-11-69, Pong: "update this data to
 * dashboard and SK03 formula"): the doctors at work in the hospital's doctor
 * list of that day, so doctors on study leave no longer count (the 13-11-69
 * sheet counted them in รวมอัตราตามจริง). Since 2026-11-16 (Pong) the owner
 * edits them on the dashboard's อัตรากำลัง tab, which saves them in the
 * Supabase table dept_staffing (scripts/dept-staffing-2026-11.sql; the
 * 25-11-69 numbers go in with scripts/dept-staffing-update-2026-11-25.sql);
 * every SK03 build reads that table. A department with no row there keeps
 * the number below.
 *
 * ไม่ได้ปฏิบัติงาน (absent: the department's doctors not at work, such as
 * on study leave) is shown on the อัตรากำลัง tab since 2026-11-26 (Pong).
 * It is not in the multiplier: lack counts only the doctors at work.
 *
 * Departments, their names, codes and order are fixed here: the SK03
 * งบรายสาขา sheet has one row per department in this order, and a new
 * department needs a code change anyway (DEPT_COLORS, the SK03 template).
 */

export interface DeptStaffing {
  no: number
  name: string    // department name as in Supabase / DEPT_COLORS
  code: string
  fte: number     // doctors the department should have (จำนวนที่ควรมี, FTE)
  staff: number   // doctors on staff at work (ข้าราชการ; not those on study leave)
  monthly: number // doctors hired by the month (ลูกจ้างชั่วคราว รายเดือน), its own column since 2026-11-17
  daily: number   // doctors hired by the day (ลูกจ้างชั่วคราว รายวัน), counted with staff since 2026-11-16
  absent: number  // doctors not at work (ไม่ได้ปฏิบัติงาน), shown only, since 2026-11-26; not in the multiplier
}

/** A department as saved: the numbers in use, and who last changed them (null: never edited). */
export interface DeptStaffingRow extends DeptStaffing {
  updated_at: string | null
  updated_by: string | null
}

/** Every 10 points of lack adds 0.5 to the multiplier (Pong, 2026-11-13). */
export const LACK_K = 5

/**
 * Where the starting numbers come from (the งบรายสาขา sheet's note says so).
 * It ends with the date, d-m-yy in BE: the อัตรากำลัง tab reads it for
 * "ปรับปรุงข้อมูล วันที่".
 */
export const STAFFING_SOURCE = "อัตรากำลัง 25-11-69"

/** Limits of each number, as the dashboard and dept_staffing take them. FTE is at least 1 (it divides). */
export const STAFFING_LIMITS: Record<"fte" | "staff" | "monthly" | "daily" | "absent", { min: number; max: number }> = {
  fte: { min: 1, max: 999 },
  staff: { min: 0, max: 999 },
  monthly: { min: 0, max: 999 },
  daily: { min: 0, max: 999 },
  absent: { min: 0, max: 999 },
}

/**
 * The 18 STAFF departments in the order of FORMULA.md's "Departments and
 * Multipliers" table: FTE from the physician staffing sheet of 13 Nov 2026
 * (Pong, 2026-11-13), on staff, monthly and daily hires from the staffing
 * report of 25 Nov 2026 (Pong, 2026-11-25; daily hires counted since
 * 2026-11-16, monthly hires in their own column since 2026-11-17), and
 * ไม่ได้ปฏิบัติงาน from the same report ("แพทย์ที่ไม่ได้ปฏิบัติงาน จำนวน N
 * ราย"; it leaves ผู้ป่วยนอก's out, so OPD is 0).
 */
export const DEPT_STAFFING_DEFAULTS: DeptStaffing[] = [
  { no: 1,  name: "กุมารเวชกรรม",                        code: "PED", fte: 19, staff: 19, monthly: 0, daily: 1, absent: 3 },
  { no: 2,  name: "จักษุวิทยา",                          code: "EYE", fte: 9,  staff: 6,  monthly: 1, daily: 0, absent: 1 },
  { no: 3,  name: "จิตเวชและยาเสพติด",                   code: "PSY", fte: 4,  staff: 4,  monthly: 0, daily: 2, absent: 0 },
  { no: 4,  name: "เทคนิคการแพทย์และพยาธิวิทยาคลินิก",   code: "CPT", fte: 1,  staff: 1,  monthly: 0, daily: 0, absent: 0 },
  { no: 5,  name: "นิติเวช",                             code: "FOR", fte: 3,  staff: 2,  monthly: 0, daily: 0, absent: 0 },
  { no: 6,  name: "ผู้ป่วยนอก",                           code: "OPD", fte: 5,  staff: 3,  monthly: 0, daily: 11, absent: 0 },
  { no: 7,  name: "พยาธิวิทยากายวิภาค",                  code: "PAT", fte: 2,  staff: 3,  monthly: 0, daily: 0, absent: 0 },
  { no: 8,  name: "รังสีวิทยา",                           code: "RAD", fte: 15, staff: 13, monthly: 0, daily: 1, absent: 1 },
  { no: 9,  name: "วิสัญญีวิทยา",                         code: "ANS", fte: 15, staff: 7,  monthly: 0, daily: 0, absent: 2 },
  { no: 10, name: "เวชกรรมฟื้นฟู",                        code: "RHB", fte: 6,  staff: 4,  monthly: 0, daily: 0, absent: 0 },
  { no: 11, name: "เวชกรรมสังคม",                         code: "SOC", fte: 10, staff: 5,  monthly: 0, daily: 15, absent: 0 },
  { no: 12, name: "เวชศาสตร์ฉุกเฉิน",                     code: "EMR", fte: 10, staff: 10, monthly: 0, daily: 0, absent: 0 },
  { no: 13, name: "ศัลยกรรม",                            code: "SUR", fte: 39, staff: 33, monthly: 0, daily: 1, absent: 1 },
  { no: 14, name: "ศัลยกรรมออร์โธปิดิกส์",                code: "ORT", fte: 17, staff: 15, monthly: 0, daily: 0, absent: 1 },
  { no: 15, name: "สูติ-นรีเวชกรรม",                      code: "OBG", fte: 18, staff: 13, monthly: 0, daily: 2, absent: 0 },
  { no: 16, name: "โสต ศอ นาสิก",                         code: "ENT", fte: 9,  staff: 8,  monthly: 0, daily: 0, absent: 0 },
  { no: 17, name: "อาชีวเวชกรรม",                         code: "OCM", fte: 5,  staff: 3,  monthly: 0, daily: 0, absent: 0 },
  { no: 18, name: "อายุรกรรม",                            code: "MED", fte: 47, staff: 33, monthly: 0, daily: 4, absent: 4 },
]

// The multiplier's numbers (absent is not one).
type Counts = { fte: number; staff: number; monthly: number; daily: number }

/** Share of the department's FTE not filled by staff, monthly and daily hires (0 when fully or over-staffed). */
export function deptLack(d: Counts): number {
  return Math.max(0, 1 - (d.staff + d.monthly + d.daily) / d.fte)
}

/** The department's multiplier on the extra above 10,000: 1 + LACK_K × lack. */
export function deptMultiplier(d: Counts): number {
  return 1 + LACK_K * deptLack(d)
}

/**
 * One count as typed or stored: a whole number (digits only, or a JS
 * integer) within the field's limits, else null. "08" is 8; "", "1.5",
 * "-1", "1e2" and "1,000" are null.
 */
export function parseStaffCount(v: unknown, field: keyof typeof STAFFING_LIMITS): number | null {
  const lim = STAFFING_LIMITS[field]
  let n: number
  if (typeof v === "number") n = v
  else if (typeof v === "string" && /^\s*\d{1,4}\s*$/.test(v)) n = Number(v.trim())
  else return null
  return Number.isInteger(n) && n >= lim.min && n <= lim.max ? n : null
}

/**
 * The 18 departments with the saved numbers (rows of dept_staffing:
 * {code, fte, staff, monthly, daily, updated_at, updated_by}) laid over the
 * starting ones, in the fixed order. A department with no row, or with a
 * row whose numbers are out of range, keeps its starting numbers and is
 * listed in `missing` / `bad`; a row for a code that is not a department is
 * listed in `unknown` and left out.
 *
 * A row with no monthly field at all comes from a table made before
 * 2026-11-17, whose staff still counts the monthly hires: it is taken with
 * monthly 0 (the same total, so the same multiplier) and its code is listed
 * in `noMonthly` until the SQL file is run again.
 *
 * A row with no absent field comes from a table made before 2026-11-26
 * (scripts/dept-staffing-absent-2026-11.sql not run yet): it gets the
 * starting absent above (what that file fills in) and its code is listed in
 * `noAbsent`. absent is not in the multiplier, so a number out of range
 * there is taken as 0 and leaves the row's other numbers in use.
 */
export function mergeStaffing(rows: unknown): {
  list: DeptStaffingRow[]; missing: string[]; bad: string[]; unknown: string[]; noMonthly: string[]; noAbsent: string[]
} {
  const byCode = new Map<string, Record<string, unknown>>()
  const unknown: string[] = []
  const known = new Set(DEPT_STAFFING_DEFAULTS.map((d) => d.code))
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== "object") continue
    const code = String((r as Record<string, unknown>).code ?? "")
    if (known.has(code)) byCode.set(code, r as Record<string, unknown>)
    else unknown.push(code)
  }
  const missing: string[] = [], bad: string[] = [], noMonthly: string[] = [], noAbsent: string[] = []
  const list = DEPT_STAFFING_DEFAULTS.map((d): DeptStaffingRow => {
    const r = byCode.get(d.code)
    if (!r) { missing.push(d.code); return { ...d, updated_at: null, updated_by: null } }
    const fte = parseStaffCount(r.fte, "fte"), staff = parseStaffCount(r.staff, "staff"), daily = parseStaffCount(r.daily, "daily")
    const legacy = !("monthly" in r)
    const monthly = legacy ? 0 : parseStaffCount(r.monthly, "monthly")
    if (fte === null || staff === null || monthly === null || daily === null) { bad.push(d.code); return { ...d, updated_at: null, updated_by: null } }
    if (legacy) noMonthly.push(d.code)
    const noCol = !("absent" in r)
    if (noCol) noAbsent.push(d.code)
    const absent = noCol ? d.absent : parseStaffCount(r.absent, "absent") ?? 0
    return {
      ...d, fte, staff, monthly, daily, absent,
      updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
      updated_by: typeof r.updated_by === "string" ? r.updated_by : null,
    }
  })
  return { list, missing, bad, unknown, noMonthly, noAbsent }
}

/** The department with this code, or null. */
export function staffingDept(code: unknown): DeptStaffing | null {
  return DEPT_STAFFING_DEFAULTS.find((d) => d.code === code) ?? null
}
