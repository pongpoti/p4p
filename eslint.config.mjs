import js from "@eslint/js"
import globals from "globals"
import prettier from "eslint-config-prettier"

export default [
  // web/ is the Next.js rewrite (REACT_REWRITE_PLAN.md). It is a self-contained
  // sub-project with its own TypeScript toolchain and its own lint step, and
  // its build output under web/.next/ is minified bundles. This config has no
  // TS parser and would report thousands of false positives on both.
  { ignores: ["node_modules/**", "assets/cards/**", ".vercel/**", "web/**"] },

  js.configs.recommended,

  // Server entry — CommonJS, Node globals.
  {
    files: ["main.js", "src/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      ecmaVersion: "latest",
      globals: { ...globals.node },
    },
  },

  // Build / admin scripts — ESM, Node globals, top-level await.
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      ecmaVersion: "latest",
      globals: { ...globals.node },
    },
  },

  // Browser scripts served to the LIFF pages. `assets/` holds the shared
  // helpers; the four page directories hold each page's own app.js. These were
  // previously outside every `files` block, so they fell back to the bare
  // recommended config with NO globals declared — every use of `fetch`,
  // `location`, `localStorage`, `console` etc. was reported as no-undef, which
  // buried any real finding under ~56 false ones.
  {
    files: [
      "assets/**/*.js",
      "verify/**/*.js",
      "status/**/*.js",
      "list/**/*.js",
      "ranking/**/*.js",
      "admin/**/*.js",
      "upload/**/*.js",
    ],
    languageOptions: {
      sourceType: "script",
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
        // Loaded from CDNs / injected by the page, not bundled.
        supabase: "readonly",
        liff: "readonly",
        P4P: "writable",
      },
    },
  },

  // lib/ is loaded from BOTH runtimes: main.js require()s these files and the
  // /upload/ page loads line-receipt-flex.js with a <script src>. Hence both
  // sets of globals — the UMD-lite wrapper in that file genuinely reads
  // `module`, `require` and `self` in the same source.
  {
    files: ["lib/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      ecmaVersion: "latest",
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // Root test suite (node:test, ESM).
  {
    files: ["lib/__tests__/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      ecmaVersion: "latest",
      globals: { ...globals.node },
    },
  },

  // Turn off rules that conflict with Prettier formatting.
  prettier,
]
