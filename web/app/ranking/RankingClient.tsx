"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Box from "@mui/material/Box"
import List from "@mui/material/List"
import Stack from "@mui/material/Stack"
import Tab from "@mui/material/Tab"
import Tabs from "@mui/material/Tabs"
import Typography from "@mui/material/Typography"
import AccessTimeIcon from "@mui/icons-material/AccessTime"
import FlagIcon from "@mui/icons-material/Flag"
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
        <Box sx={{ mx: "auto", maxWidth: 640, px: 2, pt: 1.5 }}>
          <Stack
            direction="row"
            alignItems="center"
            spacing={0.75}
            sx={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--color-primary)" }}
          >
            <Box
              sx={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                bgcolor: "var(--color-primary)",
              }}
            />
            <span>การจัดอันดับ</span>
          </Stack>
          <Typography
            component="h1"
            sx={{
              mt: 0.5,
              fontFamily: "var(--font-manrope)",
              fontSize: "1rem",
              fontWeight: 700,
              color: "var(--color-secondary)",
            }}
          >
            แพทย์ที่ส่ง P4P ตามกำหนด
          </Typography>
          <Typography sx={{ fontSize: "0.75rem", color: "var(--color-ink-muted)" }}>
            (ส่งภายในวันที่ 5 ของเดือนถัดไป)
          </Typography>

          <Tabs
            value={active}
            onChange={(_, value: string) => setActive(value)}
            aria-label="เลือกเดือน"
            variant="scrollable"
            scrollButtons={false}
            allowScrollButtonsMobile
            TabIndicatorProps={{ style: { display: "none" } }}
            sx={{
              mt: 1,
              mx: -2,
              px: 2,
              pb: 1,
              minHeight: 0,
              "& .MuiTabs-flexContainer": { gap: 0.5 },
            }}
          >
            {months.map((month) => (
              <Tab
                key={month.key}
                value={month.key}
                label={
                  <Stack direction="row" alignItems="center" spacing={0.5}>
                    {month.current ? (
                      <Box
                        aria-label="เดือนปัจจุบัน"
                        sx={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          bgcolor: month.key === active ? "white" : "var(--color-primary)",
                        }}
                      />
                    ) : null}
                    <span>{month.label}</span>
                  </Stack>
                }
                disableRipple
                sx={{
                  minHeight: 0,
                  minWidth: 0,
                  flexShrink: 0,
                  borderRadius: "var(--radius-card)",
                  px: 1.5,
                  py: 0.75,
                  fontSize: "0.75rem",
                  textTransform: "none",
                  whiteSpace: "nowrap",
                  bgcolor: "var(--color-tertiary)",
                  color: "var(--color-secondary)",
                  "&.Mui-selected": {
                    bgcolor: "var(--color-secondary)",
                    color: "white",
                    fontWeight: 600,
                  },
                }}
              />
            ))}
          </Tabs>
        </Box>
      </Box>

      <Box component="main" sx={{ mx: "auto", maxWidth: 640, px: 2, py: 2 }}>
        {state.kind === "loading" ? (
          <StateBox kind="loading" title="กำลังโหลด..." />
        ) : state.kind === "error" ? (
          <StateBox kind="error" title="เกิดข้อผิดพลาด" sub="ไม่สามารถโหลดข้อมูลได้" />
        ) : state.kind === "empty" ? (
          <StateBox kind="empty" title="ยังไม่มีการส่ง" sub="เดือนนี้ยังไม่มีแพทย์ส่งไฟล์ P4P" />
        ) : (
          <List component="ol" disablePadding sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {state.rows.map((row, i) => (
              <RankRow key={`${row.name}-${i}`} row={row} rank={i + 1} />
            ))}
          </List>
        )}
      </Box>
    </>
  )
}

/** Top three get a warmer treatment; first place gets the flag. */
const MEDAL: Record<number, { border: string; bg: string }> = {
  1: { border: "var(--color-primary)", bg: "color-mix(in srgb, var(--color-primary) 10%, white)" },
  2: { border: "var(--color-line)", bg: "var(--color-tertiary)" },
  3: { border: "var(--color-line)", bg: "var(--color-tertiary)" },
}

function RankRow({ row, rank }: { row: Submission; rank: number }) {
  const medal = MEDAL[rank]
  return (
    <Box
      component="li"
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: 1.5,
        borderRadius: "var(--radius-card)",
        border: "1px solid",
        borderColor: medal?.border ?? "var(--color-line)",
        bgcolor: medal?.bg ?? "white",
        p: 1.5,
      }}
    >
      <Box
        sx={{
          display: "flex",
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: "50%",
          fontSize: "0.75rem",
          fontWeight: 700,
          bgcolor: rank <= 3 ? "var(--color-primary)" : "var(--color-tertiary)",
          color: rank <= 3 ? "white" : "var(--color-secondary)",
        }}
      >
        {rank}
      </Box>

      <Box sx={{ minWidth: 0, flex: 1 }}>
        {rank === 1 ? (
          <Stack
            direction="row"
            alignItems="center"
            spacing={0.5}
            sx={{ mb: 0.25, fontSize: "0.65rem", fontWeight: 600, color: "var(--color-primary)" }}
          >
            <FlagIcon sx={{ fontSize: 12 }} />
            <span>ส่งเป็นคนแรก</span>
          </Stack>
        ) : null}

        <Typography
          noWrap
          sx={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--color-secondary)" }}
        >
          {row.name}
        </Typography>

        <Stack
          direction="row"
          flexWrap="wrap"
          alignItems="center"
          columnGap={1}
          rowGap={0.25}
          sx={{ mt: 0.25, fontSize: "0.7rem", color: "var(--color-ink-muted)" }}
        >
          <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.department}
          </Box>
          <Box component="span" aria-hidden sx={{ color: "var(--color-line)" }}>
            •
          </Box>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <AccessTimeIcon sx={{ fontSize: 12 }} />
            <span>{formatBangkokTime(row.submittedAt)}</span>
          </Stack>
        </Stack>
      </Box>
    </Box>
  )
}
