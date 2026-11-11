/**
 * SK03 new payment formula: the cell contents (formulas, labels and inputs)
 * that process.ts writes into the staff, intern and งบรายสาขา sheets.
 *
 * The formula is the one in pongpoti/p4p-analysis docs/formula/formula.md:
 *   1. INTERN first. Pool = per P4P per intern × interns scoring ≥ 2,200.
 *      Multiplier = clip(1 + 0.05 × (excess ÷ intern mean excess − 1), 0.95, 1.05).
 *      Pay = ROUNDDOWN(multiplier × pool ÷ Σ multipliers, 0).
 *   2. STAFF get the rest: staff budget = total budget − interns' actual pay.
 *      Each department's budget = 7,500 × its staff + the add-on pool shared by
 *      (staff × capacity multiplier). Multiplier as above but against the
 *      department's own mean. Before rounding: multiplier × dept budget ÷ dept Σ multipliers.
 *   3. STAFF floor (Pong, 2026-11-11): nobody on staff gets less than 10,000.
 *      Anyone under it is raised to it; the money comes from everyone above it,
 *      whose part above the floor shrinks by the same share:
 *        keep = 1 − (Σ shortfall under the floor) ÷ (Σ amount above the floor)
 *        pay  = ROUNDDOWN(IF(before < floor, floor, floor + keep × (before − floor)), 0)
 *      In a month where nobody is under the floor, keep = 1 and nothing changes.
 *      If the staff budget cannot give everyone the floor, the floor used is the
 *      staff budget ÷ staff count (everyone then gets the same).
 * Anyone below 2,200 (excess < 0) gets multiplier 0, pay 0 and is not counted.
 *
 * The layout matches the reference workbook 2569_07_new_formula.xlsx (as the
 * trial workbook 2569_06_new_formula.xlsx and its Thai manuals): pay stays
 * in column N on both sheets, so the department sheets keep reading N.
 *   staff  Q code · R dept mean · S ratio · T raw multiplier · U multiplier · V dept per P4P ·
 *          W pay before the floor
 *          panel X/Y: Y9 total budget (input) · Y10 staff budget · Y11 count ·
 *          Y13 guarantee · Y14 add-on · Y15 add-on per capacity unit · Y17-Y20 totals · X23 คงคืน ·
 *          Y29 floor · Y30 floor used · Y31 shortfall · Y32 above the floor · Y33 keep · Y34 staff raised
 *   intern Q ratio · R raw multiplier · S7 mean · T multiplier
 *          panel V/W: W9 pool = W10 × per P4P per intern (typed into the formula) ·
 *          W10 count · W12 sum point · W13 per P4P · W16 paid
 *
 * Pure functions only (no API calls), so the cells can be checked offline.
 */

export const GUARANTEE = 7500;
export const SLOPE = 0.05;
export const MULT_MIN = 0.95;
export const MULT_MAX = 1.05;
/** Lowest staff pay (Pong, 2026-11-11). Interns have no floor. */
export const STAFF_FLOOR = 10000;

/** Staff panel rows of the floor block (X28:Y34). */
export const FLOOR_PANEL = { head: 28, floor: 29, used: 30, short: 31, over: 32, keep: 33, raised: 34 } as const;
const FP = FLOOR_PANEL;

/** First data row of the staff and intern sheets. */
export const DATA_START = 8;

export const BUDGET_SHEET = 'งบรายสาขา';

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
 * Staff row r: pay (column N) and helpers Q..W.
 * `first`/`last` are the first and last data rows of the staff sheet.
 */
export function staffRowCells(r: number, code: string, first: number, last: number): { N: string; QtoV: (string | number)[] } {
  const L = `$L$${first}:$L$${last}`;
  const Q = `$Q$${first}:$Q$${last}`;
  const F = `$Y$${FP.used}`;
  return {
    N: `=IF(L${r}<0,0,ROUNDDOWN(IF(W${r}<${F},${F},${F}+$Y$${FP.keep}*(W${r}-${F})),0))`,
    QtoV: [
      code,                                                                 // Q  department code
      `=IFERROR(AVERAGEIFS(${L},${Q},Q${r},${L},">=0"),0)`,                 // R  dept mean excess (≥ 2,200 only)
      `=IF(OR(L${r}<0,R${r}=0),"",L${r}/R${r})`,                            // S  times the dept mean
      `=IF(L${r}<0,"",IF(R${r}=0,1,1+${SLOPE}*(S${r}-1)))`,                 // T  raw multiplier
      `=IF(L${r}<0,0,MIN(MAX(T${r},${MULT_MIN}),${MULT_MAX}))`,             // U  multiplier 0.95-1.05
      `=VLOOKUP(Q${r},${q(BUDGET_SHEET)}$C$${BUDGET_FIRST}:$L$${BUDGET_LAST},10,FALSE)`, // V  dept per P4P
      `=IF(L${r}<0,0,U${r}*V${r})`,                                         // W  pay before the floor
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
  { col: 'U', text: 'ตัวคูณ\n(0.95–1.05)', bottom: 7 },
  { col: 'V', text: 'per P4P\nของสาขา', bottom: 7 },
  { col: 'W', text: 'ค่าตอบแทน\nก่อนขั้นต่ำ', bottom: 7 },
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
      [`ฐานประกัน ${GUARANTEE.toLocaleString('en-US')} × จำนวน staff`, `=${GUARANTEE}*Y11`],
      ['ส่วนเพิ่ม (แบ่งตามศักยภาพสาขา)', '=Y10-Y13'],
      ['ส่วนเพิ่ม ต่อ 1 หน่วยศักยภาพ', `=Y14/${B}H${BUDGET_TOTAL}`],
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
      [`per P4P ของแต่ละสาขา อยู่ในชีต ${BUDGET_SHEET}`],
    ]},
    ...staffFloorPanel(first, last),
  ];
}

/**
 * Staff floor block (X28:Y34): anyone under the floor is raised to it, paid
 * for by shrinking everyone's part above the floor by the same share (Y33).
 */
export function staffFloorPanel(first: number, last: number): CellWrite[] {
  const L = `L${first}:L${last}`;
  const W = `W${first}:W${last}`;
  const F = `Y${FP.used}`;
  return [
    { range: `X${FP.head}:Y${FP.head}`, values: [['ขั้นต่ำ staff', '']] },
    { range: `X${FP.floor}:Y${FP.raised}`, values: [
      ['ขั้นต่ำต่อคน', STAFF_FLOOR],
      ['ขั้นต่ำที่ใช้ (ไม่เกิน เฉพาะ staff ÷ จำนวน)', `=MAX(0,MIN(Y${FP.floor},IF(Y11=0,0,Y10/Y11)))`],
      ['เงินที่เติมให้ถึงขั้นต่ำ', `=SUMPRODUCT((${L}>=0)*(${W}<${F})*(${F}-${W}))`],
      ['ส่วนที่เกินขั้นต่ำ รวมทุกคน', `=SUMPRODUCT((${L}>=0)*(${W}>=${F})*(${W}-${F}))`],
      ['สัดส่วนส่วนเกินที่คงไว้', `=IF(Y${FP.over}<=0,1,MAX(0,1-Y${FP.short}/Y${FP.over}))`],
      ['จำนวน staff ที่ได้รับเงินเติม', `=SUMPRODUCT((${L}>=0)*(${W}<${F}))`],
    ]},
  ];
}

/**
 * Intern panel (V/W). W9 = W10 × the month's per P4P per intern, the rate
 * written into the formula like the SK03 form's `=9906.44*24`: the one typed
 * in the dashboard's ตรวจสอบ tab (review_inputs), or 0 until someone types it.
 */
export function internPanel(first: number, last: number, rate = 0): CellWrite[] {
  return [
    { range: 'V8:W8', values: [['งบจัดสรร', '']] },
    { range: 'V9:W10', values: [
      ['เฉพาะ intern', `=W10*${rate}`],
      ['จำนวน intern (≥ 2,200)', `=COUNTIF(L${first}:L${last},">=0")`],
    ]},
    { range: 'V11:W11', values: [['ค่าที่คำนวณได้', '']] },
    { range: 'V12:W13', values: [
      ['sum point', `=SUM(T${first}:T${last})`],
      ['per P4P', '=IF(W12=0,0,W9/W12)'],
    ]},
    { range: 'V15:W15', values: [['ผลรวม', '']] },
    { range: 'V16:W16', values: [['P4P intern', `=SUM(O${first}:O${last})`]] },
  ];
}

// ─── งบรายสาขา sheet ──────────────────────────────────────────────

export const BUDGET_HEADERS = [
  'ที่', 'สาขา', 'รหัส', 'ระดับศักยภาพ', 'ตัวคูณ\nศักยภาพ', 'จำนวน\nแพทย์',
  `ฐานประกัน\n(${GUARANTEE.toLocaleString('en-US')} × จำนวน)`, 'หน่วยศักยภาพ\n(จำนวน × ตัวคูณ)',
  'ส่วนเพิ่ม\n(หน่วย × ต่อหน่วย)', 'งบสาขา', 'sum point\nของสาขา', 'per P4P\nของสาขา',
  'จ่ายจริง\n(หลังขั้นต่ำ)', 'เศษคงเหลือ\n(ติดลบ = รับเงินเติม)',
];

/** Cells of the งบรายสาขา sheet (A1:N26). */
export function budgetSheet(staffSheet: string, first: number, last: number, monthLabel: string): CellWrite[] {
  const S = q(staffSheet);
  const codes = `${S}$Q$${first}:$Q$${last}`;
  const rows: (string | number)[][] = DEPT_CAPACITY.map((d, k) => {
    const r = BUDGET_FIRST + k;
    return [
      d.no, d.name, d.code, TIER_LABEL[d.cap.toFixed(2)], d.cap,
      `=COUNTIFS(${codes},C${r},${S}$L$${first}:$L$${last},">=0")`,       // F staff ≥ 2,200
      `=${GUARANTEE}*F${r}`,                                               // G guarantee
      `=F${r}*E${r}`,                                                      // H capacity units
      `=H${r}*${S}$Y$15`,                                                  // I add-on
      `=G${r}+I${r}`,                                                      // J dept budget
      `=SUMIF(${codes},C${r},${S}$U$${first}:$U$${last})`,                 // K Σ multipliers
      `=IF(OR(K${r}=0,${S}$Y$10<=0),0,J${r}/K${r})`,                       // L dept per P4P (0 until the budget is typed in)
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
      `งบสาขา = ${GUARANTEE.toLocaleString('en-US')} × จำนวนแพทย์ + ส่วนเพิ่มต่อหน่วย × (จำนวนแพทย์ × ตัวคูณศักยภาพ)      `
      + 'per P4P ของสาขา = งบสาขา ÷ sum point ของสาขา',
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
