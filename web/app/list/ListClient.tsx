"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import IconButton from "@mui/material/IconButton"
import MenuItem from "@mui/material/MenuItem"
import Stack from "@mui/material/Stack"
import Table from "@mui/material/Table"
import TableBody from "@mui/material/TableBody"
import TableCell from "@mui/material/TableCell"
import TableHead from "@mui/material/TableHead"
import TableRow from "@mui/material/TableRow"
import TextField from "@mui/material/TextField"
import Typography from "@mui/material/Typography"
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft"
import ChevronRightIcon from "@mui/icons-material/ChevronRight"
import DesktopBlock, { useDeviceGate } from "@/components/DesktopBlock"
import { BackToTop, StateBox } from "@/components/ui"
import { monthColorHex } from "@/lib/colors"
import { fullName } from "@/lib/departments"
import { parseMonthKey, thaiLabelFromKey } from "@/lib/months"
import { pageRange, pageRangeMobile, type PageToken } from "@/lib/pagination"
import { isMissingTable, supabaseWithToken, type RosterRow } from "@/lib/supabase-browser"

const PAGE_SIZE = 25
const DASH = "—"

interface Person {
  name: string
  department: string
}

type SortColumn = "name" | "department"

export default function ListClient({
  accessToken,
  months,
}: {
  accessToken: string
  months: string[]
}) {
  const device = useDeviceGate()
  const [month, setMonth] = useState("")
  const [people, setPeople] = useState<Person[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<{ column: SortColumn; dir: "asc" | "desc" } | null>(null)
  const [page, setPage] = useState(1)
  const [showAll, setShowAll] = useState(false)
  const [narrow, setNarrow] = useState(false)

  useEffect(() => {
    const check = () => setNarrow(window.innerWidth <= 481)
    check()
    window.addEventListener("resize", check)
    return () => window.removeEventListener("resize", check)
  }, [])

  useEffect(() => {
    if (device !== "allowed" || !month) return
    let cancelled = false
    setPeople(null)
    setError(null)

    ;(async () => {
      const db = supabaseWithToken(accessToken)
      const { data, error: queryError } = await db
        .from(month)
        .select("firstname, lastname, department")

      // Guard against an out-of-order response from a previous month; the
      // legacy page used a monotonically increasing token for the same reason.
      if (cancelled) return
      if (queryError) {
        setError(isMissingTable(queryError) ? "ยังไม่มีข้อมูลของเดือนนี้" : queryError.message)
        return
      }
      setPeople(
        (data as RosterRow[])
          .map((row) => ({
            name: fullName(row.firstname, row.lastname) || DASH,
            department: row.department || DASH,
          }))
          .sort((a, b) => a.name.localeCompare(b.name, "th")),
      )
      setQuery("")
      setSort(null)
      setPage(1)
      setShowAll(false)
    })()

    return () => {
      cancelled = true
    }
  }, [device, accessToken, month])

  const filtered = useMemo(() => {
    if (!people) return []
    const q = query.trim().toLowerCase()
    const base = q
      ? people.filter((p) => `${p.name} ${p.department}`.toLowerCase().includes(q))
      : people
    if (!sort) return base

    const { column, dir } = sort
    return [...base].sort((a, b) => {
      const av = a[column]
      const bv = b[column]
      return dir === "asc" ? av.localeCompare(bv, "th") : bv.localeCompare(av, "th")
    })
  }, [people, query, sort])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const start = showAll ? 0 : (currentPage - 1) * PAGE_SIZE
  const rows = showAll ? filtered : filtered.slice(start, start + PAGE_SIZE)

  const uniqueDepartments = useMemo(
    () => new Set((people ?? []).map((p) => p.department).filter((d) => d !== DASH)).size,
    [people],
  )

  if (device !== "allowed") return <DesktopBlock state={device} />

  const accent = month ? monthColorHex(parseMonthKey(month)!.month) : "var(--color-line)"

  return (
    <>
      <Box
        component="header"
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          borderBottom: "1px solid var(--color-line)",
          bgcolor: "color-mix(in srgb, var(--color-neutral) 95%, transparent)",
          backdropFilter: "blur(8px)",
        }}
      >
        <Box sx={{ mx: "auto", maxWidth: 640, px: 2, py: 1.5 }}>
          <Typography
            sx={{
              fontFamily: "var(--font-manrope)",
              fontSize: "1rem",
              fontWeight: 700,
              color: "var(--color-secondary)",
            }}
          >
            SAKHONMSO P4P
          </Typography>
          <Typography sx={{ fontSize: "0.75rem", color: "var(--color-ink-muted)" }}>
            ข้อมูลแพทย์รายเดือน
          </Typography>

          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <TextField
              select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              size="small"
              sx={{
                minWidth: 0,
                flex: 1,
                "& .MuiOutlinedInput-root": {
                  bgcolor: "white",
                  borderRadius: "var(--radius-card)",
                  fontSize: "0.875rem",
                  "& fieldset": { borderColor: "var(--color-line)" },
                },
              }}
              slotProps={{ select: { displayEmpty: true } }}
            >
              <MenuItem value="" disabled>
                เลือกเดือน...
              </MenuItem>
              {months.map((key) => (
                <MenuItem key={key} value={key}>
                  {thaiLabelFromKey(key)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              type="search"
              value={query}
              disabled={!people}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
              placeholder="ค้นหาชื่อหรือแผนก..."
              size="small"
              sx={{
                minWidth: 0,
                flex: 1,
                "& .MuiOutlinedInput-root": {
                  bgcolor: "white",
                  borderRadius: "var(--radius-card)",
                  fontSize: "0.875rem",
                  "& fieldset": { borderColor: "var(--color-line)" },
                },
              }}
            />
          </Stack>
        </Box>
      </Box>

      <Box component="main" sx={{ mx: "auto", maxWidth: 640, px: 2, py: 2 }}>
        {people ? (
          <Box sx={{ mb: 1.5, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1 }}>
            <Stat value={people.length.toLocaleString()} label="แพทย์ทั้งหมด" />
            <Stat value={String(uniqueDepartments)} label="แผนก" />
            {query ? <Stat value={String(filtered.length)} label="ผลการค้นหา" /> : null}
          </Box>
        ) : null}

        <Box
          sx={{
            overflow: "hidden",
            borderRadius: "var(--radius-card)",
            border: "1px solid var(--color-line)",
            bgcolor: "white",
            borderTop: `3px solid ${accent}`,
          }}
        >
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ borderBottom: "1px solid var(--color-line)", px: 1.5, py: 1 }}
          >
            <Typography
              sx={{
                fontFamily: "var(--font-manrope)",
                fontSize: "0.875rem",
                fontWeight: 600,
                color: "var(--color-secondary)",
              }}
            >
              รายชื่อแพทย์
            </Typography>
            <Typography sx={{ fontSize: "0.75rem", color: "var(--color-ink-muted)" }}>
              <Box component="strong">{people ? filtered.length : DASH}</Box> รายการ
            </Typography>
          </Stack>

          {!month ? (
            <StateBox kind="empty" title="เลือกเดือนเพื่อดูข้อมูล" />
          ) : error ? (
            <StateBox kind="error" title="โหลดข้อมูลไม่ได้" sub={error} />
          ) : !people ? (
            <StateBox kind="loading" title="กำลังโหลด..." />
          ) : filtered.length === 0 ? (
            <StateBox kind="empty" title="ไม่พบข้อมูล" sub="ลองเปลี่ยนคำค้นหา" />
          ) : (
            <>
              <Table sx={{ width: "100%", tableLayout: "fixed" }} size="small">
                <TableHead>
                  <TableRow sx={{ bgcolor: accent }}>
                    <TableCell
                      sx={{
                        width: 40,
                        px: 1,
                        py: 1,
                        fontFamily: "var(--font-manrope)",
                        fontSize: "0.75rem",
                        color: "var(--color-secondary)",
                        border: 0,
                      }}
                    >
                      #
                    </TableCell>
                    <SortHeader
                      label="ชื่อ-นามสกุล"
                      column="name"
                      sort={sort}
                      onSort={setSort}
                      onPage={setPage}
                    />
                    <SortHeader
                      label="แผนก"
                      column="department"
                      sort={sort}
                      onSort={setSort}
                      onPage={setPage}
                    />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((person, i) => (
                    <TableRow
                      key={`${person.name}-${start + i}`}
                      sx={{
                        "&:not(:last-of-type) td": {
                          borderBottom: "1px solid color-mix(in srgb, var(--color-line) 60%, transparent)",
                        },
                        "&:last-of-type td": { border: 0 },
                      }}
                    >
                      <TableCell sx={{ px: 1, py: 1, fontSize: "0.75rem", color: "var(--color-faint)" }}>
                        {start + i + 1}
                      </TableCell>
                      <TableCell sx={{ px: 1, py: 1, fontSize: "0.875rem", wordBreak: "break-word" }}>
                        {person.name === DASH ? <Faint /> : person.name}
                      </TableCell>
                      <TableCell sx={{ px: 1, py: 1, fontSize: "0.875rem", wordBreak: "break-word" }}>
                        {person.department === DASH ? <Faint /> : person.department}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <Stack
                direction="row"
                flexWrap="wrap"
                alignItems="center"
                justifyContent="space-between"
                gap={1}
                sx={{ borderTop: "1px solid var(--color-line)", px: 1.5, py: 1 }}
              >
                <Typography sx={{ fontSize: "0.75rem", color: "var(--color-ink-muted)" }}>
                  <Box component="strong">
                    {showAll ? 1 : start + 1}–
                    {showAll ? filtered.length : Math.min(start + PAGE_SIZE, filtered.length)}
                  </Box>{" "}
                  จาก <Box component="strong">{filtered.length}</Box>
                </Typography>

                <Stack direction="row" flexWrap="wrap" alignItems="center" gap={0.5}>
                  <PagerButton
                    active={showAll}
                    accent={accent}
                    onClick={() => {
                      setShowAll((v) => !v)
                      setPage(1)
                    }}
                  >
                    ทั้งหมด
                  </PagerButton>

                  {!showAll ? (
                    <>
                      <PagerIconButton
                        disabled={currentPage === 1}
                        onClick={() => setPage(currentPage - 1)}
                        icon={<ChevronLeftIcon fontSize="small" />}
                        label="ก่อนหน้า"
                      />
                      {(narrow ? pageRangeMobile : pageRange)(currentPage, totalPages).map(
                        (token: PageToken, i) =>
                          token === "…" ? (
                            <Typography
                              key={`gap-${i}`}
                              sx={{ px: 0.5, fontSize: "0.75rem", color: "var(--color-muted)" }}
                            >
                              …
                            </Typography>
                          ) : (
                            <PagerButton
                              key={token}
                              active={token === currentPage}
                              accent={accent}
                              onClick={() => setPage(token)}
                            >
                              {token}
                            </PagerButton>
                          ),
                      )}
                      <PagerIconButton
                        disabled={currentPage === totalPages}
                        onClick={() => setPage(currentPage + 1)}
                        icon={<ChevronRightIcon fontSize="small" />}
                        label="ถัดไป"
                      />
                    </>
                  ) : null}
                </Stack>
              </Stack>
            </>
          )}
        </Box>

        <Typography sx={{ mt: 3, textAlign: "center", fontSize: "0.75rem", color: "var(--color-muted)" }}>
          องค์กรแพทย์ โรงพยาบาลสมุทรสาคร
        </Typography>
      </Box>

      <BackToTop />
    </>
  )
}

function Faint() {
  return <Box component="span" sx={{ color: "var(--color-faint)" }}>{DASH}</Box>
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <Box
      sx={{
        borderRadius: "var(--radius-card)",
        border: "1px solid var(--color-line)",
        bgcolor: "white",
        px: 1,
        py: 1,
        textAlign: "center",
      }}
    >
      <Typography
        sx={{
          fontFamily: "var(--font-manrope)",
          fontSize: "1rem",
          fontWeight: 700,
          color: "var(--color-secondary)",
        }}
      >
        {value}
      </Typography>
      <Typography sx={{ fontSize: "0.65rem", color: "var(--color-ink-muted)" }}>{label}</Typography>
    </Box>
  )
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
  onPage,
}: {
  label: string
  column: SortColumn
  sort: { column: SortColumn; dir: "asc" | "desc" } | null
  onSort: (s: { column: SortColumn; dir: "asc" | "desc" }) => void
  onPage: (p: number) => void
}) {
  const active = sort?.column === column
  return (
    <TableCell
      sx={{
        px: 1,
        py: 1,
        fontFamily: "var(--font-manrope)",
        fontSize: "0.75rem",
        color: "var(--color-secondary)",
        border: 0,
      }}
    >
      <Button
        type="button"
        disableRipple
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
        onClick={() => {
          onSort({ column, dir: active && sort.dir === "asc" ? "desc" : "asc" })
          onPage(1)
        }}
        sx={{
          minWidth: 0,
          p: 0,
          gap: 0.5,
          fontFamily: "var(--font-manrope)",
          fontSize: "0.75rem",
          textTransform: "none",
          color: "var(--color-secondary)",
        }}
      >
        {label}
        <Box component="span" aria-hidden sx={{ fontSize: "0.6rem" }}>
          {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
        </Box>
      </Button>
    </TableCell>
  )
}

function PagerButton({
  children,
  onClick,
  active = false,
  disabled = false,
  accent,
}: {
  children: ReactNode
  onClick: () => void
  active?: boolean
  disabled?: boolean
  accent?: string
}) {
  return (
    <Button
      type="button"
      disabled={disabled}
      onClick={onClick}
      disableRipple
      sx={{
        minWidth: 32,
        borderRadius: "var(--radius-card)",
        border: "1px solid",
        borderColor: active && accent ? accent : "var(--color-line)",
        bgcolor: active && accent ? accent : "transparent",
        px: 1,
        py: 0.5,
        fontSize: "0.75rem",
        textTransform: "none",
        fontWeight: active ? 600 : 400,
        color: active ? "var(--color-secondary)" : "var(--color-ink-muted)",
        "&:hover": { bgcolor: active && accent ? accent : "transparent" },
        "&.Mui-disabled": { opacity: 0.4 },
      }}
    >
      {children}
    </Button>
  )
}

function PagerIconButton({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <IconButton
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      size="small"
      sx={{
        minWidth: 32,
        borderRadius: "var(--radius-card)",
        border: "1px solid var(--color-line)",
        px: 1,
        py: 0.5,
        color: "var(--color-ink-muted)",
        "&.Mui-disabled": { opacity: 0.4 },
      }}
    >
      {icon}
    </IconButton>
  )
}
