import type { Metadata, Viewport } from "next"
import { Manrope, Noto_Sans_Thai_Looped, Work_Sans } from "next/font/google"
import ThemeRegistry from "@/components/ThemeRegistry"
import "./globals.css"

/**
 * Fonts are self-hosted by next/font: they are downloaded at build time and
 * served from our own origin. The legacy pages load them from
 * fonts.googleapis.com, which costs two CSP origins, two preconnects and a
 * render-blocking round trip on hospital wifi. This removes all of that.
 */
const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-manrope",
  display: "swap",
})

const workSans = Work_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-work-sans",
  display: "swap",
})

const notoSansThai = Noto_Sans_Thai_Looped({
  subsets: ["thai"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-thai",
  display: "swap",
})

export const metadata: Metadata = {
  title: "SAKHONMSO P4P",
  // These pages are behind a login gate and only ever opened from inside LINE.
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="th"
      className={`${manrope.variable} ${workSans.variable} ${notoSansThai.variable}`}
    >
      <body>
        <ThemeRegistry>{children}</ThemeRegistry>
      </body>
    </html>
  )
}
