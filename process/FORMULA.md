# SK03 Payment Formula

The formula the nightly SK03 build (workflow 2.2, `process/process.ts`) writes into the SK03 sheet; the cell formulas are in [`sk03-formula.ts`](./sk03-formula.ts). This file is the whole formula reference: the rules and step-by-step calculation, then the [departments and their multipliers](#departments-and-multipliers) and the [monthly budget inputs](#monthly-budget-inputs) they use.

## Minimum Score Eligibility (applies before any other step)

Every physician's score — STAFF and INTERN alike — is checked against a minimum threshold before any calculation begins:

```
if raw_score_i − 2,200 < 0:
    physician i is OMITTED from this month's calculation entirely
```

| Variable | Meaning |
|---|---|
| `raw_score_i` | Physician's score this month (SK03 column K) |
| `2,200` | Minimum score threshold |

**Physicians scoring below 2,200 are removed from that month's dataset before any other step** — not merely given a floored score. They receive no payment (SK03 column N = 0).

Because omission happens before headcounts are computed, every downstream `N` automatically reflects the reduction:

- **That physician's department**: `count_d` (used for the split by department multiplier) becomes `N_d − 1`.
- **Hospital-wide STAFF count**: `N_staff` (used for `base_total = 10,000 × N_staff`) also shrinks by 1 if the omitted physician is STAFF — freeing that ฿10,000 base (plus their would-be extra share) to be shared across **every other STAFF physician in every department**, not just their own.
- **INTERN count**: `N_intern` (used for `intern_budget = perP4P × N_intern`) shrinks by 1 if the omitted physician is INTERN — which directly **increases `staff_budget`** (`staff_budget = total_budget − intern_paid`), giving the entire STAFF pool more money.

Remaining (eligible) physicians use `score_adj_i = raw_score_i − 2,200` (always ≥ 0, since anyone below threshold has already been removed) in every step below.

## Core Formulas

STAFF come first: every eligible STAFF physician is paid ฿10,000 plus a share of what is left above that, and INTERN are paid from the rest. There is no top-up step; ฿10,000 is part of every STAFF payment from the start.

### INTERN — one pool, cut first when money is short

```
intern_budget = min( perP4P × N_intern,  max(0, total_budget − 10,000 × N_staff) )
intern_paid   = Σ intern payment_i
```

INTERN is calculated first and separately, as in the SK03 `intern_summary` sheet. Normally `intern_budget = perP4P × N_intern`. Only when that would leave STAFF with less than ฿10,000 each is the intern pool cut to what is left after `10,000 × N_staff`. The pool is split by the INTERN multiplier (next section, ±5%), pro-rata and floored. STAFF then receive whatever the interns were not actually paid (`total_budget − intern_paid`).

| Variable | Meaning |
|---|---|
| `intern_budget` | INTERN pool (SK03 `intern_summary` W14 "ใช้จริง"; W9 "เฉพาะ intern" = perP4P × N_intern before any cut) |
| `intern_paid` | Sum of the floored intern payments (SK03 `intern_summary` "P4P intern") |

**Key properties:**
- Interns with equal scores always get equal pay, and close scores get close pay (no tier cliffs).
- The interns' floored remainder (a few baht) is not lost: it stays in the STAFF budget.
- `perP4P` is `total_budget ÷ N` from [Monthly Budget Inputs](#monthly-budget-inputs); `N` (from the allocation document) includes doctors on study leave, so their share stays with STAFF.

---

### Mean-relative multiplier (per department; INTERN counts as one department)

```
mult_i = clip( 1 + s × (score_adj_i / mean_score_adj − 1), 1 − s, 1 + s )

s = 0.50 for STAFF   (multiplier 0.50–1.50, applied only to the part above ฿10,000)
s = 0.05 for INTERN  (multiplier 0.95–1.05, applied to the whole intern payment)
```

| Variable | Meaning |
|---|---|
| `score_adj_i` | Individual physician's score this month minus 2,200, **after the Minimum Score Eligibility step above** (physicians below threshold are already removed) |
| `mean_score_adj` | Average `score_adj` of the remaining physicians in the department this month |
| `s` | Slope and band. STAFF: a physician at twice the department average gets 1.50, one at exactly 2,200 gets 0.50. INTERN: 1.05 and 0.95 |

A physician at the department average receives mult = 1.00. Physicians with close scores receive close multipliers, and one very high scorer cannot pull everyone else to the floor. The STAFF band is wider because it only moves the part above ฿10,000, which is small (about ฿350–460 per head on average in 2569_07–08).

**Edge case:** if `mean_score_adj = 0` (every remaining physician scored exactly 2,200) → `mult_i = 1.00` for everyone (avoids division by zero). A department with one physician always gets 1.00.

---

### STAFF payment — ฿10,000 base + extra share (per department)

```
extra_pool  = staff_budget − 10,000 × N_staff
lack_d      = max(0, 1 − on_staff_d / FTE_d)                     from the staffing sheet
dept_mult_d = 1 + 5 × lack_d
dept_extra  = extra_pool × (count_d × dept_mult_d) / Σ (count × dept_mult)
payment_i   = ⌊ min(15,000, 10,000 + dept_extra × mult_i / Σ mult_d) ⌋     anything above 15,000 goes to the rest of the department (Step 3.6)
```

Every eligible STAFF physician gets ฿10,000; nobody is paid less. Only `extra_pool` is shared, first between departments by the department multiplier, then inside each department by score. The department multiplier grows in proportion to how short of doctors the department is (`lack_d`, the share of its FTE not filled): every 10 points of lack adds 0.5, so a fully staffed department is 1.00, one 20% short 2.00 and one 60% short 4.00. A physician's average extra share grows the same way: a department at 4.00 gets 4 times the extra per physician of one at 1.00. There are no tiers or groups (Pong, 2026-11-13). Nobody is paid more than ฿15,000 (Pong's 15,000 check): what a physician's share would put above it goes to the other physicians of the same department, so each department's total and average stay as above. The fractional remainder (a few dozen baht per month) is **not redistributed** — it stays unspent.

If `staff_budget < 10,000 × N_staff` even after the intern pool is cut to 0 (`total_budget < 10,000 × N_staff`), ฿10,000 each is not affordable: every STAFF physician gets `⌊staff_budget / N_staff⌋`.

---

## Step-by-Step Calculation

### Step 0 — Minimum Score Eligibility

**0.1 — Read monthly score data**
```
data ← every physician in this month's SK03  (STAFF and INTERN together)
```

**0.2 — Omit physicians below the minimum threshold**
```
omitted = data[data.score < 2,200]
data    = data[data.score >= 2,200]
data.score_adj = data.score − 2,200
```
Applied uniformly regardless of STAFF/INTERN status. `omitted` rows are dropped before any headcount (`N`) is computed anywhere downstream — department STAFF count, hospital-wide STAFF count, and INTERN count all automatically become `N-1` for each omitted physician. All later steps (INTERN and STAFF multipliers) use the reduced `data` and `score_adj` (always ≥ 0), never the raw score or original headcount.

---

### Step 1 — Inputs and INTERN Pool

INTERN is calculated first (Step 2); STAFF get what is left (Step 3), the same order as the SK03 workbook.

**1.1 — Read monthly inputs**
```
total_budget  ← budget for this month (฿)                        SK03 staff_summary "งบทั้งหมด"
perP4P        ← per-physician P4P rate for this month (฿, may have decimals)
```
Both values for each month are in [Monthly Budget Inputs](#monthly-budget-inputs).

**1.2 — Separate INTERN and STAFF rows**
```
intern_data ← all rows where Department = 'INTERN'   (post Step 0 — omitted physicians already removed)
staff_data  ← all rows where Department ≠ 'INTERN'   (post Step 0 — omitted physicians already removed)
N_intern    = len(intern_data)
N_staff     = len(staff_data)
```
Because `data` was already filtered in Step 0, `N_intern` and `N_staff` here are automatically `N-1` for any month with an omitted physician.

**1.3 — Fix intern pool (STAFF first)**
```
intern_full   = perP4P × N_intern                                  SK03 intern_summary W9 "เฉพาะ intern"
intern_budget = min( intern_full, max(0, total_budget − 10,000 × N_staff) )   W14 "ใช้จริง"
```
`intern_budget = intern_full` in every month so far (2568_05–2569_08). It is cut only when the budget cannot give every STAFF physician ฿10,000 after paying interns in full.

---

### Step 2 — INTERN Payments (one pool, mean-relative multiplier)

Runs first. Uses only `intern_data` and `intern_budget`.

**2.1 — Compute score-normalized multipliers**
```
mean_score_adj_intern = average score_adj_i over intern_data
mult_i = clip( 1 + 0.05 × (score_adj_i / mean_score_adj_intern − 1), 0.95, 1.05 )
```
The INTERN band stays ±5% (`s = 0.05`). If `mean_score_adj_intern = 0` → `mult_i = 1.00` for everyone. In SK03 this replaces only the multiplier column of `intern_summary` (the old `MAX` of the AVG±SD bands); with `O` = score − 2,200 over rows 8–38:
```
=IF(O8<0, 0, MIN(MAX(1 + 0.05*(O8/AVERAGEIF($O$8:$O$38,">=0") - 1), 0.95), 1.05))
```

**2.2 — Distribute intern_budget via pro-rata, floored**
```
rate_intern = intern_budget / Σ mult_i                             SK03 "sum point", "per P4P"
ideal_i     = rate_intern × mult_i
payment_i   = ⌊ideal_i⌋                                            SK03 ROUNDDOWN(mult × per P4P, 0)
```
In SK03, per P4P (W13) = W14 ÷ sum point (W12).

**2.3 — Record what the interns were actually paid**
```
intern_paid = Σ payment_i                                          SK03 intern_summary "P4P intern"
```
`intern_budget − intern_paid` (the floored remainder, a few baht) is not lost: Step 3 starts from `total_budget − intern_paid`, so it goes to STAFF.

---

### Step 3 — STAFF Payments

Runs after Step 2. Uses only `staff_data` and `staff_budget`.

**3.0 — Staff budget**
```
staff_budget = total_budget − intern_paid                          SK03 staff_summary Y10 "เฉพาะ staff"
```

**3.1 — ฿10,000 base and extra pool**
```
base_total = 10,000 × N_staff                                      SK03 Y13 "ฐาน 10,000 × จำนวน staff"
extra_pool = staff_budget − base_total                             SK03 Y14 "ส่วนเพิ่ม"
```
Every STAFF physician's pay starts at ฿10,000. Only `extra_pool` depends on department and score.

**3.2 — Compute weighted units per department**
```
for each department d:
    count_d          = number of physicians in department d        งบรายสาขา column F
    lack_d           = max(0, 1 − on_staff_d / FTE_d)              งบรายสาขา column D
    dept_mult_d      = 1 + 5 × lack_d                              งบรายสาขา column E
    weighted_units_d = count_d × dept_mult_d                       งบรายสาขา column H

total_weighted_units = Σ weighted_units_d
```
Each department's FTE, doctors on staff, lack and multiplier are in [Departments and Multipliers](#departments-and-multipliers). A department with its full FTE or more has lack 0, so no multiplier is below 1.00. The 5 is `LACK_K` in [`sk03-formula.ts`](./sk03-formula.ts); it sets how strongly lack counts.

**3.3 — Share the extra pool between departments**
```
extra_per_unit = extra_pool / total_weighted_units                 SK03 Y15

for each department d:
    dept_extra_d  = weighted_units_d × extra_per_unit             งบรายสาขา column I
    dept_budget_d = (count_d × 10,000) + dept_extra_d              งบรายสาขา column J
```
On average a physician in department d gets `extra_per_unit × dept_mult_d` above ฿10,000: in proportion to the department multiplier.

**3.4 — Compute score multipliers within each department**
```
for each physician i in department d:
    mean_score_adj_d = average score_adj_i over department d
    mult_i = clip( 1 + 0.50 × (score_adj_i / mean_score_adj_d − 1), 0.50, 1.50 )
```
Uses `score_adj` from Step 0, computed only over physicians remaining after omission. If `mean_score_adj_d = 0` → `mult_i = 1.00` for everyone.

**3.5 — Pay before the cap**
```
extra_rate_d = dept_extra_d / Σ mult_i                              งบรายสาขา column L
pay_i        = 10,000 + extra_rate_d × mult_i
```

**3.6 — 15,000 cap, then pay**
```
over_d       = Σ max(0, pay_i − 15,000)  over physicians in d      งบรายสาขา column O
under_d      = Σ mult_i over physicians in d with pay_i ≤ 15,000    งบรายสาขา column P
rate_d       = extra_rate_d + over_d / under_d                      งบรายสาขา column Q, staff_summary V
               (extra_rate_d if under_d = 0)
payment_i    = ⌊ min(15,000, 10,000 + rate_d × mult_i) ⌋            staff_summary N
```
Nobody is paid more than ฿15,000. What a physician's share would put above it goes once to the physicians of the same department who are under it, in proportion to their multiplier, so the department's total and average do not change and Step 3.3 still holds. If that one pass put someone else above 15,000, they would be held at 15,000 and the rest would stay unspent; this has not happened in any month 2568_05–2569_08. The cap only applies in 2569_01, 2569_02 and 2569_05, each time in SOC (฿926, ฿67 and ฿180 passed on to the other SOC physicians).

The fractional remainder is not redistributed — it stays unspent for that department this month.

If `extra_pool < 0` (only possible when `total_budget < 10,000 × N_staff`), every STAFF physician gets `⌊staff_budget / N_staff⌋` instead.

In SK03 `staff_summary`: column U = `mult_i`, column V = `rate_d` (งบรายสาขา Q), and column N = `IF(L<0, 0, ROUNDDOWN(IF($Y$14<0, $Y$10/$Y$11, MIN(15000, 10000 + U × V)), 0))`.

**Results (2569_07 and 2569_08: department multiplier 1 + 5 × lack from the staffing sheet 13-11-69, score ±50%)**

| Department multiplier | Departments | 2569_07 (180 STAFF, extra ฿62,620, ฿197.65 per unit) | 2569_08 (181 STAFF, extra ฿83,445, ฿262.99 per unit) |
|---|---|---|---|
| 3.00–4.00 | SOC, ANS, OCM | ฿10,402–11,037, avg ฿10,645 | ฿10,563–11,499, avg ฿10,859 |
| 2.06–2.67 | FOR, RHB, OBG, MED | ฿10,218–10,621, avg ฿10,438 | ฿10,276–10,909, avg ฿10,583 |
| 1.33–1.64 | RAD, SUR, ORT, EYE, ENT | ฿10,134–10,506, avg ฿10,307 | ฿10,218–10,680, avg ฿10,410 |
| 1.00 | PED, PSY, CPT, OPD, PAT, EMR | ฿10,122–10,280, avg ฿10,197 | ฿10,148–10,362, avg ฿10,262 |

- Nobody is paid less than ฿10,000, and with the budgets of 2568_05–2569_08 everyone is paid more (lowest ฿10,122, in 2569_07): every department multiplier is at least 1 and every score multiplier at least 0.5, so every share of a positive extra pool is above 0.
- The average extra per physician is `extra_per_unit × dept_mult_d`, a straight line in the department's lack (2569_08: ฿263 at 1.00, ฿542 at 2.06, ฿1,052 at 4.00).
- Score still counts inside each department (±50% of the extra), so pay ranges of departments with close multipliers overlap: a high scorer in a slightly short department can be paid more than a low scorer in a shorter one. Department averages follow the multiplier order.
- Nobody is paid more than ฿15,000 (Step 3.6). In 2569_07 and 2569_08 the cap changes nothing (highest ฿11,037 and ฿11,499). Without it, the larger extra of 2569_01, 2569_02 and 2569_05 (฿1,458–1,705 per head) would have paid one or two SOC physicians up to ฿15,926.
- Checked on all 8 months with เวชกรรมสังคม (2569_01–2569_08, Pong, 2026-11-13): everyone above ฿10,000 (lowest ฿10,122–10,535), nobody above ฿15,000, nobody below that month's intern average, ฿80–93 unspent, and in every month SOC's average extra is 4.00 times that of the fully staffed departments.
- Replaces the capacity tiers (bonus weight 1.5 สาขาขาดแคลน / 1.0 กึ่งขาดแคลน / 0.5 เต็มศักยภาพ, Pong, 2026-11-11), at Pong's request on 2026-11-13: a department's share follows how short it is, without groups.
- Replaces the earlier ฿7,500 guarantee + ฿10,000 top-up (the former Step 3.6), at Pong's request: ฿10,000 is built in, with no top-up.

---

## Departments and Multipliers

Used in Step 3.2: each STAFF department's multiplier sets its share of the extra pool above ฿10,000. INTERN is paid from its own pool (Step 2) and has no department multiplier. `Abbrev` is each department's short code.

The multiplier comes from the hospital's doctor staffing sheet:

```
lack_d      = max(0, 1 − on_staff_d / FTE_d)     on staff = รวมอัตราตามจริง, FTE = จำนวนที่ควรมี
dept_mult_d = 1 + 5 × lack_d
```

Doctors hired by the day (ลจ.ชั่วคราว รายวัน) are not counted. The SK03 งบรายสาขา sheet works out lack (column D, `=MAX(0,1-on staff/FTE)`) and the multiplier (column E) from the two numbers, so it uses exact values; the table below rounds them.

The numbers are from the staffing sheet อัตรากำลัง แพทย์ 13-11-69 (Pong, 2026-11-13). Every SK03 build from then on uses them, including a rebuild of an older month (2569_08 too). The last column is the bonus weight of each department's capacity tier before; only ratios count, so 3.00 against 1.00 now is the same step as 1.5 against 0.5 was.

| # | Department | Abbrev | FTE | On staff | Lack | Multiplier | Before 2026-11-13 |
|:-:|---|:-:|:-:|:-:|:-:|:-:|---|
| 1 | กุมารเวชกรรม | PED | 19 | 21 | 0% | 1.00 | 0.5 (สาขาเต็มศักยภาพ) |
| 2 | จักษุวิทยา | EYE | 9 | 8 | 11.1% | 1.56 | 1.0 (สาขากึ่งขาดแคลน) |
| 3 | จิตเวชและยาเสพติด | PSY | 4 | 4 | 0% | 1.00 | 1.0 (สาขากึ่งขาดแคลน) |
| 4 | เทคนิคการแพทย์และพยาธิวิทยาคลินิก | CPT | 1 | 1 | 0% | 1.00 | 0.5 (สาขาเต็มศักยภาพ) |
| 5 | นิติเวช | FOR | 3 | 2 | 33.3% | 2.67 | 1.5 (สาขาขาดแคลน) |
| 6 | ผู้ป่วยนอก | OPD | 5 | 14 | 0% | 1.00 | 0.5 (สาขาเต็มศักยภาพ) |
| 7 | พยาธิวิทยากายวิภาค | PAT | 2 | 3 | 0% | 1.00 | 0.5 (สาขาเต็มศักยภาพ) |
| 8 | รังสีวิทยา | RAD | 15 | 14 | 6.7% | 1.33 | 1.0 (สาขากึ่งขาดแคลน) |
| 9 | วิสัญญีวิทยา | ANS | 15 | 9 | 40.0% | 3.00 | 1.5 (สาขาขาดแคลน) |
| 10 | เวชกรรมฟื้นฟู | RHB | 6 | 4 | 33.3% | 2.67 | 1.5 (สาขาขาดแคลน) |
| 11 | เวชกรรมสังคม | SOC | 10 | 4 | 60.0% | 4.00 | 0.5 (สาขาเต็มศักยภาพ) |
| 12 | เวชศาสตร์ฉุกเฉิน | EMR | 10 | 10 | 0% | 1.00 | 0.5 (สาขาเต็มศักยภาพ) |
| 13 | ศัลยกรรม | SUR | 39 | 34 | 12.8% | 1.64 | 1.0 (สาขากึ่งขาดแคลน) |
| 14 | ศัลยกรรมออร์โธปิดิกส์ | ORT | 17 | 15 | 11.8% | 1.59 | 1.0 (สาขากึ่งขาดแคลน) |
| 15 | สูติ-นรีเวชกรรม | OBG | 18 | 13 | 27.8% | 2.39 | 1.5 (สาขาขาดแคลน) |
| 16 | โสต ศอ นาสิก | ENT | 9 | 8 | 11.1% | 1.56 | 1.0 (สาขากึ่งขาดแคลน) |
| 17 | อาชีวเวชกรรม | OCM | 5 | 3 | 40.0% | 3.00 | 1.5 (สาขาขาดแคลน) |
| 18 | อายุรกรรม | MED | 47 | 37 | 21.3% | 2.06 | 1.5 (สาขาขาดแคลน) |
| 19 | INTERN | INT | — | — | — | — (own pool, Step 2) | — |

12 departments are short of doctors (multiplier 1.33 to 4.00) and 6 are not (1.00).

Notes on the 13-11-69 sheet:
- The sheet also lists กลุ่มงานการแพทย์แผนไทยฯ (FTE 1, 0 on staff) and three dental groups; none of them is a P4P department.
- SOC also has 15 doctors hired by the day. Counted in, SOC would not be short (190%), and its multiplier would be 1.00.
- PED, OPD and PAT have more doctors than their FTE; they count as lack 0, the same as a department with exactly its FTE.
- OPD (14) lists more doctors than the SK03 has (2569_08: 3); OPD has lack 0 either way.

---

## Monthly Budget Inputs

`Budget` is `total_budget` and `perP4P` is the per-physician rate used in Step 1.1. `N` is the headcount in the allocation document that Budget is divided by (it includes doctors on study leave, so it is larger than the number of doctors in the SK03). **perP4P = round(Budget ÷ N, 2).**

Since 2026-11-11 the numbers are not kept in this file. Each month's Budget and N are saved on the dashboard's overview page (`/dashboard/`, owner only: the งบ button on each month card), which stores them with perP4P in the Supabase table `review_inputs`; every save is in the ประวัติการใช้งาน (History) tab with the numbers before and after. Workflow 2.2 reads that table on every run: Budget goes into staff Y9 and perP4P into intern W9 (`=W10*perP4P`) of that month's SK03. A save starts workflow 2.2 for that month right away when every doctor has sent (otherwise the build after the last file uses it), and Pong gets a Telegram once the SK03 is built with the new numbers. A month with nothing saved leaves both cells empty (pay shows 0).

The 17 months 2568_05 to 2569_09 that used to be listed here were copied into the table by [`scripts/budget-inputs-2026-11.sql`](../scripts/budget-inputs-2026-11.sql), which also lists them and their sources (2569_08 and 2569_09: the allocation document จัดสรร กค.-สค. 69, row 2.1 แพทย์: จำนวนคน = N, ค่ากลางวงเงิน = perP4P, รวมเงิน = Budget).
