/** GENERATED FILE'S SOURCE — this file is compiled to list/app.js by
 * `npm run build:browser` (see tsconfig.browser.json). Edit this file, not
 * the .js twin, which is a build artifact served byte-for-byte by
 * express.static() and must not be hand-edited. */
// Wrapped in an IIFE (the original file was a bare top-level classic script,
// no wrapper) purely so its declarations don't collide, under tsc's
// whole-program type-check of every page script in this tsconfig together,
// with same-named top-level identifiers another page's script declares (e.g.
// ranking/app.ts's own `escHtml`). Every one of these pages is still served,
// and runs, entirely on its own — nothing outside this file ever reads any
// of these names.
;(function () {
// Supabase client + verification gate come from /assets/auth-guard.js
const client = P4P.db as SupabaseClientLike;

/* ── THAI MONTH NAMES ── */
const THAI_MONTHS = P4P.THAI_MONTHS;

const COLOR_ARRAY = P4P.COLOR_ARRAY;

/* Convert Gregorian year → Buddhist Era year (พ.ศ.) */
function toBE(year: number): number {
  return year + 543;
}

/* Build table key: YYYY_MM (zero-padded) */
function tableKey(beYear: number, month: number): string {
  return `${beYear}_${String(month).padStart(2,'0')}`;
}

/* Build Thai label: "มีนาคม 2569" */
function thaiLabel(beYear: number, month: number): string {
  return `${THAI_MONTHS[month-1]} ${beYear}`;
}

/* Get color hex for a 1-based month number */
function monthColor(month: number): string {
  return COLOR_ARRAY[(month - 1) % 12][1];
}

/* ── POPULATE DROPDOWN — current month back 5 ── */
(function buildDropdown() {
  const now   = new Date();
  const sel   = document.getElementById('monthSelect') as HTMLSelectElement;
  let   year  = now.getFullYear();
  let   month = now.getMonth() + 1; // 1-based

  for (let i = 0; i < 6; i++) {
    // @ts-expect-error preserved bug (REACT_REWRITE_PLAN.md §8, list/app.js:37): toBE() takes one argument; the extra `month` here is silently ignored by JS at runtime — left exactly as-is.
    const beYear = toBE(year, month);
    const opt    = document.createElement('option');
    opt.value    = tableKey(beYear, month);
    opt.textContent = thaiLabel(beYear, month);
    sel.appendChild(opt);

    // go back one month
    month--;
    if (month === 0) { month = 12; year--; }
  }
})();

/* Build a lookup from tableKey → { label, color } */
function getMonthMeta(tableKey: string): { label: string; color: string } {
  const [beStr, mStr] = tableKey.split('_');
  const month = parseInt(mStr, 10);
  const beYear = parseInt(beStr, 10);
  return {
    label: thaiLabel(beYear, month),
    color: monthColor(month),
  };
}

interface ListRow {
  name: string
  department: string
}
type ListSortDir = 'asc' | 'desc'

let allData: ListRow[] = [], filtered: ListRow[] = [], sortCol: keyof ListRow | null = null, sortDir: ListSortDir = 'asc', columns: (keyof ListRow)[] = [];
let currentPage=1, showAll=false, loadToken=0;
const PAGE_SIZE = 25;

/* clock */
function updateClock(): void {
  (document.getElementById('clockDisplay') as HTMLElement).textContent =
    new Date().toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
setInterval(updateClock,1000); updateClock();

const isMobile = (): boolean => window.innerWidth <= 481;

/* ── LOAD ── */
async function loadData(): Promise<void> {
  const table = (document.getElementById('monthSelect') as HTMLSelectElement).value;
  if (!table) return;
  await P4P.ready;   // don't query until the verification gate has a valid session
  const myToken = ++loadToken;
  const meta = getMonthMeta(table);

  (document.getElementById('paginationBar') as HTMLElement).style.display = 'none';
  const statsRowEl = document.getElementById('statsRow') as HTMLElement;
  statsRowEl.style.display = 'none';
  statsRowEl.innerHTML = '';
  const monthBadgeEl = document.getElementById('monthBadge') as HTMLElement;
  monthBadgeEl.textContent = meta.label;
  monthBadgeEl.style.background = meta.color;
  monthBadgeEl.style.borderColor = meta.color;
  monthBadgeEl.style.color = '#4B3D33';
  // store color for thead
  const tableCardEl = document.getElementById('tableCard') as HTMLElement;
  tableCardEl.dataset.color = meta.color;
  tableCardEl.style.borderTop = `3px solid ${meta.color}`;
  const searchInputEl = document.getElementById('searchInput') as HTMLInputElement;
  searchInputEl.value = '';
  searchInputEl.disabled = true;
  setLoading('กำลังโหลด...');
  try {
    const { data, error } = await client.from(table).select('firstname, lastname, department');
    if (myToken !== loadToken) return;   // stale — a newer load already started
    if (error) throw error;
    const rows = (data as { firstname: string | null; lastname: string | null; department: string | null }[] | null) || [];
    allData = rows.map(r=>({
      name: [r.firstname,r.lastname].filter(Boolean).join(' ') || '—',
      department: r.department || '—',
    }));
    allData.sort((a,b)=>a.name.localeCompare(b.name,'th'));
    columns = ['name','department'];
    sortCol=null; sortDir='asc'; currentPage=1; showAll=false;
    searchInputEl.disabled = false;
    filterAndRender();
  } catch(err) {
    if (myToken !== loadToken) return;
    (document.getElementById('monthSelect') as HTMLSelectElement).value = '';
    searchInputEl.disabled = true;
    setError((err as Error).message);
  }
}

/* ── STATS ── */
function renderStats(): void {
  const uniqueDepts = new Set(allData.map(r=>r.department).filter(d=>d&&d!=='—')).size;
  const q = (document.getElementById('searchInput') as HTMLInputElement).value.trim();
  const searchCard = q ? `
    <div class="stat-pill">
      <div class="stat-pill-val">${filtered.length}</div>
      <div class="stat-pill-lbl">ผลการค้นหา</div>
    </div>` : '';
  const statsRowEl = document.getElementById('statsRow') as HTMLElement;
  statsRowEl.style.display = 'grid';
  statsRowEl.innerHTML = `
    <div class="stat-pill">
      <div class="stat-pill-val">${allData.length.toLocaleString()}</div>
      <div class="stat-pill-lbl">แพทย์ทั้งหมด</div>
    </div>
    <div class="stat-pill">
      <div class="stat-pill-val">${uniqueDepts}</div>
      <div class="stat-pill-lbl">แผนก</div>
    </div>
    ${searchCard}`;
}

/* ── FILTER ── */
function filterAndRender(): void {
  const q = (document.getElementById('searchInput') as HTMLInputElement).value.trim().toLowerCase();
  filtered = q
    ? allData.filter(r=>Object.values(r).some(v=>v&&String(v).toLowerCase().includes(q)))
    : [...allData];
  if (sortCol) sortFiltered();
  currentPage=1; renderStats(); renderTable();
}

/* ── SORT ── */
function sortFiltered(): void {
  const col = sortCol as keyof ListRow;
  filtered.sort((a,b)=>{
    const av: unknown = a[col], bv: unknown = b[col];
    if(av==null)return 1; if(bv==null)return -1;
    const n=parseFloat(av as string),m=parseFloat(bv as string);
    if(!isNaN(n)&&!isNaN(m)) return sortDir==='asc'?n-m:m-n;
    return sortDir==='asc'
      ? String(av).localeCompare(String(bv),'th')
      : String(bv).localeCompare(String(av),'th');
  });
}
function handleSort(col: keyof ListRow): void {
  sortDir = sortCol===col?(sortDir==='asc'?'desc':'asc'):'asc';
  sortCol=col; sortFiltered(); currentPage=1; renderTable();
}

/* ── RENDER ── */
function renderTable(): void {
  (document.getElementById('rowCountDisplay') as HTMLElement).textContent = String(filtered.length);
  const paginationBarEl = document.getElementById('paginationBar') as HTMLElement;
  if (!filtered.length) { setEmpty(); paginationBarEl.style.display='none'; return; }

  const effectiveSize = showAll ? filtered.length : PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(filtered.length / effectiveSize));
  if (currentPage > totalPages) currentPage = totalPages;
  const start    = showAll ? 0 : (currentPage-1)*PAGE_SIZE;
  const pageRows = showAll ? filtered : filtered.slice(start, start+PAGE_SIZE);

  /* Mobile row list */
  const tableCardEl = document.getElementById('tableCard') as HTMLElement;
  const thColor = tableCardEl.dataset.color || '#E8E3DC';
  let rowList = '<div class="row-list">';
  pageRows.forEach((row,i)=>{
    const name = row.name==='—'?'<span style="color:#C9BEAF">—</span>':escHtml(row.name);
    const deptStyle = `background:${thColor};color:#4B3D33;border:none`;
    const dept = row.department==='—'?'':`<span class="row-dept" style="${deptStyle}">${escHtml(row.department)}</span>`;
    rowList += `<div class="row-item" style="border-left:3px solid ${thColor};padding-left:11px">
      <span class="row-num">${start+i+1}</span>
      <span class="row-name">${name}</span>
      ${dept}
    </div>`;
  });
  rowList += '</div>';

  /* Desktop table */
  const COL_LABELS: Record<keyof ListRow, string> = {name:'ชื่อ-นามสกุล',department:'แผนก'};
  let thead = `<thead><tr style="background:${thColor}"><th style="width:36px;color:#4B3D33;font-family:'Manrope',sans-serif">#</th>`;
  columns.forEach(col=>{
    const sc = sortCol===col?'sort-'+sortDir:'';
    thead+=`<th class="${sc}" data-col="${escHtml(col)}" style="color:#4B3D33;font-family:'Manrope',sans-serif">${COL_LABELS[col]||escHtml(col)}<span class="sort-icon"></span></th>`;
  });
  thead+='</tr></thead>';
  let tbody='<tbody>';
  pageRows.forEach((row,i)=>{
    tbody+='<tr>';
    tbody+=`<td style="font-family:'Work Sans','Noto Sans Thai Looped',sans-serif;font-size:12px;color:#C9BEAF">${start+i+1}</td>`;
    columns.forEach(col=>{
      const val: unknown = row[col];
      tbody+=`<td>${(val===null||val===undefined||val===''||val==='—')?'<span style="color:#C9BEAF">—</span>':escHtml(String(val))}</td>`;
    });
    tbody+='</tr>';
  });
  tbody+='</tbody>';

  (document.getElementById('tableContent') as HTMLElement).innerHTML =
    rowList + `<div style="overflow-x:auto"><table class="dt-table">${thead}${tbody}</table></div>`;

  /* Pagination */
  paginationBarEl.style.display = 'flex';
  const shownEnd = showAll?filtered.length:Math.min(start+PAGE_SIZE,filtered.length);
  (document.getElementById('pageInfo') as HTMLElement).innerHTML =
    `<strong>${showAll?1:start+1}–${shownEnd}</strong> จาก <strong>${filtered.length}</strong>`;

  const btnsEl = document.getElementById('pageBtns') as HTMLElement;
  btnsEl.innerHTML='';

  const allBtn = document.createElement('button');
  allBtn.className='pag-btn-all';
  if (showAll) {
    allBtn.style.background = thColor;
    allBtn.style.borderColor = thColor;
    allBtn.style.color = '#4B3D33';
  }
  allBtn.innerHTML=`<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>ทั้งหมด`;
  allBtn.onclick=()=>{ showAll=!showAll;currentPage=1;renderTable();(document.getElementById('tableCard') as HTMLElement).scrollIntoView({behavior:'smooth',block:'start'}); };
  btnsEl.appendChild(allBtn);

  if(!showAll){
    const sep=document.createElement('div'); sep.className='pag-sep'; btnsEl.appendChild(sep);
    const mk=(label: string | number, page: number, active: boolean, disabled: boolean): void =>{
      const b=document.createElement('button');
      b.className='pag-btn';
      if (active) {
        b.style.background = thColor;
        b.style.borderColor = thColor;
        b.style.color = '#4B3D33';
      }
      b.disabled=disabled; b.textContent=String(label);
      b.onclick=()=>{ currentPage=page;renderTable();(document.getElementById('tableCard') as HTMLElement).scrollIntoView({behavior:'smooth',block:'start'}); };
      btnsEl.appendChild(b);
    };
    mk('‹',currentPage-1,false,currentPage===1);
    (isMobile()?pageRangeMobile(currentPage,totalPages):pageRange(currentPage,totalPages)).forEach(p=>{
      if(p==='…'){const s=document.createElement('button');s.className='pag-btn';s.disabled=true;s.textContent='…';btnsEl.appendChild(s);}
      else mk(p,p,p===currentPage,false);
    });
    mk('›',currentPage+1,false,currentPage===totalPages);
  }
}

function setLoading(msg: string): void {
  (document.getElementById('tableContent') as HTMLElement).innerHTML=`
    <div class="state-box">
      <svg viewBox="0 0 24 24" style="fill:none;stroke:#a1a1aa;stroke-width:2;animation:spin 1s linear infinite">
        <path d="M12 2a10 10 0 0 1 10 10"/>
      </svg>
      <div class="state-title">${msg}</div>
    </div>`;
}
function setEmpty(): void {
  (document.getElementById('tableContent') as HTMLElement).innerHTML=`
    <div class="state-box">
      <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z"/></svg>
      <div class="state-title">ไม่พบข้อมูล</div>
      <div class="state-sub">ลองเปลี่ยนคำค้นหา</div>
    </div>`;
}
function setError(msg: string): void {
  (document.getElementById('tableContent') as HTMLElement).innerHTML=`
    <div class="state-box">
      <svg viewBox="0 0 24 24" style="fill:#fca5a5"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
      <div class="state-title">โหลดข้อมูลไม่ได้</div>
      <div class="state-sub">${escHtml(msg)}</div>
    </div>`;
}

type PageToken = number | '…';

function pageRange(c: number,t: number): PageToken[] {
  if(t<=7)return Array.from({length:t},(_,i)=>i+1);
  if(c<=4)return[1,2,3,4,5,'…',t];
  if(c>=t-3){
    const arr: PageToken[] = [1,'…',t-4,t-3,t-2,t-1,t];
    return arr.filter(p=>p==='…'||p>=1);
  }
  return[1,'…',c-1,c,c+1,'…',t];
}
function pageRangeMobile(c: number,t: number): PageToken[] {
  if(t<=5)return Array.from({length:t},(_,i)=>i+1);
  if(c<=2)return[1,2,3,'…',t];
  if(c>=t-1)return[1,'…',t-2,t-1,t];
  return[1,'…',c,'…',t];
}
const escHtml = P4P.escHtml;

/* desktop block */
const _db = document.getElementById('desktop-block') as HTMLElement;
if (!/Line\//i.test(navigator.userAgent)) {
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    _db.querySelector('h2')!.textContent = 'กรุณาเปิดผ่าน LINE application';
    _db.querySelector('p')!.textContent  = 'ขอบคุณสำหรับความร่วมมือ';
  }
  _db.style.display = 'flex';
}

/* back to top */
const btt=document.getElementById('backToTop') as HTMLElement;
window.addEventListener('scroll',()=>btt.classList.toggle('visible',window.scrollY>200),{passive:true});
btt.addEventListener('click',()=>window.scrollTo({top:0,behavior:'smooth'}));

/* ── Event wiring (replaces inline on* handlers so a strict CSP works) ── */
(document.getElementById('monthSelect') as HTMLSelectElement).addEventListener('change', loadData);
(document.getElementById('searchInput') as HTMLInputElement).addEventListener('input', filterAndRender);
// Sort headers are re-rendered into #tableContent, so delegate the click.
(document.getElementById('tableContent') as HTMLElement).addEventListener('click', (e) => {
  const th = (e.target as HTMLElement).closest('th[data-col]') as HTMLElement | null;
  if (th) handleSort(th.dataset.col as keyof ListRow);
});
})();
