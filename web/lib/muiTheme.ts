import { createTheme } from "@mui/material/styles"

/**
 * MUI theme for the status/ranking/list pages.
 *
 * Mirrors the design tokens in app/globals.css (--color-*, --radius-card)
 * rather than replacing them, so switching these pages' markup over to MUI
 * components does not change how they look. Components still read the CSS
 * variables directly for anything the theme object has no slot for (e.g. the
 * per-month accent colours), but palette/shape/typography are set here so
 * MUI's own defaults (ripple colours, focus rings, Paper corners, ...) line
 * up too.
 */
export const muiTheme = createTheme({
  palette: {
    primary: { main: "#a68966" }, // --color-primary
    secondary: { main: "#4b3d33" }, // --color-secondary
    error: { main: "#c0392b" }, // --color-danger
    success: { main: "#2f7d32" }, // --color-success
    background: { default: "#faf9f6", paper: "#ffffff" }, // --color-neutral
    text: {
      primary: "#2d2d2d", // --color-ink
      secondary: "#6b6b6b", // --color-ink-muted
    },
    divider: "#d9d2c8", // --color-line
  },
  shape: {
    borderRadius: 4, // --radius-card
  },
  typography: {
    fontFamily: "var(--font-body)",
  },
  components: {
    MuiButtonBase: {
      defaultProps: {
        disableRipple: true,
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },
  },
})
