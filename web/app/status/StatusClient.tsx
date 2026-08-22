"use client"

import { useEffect, useMemo, useState } from "react"
import Box from "@mui/material/Box"
import Chip from "@mui/material/Chip"
import FormControlLabel from "@mui/material/FormControlLabel"
import InputAdornment from "@mui/material/InputAdornment"
import MenuItem from "@mui/material/MenuItem"
import Radio from "@mui/material/Radio"
import RadioGroup from "@mui/material/RadioGroup"
import Stack from "@mui/material/Stack"
import TextField from "@mui/material/TextField"
import Typography from "@mui/material/Typography"
import Accordion from "@mui/material/Accordion"
import AccordionSummary from "@mui/material/AccordionSummary"
import AccordionDetails from "@mui/material/AccordionDetails"
import List from "@mui/material/List"
import ListItem from "@mui/material/ListItem"
import ListItemText from "@mui/material/ListItemText"
import ExpandMoreIcon from "@mui/icons-material/ExpandMore"
import SearchIcon from "@mui/icons-material/Search"
import CheckIcon from "@mui/icons-material/Check"
import CloseIcon from "@mui/icons-material/Close"
import DesktopBlock, { useDeviceGate } from "@/components/DesktopBlock"
import { BackToTop, Skeleton, StateBox } from "@/components/ui"
import { departmentLabel, fullName, sortDepartments } from "@/lib/departments"
import { monthColorHex } from "@/lib/colors"
import { parseMonthKey, thaiLabelFromKey } from "@/lib/months"
import { isMissingTable, supabaseWithToken, type RosterRow } from "@/lib/supabase-browser"

interface Entry {
  name: string
  department: string
  sent: boolean
}

/**
 * Five interdependent `style.display` assignments in the legacy page collapse
 * into this one value. Which section is on screen was previously implicit in
 * the combination of several booleans, and getting it wrong showed two lists at
 * once.
 */
type View = { mode: "sections" } | { mode: "filtered"; entries: Entry[] }

type SearchBy = "name" | "department"

export default function StatusClient({
  accessToken,
  monthKey,
}: {
  accessToken: string
  monthKey: string | null
}) {
  const device = useDeviceGate()
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [searchBy, setSearchBy] = useState<SearchBy>("name")
  const [department, setDepartment] = useState("")

  useEffect(() => {
    if (device !== "allowed" || !monthKey) return
    let cancelled = false

    ;(async () => {
      const db = supabaseWithToken(accessToken)
      const { data, error: queryError } = await db
        .from(monthKey)
        .select("firstname, lastname, department, submitted_at")

      if (cancelled) return
      if (queryError) {
        setError(isMissingTable(queryError) ? "ยังไม่มีข้อมูลของเดือนนี้" : "เกิดข้อผิดพลาด")
        return
      }
      setEntries(
        (data as RosterRow[]).map((row) => ({
          name: fullName(row.firstname, row.lastname),
          department: row.department ?? "",
          sent: row.submitted_at != null,
        })),
      )
    })()

    return () => {
      cancelled = true
    }
  }, [device, accessToken, monthKey])

  const departments = useMemo(
    () => sortDepartments([...new Set((entries ?? []).map((e) => e.department).filter(Boolean))]),
    [entries],
  )

  const view: View = useMemo(() => {
    if (!entries) return { mode: "sections" }

    if (department) {
      return { mode: "filtered", entries: entries.filter((e) => e.department === department) }
    }
    if (query === "") return { mode: "sections" }
    // A query of only spaces means "show everything, grouped" — a documented
    // affordance in the legacy UI, explained by the hint under the search box.
    if (/^ +$/.test(query)) return { mode: "filtered", entries }

    const needle = query.trim().toLowerCase()
    const field = searchBy === "name" ? "name" : "department"
    return {
      mode: "filtered",
      entries: entries.filter((e) => e[field].toLowerCase().includes(needle)),
    }
  }, [entries, query, searchBy, department])

  const pending = useMemo(
    () => (entries ?? []).filter((e) => !e.sent).sort(byName),
    [entries],
  )
  const sent = useMemo(() => (entries ?? []).filter((e) => e.sent).sort(byName), [entries])

  if (device !== "allowed") return <DesktopBlock state={device} />

  const monthLabel = monthKey ? thaiLabelFromKey(monthKey) : null
  const accent = monthKey ? monthColorHex(parseMonthKey(monthKey)!.month) : undefined

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
          <Stack direction="row" alignItems="center" spacing={1}>
            {monthLabel ? (
              <Chip
                label={monthLabel}
                sx={{
                  bgcolor: accent,
                  borderRadius: "var(--radius-card)",
                  fontFamily: "var(--font-manrope)",
                  fontSize: "0.875rem",
                  fontWeight: 700,
                  color: "var(--color-ink)",
                  height: "auto",
                  px: 0.5,
                  py: 0.5,
                }}
              />
            ) : (
              <Typography
                sx={{
                  fontFamily: "var(--font-manrope)",
                  fontSize: "0.875rem",
                  fontWeight: 700,
                  color: "var(--color-secondary)",
                }}
              >
                {monthKey === null ? "ไม่พบพารามิเตอร์" : <Skeleton width={112} height={20} />}
              </Typography>
            )}
            {entries ? (
              <Typography sx={{ fontSize: "0.75rem", color: "var(--color-ink-muted)" }}>
                (ส่ง {sent.length} จาก {entries.length} ราย)
              </Typography>
            ) : monthKey ? (
              <Skeleton width={96} height={16} />
            ) : null}
          </Stack>

          {monthKey ? (
            <Stack spacing={1} sx={{ mt: 1.5 }}>
              <TextField
                type="search"
                value={query}
                disabled={!entries}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setDepartment("")
                }}
                placeholder="พิมพ์เพื่อค้นหา.."
                autoComplete="off"
                fullWidth
                size="small"
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon fontSize="small" sx={{ color: "var(--color-muted)" }} />
                      </InputAdornment>
                    ),
                  },
                }}
                sx={{
                  "& .MuiOutlinedInput-root": {
                    bgcolor: "white",
                    borderRadius: "var(--radius-card)",
                    fontSize: "0.875rem",
                    "& fieldset": { borderColor: "var(--color-line)" },
                  },
                }}
              />
              <Typography sx={{ fontSize: "0.7rem", color: "var(--color-muted)" }}>
                พิมพ์เว้นวรรคเพื่อดูรายชื่อทั้งหมดเรียงตามกลุ่มงาน
              </Typography>

              <RadioGroup
                row
                name="search_by"
                value={searchBy}
                onChange={(e) => {
                  setSearchBy(e.target.value as SearchBy)
                  setQuery("")
                  setDepartment("")
                }}
                sx={{ gap: 2 }}
              >
                {(["name", "department"] as const).map((mode) => (
                  <FormControlLabel
                    key={mode}
                    value={mode}
                    disabled={!entries}
                    control={
                      <Radio
                        size="small"
                        sx={{
                          p: 0.5,
                          color: "var(--color-line)",
                          "&.Mui-checked": { color: "var(--color-primary)" },
                        }}
                      />
                    }
                    label={
                      <Typography
                        sx={{
                          fontSize: "0.75rem",
                          color: entries ? "var(--color-secondary)" : "var(--color-muted)",
                        }}
                      >
                        {mode === "name" ? "ชื่อแพทย์" : "ชื่อกลุ่มงาน"}
                      </Typography>
                    }
                  />
                ))}
              </RadioGroup>

              {searchBy === "department" ? (
                <TextField
                  select
                  value={department}
                  disabled={!entries}
                  onChange={(e) => {
                    setDepartment(e.target.value)
                    setQuery("")
                  }}
                  fullWidth
                  size="small"
                  sx={{
                    "& .MuiOutlinedInput-root": {
                      bgcolor: "white",
                      borderRadius: "var(--radius-card)",
                      fontSize: "0.875rem",
                      "& fieldset": { borderColor: "var(--color-line)" },
                    },
                  }}
                >
                  <MenuItem value="">ทุกกลุ่มงาน</MenuItem>
                  {departments.map((d) => (
                    <MenuItem key={d} value={d}>
                      {departmentLabel(d)}
                    </MenuItem>
                  ))}
                </TextField>
              ) : null}
            </Stack>
          ) : null}
        </Box>
      </Box>

      <Box component="main" sx={{ mx: "auto", maxWidth: 640, px: 2, py: 2 }}>
        {monthKey === null ? (
          <StateBox kind="error" title="ไม่พบพารามิเตอร์" sub="กรุณาเปิดจากเมนูเลือกเดือนใน LINE" />
        ) : error ? (
          <StateBox kind="error" title={error} />
        ) : !entries ? (
          <StateBox kind="loading" title="กำลังโหลด..." />
        ) : view.mode === "filtered" ? (
          <GroupedList entries={view.entries} />
        ) : (
          <Stack spacing={1.5}>
            <Section title="รายชื่อผู้ที่ยังไม่ได้ส่ง" entries={pending} defaultOpen />
            <Section title="รายชื่อผู้ที่ส่งแล้ว" entries={sent} />
          </Stack>
        )}
      </Box>

      <BackToTop threshold={20} />
    </>
  )
}

const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, "th")

function Section({
  title,
  entries,
  defaultOpen = false,
}: {
  title: string
  entries: Entry[]
  defaultOpen?: boolean
}) {
  return (
    <Accordion
      defaultExpanded={defaultOpen}
      disableGutters
      square
      sx={{
        overflow: "hidden",
        borderRadius: "var(--radius-card)",
        border: "1px solid var(--color-line)",
        bgcolor: "white",
        "&:before": { display: "none" },
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon sx={{ color: "white" }} />}
        sx={{
          bgcolor: "var(--color-secondary)",
          color: "white",
          minHeight: 0,
          "& .MuiAccordionSummary-content": { my: 1 },
        }}
      >
        <Typography
          sx={{
            fontFamily: "var(--font-manrope)",
            fontSize: "0.875rem",
            fontWeight: 600,
            color: "white",
          }}
        >
          {title} ({entries.length})
        </Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ p: 0 }}>
        <List disablePadding>
          {entries.map((entry, i) => (
            <Row key={`${entry.name}-${i}`} entry={entry} showDepartment />
          ))}
        </List>
      </AccordionDetails>
    </Accordion>
  )
}

function GroupedList({ entries }: { entries: Entry[] }) {
  const groups = useMemo(() => {
    const departments = sortDepartments([...new Set(entries.map((e) => e.department))])
    return departments
      .map((dep) => ({
        dep,
        rows: entries.filter((e) => e.department === dep).sort(byName),
      }))
      .filter((g) => g.rows.length > 0)
  }, [entries])

  if (entries.length === 0) {
    return <StateBox kind="empty" title="ไม่พบข้อมูล" sub="ลองเปลี่ยนคำค้นหา" />
  }

  return (
    <Box
      sx={{
        overflow: "hidden",
        borderRadius: "var(--radius-card)",
        border: "1px solid var(--color-line)",
        bgcolor: "white",
      }}
    >
      {groups.map(({ dep, rows }) => (
        <Box component="section" key={dep}>
          <Typography
            component="h2"
            sx={{
              bgcolor: "var(--color-tertiary)",
              px: 1.5,
              py: 1,
              fontSize: "0.75rem",
              fontWeight: 600,
              color: "var(--color-secondary)",
            }}
          >
            {dep ? departmentLabel(dep) : "ไม่ระบุกลุ่มงาน"}
          </Typography>
          <List disablePadding>
            {rows.map((entry, i) => (
              <Row key={`${entry.name}-${i}`} entry={entry} />
            ))}
          </List>
        </Box>
      ))}
    </Box>
  )
}

function Row({ entry, showDepartment = false }: { entry: Entry; showDepartment?: boolean }) {
  return (
    <ListItem
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        borderBottom: "1px solid color-mix(in srgb, var(--color-line) 60%, transparent)",
        px: 1.5,
        py: 1,
        "&:last-of-type": { borderBottom: "none" },
      }}
    >
      <ListItemText
        sx={{ minWidth: 0, flex: 1, my: 0 }}
        primary={entry.name || "—"}
        primaryTypographyProps={{
          noWrap: true,
          sx: { fontSize: "0.875rem", color: entry.sent ? undefined : "var(--color-ink-muted)" },
        }}
        secondary={showDepartment && entry.department ? entry.department : undefined}
        secondaryTypographyProps={{
          noWrap: true,
          sx: { fontSize: "0.7rem", color: "var(--color-muted)" },
        }}
      />
      <StatusIcon sent={entry.sent} />
    </ListItem>
  )
}

function StatusIcon({ sent }: { sent: boolean }) {
  const Icon = sent ? CheckIcon : CloseIcon
  return (
    <Icon
      aria-label={sent ? "ส่งแล้ว" : "ยังไม่ได้ส่ง"}
      sx={{
        flexShrink: 0,
        fontSize: 18,
        color: sent ? "var(--color-success)" : "var(--color-danger)",
      }}
    />
  )
}
