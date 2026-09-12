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

export const RELEASE  = 'v1'
export const BASE_URL = 'https://skh-mso-p4p.vercel.app/assets/cards/v1'
export const ALT_TEXT = 'อัปเดตใหม่ — ระบบ P4P มีฟีเจอร์ใหม่ 3 อย่าง'

// SVG strings + render widths. Height is derived from viewBox aspect ratio.
export const svgs: SvgSpec[] = [
  {
    file: 'cover.png',
    width: 1080,  // → 1080×1520 (270:380)
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 270 380">
  <defs><path id="st" d="M0,-6 L1.4,-1.4 L6,0 L1.4,1.4 L0,6 L-1.4,1.4 L-6,0 L-1.4,-1.4 Z"/></defs>
  <rect width="270" height="380" fill="#E7F8EC"/>
  <use href="#st" transform="translate(36,50) scale(1.5)" fill="#FFC400"/>
  <use href="#st" transform="translate(234,44) scale(1.0)" fill="#00C300" opacity=".45"/>
  <use href="#st" transform="translate(250,150) scale(.9)" fill="#FFC400" opacity=".8"/>
  <use href="#st" transform="translate(22,140) scale(1.0)" fill="#00C300" opacity=".4"/>
  <use href="#st" transform="translate(246,232) scale(.9)" fill="#FFC400" opacity=".7"/>
  <use href="#st" transform="translate(26,250) scale(1.4)" fill="#FFC400" opacity=".55"/>
  <use href="#st" transform="translate(250,318) scale(1.0)" fill="#00C300" opacity=".4"/>
  <use href="#st" transform="translate(40,352) scale(1.1)" fill="#FFC400" opacity=".75"/>
  <use href="#st" transform="translate(236,360) scale(1.4)" fill="#FFC400" opacity=".6"/>
  <use href="#st" transform="translate(210,300) scale(.8)" fill="#00C300" opacity=".4"/>
  <use href="#st" transform="translate(60,305) scale(.7)" fill="#FFC400" opacity=".5"/>
  <use href="#st" transform="translate(135,16) scale(.8)" fill="#00C300" opacity=".4"/>
  <rect x="103" y="30" width="64" height="124" rx="15" fill="#fff" stroke="#00C300" stroke-width="3"/>
  <rect x="126" y="36" width="18" height="3.5" rx="1.75" fill="#CDEFD6"/>
  <rect x="110" y="46" width="50" height="92" rx="7" fill="#EAF8EE"/>
  <rect x="116" y="52" width="38" height="24" rx="6" fill="#00C300"/>
  <rect x="123" y="59" width="13" height="10" rx="2" fill="#fff"/><path d="M139 64 l2 2 l4 -4.5" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="116" y="80" width="38" height="24" rx="6" fill="#4FD15C"/>
  <path transform="translate(135,92)" d="M0,-8 L1.8,-2.5 L7.6,-2.5 L2.9,1 L4.7,6.5 L0,3.2 L-4.7,6.5 L-2.9,1 L-7.6,-2.5 L-1.8,-2.5 Z" fill="#fff"/>
  <rect x="116" y="108" width="38" height="24" rx="6" fill="#8BE693"/>
  <circle cx="135" cy="113" r="4.5" fill="#fff"/><path d="M126 129 Q126 120 135 120 Q144 120 144 129 Z" fill="#fff"/>
  <rect x="124" y="142" width="22" height="3.5" rx="1.75" fill="#CDEFD6"/>
  <g transform="rotate(-12 192 50)">
    <rect x="170" y="36" width="44" height="28" rx="14" fill="#FFC400"/>
    <text x="192" y="55" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="15" font-weight="700" fill="#333">ใหม่</text>
  </g>
  <rect x="87" y="206" width="96" height="27" rx="13.5" fill="#00C300"/>
  <text x="135" y="224.5" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="14" font-weight="700" fill="#fff">อัปเดตใหม่</text>
  <text x="135" y="272" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="23" font-weight="700" fill="#2E2E2E">ฟีเจอร์ใหม่ 3 อย่าง</text>
  <rect x="115" y="285" width="40" height="3.5" rx="1.75" fill="#00C300"/>
  <text x="135" y="312" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="13.5" fill="#555">ระบบ P4P องค์กรแพทย์</text>
  <text x="135" y="331" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="13.5" fill="#555">โรงพยาบาลสมุทรสาคร</text>
  <text x="120" y="360" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="13" font-weight="700" fill="#00A300">เลื่อนดูทางขวา</text>
  <g stroke="#00A300" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <line x1="183" y1="356" x2="197" y2="356"/><polyline points="192,351 197,356 192,361"/>
  </g>
</svg>`,
  },
  {
    file: 'status.png',
    width: 1536,  // → 1536×967 (27:17)
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 270 170">
  <rect width="270" height="170" fill="#E7F8EC"/>
  <circle cx="36" cy="34" r="5" fill="#00C300" opacity=".22"/><circle cx="240" cy="36" r="7" fill="#00C300" opacity=".15"/><circle cx="232" cy="138" r="4" fill="#00C300" opacity=".25"/>
  <rect x="78" y="30" width="116" height="118" rx="14" fill="#fff" stroke="#CDEFD6" stroke-width="2"/>
  <rect x="108" y="23" width="56" height="16" rx="8" fill="#00C300"/>
  <circle cx="100" cy="64" r="9" fill="#00C300"/><path d="M96 64 l3 3 l5 -6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><rect x="116" y="60" width="62" height="8" rx="4" fill="#D8DCE0"/>
  <circle cx="100" cy="92" r="9" fill="#00C300"/><path d="M96 92 l3 3 l5 -6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><rect x="116" y="88" width="50" height="8" rx="4" fill="#D8DCE0"/>
  <circle cx="100" cy="120" r="9" fill="none" stroke="#D8DCE0" stroke-width="2.4"/><rect x="116" y="116" width="44" height="8" rx="4" fill="#E4E7EA"/>
  <circle cx="182" cy="118" r="25" fill="#fff" stroke="#00C300" stroke-width="6"/><circle cx="182" cy="118" r="13" fill="#E7F8EC"/><line x1="200" y1="136" x2="216" y2="152" stroke="#06A300" stroke-width="8" stroke-linecap="round"/>
  <rect x="34" y="58" width="42" height="40" rx="8" fill="#fff" stroke="#CDEFD6" stroke-width="2"/><rect x="34" y="58" width="42" height="13" rx="6" fill="#00C300"/><text x="55" y="92" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif" font-size="20" font-weight="700" fill="#333">6</text>
</svg>`,
  },
  {
    file: 'ranking.png',
    width: 1536,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 270 170">
  <rect width="270" height="170" fill="#E7F8EC"/>
  <circle cx="36" cy="40" r="6" fill="#00C300" opacity=".18"/><circle cx="236" cy="130" r="5" fill="#00C300" opacity=".22"/>
  <path d="M135 20 l4.4 9 l9.8 1.4 l-7.1 6.9 l1.7 9.8 l-8.8 -4.6 l-8.8 4.6 l1.7 -9.8 l-7.1 -6.9 l9.8 -1.4 z" fill="#FFC400"/>
  <rect x="96" y="64" width="48" height="84" rx="6" fill="#00C300"/><rect x="50" y="92" width="46" height="56" rx="6" fill="#5FD96B"/><rect x="144" y="104" width="46" height="44" rx="6" fill="#8BE693"/>
  <circle cx="120" cy="60" r="15" fill="#fff" stroke="#00C300" stroke-width="3"/><text x="120" y="66" text-anchor="middle" font-size="15" font-weight="700" fill="#00A300" font-family="'Noto Sans Thai',sans-serif">1</text>
  <circle cx="73" cy="88" r="13" fill="#fff" stroke="#5FD96B" stroke-width="3"/><text x="73" y="93" text-anchor="middle" font-size="13" font-weight="700" fill="#3FB94B" font-family="'Noto Sans Thai',sans-serif">2</text>
  <circle cx="167" cy="100" r="12" fill="#fff" stroke="#8BE693" stroke-width="3"/><text x="167" y="105" text-anchor="middle" font-size="12" font-weight="700" fill="#5FB36A" font-family="'Noto Sans Thai',sans-serif">3</text>
  <circle cx="228" cy="44" r="20" fill="#fff" stroke="#00C300" stroke-width="5"/><line x1="228" y1="44" x2="228" y2="33" stroke="#06A300" stroke-width="3.5" stroke-linecap="round"/><line x1="228" y1="44" x2="236" y2="48" stroke="#06A300" stroke-width="3.5" stroke-linecap="round"/>
</svg>`,
  },
  {
    file: 'list.png',
    width: 1536,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 270 170">
  <rect width="270" height="170" fill="#E7F8EC"/>
  <circle cx="40" cy="36" r="6" fill="#00C300" opacity=".18"/><circle cx="234" cy="40" r="4" fill="#00C300" opacity=".25"/>
  <rect x="52" y="30" width="166" height="112" rx="14" fill="#fff" stroke="#CDEFD6" stroke-width="2"/>
  <circle cx="78" cy="58" r="12" fill="#00C300"/><circle cx="78" cy="54.5" r="4.2" fill="#fff"/><path d="M70.5 64 q7.5 -7 15 0" fill="#fff"/><rect x="98" y="51" width="74" height="7" rx="3.5" fill="#333" opacity=".7"/><rect x="98" y="62" width="50" height="6" rx="3" fill="#D8DCE0"/>
  <circle cx="78" cy="92" r="12" fill="#5FD96B"/><circle cx="78" cy="88.5" r="4.2" fill="#fff"/><path d="M70.5 98 q7.5 -7 15 0" fill="#fff"/><rect x="98" y="85" width="68" height="7" rx="3.5" fill="#333" opacity=".7"/><rect x="98" y="96" width="44" height="6" rx="3" fill="#D8DCE0"/>
  <circle cx="78" cy="120" r="12" fill="#8BE693"/><circle cx="78" cy="116.5" r="4.2" fill="#fff"/><path d="M70.5 126 q7.5 -7 15 0" fill="#fff"/><rect x="98" y="117" width="60" height="7" rx="3.5" fill="#333" opacity=".55"/>
  <circle cx="206" cy="118" r="20" fill="#fff" stroke="#00C300" stroke-width="5"/><path d="M197 118 l6 6 l11 -13" fill="none" stroke="#00C300" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,
  },
]

// Feature cards (one bubble per entry, in carousel order after the cover)
export const features: FeatureSpec[] = [
  {
    img: 'status.png',
    title: 'สถานะการส่ง P4P',
    bullets: [
      'เช็คสถานะการส่ง ย้อนหลัง 6 เดือน',
      'กดที่เมนูด้านล่าง เพื่อเลือกเดือน',
      'สามารถพิมพ์ เพื่อค้นหาชื่อหรือกลุ่มงาน',
    ],
  },
  {
    img: 'ranking.png',
    title: 'อันดับการส่ง P4P',
    bullets: [
      'แสดงรายชื่อ ผู้ที่ส่งภายในกำหนด',
      'เรียงลำดับชื่อ ตามวันที่ส่ง',
      'เพื่อกระตุ้นให้ส่งตามเวลา',
    ],
  },
  {
    img: 'list.png',
    title: 'ผู้มีสิทธิ์รับ P4P',
    bullets: [
      'อ้างอิงข้อมูลจากงานทรัพยฯ',
      'ตรวจสอบข้อมูลย้อนหลังได้ 6 เดือน',
    ],
  },
]
