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
  // `automation/` declares "type": "module" in its own package.json, so its
  // plain .js files are ESM too and belong here rather than with main.js.
  {
    files: ["scripts/**/*.mjs", "automation/**/*.js", "automation/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      ecmaVersion: "latest",
      globals: { ...globals.node },
    },
  },

  // The SK03 pipeline — CommonJS, Node globals. Same situation the browser
  // block below describes: these directories matched no `files` block at all,
  // so every `require`, `process` and `console` in them was reported as
  // no-undef. Between them and automation/ that was ~570 false positives, which
  // is why `npm run lint` exited non-zero on a clean tree and had stopped being
  // a signal anyone could act on.
  {
    files: ["process/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
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

  // Turn off rules that conflict with Prettier formatting.
  prettier,
]
