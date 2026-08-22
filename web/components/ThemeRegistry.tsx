"use client"

import type { ReactNode } from "react"
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter"
import { ThemeProvider } from "@mui/material/styles"
import { muiTheme } from "@/lib/muiTheme"

/**
 * The theme object holds functions (breakpoints.up, ...), so it can only be
 * created and consumed on the client side of the tree — passing it as a prop
 * from the (server) root layout into ThemeProvider fails the RSC
 * serialization check at build time. This component imports it directly
 * instead of receiving it, keeping the whole MUI wiring on the client.
 */
export default function ThemeRegistry({ children }: { children: ReactNode }) {
  return (
    <AppRouterCacheProvider options={{ key: "mui" }}>
      <ThemeProvider theme={muiTheme}>{children}</ThemeProvider>
    </AppRouterCacheProvider>
  )
}
