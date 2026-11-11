# SK03 Payment Formula

The formula the nightly SK03 build (workflow 2.2, `process/process.ts`) writes into the SK03 sheet; the cell formulas are in [`sk03-formula.ts`](./sk03-formula.ts). This file is the whole formula reference: the rules and step-by-step calculation, then the [departments and capacity multipliers](#departments-and-capacity-multipliers) and the [monthly budget inputs](#monthly-budget-inputs) they use.

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

- **That physician's department**: `count_d` (used for capacity-weighted allocation) becomes `N_d − 1`.
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
dept_extra  = extra_pool × (count_d × weight_d) / Σ (count × weight)     weight = 1.5 / 1.0 / 0.5 by tier
payment_i   = ⌊ 10,000 + dept_extra × mult_i / Σ mult_d ⌋
```

Every eligible STAFF physician gets ฿10,000; nobody is paid less. Only `extra_pool` is shared, first between departments by capacity tier (bonus weight 1.5 for สาขาขาดแคลน, 1.0 for สาขากึ่งขาดแคลน, 0.5 for สาขาเต็มศักยภาพ), then inside each department by score. With these weights and the ±50% score band, every สาขาขาดแคลน physician is paid more than every สาขาเต็มศักยภาพ physician. The fractional remainder (a few dozen baht per month) is **not redistributed** — it stays unspent.

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
    count_d          = number of physicians in department d
    weight_d         = bonus weight of department d's tier (1.5 / 1.0 / 0.5)
    weighted_units_d = count_d × weight_d                          งบรายสาขา columns E, H

total_weighted_units = Σ weighted_units_d
```
Each department's tier and `weight_d` are in [Departments and Capacity Multipliers](#departments-and-capacity-multipliers). The tier names keep their capacity multipliers (1.15 / 1.00 / 0.85); only the split of the extra uses the wider weights 1.5 / 1.0 / 0.5 (Pong, 2026-11-11), so the tier still counts when the extra is small.

**3.3 — Share the extra pool between departments**
```
extra_per_unit = extra_pool / total_weighted_units                 SK03 Y15

for each department d:
    dept_extra_d  = weighted_units_d × extra_per_unit             งบรายสาขา column I
    dept_budget_d = (count_d × 10,000) + dept_extra_d              งบรายสาขา column J
```
A shortage department's physician gets 1.5 ÷ 0.5 = 3 times the extra share of a full-capacity one, on average.

**3.4 — Compute score multipliers within each department**
```
for each physician i in department d:
    mean_score_adj_d = average score_adj_i over department d
    mult_i = clip( 1 + 0.50 × (score_adj_i / mean_score_adj_d − 1), 0.50, 1.50 )
```
Uses `score_adj` from Step 0, computed only over physicians remaining after omission. If `mean_score_adj_d = 0` → `mult_i = 1.00` for everyone.

**3.5 — Pay**
```
extra_rate_d = dept_extra_d / Σ mult_i                              งบรายสาขา column L, staff_summary V
payment_i    = ⌊ 10,000 + extra_rate_d × mult_i ⌋                   staff_summary N
```
The fractional remainder is not redistributed — it stays unspent for that department this month.

If `extra_pool < 0` (only possible when `total_budget < 10,000 × N_staff`), every STAFF physician gets `⌊staff_budget / N_staff⌋` instead.

In SK03 `staff_summary`: column U = `mult_i`, column V = `extra_rate_d`, and column N = `IF(L<0, 0, ROUNDDOWN(IF($Y$14<0, $Y$10/$Y$11, 10000 + U × V), 0))`.

**Results (2569_07 and 2569_08: weights 1.5 / 1 / 0.5, score ±50%)**

| | สาขาขาดแคลน (1.5) | สาขากึ่งขาดแคลน (1.0) | สาขาเต็มศักยภาพ (0.5) |
|---|---|---|---|
| 2569_07 (180 STAFF, extra ฿62,603) | ฿10,263–10,751, avg ฿10,493 | ฿10,168–10,513, avg ฿10,328 | ฿10,096–10,233, avg ฿10,164 |
| 2569_08 (181 STAFF, extra ฿83,445) | ฿10,334–10,997, avg ฿10,657 | ฿10,230–10,690, avg ฿10,438 | ฿10,119–10,312, avg ฿10,219 |

- The lowest สาขาขาดแคลน payment is above the highest สาขาเต็มศักยภาพ payment in both months (by ฿30 and ฿22).
- No overlap holds as long as 1.5 × (1 − 0.5) > 0.5 × (1 + 0.5), i.e. 0.75 > 0.75 — exactly at the edge, so the margin comes only from department averages; a narrower score band widens it.
- Replaces the earlier ฿7,500 guarantee + ฿10,000 top-up (Step 3.6), at Pong's request: ฿10,000 is built in, with no top-up.

---

## Departments and Capacity Multipliers

Used in Step 3.2: each STAFF department's tier sets its bonus weight (1.5 / 1.0 / 0.5) and so its share of the extra pool above ฿10,000. INTERN is paid from its own pool (Step 2) and has no capacity multiplier. `Abbrev` is each department's short code.

| # | Department | Abbrev | Capacity tier | Multiplier | Bonus weight |
|:-:|---|:-:|---|:-:|:-:|
| 1 | กุมารเวชกรรม | PED | สาขาเต็มศักยภาพ (full capacity) | 0.85 | 0.5 |
| 2 | จักษุวิทยา | EYE | สาขากึ่งขาดแคลน (semi-shortage) | 1.00 | 1.0 |
| 3 | จิตเวชและยาเสพติด | PSY | สาขากึ่งขาดแคลน (semi-shortage) | 1.00 | 1.0 |
| 4 | เทคนิคการแพทย์และพยาธิวิทยาคลินิก | CPT | สาขาเต็มศักยภาพ (full capacity) | 0.85 | 0.5 |
| 5 | นิติเวช | FOR | สาขาขาดแคลน (shortage) | 1.15 | 1.5 |
| 6 | ผู้ป่วยนอก | OPD | สาขาเต็มศักยภาพ (full capacity) | 0.85 | 0.5 |
| 7 | พยาธิวิทยากายวิภาค | PAT | สาขาเต็มศักยภาพ (full capacity) | 0.85 | 0.5 |
| 8 | รังสีวิทยา | RAD | สาขากึ่งขาดแคลน (semi-shortage) | 1.00 | 1.0 |
| 9 | วิสัญญีวิทยา | ANS | สาขาขาดแคลน (shortage) | 1.15 | 1.5 |
| 10 | เวชกรรมฟื้นฟู | RHB | สาขาขาดแคลน (shortage) | 1.15 | 1.5 |
| 11 | เวชกรรมสังคม | SOC | สาขาเต็มศักยภาพ (full capacity) | 0.85 | 0.5 |
| 12 | เวชศาสตร์ฉุกเฉิน | EMR | สาขาเต็มศักยภาพ (full capacity) | 0.85 | 0.5 |
| 13 | ศัลยกรรม | SUR | สาขากึ่งขาดแคลน (semi-shortage) | 1.00 | 1.0 |
| 14 | ศัลยกรรมออร์โธปิดิกส์ | ORT | สาขากึ่งขาดแคลน (semi-shortage) | 1.00 | 1.0 |
| 15 | สูติ-นรีเวชกรรม | OBG | สาขาขาดแคลน (shortage) | 1.15 | 1.5 |
| 16 | โสต ศอ นาสิก | ENT | สาขากึ่งขาดแคลน (semi-shortage) | 1.00 | 1.0 |
| 17 | อาชีวเวชกรรม | OCM | สาขาขาดแคลน (shortage) | 1.15 | 1.5 |
| 18 | อายุรกรรม | MED | สาขาขาดแคลน (shortage) | 1.15 | 1.5 |
| 19 | INTERN | INT | — (own pool, Step 2) | — |

Six departments sit in each tier: สาขาขาดแคลน, shortage specialty (1.15); สาขากึ่งขาดแคลน, semi-shortage specialty (1.00); and สาขาเต็มศักยภาพ, full-capacity specialty (0.85).

---

## Monthly Budget Inputs

`Budget` is `total_budget` and `perP4P` is the per-physician rate used in Step 1.1. `N` is the headcount in the allocation document that Budget is divided by (it includes doctors on study leave, so it is larger than the number of doctors in the SK03).

Workflow 2.2 reads this table on every run: `Budget` goes into staff Y9 and `perP4P` into intern W9 (`=W10*perP4P`) of that month's SK03. A month with no row, or a blank cell, leaves that cell empty (pay shows 0). If `perP4P` is blank but `Budget` and `N` are filled, 2.2 uses round(Budget ÷ N, 2). Keep the four columns and the `YYYY_MM` month format.

| Month | Budget | N | perP4P |
|------|--------|---|--------|
| 2568_05 | 2,113,551.36 | 216 | 9,784.96 |
| 2568_06 | 2,102,336.65 | 215 | 9,778.31 |
| 2568_07 | 2,123,888.28 | 219 | 9,698.12 |
| 2568_08 | 2,156,973.75 | 225 | 9,586.55 |
| 2568_09 | 2,151,499.84 | 224 | 9,604.91 |
| 2568_10 | 2,213,270.80 | 221 | 10,014.80 |
| 2568_11 | 2,204,138.20 | 220 | 10,018.81 |
| 2568_12 | 2,206,831.00 | 220 | 10,031.05 |
| 2569_01 | 2,219,107.41 | 221 | 10,041.21 |
| 2569_02 | 2,211,228.80 | 220 | 10,051.04 |
| 2569_03 | 2,191,518.72 | 216 | 10,145.92 |
| 2569_04 | 2,144,594.88 | 216 | 9,928.68 |
| 2569_05 | 2,139,791.04 | 216 | 9,906.44 |
| 2569_06 | 2,159,731.84 | 224 | 9,641.66 |
| 2569_08 | 2,189,874.33 | 229 | 9,562.77 |
| 2569_09 | 2,210,764.71 | 231 | 9,570.41 |

**perP4P = round(Budget ÷ N, 2)** for every month above.

2569_08 and 2569_09 come from the hospital allocation document (จัดสรร กค.-สค. 69, row 2.1 แพทย์: จำนวนคน = N, ค่ากลางวงเงิน = perP4P, รวมเงิน = Budget). 2569_07 has no row yet, so its SK03 cells stay empty.
