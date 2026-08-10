"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import DesktopBlock, { useDeviceGate } from "@/components/DesktopBlock"
import { StateBox } from "@/components/ui"
import { fullName } from "@/lib/departments"
import { deadlineISO, formatBangkokTime, type RankingMonth } from "@/lib/months"
import { isMissingTable, supabaseWithToken, type RosterRow } from "@/lib/supabase-browser"

interface Submission {
  name: string
  department: string
  submittedAt: string
}

type MonthState =
  | { kind: "loading" }
  | { kind: "ready"; rows: Submission[] }
  | { kind: "empty" }
  | { kind: "error" }

export default function RankingClient({
  accessToken,
  months,
}: {
  accessToken: string
  months: RankingMonth[]
}) {
  const device = useDeviceGate()
  const [active, setActive] = useState(months[0]?.key ?? "")
  const [state, setState] = useState<MonthState>({ kind: "loading" })
  const tabsRef = useRef<HTMLDivElement>(null)

  /**
   * Results are cached per month. The legacy page refetched on every tab click,
   * so flicking between 24 tabs meant 24 round trips over hospital wifi for
   * data that never changes once a month has closed.
   */
  const cache = useRef(new Map<string, Submission[]>())

  const load = useCallback(
    async (key: string) => {
      const cached = cache.current.get(key)
      if (cached) {
        setState(cached.length === 0 ? { kind: "empty" } : { kind: "ready", rows: cached })
        return
      }

      setState({ kind: "loading" })
      const db = supabaseWithToken(accessToken)
      const { data, error } = await db
        .from(key)
        .select("firstname, lastname, department, submitted_at")
        .not("submitted_at", "is", null)
        .lte("submitted_at", deadlineISO(key))
        .order("submitted_at", { ascending: true })
        .limit(500)

      if (error) {
        // The current month's table may not exist until provision_month() runs.
        // That is "nobody has sent yet", not an error.
        setState(isMissingTable(error) ? { kind: "empty" } : { kind: "error" })
        return
      }

      const rows: Submission[] = (data as RosterRow[]).map((row) => ({
        name: fullName(row.firstname, row.lastname) || "—",
        department: row.department ?? "—",
        submittedAt: row.submitted_at ?? "",
      }))
      cache.current.set(key, rows)
      setState(rows.length === 0 ? { kind: "empty" } : { kind: "ready", rows })
    },
    [accessToken],
  )

  useEffect(() => {
    if (device !== "allowed" || !active) return
    void load(active)
  }, [device, active, load])

  if (device !== "allowed") return <DesktopBlock state={device} />

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[var(--color-neutral)]/95 backdrop-blur">
        <div className="mx-auto max-w-[640px] px-4 pt-3">
          <div className="flex items-center gap-1.5 text-[0.7rem] font-semibold text-[var(--color-primary)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" />
            การจัดอันดับ
          </div>
          <h1 className="mt-1 font-[family-name:var(--font-manrope)] text-base font-bold text-[var(--color-secondary)]">
            แพทย์ที่ส่ง P4P ตามกำหนด
          </h1>
          <p className="text-xs text-[var(--color-ink-muted)]">
            (ส่งภายในวันที่ 10 ของเดือนถัดไป)
          </p>

          <div
            ref={tabsRef}
            role="tablist"
            aria-label="เลือกเดือน"
            className="mt-2 -mx-4 flex gap-1 overflow-x-auto px-4 pb-2"
          >
            {months.map((month) => {
              const selected = month.key === active
              return (
                <button
                  key={month.key}
                  role="tab"
                  aria-selected={selected}
                  onClick={(e) => {
                    setActive(month.key)
                    const el = e.currentTarget
                    const container = tabsRef.current
                    if (container) {
                      container.scrollTo({
                        left: el.offsetLeft - (container.offsetWidth - el.offsetWidth) / 2,
                        behavior: "smooth",
                      })
                    }
                  }}
                  className={`flex shrink-0 items-center gap-1 rounded-[var(--radius-card)] px-3 py-1.5 text-xs whitespace-nowrap transition-colors ${
                    selected
                      ? "bg-[var(--color-secondary)] font-semibold text-white"
                      : "bg-[var(--color-tertiary)] text-[var(--color-secondary)]"
                  }`}
                >
                  {month.current ? (
                    <span
                      aria-label="เดือนปัจจุบัน"
                      className={`h-1.5 w-1.5 rounded-full ${selected ? "bg-white" : "bg-[var(--color-primary)]"}`}
                    />
                  ) : null}
                  {month.label}
                </button>
              )
            })}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[640px] px-4 py-4">
        {state.kind === "loading" ? (
          <StateBox kind="loading" title="กำลังโหลด..." />
        ) : state.kind === "error" ? (
          <StateBox kind="error" title="เกิดข้อผิดพลาด" sub="ไม่สามารถโหลดข้อมูลได้" />
        ) : state.kind === "empty" ? (
          <StateBox kind="empty" title="ยังไม่มีการส่ง" sub="เดือนนี้ยังไม่มีแพทย์ส่งไฟล์ P4P" />
        ) : (
          <ol className="space-y-2">
            {state.rows.map((row, i) => (
              <RankRow key={`${row.name}-${i}`} row={row} rank={i + 1} />
            ))}
          </ol>
        )}
      </main>
    </>
  )
}

/** Top three get a warmer treatment; first place gets the flag. */
const MEDAL: Record<number, string> = {
  1: "border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_10%,white)]",
  2: "border-[var(--color-line)] bg-[var(--color-tertiary)]",
  3: "border-[var(--color-line)] bg-[var(--color-tertiary)]",
}

function RankRow({ row, rank }: { row: Submission; rank: number }) {
  return (
    <li
      className={`flex items-start gap-3 rounded-[var(--radius-card)] border bg-white p-3 ${
        MEDAL[rank] ?? "border-[var(--color-line)]"
      }`}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          rank <= 3
            ? "bg-[var(--color-primary)] text-white"
            : "bg-[var(--color-tertiary)] text-[var(--color-secondary)]"
        }`}
      >
        {rank}
      </span>

      <div className="min-w-0 flex-1">
        {rank === 1 ? (
          <div className="mb-0.5 inline-flex items-center gap-1 text-[0.65rem] font-semibold text-[var(--color-primary)]">
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden>
              <path d="M5 3.5V20.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <rect x="5" y="4.5" width="12" height="7.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
              <rect x="5" y="4.5" width="6" height="3.75" fill="currentColor" />
              <rect x="11" y="8.25" width="6" height="3.75" fill="currentColor" />
            </svg>
            ส่งเป็นคนแรก
          </div>
        ) : null}

        <p className="truncate text-sm font-semibold text-[var(--color-secondary)]">{row.name}</p>

        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.7rem] text-[var(--color-ink-muted)]">
          <span className="truncate">{row.department}</span>
          <span aria-hidden className="text-[var(--color-line)]">
            •
          </span>
          <span className="inline-flex items-center gap-1">
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden>
              <path
                d="M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {formatBangkokTime(row.submittedAt)}
          </span>
        </div>
      </div>
    </li>
  )
}
