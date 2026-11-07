/**
 * SK03 new payment formula: the cell contents (formulas, labels and inputs)
 * that process.ts writes into the staff and intern sheets.
 *
 * The formula is the one in pongpoti/p4p-analysis docs/formula/formula.md:
 *   1. INTERN first. Pool = perP4P × interns scoring ≥ 2,200.
 *      Multiplier = clip(1 + 0.05 × (E ÷ intern mean E − 1), 0.95, 1.05).
 *      Pay = ROUNDDOWN(multiplier × pool ÷ Σ multipliers, 0).
 *   2. STAFF get the rest: staff budget = total budget − interns' actual pay.
 *      Each department's budget = 7,500 × its staff + the add-on pool shared by
 *      (staff × capacity multiplier). Multiplier as above but against the
 *      department's own mean. Pay = ROUNDDOWN(multiplier × dept budget ÷ dept Σ multipliers, 0).
 * Anyone below 2,200 (E < 0) gets multiplier 0 and is not counted.
 *
 * The layout is the one in the new-formula SK03 workbooks of 2026-11-05
 * (project folder sk03-new-formula-2026-11-05, built by build_sk03.py), so
 * the nightly Google Sheet reads the same way as those files:
 *   staff  Q แผนก (department name) · R dept mean E · S multiplier · T baht per multiplier
 *          panel V/W rows 8-31: W9 total budget · W10 intern paid · W11 staff budget ·
 *          W13-W16 settings (7,500 / 0.05 / 0.95 / 1.05) · W17-W21 staff count and add-on ·
 *          W24-W28 totals and คงคืน · W30-W31 checks
 *          department table V33:AF51 (header row 33, one row per department, total row 52)
 *   intern Q multiplier
 *          panel T/U rows 8-20: U9 perP4P · U10 count · U11 pool · U12 mean E ·
 *          U13 Σ multipliers · U14 baht per multiplier · U17 paid · U18 leftover
 * Pay stays in column N on both sheets, so the department sheets keep reading N.
 * W9 and U9 are yellow inputs, written as 0 and typed in by hand each month.
 *
 * Pure functions only (no API calls), so the cells can be checked offline.
 */

export const GUARANTEE = 7500;
export const SLOPE = 0.05;
export const MULT_MIN = 0.95;
export const MULT_MAX = 1.05;

/** First data row of the staff and intern sheets. */
export const DATA_START = 8;

export interface DeptCapacity {
  no: number;
  name: string; // department name as in Supabase / DEPT_COLORS
  code: string;
  cap: number;  // capacity multiplier
}

/** formula.md "Departments and Capacity Multipliers", in that table's order. */
export const DEPT_CAPACITY: DeptCapacity[] = [
  { no: 1,  name: 'กุมารเวชกรรม',                        code: 'PED', cap: 0.85 },
  { no: 2,  name: 'จักษุวิทยา',                          code: 'EYE', cap: 1.00 },
  { no: 3,  name: 'จิตเวชและยาเสพติด',                   code: 'PSY', cap: 1.00 },
  { no: 4,  name: 'เทคนิคการแพทย์และพยาธิวิทยาคลินิก',   code: 'CPT', cap: 0.85 },
  { no: 5,  name: 'นิติเวช',                             code: 'FOR', cap: 1.15 },
  { no: 6,  name: 'ผู้ป่วยนอก',                           code: 'OPD', cap: 0.85 },
  { no: 7,  name: 'พยาธิวิทยากายวิภาค',                  code: 'PAT', cap: 0.85 },
  { no: 8,  name: 'รังสีวิทยา',                           code: 'RAD', cap: 1.00 },
  { no: 9,  name: 'วิสัญญีวิทยา',                         code: 'ANS', cap: 1.15 },
  { no: 10, name: 'เวชกรรมฟื้นฟู',                        code: 'RHB', cap: 1.15 },
  { no: 11, name: 'เวชกรรมสังคม',                         code: 'SOC', cap: 0.85 },
  { no: 12, name: 'เวชศาสตร์ฉุกเฉิน',                     code: 'EMR', cap: 0.85 },
  { no: 13, name: 'ศัลยกรรม',                            code: 'SUR', cap: 1.00 },
  { no: 14, name: 'ศัลยกรรมออร์โธปิดิกส์',                code: 'ORT', cap: 1.00 },
  { no: 15, name: 'สูติ-นรีเวชกรรม',                      code: 'OBG', cap: 1.15 },
  { no: 16, name: 'โสต ศอ นาสิก',                         code: 'ENT', cap: 1.00 },
  { no: 17, name: 'อาชีวเวชกรรม',                         code: 'OCM', cap: 1.15 },
  { no: 18, name: 'อายุรกรรม',                            code: 'MED', cap: 1.15 },
];

export const TIER_LABEL: Record<string, string> = {
  '1.15': 'สาขาขาดแคลน',
  '1.00': 'สาขากึ่งขาดแคลน',
  '0.85': 'สาขาเต็มศักยภาพ',
};

const DEPT_NAMES = new Set(DEPT_CAPACITY.map(d => d.name));

/** Throws when a staff department has no capacity multiplier in DEPT_CAPACITY. */
export function checkDept(name: string): string {
  if (!DEPT_NAMES.has(name)) throw new Error(`No capacity multiplier for department "${name}" (sk03-formula.ts DEPT_CAPACITY)`);
  return name;
}

export interface CellWrite {
  range: string; // A1 range without the sheet name, e.g. "Q6" or "V9:W11"
  values: (string | number)[][];
}

const q = (sheet: string) => `'${sheet.replace(/'/g, "''")}'!`;

// ─── Fixed cells ──────────────────────────────────────────────────

/** Staff panel: label column V, value column W. */
export const STAFF_PANEL = { label: 'V', value: 'W' } as const;
/** Intern panel: label column T, value column U. */
export const INTERN_PANEL = { label: 'T', value: 'U' } as const;

export const STAFF_BUDGET_CELL = 'W9';   // งบทั้งหมด (input)
export const INTERN_PERP4P_CELL = 'U9';  // perP4P (input)

/** Department table on the staff sheet: header row, first/last department row, total row. */
export const TABLE_HEAD  = 33;
export const TABLE_FIRST = TABLE_HEAD + 1;                          // 34
export const TABLE_LAST  = TABLE_HEAD + DEPT_CAPACITY.length;       // 51
export const TABLE_TOTAL = TABLE_LAST + 1;                          // 52
/** Table columns, left to right (V..AF). */
export const TABLE_COLS = ['V', 'W', 'X', 'Y', 'Z', 'AA', 'AB', 'AC', 'AD', 'AE', 'AF'] as const;
const [TV, , , TY, TZ, TAA, TAB, TAC, TAD, TAE, TAF] = TABLE_COLS;
const tcol = (c: string) => `$${c}$${TABLE_FIRST}:$${c}$${TABLE_LAST}`;

export const TABLE_HEADERS = [
  'แผนก', 'รหัส', 'ระดับสาขา', 'ตัวคูณสาขา', 'จำนวน (≥ 2,200)', 'หน่วยถ่วงน้ำหนัก',
  'งบแผนก', 'รวมตัวคูณคะแนน', 'บาทต่อตัวคูณ', 'จ่ายจริง', 'เศษที่เหลือ',
];

// ─── Data rows ────────────────────────────────────────────────────

/**
 * Staff row r: pay (column N) and helpers Q..T.
 * `first`/`last` are the first and last data rows of the staff sheet.
 */
export function staffRowCells(r: number, dept: string, first: number, last: number): { N: string; QtoT: (string | number)[] } {
  const E = `$L$${first}:$L$${last}`;
  const D = `$Q$${first}:$Q$${last}`;
  const e = `L${r}`;
  return {
    N: `=IF(${e}<0,0,ROUNDDOWN(S${r}*T${r},0))`,
    QtoT: [
      checkDept(dept),                                                                       // Q  แผนก
      `=IF(${e}<0,"",IFERROR(AVERAGEIFS(${E},${D},Q${r},${E},">=0"),0))`,                    // R  ค่าเฉลี่ย E ของแผนก
      `=IF(${e}<0,0,IF(R${r}=0,1,MIN(MAX(1+$W$14*(${e}/R${r}-1),$W$15),$W$16)))`,            // S  ตัวคูณคะแนน
      `=IF(${e}<0,0,IFERROR(INDEX(${tcol(TAD)},MATCH(Q${r},${tcol(TV)},0)),0))`,             // T  บาทต่อตัวคูณ
    ],
  };
}

/** Intern row r: pay (column N) and the multiplier in Q. */
export function internRowCells(r: number, staffSheet: string): { N: string; Q: string } {
  const S = q(staffSheet);
  const e = `L${r}`;
  return {
    N: `=IF(${e}<0,0,ROUNDDOWN(Q${r}*$U$14,0))`,
    Q: `=IF(${e}<0,0,IF($U$12=0,1,MIN(MAX(1+${S}$W$14*(${e}/$U$12-1),${S}$W$15),${S}$W$16)))`,
  };
}

// ─── Column headers (rows 5-7) ────────────────────────────────────

/** Header text (rows 5-6, merged) and the letter row 7, like L7 " E = D-A". */
export interface HeaderCell { col: string; text: string; letter: string }

export const STAFF_HEADERS: HeaderCell[] = [
  { col: 'Q', text: 'แผนก',                     letter: 'F' },
  { col: 'R', text: 'ค่าเฉลี่ย E\nของแผนก',      letter: 'G' },
  { col: 'S', text: 'ตัวคูณคะแนน',               letter: 'H = ตัวคูณ' },
  { col: 'T', text: 'บาทต่อตัวคูณ\n(ของแผนก)',  letter: 'I' },
];

export const INTERN_HEADERS: HeaderCell[] = [
  { col: 'Q', text: 'ตัวคูณคะแนน', letter: 'F = ตัวคูณ' },
];

// ─── Side panels ──────────────────────────────────────────────────

/** A panel row: label, value (omitted for a section heading), and whether the value is a yellow input. */
export interface PanelRow { row: number; label: string; value?: string | number; heading?: boolean; input?: boolean; fmt?: string }

export const FMT_BAHT  = '#,##0.00';
export const FMT_INT   = '#,##0';
export const FMT_RATIO = '0.0000';

/**
 * Staff panel (V/W) and department table (V33:AF52).
 * `budget` is the month's total budget (written as 0, typed in by hand).
 */
export function staffPanel(internSheet: string, first: number, last: number, budget: number, budgetNote: string): { panel: PanelRow[]; table: CellWrite[] } {
  const I = q(internSheet);
  const E = `$L$${first}:$L$${last}`;
  const D = `$Q$${first}:$Q$${last}`;
  const X = `$S$${first}:$S$${last}`;
  const P = `$N$${first}:$N$${last}`;
  const A = `$M$${first}:$M$${last}`;
  const panel: PanelRow[] = [
    { row: 8,  label: 'งบจัดสรร (สูตรใหม่ตาม formula.md)', heading: true },
    { row: 9,  label: 'งบทั้งหมด', value: budget, input: true, fmt: FMT_BAHT },
    { row: 10, label: 'จ่าย intern จริง (P4P intern)', value: `=${I}$U$17`, fmt: FMT_INT },
    { row: 11, label: 'เฉพาะ staff', value: '=$W$9-$W$10', fmt: FMT_BAHT },
    { row: 12, label: 'ตั้งค่าสูตร', heading: true },
    { row: 13, label: 'ประกันต่อหัวก่อนถ่วงน้ำหนัก (บาท)', value: GUARANTEE, input: true, fmt: FMT_INT },
    { row: 14, label: 'ความชันตัวคูณคะแนน', value: SLOPE, input: true, fmt: '0.00' },
    { row: 15, label: 'ตัวคูณต่ำสุด', value: MULT_MIN, input: true, fmt: '0.00' },
    { row: 16, label: 'ตัวคูณสูงสุด', value: MULT_MAX, input: true, fmt: '0.00' },
    { row: 17, label: 'จำนวน staff (≥ 2,200 แต้ม)', value: `=COUNTIF(${E},">=0")`, fmt: FMT_INT },
    { row: 18, label: 'งบประกันรวม', value: '=$W$13*$W$17', fmt: FMT_BAHT },
    { row: 19, label: 'งบเพิ่มตามระดับสาขา (addon)', value: '=$W$11-$W$18', fmt: FMT_BAHT },
    { row: 20, label: 'รวมหน่วยถ่วงน้ำหนัก', value: `=SUM(${tcol(TAA)})`, fmt: FMT_BAHT },
    { row: 21, label: 'งบเพิ่มต่อหน่วยถ่วงน้ำหนัก', value: '=IF($W$20=0,0,$W$19/$W$20)', fmt: FMT_BAHT },
    { row: 23, label: 'ผลรวม', heading: true },
    { row: 24, label: 'ค่าตอบแทนตามสัดส่วนวิชาชีพ (staff)', value: `=SUM(${P})`, fmt: FMT_INT },
    { row: 25, label: 'ค่าตอบแทนบริหาร', value: `=SUM(${A})`, fmt: FMT_INT },
    { row: 26, label: 'P4P staff & intern (ไม่รวมค่าบริหาร)', value: '=$W$24+$W$10', fmt: FMT_INT },
    { row: 27, label: 'P4P staff & intern (รวมค่าบริหาร)', value: '=$W$26+$W$25', fmt: FMT_INT },
    { row: 28, label: 'คงคืน', value: '=$W$9-$W$26', fmt: FMT_BAHT },
    { row: 30, label: 'ตรวจ: staff ที่ไม่มีแผนกในตาราง (ต้องเป็น 0)', value: `=SUMPRODUCT((${E}>=0)*ISNA(MATCH(${D},${tcol(TV)},0)))`, fmt: '0' },
    { row: 31, label: 'ตรวจ: จ่ายเกินงบ (ต้องเป็น FALSE)', value: '=$W$26>$W$9' },
  ];
  // W9's source, written beside it in X9
  const note: CellWrite = { range: 'X9', values: [[budgetNote]] };

  const rows = DEPT_CAPACITY.map((d, k) => {
    const r = TABLE_FIRST + k;
    const c = (col: string) => `${col}${r}`;
    return [
      d.name, d.code, TIER_LABEL[d.cap.toFixed(2)], d.cap,
      `=COUNTIFS(${D},${c(TV)},${E},">=0")`,                      // Z  จำนวน
      `=${c(TZ)}*${c(TY)}`,                                        // AA หน่วยถ่วงน้ำหนัก
      `=${c(TZ)}*$W$13+${c(TAA)}*$W$21`,                           // AB งบแผนก
      `=SUMIFS(${X},${D},${c(TV)})`,                               // AC รวมตัวคูณคะแนน
      `=IF(OR(${c(TAC)}=0,$W$11<=0),0,${c(TAB)}/${c(TAC)})`,       // AD บาทต่อตัวคูณ (0 until the budget is in)
      `=SUMIFS(${P},${D},${c(TV)})`,                               // AE จ่ายจริง
      `=${c(TAB)}-${c(TAE)}`,                                      // AF เศษที่เหลือ
    ];
  });
  const sum = (col: string) => `=SUM(${col}${TABLE_FIRST}:${col}${TABLE_LAST})`;
  const table: CellWrite[] = [
    note,
    { range: `${TV}${TABLE_HEAD}:${TAF}${TABLE_HEAD}`, values: [TABLE_HEADERS] },
    { range: `${TV}${TABLE_FIRST}:${TAF}${TABLE_LAST}`, values: rows },
    { range: `${TV}${TABLE_TOTAL}:${TAF}${TABLE_TOTAL}`, values: [[
      'รวม', '', '', '', sum(TZ), sum(TAA), sum(TAB), sum(TAC), '', sum(TAE), sum(TAF),
    ]] },
  ];
  return { panel, table };
}

/** Intern panel (T/U). `perP4P` is the month's per-head rate (written as 0, typed in by hand). */
export function internPanel(first: number, last: number, perP4P: number, perP4PNote: string): { panel: PanelRow[]; extra: CellWrite[] } {
  const E = `$L$${first}:$L$${last}`;
  const panel: PanelRow[] = [
    { row: 8,  label: 'งบจัดสรร intern (สูตรใหม่ตาม formula.md)', heading: true },
    { row: 9,  label: 'perP4P (บาทต่อหัว)', value: perP4P, input: true, fmt: FMT_BAHT },
    { row: 10, label: 'จำนวน intern (≥ 2,200 แต้ม)', value: `=COUNTIF(${E},">=0")`, fmt: '0' },
    { row: 11, label: 'เฉพาะ intern', value: '=$U$9*$U$10', fmt: FMT_BAHT },
    { row: 12, label: 'ค่าเฉลี่ย E ของ intern (≥ 2,200)', value: `=IFERROR(AVERAGEIF(${E},">=0"),0)`, fmt: FMT_BAHT },
    { row: 13, label: 'รวมตัวคูณคะแนน', value: `=SUM($Q$${first}:$Q$${last})`, fmt: FMT_RATIO },
    { row: 14, label: 'บาทต่อตัวคูณ', value: '=IF($U$13=0,0,$U$11/$U$13)', fmt: FMT_BAHT },
    { row: 16, label: 'ผลรวม', heading: true },
    { row: 17, label: 'P4P intern (จ่ายจริง)', value: `=SUM($N$${first}:$N$${last})`, fmt: FMT_INT },
    { row: 18, label: 'เศษที่เหลือ (ไปรวมงบ staff)', value: '=$U$11-$U$17', fmt: FMT_BAHT },
    { row: 20, label: 'ตัวคูณต่ำสุด/สูงสุด และความชัน ใช้ค่าจาก staff' },
  ];
  return { panel, extra: [{ range: 'V9', values: [[perP4PNote]] }] };
}

/** Panel rows as value writes (label column + value column). */
export function panelWrites(panel: PanelRow[], cols: { label: string; value: string }): CellWrite[] {
  return panel.map(p => ({
    range: `${cols.label}${p.row}:${cols.value}${p.row}`,
    values: [[p.label, p.value ?? '']],
  }));
}
