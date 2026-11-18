"use strict";
/** GENERATED FILE'S SOURCE — compiled to dashboard/icons.js by
 * `npm run build:browser` (see tsconfig.browser.json). Edit this file, not
 * the .js twin.
 *
 * Line icons for the dashboard (2026-11-18). TH SarabunPSK has no arrows or
 * ticks (← → ↗ ✓), so app.js and review.js draw them from here instead of
 * from a font. Loaded before both, as plain global functions (no modules).
 * The paths are the same 24px strokes as the --i-* masks in index.html.
 */
const ICON_PATHS = {
    "check": '<path d="M20 6 9 17l-5-5"/>',
    "check-circle": '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
    "x-circle": '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
    "alert-circle": '<circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 16.5v.5"/>',
    "alert-tri": '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17v.5"/>',
    "help": '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5M12 17.5v.5"/>',
    "info": '<circle cx="12" cy="12" r="10"/><path d="M12 16v-5M12 7.5v.5"/>',
    "clock": '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    "arrow-circle": '<circle cx="12" cy="12" r="10"/><path d="m12 16 4-4-4-4M8 12h8"/>',
    "pencil": '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    "flag": '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
    "flask": '<path d="M10 2v7.5L4.2 19a2 2 0 0 0 1.7 3h12.2a2 2 0 0 0 1.7-3L14 9.5V2M8.5 2h7M7 16h10"/>',
    "external": '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    "download": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    "file": '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    "search": '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    "refresh": '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
    "mail": '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
    "lock": '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    "undo": '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "bang": '<path d="M12 5v9M12 19v.5"/>',
    "list": '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    "comment": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    // Not among the CSS masks: the arrows that replace ← → and the × of a close button.
    "arrow-left": '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    "arrow-right": '<path d="M5 12h14M12 5l7 7-7 7"/>',
    "x": '<path d="M18 6 6 18M6 6l12 12"/>',
    // อัตรากำลัง: when the numbers were last brought up to date.
    "calendar": '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    // ภาพรวม's ข้อมูล menu (2026-11-18): งบรายเดือน and เอกสารจัดสรร.
    "banknote": '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
    "upload": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    // The owner's user menu (QR invite, 2026-11-18).
    "qr": '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4h-4"/>',
    "users": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
};
// icon() and iconEl() are globals for app.ts and review.ts (plain scripts,
// no modules), so nothing in this file calls them.
/** The icon as SVG markup: 1em square, drawn in the text colour, hidden from
 * screen readers (the words next to it carry the meaning). */
function icon(name, cls) {
    const paths = ICON_PATHS[name] || "";
    return '<svg class="ic' + (cls ? " " + cls : "") + '" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="1em" height="1em"' +
        ' fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
}
/** The same icon as an element, ready to append. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function iconEl(name, cls) {
    const t = document.createElement("template");
    t.innerHTML = icon(name, cls);
    return t.content.firstChild;
}
