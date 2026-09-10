;(function () {
    "use strict"

    // ── Mobile-only gate ─────────────────────────────────────────────────
    const desktopBlock = document.getElementById("desktop-block")
    if (!/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        desktopBlock.style.display = "flex"
        return
    }

    // ── DOM refs ─────────────────────────────────────────────────────────
    const load          = document.getElementById("load")
    const unauthorized  = document.getElementById("unauthorized")
    const appEl         = document.getElementById("app")
    const logoutBtn     = document.getElementById("logout-btn")
    const requestsBtn   = document.getElementById("requests-btn")
    const requestsBadge = document.getElementById("requests-badge")
    const requestsPanel = document.getElementById("requests-panel")
    const requestsList  = document.getElementById("requests-list")
    const requestsEmpty = document.getElementById("requests-empty")
    const tableSelect   = document.getElementById("table_select")
    const searchInput   = document.getElementById("search_input")
    const deptFilter    = document.getElementById("dept_filter")
    const addBtn        = document.getElementById("add-btn")
    const addOverlay    = document.getElementById("add-overlay")
    const rowCount      = document.getElementById("row-count")
    const rowsEl        = document.getElementById("rows")
    const newRowCard    = document.getElementById("new-row-card")
    const statusMsg     = document.getElementById("status_msg")
    const emptyState    = document.getElementById("empty-state")

    let columns = []      // [{column_name, data_type, is_pk}]
    let currentTable = null
    let allRows = []       // every row currently loaded for currentTable

    // ── Canonical department list — mirrors status/app.js's dep_array so
    // the admin dropdown and filter use the exact same Thai-dictionary
    // order (INTERN forced last), instead of a second, possibly-drifting
    // copy of that ordering. ──────────────────────────────────────────────
    const dep_array = ["กุมารเวชกรรม", "จักษุวิทยา", "จิตเวชและยาเสพติด", "เทคนิคการแพทย์และพยาธิวิทยาคลินิก", "นิติเวช", "ผู้ป่วยนอก", "พยาธิวิทยากายวิภาค", "รังสีวิทยา", "วิสัญญีวิทยา", "เวชกรรมฟื้นฟู", "เวชกรรมสังคม", "เวชศาสตร์ฉุกเฉิน", "ศัลยกรรม", "ศัลยกรรมออร์โธปิดิกส์", "สูติ-นรีเวชกรรม", "โสต ศอ นาสิก", "อาชีวเวชกรรม", "อายุรกรรม", "INTERN"]
    const sortDeps = (list) => [...list].sort((a, b) => {
        const ia = dep_array.indexOf(a)
        const ib = dep_array.indexOf(b)
        if (ia === -1 && ib === -1) return a.localeCompare(b, "th")
        if (ia === -1) return 1
        if (ib === -1) return -1
        return ia - ib
    })

    // ── Helpers ──────────────────────────────────────────────────────────
    function escHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;")
    }

    function showStatus(text, isError) {
        statusMsg.textContent = text
        statusMsg.className = isError ? "error" : "ok"
        if (text) setTimeout(() => { statusMsg.className = "hidden" }, 3500)
        else statusMsg.className = "hidden"
    }

    async function api(path, opts) {
        const resp = await fetch(path, Object.assign({ credentials: "same-origin" }, opts))
        if (resp.status === 401) {
            appEl.classList.add("hidden")
            unauthorized.classList.remove("hidden")
            throw new Error("unauthorized")
        }
        const body = await resp.json().catch(() => ({}))
        if (!resp.ok) throw new Error(body.error || ("request failed: " + resp.status))
        return body
    }

    // Current Thai-calendar (Buddhist year) YYYY_MM, same arithmetic as
    // main.js's createStatusSublist (Gregorian year + 543).
    function currentRosterTableName() {
        const now = new Date()
        const year = now.getFullYear() + 543
        const month = String(now.getMonth() + 1).padStart(2, "0")
        return year + "_" + month
    }

    function isTimestampType(dataType) {
        return /timestamp/i.test(dataType || "")
    }
    function isNumericType(dataType) {
        return /double precision|numeric|integer|real|bigint/i.test(dataType || "")
    }

    // Editable columns only (skip the uuid PK, e.g. "index").
    function editableColumns() {
        return columns.filter((c) => !c.is_pk)
    }

    // Thai prefixes attach directly to the first name (no space), e.g.
    // "นพ.สมชาย ใจดี" — matches the convention used elsewhere in this
    // codebase (see verify/app.js's full-name trim(coalesce(...))).
    function fullName(row) {
        const head = ((row.prefix || "") + (row.firstname || "")).trim()
        return (head + " " + (row.lastname || "")).trim().replace(/\s+/g, " ")
    }

    // Sort key WITHOUT the prefix — sorting on fullName() would group
    // everyone by นพ./พญ. first (a Thai collator has no way to know
    // "นพ."/"พญ." is a title rather than part of the name), scattering an
    // otherwise-alphabetical roster into two title-shaped halves. Dropping
    // the prefix here sorts strictly by given name, matching what "sort by
    // name" actually means to someone scanning the list for a person.
    function sortName(row) {
        return ((row.firstname || "") + " " + (row.lastname || "")).trim().replace(/\s+/g, " ")
    }

    function inputTypeFor(col) {
        if (isTimestampType(col.data_type)) return "datetime-local"
        if (isNumericType(col.data_type)) return "number"
        return "text"
    }

    // "2026-08-08T10:00:00+00:00" -> "2026-08-08T10:00" (for <input datetime-local>)
    function toLocalInputValue(iso) {
        if (!iso) return ""
        const d = new Date(iso)
        if (isNaN(d.getTime())) return ""
        const pad = (n) => String(n).padStart(2, "0")
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
            "T" + pad(d.getHours()) + ":" + pad(d.getMinutes())
    }

    // ── Access requests ──────────────────────────────────────────────────
    // Approving/rejecting here replaces the old Telegram inline-button flow
    // (a bearer token in callback_data, replayable by anyone in that chat —
    // see SECURITY_ANALYSIS.md §2c): the write now happens through this
    // already-authenticated dashboard session, server-side with the
    // service-role key, same as every roster edit above.
    let requestsPanelOpen = false

    function renderRequestCard(reqRow) {
        const card = document.createElement("div")
        card.className = "row-card"
        card.innerHTML =
            '<div class="row-card-head" style="cursor:default;">' +
            '<div style="flex:1;min-width:0;">' +
            '<div class="row-card-name">' + escHtml(reqRow.name || "(ไม่ระบุชื่อ)") + "</div>" +
            '<div class="req-email">' + escHtml(reqRow.email) + "</div>" +
            "</div>" +
            (reqRow.department ? '<div class="dept-badge">' + escHtml(reqRow.department) + "</div>" : "") +
            "</div>" +
            '<div class="row-card-body" style="display:block;">' +
            '<div class="row-actions">' +
            '<button type="button" class="row-btn btn-reject">ปฏิเสธ</button>' +
            '<button type="button" class="row-btn btn-approve">อนุมัติ</button>' +
            "</div></div>"

        card.querySelector(".btn-approve").addEventListener("click", async () => {
            try {
                await api("/admin/api/access-requests/" + encodeURIComponent(reqRow.email) + "/approve", { method: "POST" })
                showStatus("อนุมัติแล้ว: " + reqRow.email, false)
                await loadAccessRequests()
            } catch (e) {
                showStatus("อนุมัติไม่สำเร็จ: " + e.message, true)
            }
        })
        card.querySelector(".btn-reject").addEventListener("click", async () => {
            if (!confirm("ปฏิเสธคำขอของ " + (reqRow.name || reqRow.email) + "?")) return
            try {
                await api("/admin/api/access-requests/" + encodeURIComponent(reqRow.email) + "/reject", { method: "POST" })
                showStatus("ปฏิเสธแล้ว", false)
                await loadAccessRequests()
            } catch (e) {
                showStatus("ปฏิเสธไม่สำเร็จ: " + e.message, true)
            }
        })
        return card
    }

    async function loadAccessRequests() {
        try {
            const { requests } = await api("/admin/api/access-requests")
            requestsList.innerHTML = ""
            for (const r of requests) requestsList.appendChild(renderRequestCard(r))
            requestsEmpty.classList.toggle("hidden", requests.length > 0)
            if (requests.length > 0) {
                requestsBadge.textContent = String(requests.length)
                requestsBadge.classList.remove("hidden")
            } else {
                requestsBadge.classList.add("hidden")
            }
        } catch (e) {
            if (e.message !== "unauthorized") console.error("loadAccessRequests failed:", e.message)
        }
    }

    requestsBtn.addEventListener("click", () => {
        requestsPanelOpen = !requestsPanelOpen
        requestsPanel.classList.toggle("hidden", !requestsPanelOpen)
    })

    // ── Table select ─────────────────────────────────────────────────────
    async function loadTables() {
        const { tables } = await api("/admin/api/tables")
        // API returns ascending (YYYY_MM order); show newest month first.
        const sorted = [...tables].sort().reverse()
        tableSelect.innerHTML = ""
        for (const t of sorted) {
            const opt = document.createElement("option")
            opt.value = t
            opt.textContent = t
            tableSelect.appendChild(opt)
        }
        const preferred = currentRosterTableName()
        tableSelect.value = sorted.includes(preferred) ? preferred : (sorted[0] || "")
        return tableSelect.value
    }

    // ── Department filter dropdown ──────────────────────────────────────
    function populateDeptFilter() {
        const present = sortDeps([...new Set(allRows.map((r) => r.department).filter(Boolean))])
        const current = deptFilter.value
        deptFilter.innerHTML = '<option value="">ทุกกลุ่มงาน</option>'
        for (const d of present) {
            const opt = document.createElement("option")
            opt.value = d
            opt.textContent = d === "INTERN" ? "INTERN" : "กลุ่มงาน" + d
            deptFilter.appendChild(opt)
        }
        if (present.includes(current)) deptFilter.value = current
    }

    // ── Field rendering ──────────────────────────────────────────────────
    function fieldLineHtml(col, value, editing) {
        const label = escHtml(col.column_name)
        if (!editing) {
            let display = value
            if (isTimestampType(col.data_type) && value) {
                const d = new Date(value)
                display = isNaN(d.getTime()) ? value : d.toLocaleString("th-TH")
            }
            return '<div class="field-line"><div class="field-label">' + label + '</div>' +
                '<div class="field-value">' + (display == null || display === "" ? "<span style=\"color:var(--border)\">—</span>" : escHtml(display)) + "</div></div>"
        }
        // Department switches from free text to a dropdown so the admin can
        // only assign a valid, canonically-spelled department. If the
        // current value isn't in the canonical list (a legacy/typo'd
        // value), keep it as the first option so saving without touching
        // this field doesn't silently overwrite it.
        if (col.column_name === "department") {
            const options = value && !dep_array.includes(value) ? [value, ...dep_array] : dep_array
            const opts = options.map((d) =>
                '<option value="' + escHtml(d) + '"' + (d === value ? " selected" : "") + '>' +
                escHtml(d === "INTERN" ? "INTERN" : d) + "</option>"
            ).join("")
            return '<div class="field-line"><div class="field-label">' + label + '</div>' +
                '<select data-col="department"><option value="">—</option>' + opts + "</select></div>"
        }
        const type = inputTypeFor(col)
        let inputValue = type === "datetime-local" ? toLocalInputValue(value) : (value == null ? "" : value)
        // Almost every row is "นายแพทย์" — autofill it when the field is
        // blank so the admin isn't retyping the same value on every add/
        // edit; still just a normal editable value, not a fixed default.
        if (col.column_name === "position" && !inputValue) inputValue = "นายแพทย์"
        return '<div class="field-line"><div class="field-label">' + label + '</div>' +
            '<input data-col="' + escHtml(col.column_name) + '" type="' + type + '" ' +
            (type === "number" ? 'step="any" ' : "") +
            'value="' + escHtml(inputValue) + '"></div>'
    }

    function collectInputValues(card) {
        const out = {}
        card.querySelectorAll("[data-col]").forEach((input) => {
            const col = columns.find((c) => c.column_name === input.dataset.col)
            let v = input.value
            if (v === "") { out[input.dataset.col] = null; return }
            if (col && isNumericType(col.data_type)) v = Number(v)
            if (col && isTimestampType(col.data_type)) v = new Date(v).toISOString()
            out[input.dataset.col] = v
        })
        return out
    }

    // ── Row cards ────────────────────────────────────────────────────────
    // Cards default to collapsed (name + department badge only) — a full
    // ~200-row roster is unwieldy with every field always visible. Tapping
    // the header expands to a read-only field list with edit/delete
    // actions; edit mode is only reachable from there.
    function renderRowCard(row) {
        const card = document.createElement("div")
        card.className = "row-card"
        const pk = columns.find((c) => c.is_pk)
        const pkValue = pk ? row[pk.column_name] : null

        const head = document.createElement("div")
        head.className = "row-card-head"
        head.innerHTML =
            '<div class="row-card-name">' + escHtml(fullName(row) || "(ไม่มีชื่อ)") + "</div>" +
            (row.department ? '<div class="dept-badge">' + escHtml(row.department) + "</div>" : "") +
            '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
        head.addEventListener("click", () => card.classList.toggle("expanded"))

        const body = document.createElement("div")
        body.className = "row-card-body"

        function renderView() {
            body.innerHTML = editableColumns().map((c) => fieldLineHtml(c, row[c.column_name], false)).join("") +
                '<div class="row-actions">' +
                '<button type="button" class="row-btn btn-delete">ลบ</button>' +
                '<button type="button" class="row-btn btn-edit">แก้ไข</button>' +
                "</div>"
            body.querySelector(".btn-edit").addEventListener("click", () => {
                openEditForm(row, pkValue, head)
            })
            body.querySelector(".btn-delete").addEventListener("click", async () => {
                if (!confirm("ยืนยันการลบ " + fullName(row) + "?")) return
                try {
                    await api("/admin/api/tables/" + encodeURIComponent(currentTable) + "/rows/" + encodeURIComponent(pkValue), { method: "DELETE" })
                    allRows = allRows.filter((r) => r !== row)
                    renderList()
                    showStatus("ลบแล้ว", false)
                } catch (e) {
                    showStatus("ลบไม่สำเร็จ: " + e.message, true)
                }
            })
        }

        renderView()
        card.appendChild(head)
        card.appendChild(body)
        return card
    }

    // ── Filter + sort + render pipeline ─────────────────────────────────
    // Single source of truth: allRows. Every mutation (insert/update/
    // delete) updates allRows then calls this — search, department filter
    // and Thai-collated name sort all recompute from scratch each time, so
    // the list is always self-consistent without a network refetch.
    function renderList() {
        const q = searchInput.value.trim().toLowerCase()
        const dept = deptFilter.value

        let visible = allRows.filter((row) => {
            if (dept && row.department !== dept) return false
            if (!q) return true
            const haystack = (fullName(row) + " " + (row.department || "")).toLowerCase()
            return haystack.includes(q)
        })

        // Thai-dictionary-correct sort (same technique as status/app.js's
        // localeCompare(..., "th") — raw codepoint order gets Thai vowel/
        // tone-mark placement wrong).
        visible.sort((a, b) => sortName(a).localeCompare(sortName(b), "th"))

        rowsEl.innerHTML = ""
        for (const row of visible) rowsEl.appendChild(renderRowCard(row))
        rowCount.textContent = visible.length + " จาก " + allRows.length + " แถว"
        emptyState.classList.toggle("hidden", visible.length > 0)
    }

    async function loadRowsAndColumns(table) {
        rowsEl.innerHTML = ""
        closeAddForm()
        load.style.display = "block"
        try {
            const [{ columns: cols }, { rows }] = await Promise.all([
                api("/admin/api/tables/" + encodeURIComponent(table) + "/columns"),
                api("/admin/api/tables/" + encodeURIComponent(table) + "/rows"),
            ])
            columns = cols
            allRows = rows
            searchInput.value = ""
            populateDeptFilter()
            renderList()
        } catch (e) {
            if (e.message !== "unauthorized") showStatus("โหลดข้อมูลไม่สำเร็จ: " + e.message, true)
        } finally {
            load.style.display = "none"
        }
    }

    // ── Add / edit row ───────────────────────────────────────────────────
    // Both add and edit share one fixed overlay (FAB to open the add form,
    // "แก้ไข" on a row to open the edit form; tap the backdrop or ยกเลิก to
    // close either) instead of appearing inline, so opening either one never
    // shifts whatever row the admin was already looking at.
    function closeAddForm() {
        addOverlay.classList.add("hidden")
        newRowCard.innerHTML = ""
        addBtn.classList.remove("hidden")
    }

    // sourceRow: values to prefill from (null for a blank add form).
    // onSave(values): performs the API call and applies the result to local
    // state; throwing leaves the form open and shows the error.
    function openFormOverlay(sourceRow, saveLabel, onSave) {
        addBtn.classList.add("hidden")
        addOverlay.classList.remove("hidden")
        newRowCard.innerHTML = editableColumns().map((c) => fieldLineHtml(c, sourceRow ? sourceRow[c.column_name] : null, true)).join("") +
            '<div class="row-actions">' +
            '<button type="button" class="row-btn btn-cancel">ยกเลิก</button>' +
            '<button type="button" class="row-btn btn-save">' + escHtml(saveLabel) + '</button>' +
            "</div>"
        newRowCard.querySelector(".btn-cancel").addEventListener("click", closeAddForm)
        newRowCard.querySelector(".btn-save").addEventListener("click", async () => {
            const values = collectInputValues(newRowCard)
            try {
                await onSave(values)
                closeAddForm()
            } catch (e) {
                showStatus("บันทึกไม่สำเร็จ: " + e.message, true)
            }
        })
    }

    function openAddForm() {
        openFormOverlay(null, "เพิ่ม", async (values) => {
            const { row } = await api(
                "/admin/api/tables/" + encodeURIComponent(currentTable) + "/rows",
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) }
            )
            if (row) {
                allRows.push(row)
                populateDeptFilter()
                renderList()
            }
            showStatus("เพิ่มแถวแล้ว", false)
        })
    }

    function openEditForm(row, pkValue, head) {
        openFormOverlay(row, "บันทึก", async (values) => {
            const { row: updated } = await api(
                "/admin/api/tables/" + encodeURIComponent(currentTable) + "/rows/" + encodeURIComponent(pkValue),
                { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) }
            )
            Object.assign(row, updated || values)
            head.querySelector(".row-card-name").textContent = fullName(row) || "(ไม่มีชื่อ)"
            const badge = head.querySelector(".dept-badge")
            if (row.department) {
                if (badge) badge.textContent = row.department
                else head.insertBefore(Object.assign(document.createElement("div"), { className: "dept-badge", textContent: row.department }), head.querySelector(".chevron"))
            } else if (badge) {
                badge.remove()
            }
            populateDeptFilter()
            showStatus("บันทึกแล้ว", false)
        })
    }

    addBtn.addEventListener("click", openAddForm)
    // Only a click on the backdrop itself (not a descendant) closes the form.
    addOverlay.addEventListener("click", (e) => {
        if (e.target === addOverlay) closeAddForm()
    })

    tableSelect.addEventListener("change", () => {
        currentTable = tableSelect.value
        loadRowsAndColumns(currentTable)
    })
    searchInput.addEventListener("input", renderList)
    deptFilter.addEventListener("change", renderList)

    logoutBtn.addEventListener("click", async () => {
        await fetch("/admin/logout", { method: "POST", credentials: "same-origin" }).catch(() => {})
        location.reload()
    })

    // ── Boot ─────────────────────────────────────────────────────────────
    ;(async function main() {
        // Show the app shell (header/filter-bar/content) up front so the
        // loading spinner — now inside #content, not floating above
        // everything — has somewhere to render while the auth check is in
        // flight. If it turns out we're not authenticated, api()'s 401
        // handler hides #app and shows #unauthorized instead.
        appEl.classList.remove("hidden")
        load.style.display = "block"
        try {
            currentTable = await loadTables()
            unauthorized.classList.add("hidden")
            if (currentTable) await loadRowsAndColumns(currentTable)
            await loadAccessRequests()
        } catch (e) {
            if (e.message !== "unauthorized") showStatus("โหลดไม่สำเร็จ: " + e.message, true)
        } finally {
            load.style.display = "none"
        }
    })()
})()
