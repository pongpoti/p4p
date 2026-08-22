"use client"

import { useEffect, useState, type ReactNode } from "react"
import Box from "@mui/material/Box"
import CircularProgress from "@mui/material/CircularProgress"
import Fab from "@mui/material/Fab"
import Fade from "@mui/material/Fade"
import MuiSkeleton from "@mui/material/Skeleton"
import Typography from "@mui/material/Typography"
import CheckBoxIcon from "@mui/icons-material/CheckBox"
import ErrorIcon from "@mui/icons-material/Error"
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp"

/**
 * The small shared primitives. Each of these exists three or four times across
 * the legacy pages in slightly different forms; this is the single version.
 */

export function Spinner({ dark = false }: { dark?: boolean }) {
  return (
    <span
      role="status"
      aria-label="กำลังโหลด"
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 align-middle ${
        dark
          ? "border-[color-mix(in_srgb,var(--color-secondary)_25%,transparent)] border-t-[var(--color-secondary)]"
          : "border-white/40 border-t-white"
      }`}
    />
  )
}

export type StateKind = "loading" | "empty" | "error"

/** Loading / empty / error, which the list and ranking pages both need. */
export function StateBox({
  kind,
  title,
  sub,
}: {
  kind: StateKind
  title: string
  sub?: string
}) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 1,
        px: 3,
        py: 7,
        textAlign: "center",
      }}
    >
      {kind === "loading" ? (
        <CircularProgress size={32} sx={{ color: "var(--color-secondary)" }} />
      ) : kind === "error" ? (
        <ErrorIcon sx={{ fontSize: 32, color: "var(--color-danger)" }} />
      ) : (
        <CheckBoxIcon sx={{ fontSize: 32, color: "var(--color-muted)" }} />
      )}
      <Typography
        sx={{
          fontFamily: "var(--font-manrope)",
          fontSize: "0.875rem",
          fontWeight: 600,
          color: "var(--color-secondary)",
        }}
      >
        {title}
      </Typography>
      {sub ? (
        <Typography sx={{ fontSize: "0.75rem", color: "var(--color-ink-muted)" }}>{sub}</Typography>
      ) : null}
    </Box>
  )
}

/** Grey placeholder used while the month header resolves. */
export function Skeleton({
  width = "100%",
  height = 16,
}: {
  width?: number | string
  height?: number | string
}) {
  return (
    <MuiSkeleton
      aria-hidden
      variant="rounded"
      width={width}
      height={height}
      sx={{ borderRadius: "var(--radius-card)", bgcolor: "var(--color-line)" }}
    />
  )
}

export function BackToTop({ threshold = 200 }: { threshold?: number }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > threshold)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    // The legacy pages never removed this listener. Harmless on a page that
    // only ever unloads, but wrong the moment a component unmounts.
    return () => window.removeEventListener("scroll", onScroll)
  }, [threshold])

  return (
    <Fade in={visible}>
      <Fab
        aria-label="กลับขึ้นด้านบน"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        sx={{
          position: "fixed",
          right: 16,
          bottom: 16,
          zIndex: 50,
          width: 44,
          height: 44,
          minHeight: 44,
          bgcolor: "var(--color-secondary)",
          color: "white",
          boxShadow: 3,
          "&:hover": { bgcolor: "var(--color-secondary)" },
        }}
      >
        <KeyboardArrowUpIcon />
      </Fab>
    </Fade>
  )
}

/** The page-level banner used for transient success/error notices. */
export function Notice({ kind, children }: { kind: "ok" | "error" | "info"; children: ReactNode }) {
  const styles = {
    ok: "bg-[#eef5ee] text-[var(--color-success)]",
    error: "bg-[#fbeae8] text-[var(--color-danger)]",
    info: "bg-[var(--color-tertiary)] text-[var(--color-secondary)] border border-[var(--color-line)]",
  }[kind]
  return (
    <div role="status" className={`rounded-[var(--radius-card)] px-3 py-2.5 text-sm ${styles}`}>
      {children}
    </div>
  )
}

/** Shared page shell: consistent max width and padding on every page. */
export function AppHeader({
  title,
  subtitle,
  right,
}: {
  title: string
  subtitle?: string
  right?: ReactNode
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[var(--color-neutral)]/95 backdrop-blur">
      <div className="mx-auto flex max-w-[640px] items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="font-[family-name:var(--font-manrope)] text-base font-bold text-[var(--color-secondary)]">
            {title}
          </div>
          {subtitle ? (
            <div className="truncate text-xs text-[var(--color-ink-muted)]">{subtitle}</div>
          ) : null}
        </div>
        {right}
      </div>
    </header>
  )
}
