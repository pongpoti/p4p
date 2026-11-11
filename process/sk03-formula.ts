/**
 * SK03 new payment formula: the cell contents (formulas, labels and inputs)
 * that process.ts writes into the staff, intern and งบรายสาขา sheets.
 *
 * The formula is the one in ./FORMULA.md:
 *   1. INTERN first. Pool = per P4P per intern × interns scoring ≥ 2,200.
 *      Multiplier = clip(1 + 0.05 × (excess ÷ intern mean excess − 1), 0.95, 1.05).
 *      Pay = ROUNDDOWN(multiplier × pool ÷ Σ multipliers, 0).
 *      Staff come first: if the budget is short, the intern pool is cut to
 *      whatever is left after 10,000 × staff.
 *   2. STAFF get the rest: staff budget = total budget − interns' actual pay.
 *      Every staff member gets the 10,000 base. The extra (staff budget −
 *      10,000 × staff) goes to departments by (staff × bonus weight: 1.5 for
 *      สาขาขาดแคลน, 1.0 กึ่งขาดแคลน, 0.5 เต็มศักยภาพ),
 *      then inside a department by score: multiplier = clip(1 + 0.5 × (excess
 *      ÷ dept mean excess − 1), 0.5, 1.5).
 *      Pay = ROUNDDOWN(10,000 + multiplier × dept extra ÷ dept Σ multipliers, 0).
 *      If the staff budget cannot give 10,000 each, every staff member gets
 *      staff budget ÷ staff.
 * Anyone below 2,200 (excess < 0) gets multiplier 0 and is not counted.
 *
 * The layout matches the reference workbook 2569_07_new_formula.xlsx (as the
 * trial workbook 2569_06_new_formula.xlsx and its Thai manuals): pay stays
 * in column N on both sheets, so the department sheets keep reading N.
 *   staff  Q code · R dept mean · S ratio · T raw multiplier · U multiplier · V dept extra per multiplier
 *          panel X/Y: Y9 total budget (input) · Y10 staff budget · Y11 count ·
 *          Y13 base 10,000 × staff · Y14 extra · Y15 extra per unit (staff × bonus weight) · Y17-Y20 totals · X23 คงคืน
 *   intern Q ratio · R raw multiplier · S7 mean · T multiplier
 *          panel V/W: W9 pool = W10 × per P4P per intern (typed into the formula) ·
 *          W10 count · W12 sum point · W13 per P4P · W14 pool used (staff first) · W16 paid
 *
 * Pure functions only (no API calls), so the cells can be checked offline.
 */

/** Every staff member's base pay; only the money above it is shared by department and score. */
export const BASE = 10000;
/** Staff score band on the part above BASE: multiplier 0.5-1.5. */
export const STAFF_SLOPE = 0.5;
export const STAFF_MULT_MIN = 0.5;
export const STAFF_MULT_MAX = 1.5;
/** Intern score band (unchanged): multiplier 0.95-1.05. */
export const SLOPE = 0.05;
export const MULT_MIN = 0.95;
export const MULT_MAX = 1.05;

/** First data row of the staff and intern sheets. */
export const DATA_START = 8;

export const BUDGET_SHEET = 'งบรายสาขา';

export interface DeptCapacity {
  no: number;
  name: string; // department name as in Supabase / DEPT_COLORS
  code: string;
  cap: number;  // capacity multiplier
}

/** FORMULA.md "Departments and Capacity Multipliers", in that table's order. */
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

/**
 * Weight of each capacity tier when the extra above BASE is split between
 * departments (Pong, 2026-11-11: 1.5 / 1 / 0.5, so with the ±50% score band
 * every สาขาขาดแคลน doctor is paid more than every สาขาเต็มศักยภาพ doctor).
 */
export const BONUS_WEIGHT: Record<string, number> = {
  '1.15': 1.5,
  '1.00': 1.0,
  '0.85': 0.5,
};

export const TIER_LABEL: Record<string, string> = {
  '1.15': 'สาขาขาดแคลน',
  '1.00': 'สาขากึ่งขาดแคลน',
  '0.85': 'สาขาเต็มศักยภาพ',
};

const DEPT_CODE_BY_NAME: Record<string, string> = Object.fromEntries(DEPT_CAPACITY.map(d => [d.name, d.code]));

/** Department code (PED, EYE, …) for a staff department name; throws on an unknown name. */
export function deptCode(name: string): string {
  const code = DEPT_CODE_BY_NAME[name];
  if (!code) throw new Error(`No capacity multiplier for department "${name}" (sk03-formula.ts DEPT_CAPACITY)`);
  return code;
}

/** Budget-sheet rows: header rows 4-5, one row per department from 6, total row after. */
export const BUDGET_FIRST = 6;
export const BUDGET_LAST = BUDGET_FIRST + DEPT_CAPACITY.length - 1; // 23
export const BUDGET_TOTAL = BUDGET_LAST + 1;                         // 24

export interface CellWrite {
  range: string; // A1 range without the sheet name, e.g. "Q5" or "X9:Y11"
  values: (string | number)[][];
}

const q = (sheet: string) => `'${sheet.replace(/'/g, "''")}'!`;

// ─── Data rows ────────────────────────────────────────────────────

/**
 * Staff row r: pay (column N) and helpers Q..V. Pay = 10,000 + multiplier ×
 * the department's extra per multiplier (V); everyone equal if the staff
 * budget is below 10,000 each (Y14 < 0).
 * `first`/`last` are the first and last data rows of the staff sheet.
 */
export function staffRowCells(r: number, code: string, first: number, last: number): { N: string; QtoV: (string | number)[] } {
  const L = `$L$${first}:$L$${last}`;
  const Q = `$Q$${first}:$Q$${last}`;
  return {
    N: `=IF(L${r}<0,0,ROUNDDOWN(IF($Y$14<0,$Y$10/$Y$11,${BASE}+U${r}*V${r}),0))`,
    QtoV: [
      code,                                                                 // Q  department code
      `=IFERROR(AVERAGEIFS(${L},${Q},Q${r},${L},">=0"),0)`,                 // R  dept mean excess (≥ 2,200 only)
      `=IF(OR(L${r}<0,R${r}=0),"",L${r}/R${r})`,                            // S  times the dept mean
      `=IF(L${r}<0,"",IF(R${r}=0,1,1+${STAFF_SLOPE}*(S${r}-1)))`,           // T  raw multiplier
      `=IF(L${r}<0,0,MIN(MAX(T${r},${STAFF_MULT_MIN}),${STAFF_MULT_MAX}))`, // U  multiplier 0.5-1.5
      `=VLOOKUP(Q${r},${q(BUDGET_SHEET)}$C$${BUDGET_FIRST}:$L$${BUDGET_LAST},10,FALSE)`, // V  dept extra per multiplier
    ],
  };
}

/** Intern row r: pay (column N) and helpers Q..V (S, U, V stay empty on data rows). */
export function internRowCells(r: number): { N: string; QtoV: (string | number)[] } {
  return {
    N: `=ROUNDDOWN(T${r}*$W$13,0)`,
    QtoV: [
      `=IF(OR(L${r}<0,$S$7=0),"",L${r}/$S$7)`,                              // Q  times the intern mean
      `=IF(L${r}<0,"",IF($S$7=0,1,1+${SLOPE}*(Q${r}-1)))`,                  // R  raw multiplier
      '',                                                                   // S  (mean sits in S7)
      `=IF(L${r}<0,0,MIN(MAX(R${r},${MULT_MIN}),${MULT_MAX}))`,             // T  multiplier 0.95-1.05
      '',                                                                   // U
      '',                                                                   // V  (panel label column)
    ],
  };
}

// ─── Column headers (rows 5-7) ────────────────────────────────────

export interface HeaderCell { col: string; text: string; bottom: number } // merged from row 5 to `bottom`

export const STAFF_HEADERS: HeaderCell[] = [
  { col: 'Q', text: 'สาขา', bottom: 7 },
  { col: 'R', text: 'ค่าเฉลี่ย\nแต้มเกิน\nของสาขา', bottom: 7 },
  { col: 'S', text: 'เทียบค่าเฉลี่ย\n(เท่า)', bottom: 7 },
  { col: 'T', text: 'ตัวคูณ\nก่อนจำกัด', bottom: 7 },
  { col: 'U', text: 'ตัวคูณ\n(0.50–1.50)', bottom: 7 },
  { col: 'V', text: 'ส่วนเพิ่ม\nต่อตัวคูณ\nของสาขา', bottom: 7 },
];

export const INTERN_HEADERS: HeaderCell[] = [
  { col: 'Q', text: 'เทียบค่าเฉลี่ย\n(เท่า)', bottom: 7 },
  { col: 'R', text: 'ตัวคูณ\nก่อนจำกัด', bottom: 7 },
  { col: 'S', text: 'ค่าเฉลี่ย\nแต้มเกิน\n(≥ 2,200)', bottom: 6 }, // S7 holds the mean
  { col: 'T', text: 'ตัวคูณ\n(0.95–1.05)', bottom: 7 },
];

/** Intern S7: mean excess of the interns scoring ≥ 2,200. */
export function internMeanCell(first: number, last: number): CellWrite {
  return { range: 'S7', values: [[`=IFERROR(AVERAGEIF(L${first}:L${last},">=0"),0)`]] };
}

// ─── Side panels ──────────────────────────────────────────────────

/**
 * Staff panel (X/Y). Y9 is the month's total budget: the one typed in the
 * dashboard's ตรวจสอบ tab (review_inputs), or 0 until someone types it.
 */
export function staffPanel(internSheet: string, first: number, last: number, budget = 0): CellWrite[] {
  const I = q(internSheet);
  const B = q(BUDGET_SHEET);
  return [
    { range: 'X8:Y8', values: [['งบจัดสรร', '']] },
    { range: 'X9:Y11', values: [
      ['งบทั้งหมด', budget],
      ['เฉพาะ staff', `=Y9-${I}W16`],
      ['จำนวน staff (≥ 2,200)', `=COUNTIF(L${first}:L${last},">=0")`],
    ]},
    { range: 'X12:Y12', values: [['ค่าที่คำนวณได้', '']] },
    { range: 'X13:Y15', values: [
      [`ฐาน ${BASE.toLocaleString('en-US')} × จำนวน staff`, `=${BASE}*Y11`],
      ['ส่วนเพิ่ม (แบ่งตามศักยภาพสาขา)', '=Y10-Y13'],
      ['ส่วนเพิ่ม ต่อ 1 หน่วย', `=Y14/${B}H${BUDGET_TOTAL}`],
    ]},
    { range: 'X16:Y16', values: [['ผลรวม', '']] },
    { range: 'X17:Y20', values: [
      ['ค่าตอบแทนตามสัดส่วนวิชาชีพ', `=SUM(N${first}:N${last})`],
      ['ค่าตอบแทนบริหาร', `=SUM(M${first}:M${last})`],
      ['P4P staff & intern (ไม่รวมค่าบริหาร)', `=Y17+${I}W16`],
      ['P4P staff & intern (รวมค่าบริหาร)', '=Y19+Y18'],
    ]},
    { range: 'X22:Y22', values: [['คงคืน', '']] },
    { range: 'X23', values: [['=Y9-Y19']] },
    { range: 'X25:X26', values: [
      ['เซลล์สีเหลือง = สูตรใหม่ (ดูคู่มือการอ่านไฟล์ SK03 สูตรใหม่)'],
      [`staff ได้ ${BASE.toLocaleString('en-US')} + ส่วนเพิ่มตามสาขาและคะแนน (ชีต ${BUDGET_SHEET})`],
    ]},
  ];
}

/**
 * Intern panel (V/W). W9 = W10 × the month's per P4P per intern, the rate
 * written into the formula like the SK03 form's `=9906.44*24`: the one typed
 * in the dashboard's ตรวจสอบ tab (review_inputs), or 0 until someone types it.
 * W14 is the pool actually shared: W9, cut so the staff keep 10,000 each
 * (staff budget Y9 − 10,000 × staff Y11) when the budget is short.
 */
export function internPanel(staffSheet: string, first: number, last: number, rate = 0): CellWrite[] {
  const St = q(staffSheet);
  return [
    { range: 'V8:W8', values: [['งบจัดสรร', '']] },
    { range: 'V9:W10', values: [
      ['เฉพาะ intern', `=W10*${rate}`],
      ['จำนวน intern (≥ 2,200)', `=COUNTIF(L${first}:L${last},">=0")`],
    ]},
    { range: 'V11:W11', values: [['ค่าที่คำนวณได้', '']] },
    { range: 'V12:W14', values: [
      ['sum point', `=SUM(T${first}:T${last})`],
      ['per P4P', '=IF(W12=0,0,W14/W12)'],
      [`ใช้จริง (กัน staff ${BASE.toLocaleString('en-US')} ก่อน)`, `=IF(${St}$Y$9=0,W9,MAX(0,MIN(W9,${St}$Y$9-${BASE}*${St}$Y$11)))`],
    ]},
    { range: 'V15:W15', values: [['ผลรวม', '']] },
    { range: 'V16:W16', values: [['P4P intern', `=SUM(O${first}:O${last})`]] },
  ];
}

// ─── งบรายสาขา sheet ──────────────────────────────────────────────

export const BUDGET_HEADERS = [
  'ที่', 'สาขา', 'รหัส', 'ระดับศักยภาพ', 'น้ำหนัก\nส่วนเพิ่ม', 'จำนวน\nแพทย์',
  `ฐาน\n(${BASE.toLocaleString('en-US')} × จำนวน)`, 'หน่วย\n(จำนวน × น้ำหนัก)',
  'ส่วนเพิ่ม\n(หน่วย × ต่อหน่วย)', 'งบสาขา', 'sum point\nของสาขา', 'ส่วนเพิ่ม\nต่อตัวคูณ',
  'จ่ายจริง\n(ROUNDDOWN)', 'เศษคงเหลือ',
];

/** Cells of the งบรายสาขา sheet (A1:N26). */
export function budgetSheet(staffSheet: string, first: number, last: number, monthLabel: string): CellWrite[] {
  const S = q(staffSheet);
  const codes = `${S}$Q$${first}:$Q$${last}`;
  const rows: (string | number)[][] = DEPT_CAPACITY.map((d, k) => {
    const r = BUDGET_FIRST + k;
    return [
      d.no, d.name, d.code, TIER_LABEL[d.cap.toFixed(2)], BONUS_WEIGHT[d.cap.toFixed(2)],
      `=COUNTIFS(${codes},C${r},${S}$L$${first}:$L$${last},">=0")`,       // F staff ≥ 2,200
      `=${BASE}*F${r}`,                                                    // G base 10,000 each
      `=F${r}*E${r}`,                                                      // H units (staff × bonus weight)
      `=H${r}*${S}$Y$15`,                                                  // I add-on
      `=G${r}+I${r}`,                                                      // J dept budget
      `=SUMIF(${codes},C${r},${S}$U$${first}:$U$${last})`,                 // K Σ multipliers
      `=IF(OR(K${r}=0,${S}$Y$10<=0),0,I${r}/K${r})`,                       // L extra per multiplier (0 until the budget is typed in)
      `=SUMIF(${codes},C${r},${S}$N$${first}:$N$${last})`,                 // M paid
      `=J${r}-M${r}`,                                                      // N remainder
    ];
  });
  const T = BUDGET_TOTAL;
  const sum = (c: string) => `=SUM(${c}${BUDGET_FIRST}:${c}${BUDGET_LAST})`;
  return [
    { range: 'A1', values: [['งบ P4P staff รายสาขา (สูตรใหม่)']] },
    { range: 'A2', values: [[monthLabel]] },
    { range: 'A3', values: [[
      `งบสาขา = ${BASE.toLocaleString('en-US')} × จำนวนแพทย์ + ส่วนเพิ่มต่อหน่วย × (จำนวนแพทย์ × น้ำหนักส่วนเพิ่ม 1.5 / 1 / 0.5)      `
      + `ส่วนเพิ่มต่อตัวคูณ = ส่วนเพิ่มของสาขา ÷ sum point ของสาขา      ได้รับ = ${BASE.toLocaleString('en-US')} + ตัวคูณ × ส่วนเพิ่มต่อตัวคูณ`,
    ]] },
    { range: 'A4:N4', values: [BUDGET_HEADERS] },
    { range: `A${BUDGET_FIRST}:N${BUDGET_LAST}`, values: rows },
    { range: `A${T}:N${T}`, values: [[
      'รวม staff', '', '', '', '',
      sum('F'), sum('G'), sum('H'), sum('I'), sum('J'), sum('K'), '', sum('M'), sum('N'),
    ]] },
    { range: `B${T + 2}`, values: [['เช็ก: รวมงบสาขา = เฉพาะ staff']] },
    { range: `J${T + 2}:K${T + 2}`, values: [[`=J${T}-${S}Y10`, '← ต้องเป็น 0']] },
  ];
}
