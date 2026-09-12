// One rendered hero image: an inline SVG string plus the pixel width to
// rasterize it at (height follows from the SVG's own viewBox aspect ratio).
export interface SvgSpec {
  file: string
  width: number
  svg: string
}

// One feature bubble in the carousel, keyed to one of the SvgSpecs above by
// filename.
export interface FeatureSpec {
  img: string
  title: string
  bullets: string[]
}

export const RELEASE  = 'v2'
// NOTE: v1.mts points this at skh-mso-p4p.vercel.app, which is not one of
// this project's live domains (checked against the actual Vercel project —
// see the domains list in `vercel --prod` / the dashboard). That looks like
// a stale reference surviving a project rename; v1's carousel may have been
// serving broken images this whole time. Using the real current domain here.
export const BASE_URL = 'https://p4p-sakhonmso.vercel.app/assets/cards/v2'
export const ALT_TEXT = 'อัปเดตใหม่ — ระบบ P4P มีฟีเจอร์ใหม่ 2 อย่าง'
// Blue theme (v1 is green). Picked up by build-cards.mts for the TEXT area
// below the hero image — bullet dot, divider bar, "ฟีเจอร์" eyebrow label —
// which lives in the shared card builder, not in these SVGs, so it needs
// its own hook to actually change colour along with the artwork below.
export const THEME_COLOR       = '#0B84FF'
export const THEME_LABEL_COLOR = '#0A6FD6'

// SVG strings + render widths. Height is derived from viewBox aspect ratio.
export const svgs: SvgSpec[] = [
  {
    file: 'cover.png',
    width: 1080,  // → 1080×1520 (270:380)
    // Same cover composition as v1.mjs (same phone mockup, same sparkle
    // decoration, same "อัปเดตใหม่" pill and swipe hint) — only the feature
    // count in the headline changes. Keeping the shell identical is
    // deliberate: repeat visitors should recognise this as "another one of
    // those update cards", not a redesign.
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 270 380">
  <defs><path id="st" d="M0,-6 L1.4,-1.4 L6,0 L1.4,1.4 L0,6 L-1.4,1.4 L-6,0 L-1.4,-1.4 Z"/></defs>
  <rect width="270" height="380" fill="#E8F1FC"/>
  <use href="#st" transform="translate(36,50) scale(1.5)" fill="#FFC400"/>
  <use href="#st" transform="translate(234,44) scale(1.0)" fill="#0B84FF" opacity=".45"/>
  <use href="#st" transform="translate(250,150) scale(.9)" fill="#FFC400" opacity=".8"/>
  <use href="#st" transform="translate(22,140) scale(1.0)" fill="#0B84FF" opacity=".4"/>
  <use href="#st" transform="translate(246,232) scale(.9)" fill="#FFC400" opacity=".7"/>
  <use href="#st" transform="translate(26,250) scale(1.4)" fill="#FFC400" opacity=".55"/>
  <use href="#st" transform="translate(250,318) scale(1.0)" fill="#0B84FF" opacity=".4"/>
  <use href="#st" transform="translate(40,352) scale(1.1)" fill="#FFC400" opacity=".75"/>
  <use href="#st" transform="translate(236,360) scale(1.4)" fill="#FFC400" opacity=".6"/>
  <use href="#st" transform="translate(210,300) scale(.8)" fill="#0B84FF" opacity=".4"/>
  <use href="#st" transform="translate(60,305) scale(.7)" fill="#FFC400" opacity=".5"/>
  <use href="#st" transform="translate(135,16) scale(.8)" fill="#0B84FF" opacity=".4"/>
  <rect x="103" y="30" width="64" height="124" rx="15" fill="#fff" stroke="#0B84FF" stroke-width="3"/>
  <rect x="126" y="36" width="18" height="3.5" rx="1.75" fill="#CFE3FA"/>
  <rect x="110" y="46" width="50" height="92" rx="7" fill="#EAF3FC"/>
  <rect x="116" y="52" width="38" height="24" rx="6" fill="#0B84FF"/>
  <rect x="123" y="59" width="13" height="10" rx="2" fill="#fff"/><path d="M139 64 l2 2 l4 -4.5" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="116" y="80" width="38" height="24" rx="6" fill="#4FA3FF"/>
  <path transform="translate(135,92)" d="M0,-8 L1.8,-2.5 L7.6,-2.5 L2.9,1 L4.7,6.5 L0,3.2 L-4.7,6.5 L-2.9,1 L-7.6,-2.5 L-1.8,-2.5 Z" fill="#fff"/>
  <rect x="116" y="108" width="38" height="24" rx="6" fill="#8FC6FF"/>
  <circle cx="135" cy="113" r="4.5" fill="#fff"/><path d="M126 129 Q126 120 135 120 Q144 120 144 129 Z" fill="#fff"/>
  <rect x="124" y="142" width="22" height="3.5" rx="1.75" fill="#CFE3FA"/>
  <g transform="rotate(-12 192 50)">
    <rect x="170" y="36" width="44" height="28" rx="14" fill="#FFC400"/>
    <text x="192" y="55" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="15" font-weight="700" fill="#333">ใหม่</text>
  </g>
  <rect x="87" y="206" width="96" height="27" rx="13.5" fill="#0B84FF"/>
  <text x="135" y="224.5" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="14" font-weight="700" fill="#fff">อัปเดตใหม่</text>
  <text x="135" y="272" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="23" font-weight="700" fill="#2E2E2E">ฟีเจอร์ใหม่ 2 อย่าง</text>
  <rect x="115" y="285" width="40" height="3.5" rx="1.75" fill="#0B84FF"/>
  <text x="135" y="312" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="13.5" fill="#555">ระบบ P4P องค์กรแพทย์</text>
  <text x="135" y="331" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="13.5" fill="#555">โรงพยาบาลสมุทรสาคร</text>
  <text x="120" y="360" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="13" font-weight="700" fill="#0A6FD6">เลื่อนดูทางขวา</text>
  <g stroke="#0A6FD6" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <line x1="183" y1="356" x2="197" y2="356"/><polyline points="192,351 197,356 192,361"/>
  </g>
</svg>`,
  },
  {
    file: 'upload.png',
    width: 1536,  // → 1536×967 (27:17)
    // Centrepiece is a glimpse of the actual rich-menu row — same clay
    // circle + upload-tray glyph as src/richmenu.svg's real "ส่งไฟล์ P4P"
    // button, in its own true colour rather than the card's blue theme, so
    // it reads as "here is that exact button" rather than as themed
    // artwork. Month chip + a small "sent" check badge (overlapping the
    // card's corner, not a separate element) supply the same "this is a
    // submission" story the previous version told with a document icon.
    // Title is 16px at x=130, not the original 19px at x=134: at 19px the
    // text ran ~9px past the card's right edge (caught from a live LINE
    // screenshot; resvg.innerBBox() on the string alone measured 93px
    // wide, and 134+93=227 is past the card's edge at 218). 16px measures
    // 78px, ending at 208 — 10px clear.
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 270 170">
  <rect width="270" height="170" fill="#E8F1FC"/>
  <circle cx="30" cy="140" r="5" fill="#0B84FF" opacity=".2"/><circle cx="248" cy="26" r="4" fill="#FFC400" opacity=".4"/>
  <rect x="52" y="44" width="166" height="82" rx="16" fill="#fff" stroke="#CFE3FA" stroke-width="2"/>
  <circle cx="94" cy="85" r="28" fill="#8A6F52"/>
  <g transform="translate(94,84) scale(.78)" fill="none" stroke="#FFFFFF" stroke-width="6.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M-18,10 v7 q0,5 5,5 h26 q5,0 5,-5 v-7"/>
    <line x1="0" y1="12" x2="0" y2="-15"/>
    <polyline points="-10,-5 0,-17 10,-5"/>
  </g>
  <text x="130" y="80" font-family="'Noto Sans Thai',sans-serif" font-size="16" font-weight="700" fill="#2D2218">ส่งไฟล์ P4P</text>
  <rect x="130" y="88" width="28" height="4" rx="2" fill="#A68966" opacity=".75"/>
  <text x="130" y="106" font-family="'Noto Sans Thai',sans-serif" font-size="11" fill="#6E5C49">แตะเพื่อส่งไฟล์</text>
  <rect x="200" y="22" width="54" height="24" rx="12" fill="#0B84FF"/>
  <text x="227" y="38" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="12" font-weight="700" fill="#fff">ก.ค. 69</text>
  <!-- cx=222, not 212: at 212 the ring's stroke (radius 19 + half of
       stroke-width 4.5 = 21.25px visual reach) started at x≈190.75, which
       overlapped the subtitle text ending at x≈192 — confirmed from a live
       LINE screenshot showing the ring cutting into "แตะเพื่อส่งไฟล์". At
       222 the ring starts at x≈200.75, a clear 8.75px past the subtitle. -->
  <circle cx="222" cy="118" r="19" fill="#fff" stroke="#0B84FF" stroke-width="4.5"/>
  <path d="M214 118 l5.5 6 l10.5 -12" fill="none" stroke="#0B84FF" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,
  },
  {
    file: 'verify.png',
    width: 1536,
    // An ID card (name + department rows, like the identity block on
    // status/) with a check-shield for "identity confirmed" and an opened
    // envelope for "by email" — the two things verifying actually checks.
    // A small LINE badge overlaps the card's bottom-right corner: this is
    // verification happening THROUGH LINE, so the card alone (which reads
    // as "any ID") needed that anchor. Simplified original speech-bubble
    // glyph rather than a traced copy of LINE's own logo file — appropriate
    // for this internal, non-commercial use. Positioned in the one gap that
    // doesn't crowd anything else: right of the envelope, below the shield,
    // above the checkmark badge (checked against all three's coordinates).
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 270 170">
  <rect width="270" height="170" fill="#E8F1FC"/>
  <circle cx="234" cy="34" r="5" fill="#0B84FF" opacity=".2"/><circle cx="34" cy="132" r="6" fill="#0B84FF" opacity=".18"/>
  <rect x="40" y="34" width="120" height="76" rx="12" fill="#fff" stroke="#CFE3FA" stroke-width="2"/>
  <circle cx="68" cy="64" r="15" fill="#0B84FF"/>
  <circle cx="68" cy="59" r="5.5" fill="#fff"/><path d="M57.5 76 q10.5 -11 21 0" fill="#fff"/>
  <rect x="92" y="54" width="52" height="6" rx="3" fill="#333" opacity=".65"/>
  <rect x="92" y="66" width="40" height="5" rx="2.5" fill="#D8DCE0"/>
  <rect x="92" y="76" width="46" height="5" rx="2.5" fill="#D8DCE0"/>
  <rect x="52" y="90" width="96" height="10" rx="5" fill="#EAF3FC"/>
  <path d="M180 40 l24 -9 l24 9 v20 q0 24 -24 31 q-24 -7 -24 -31 z" fill="#fff" stroke="#0B84FF" stroke-width="4"/>
  <path d="M193 62 l7.5 7.5 l15 -17" fill="none" stroke="#0B84FF" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="66" y="120" width="60" height="38" rx="6" fill="#fff" stroke="#CFE3FA" stroke-width="2"/>
  <polyline points="66,124 96,144 126,124" fill="none" stroke="#0B84FF" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="150" cy="146" r="15" fill="#0B84FF"/>
  <path d="M143.5 146 l4.5 4.5 l8.5 -9.5" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="140" y="90" width="36" height="36" rx="10" fill="#06C755" stroke="#fff" stroke-width="3"/>
  <rect x="148" y="99" width="20" height="14" rx="5" fill="#fff"/>
  <polygon points="152,113 152,119 158,113" fill="#fff"/>
</svg>`,
  },
]

// Feature cards (one bubble per entry, in carousel order after the cover)
export const features: FeatureSpec[] = [
  {
    img: 'upload.png',
    title: 'ส่งไฟล์ P4P ผ่าน LINE',
    // Each bullet trimmed to fit one line in the Flex bubble (size 'sm').
    // The originals wrapped to 2 lines each — confirmed from a live LINE
    // screenshot — so these were re-measured with the same resvg/Noto Sans
    // Thai proxy used for the hero art: calibrated against that screenshot's
    // own wrap points (a known-fitting line measured 200-221px there), every
    // string below measures under 200px, well clear of that line.
    bullets: [
      'แตะเมนู "ส่งไฟล์ P4P" ส่งไฟล์ได้ทันที',
      'เลือกเดือน แนบไฟล์ ตรวจให้อัตโนมัติ',
      'ทราบผลคะแนนทันที ไม่ต้องรอทางอีเมล',
    ],
  },
  {
    img: 'verify.png',
    title: 'ยืนยันตัวตนผ่าน LINE',
    bullets: [
      'ยืนยันตัวตนด้วยอีเมลที่ลงทะเบียน',
      'ผูก LINE รับแจ้งเตือน ใช้เมนูอื่นได้ทันที',
    ],
  },
]
