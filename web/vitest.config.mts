import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
  test: {
    // Phase 0 covers pure logic only, so the default node environment is
    // enough. Component tests (Phase 2+) add jsdom + @testing-library/react.
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts", "components/**/*.test.tsx"],

    // Several month helpers read "now". Every test that depends on the current
    // date pins it with vi.setSystemTime, so a suite that passes in August must
    // not start failing in September.
    restoreMocks: true,
  },
})
