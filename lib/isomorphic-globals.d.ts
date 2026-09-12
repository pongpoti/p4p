/**
 * lib/isomorphic-globals.d.ts
 *
 * lib/line-receipt-flex.ts is loaded both as a Node/CommonJS module
 * (main.js's `require("./lib/line-receipt-flex")`) and as a plain browser
 * <script> (upload/index.html) — see that file's UMD-lite header. Under
 * tsconfig.browser.json's "types": [] (deliberately excluding @types/node,
 * which would otherwise clash with the DOM lib for every other file in this
 * config), `module` and `require` are otherwise undeclared. This file adds
 * just enough of both for that one file to type-check, without pulling in
 * the rest of Node's ambient types. (`self` needs no declaration here — the
 * DOM lib already provides it.)
 */

declare const module: { exports: any } | undefined
declare function require(id: string): any
