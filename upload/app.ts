/** GENERATED FILE'S SOURCE — this file is compiled to upload/app.js by
 * `npm run build:browser` (see tsconfig.browser.json). Edit this file, not
 * the .js twin, which is a build artifact served byte-for-byte by
 * express.static() and must not be hand-edited. */
/**
 * upload/app.js — submit a monthly P4P scorecard from the LINE rich menu.
 *
 * See UPLOAD_VIA_LINE_DESIGN.md. The shape of this page, in one paragraph:
 * the bytes never touch our server — the browser PUTs them straight into
 * Supabase Storage under a path pinned to its own auth.uid(), then calls
 * enqueue_p4p_upload() (which resolves identity from the JWT, never from
 * anything this file sends) and finally POSTs the returned queue id to
 * /upload/score, which scores the common case synchronously and answers with
 * a number. Everything identifying is server-derived; this page chooses only
 * a month and a file.
 */
;(function () {
  "use strict"

  // ── LINE-only guard (design §5.5 gap 3) ─────────────────────────────────
  // Uploading works fine in any browser, but the receipt does not: it goes
  // out through liff.sendMessages(), which needs a LIFF app launched from a
  // chat. Rather than let a desktop visitor submit and then silently never
  // hear back, stop here — the same block the other pages show.
  var desktopBlock = document.getElementById("desktop-block") as HTMLElement
  if (!/Line\//i.test(navigator.userAgent)) {
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      desktopBlock.querySelector("h2")!.textContent = "กรุณาเปิดผ่าน LINE application"
      desktopBlock.querySelector("p")!.textContent = "ขอบคุณสำหรับความร่วมมือ"
    }
    desktopBlock.style.display = "flex"
    return
  }

  var P4P = window.P4P
  var db = P4P.db as SupabaseClientLike
  var esc = P4P.escHtml
  var receipt = P4P.receipt as FlexReceiptModule

  var BUCKET = "p4p-uploads"

  // LIFF often nests an already percent-encoded querystring inside
  // liff.state (e.g. "?liff.state=%3Fprobe%3D1"), so reading
  // location.search directly finds nothing — status/app.js documents the
  // same trap. A stray "%" that isn't a valid escape makes
  // decodeURIComponent throw URIError, and this runs at top level, so the
  // decode is guarded: a page that can't read its own query string should
  // still load.
  var queryString: string
  try {
    queryString = decodeURIComponent(location.search).replace("?liff.state=", "")
  } catch (e) {
    console.warn("Failed to decode location.search:", e)
    queryString = location.search.replace("?liff.state=", "")
  }
  var PROBE = new URLSearchParams(queryString).get("probe") === "1"

  // The access token the server injected (assets/auth-guard.js already used
  // it to build P4P.db; we need the raw one for Storage's REST endpoint and
  // for the `sub` claim, which is the folder every object must live under).
  var meta = document.querySelector('meta[name="p4p-session"]')
  var ACCESS_TOKEN = meta ? meta.getAttribute("content") || "" : ""
  var liffMeta = document.querySelector('meta[name="p4p-upload-liff"]')
  var LIFF_ID = liffMeta ? (liffMeta.getAttribute("content") || "").trim() : ""

  function jwtClaim(token: string, key: string): any {
    try {
      var b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")
      return JSON.parse(decodeURIComponent(escape(atob(b64))))[key] || null
    } catch { return null }
  }
  var UID = jwtClaim(ACCESS_TOKEN, "sub")

  // ── DOM ──────────────────────────────────────────────────────────────────
  var identityEl = document.getElementById("identity") as HTMLElement
  var rosterNotice = document.getElementById("roster-notice") as HTMLElement
  var monthsEl = document.getElementById("months") as HTMLElement
  var deadlineNotice = document.getElementById("deadline-notice") as HTMLElement
  var fileInput = document.getElementById("file-input") as HTMLInputElement
  var fileButton = document.getElementById("file-button") as HTMLElement
  var fileNameEl = document.getElementById("file-name") as HTMLElement
  var fileErrorEl = document.getElementById("file-error") as HTMLElement
  var stepConfirm = document.getElementById("step-confirm") as HTMLElement
  var confirmLine = document.getElementById("confirm-line") as HTMLElement
  var submitButton = document.getElementById("submit-button") as HTMLButtonElement
  var stepUploading = document.getElementById("step-uploading") as HTMLElement
  var progressBar = document.getElementById("progress-bar") as HTMLElement
  var progressLabel = document.getElementById("progress-label") as HTMLElement
  var stepResult = document.getElementById("step-result") as HTMLElement
  var resultTitle = document.getElementById("result-title") as HTMLElement
  var resultBody = document.getElementById("result-body") as HTMLElement
  var againButton = document.getElementById("again-button") as HTMLElement
  var historyList = document.getElementById("history-list") as HTMLElement
  var historyEmpty = document.getElementById("history-empty") as HTMLElement

  // Loose shape of my_p4p_identity()'s result — a real Supabase row, so kept
  // as a bag of fields rather than an exhaustive contract (see admin/app.ts's
  // RowRecord for the same reasoning).
  interface UploadIdentity {
    full_name?: string | null
    department?: string | null
    in_roster?: boolean
    [key: string]: unknown
  }

  // Loose shape of the JSON /upload/score answers with — both the success
  // and the rejection/pending shapes in one type, since call sites narrow by
  // checking individual fields exactly like the original did.
  interface UploadScorePayload {
    error?: string
    detail?: string
    pending?: boolean
    score?: unknown
    is_late?: boolean
    display_name?: string | null
    department?: string | null
    display_date?: string
    month_key?: string
    received_at?: string
  }

  // ── State ────────────────────────────────────────────────────────────────
  var MONTHS = P4P.recentMonthKeys(6)
  // Default to the PREVIOUS month: the month people are actually submitting
  // for. MONTHS[0] is the current (usually still in progress) one.
  var selectedMonth = MONTHS[1] || MONTHS[0]
  var identity: UploadIdentity | null = null
  var pickedFile: File | null = null

  function show(el: HTMLElement): void { el.classList.remove("hidden") }
  function hide(el: HTMLElement): void { el.classList.add("hidden") }

  // ── LIFF ─────────────────────────────────────────────────────────────────
  // Everything LIFF gives us here is an enhancement: the chat receipt and the
  // opportunistic LINE bind. A failed init must never stop a physician from
  // submitting, so it resolves false instead of throwing.
  var liffReady: Promise<boolean> = LIFF_ID
    ? liff.init({ liffId: LIFF_ID }).then(function () { return true }).catch(function (err) {
        console.warn("liff.init failed:", err)
        return false
      })
    : Promise.resolve(false)

  /**
   * Gap 1 (design §5.5): a physician who only ever logged in by OTP has no
   * line_user_id, so the deferred tier's chat notification has nowhere to go.
   * The binding machinery already exists — supabase/functions/line-verify's
   * mode:"bind" takes exactly this pair — so bind on boot, best-effort. No
   * openid scope → getIDToken() returns null → this silently no-ops, which is
   * the correct degradation.
   */
  function bindLineAccount() {
    return liffReady.then(function (ok) {
      if (!ok || !liff.isLoggedIn() || !ACCESS_TOKEN) return
      var idToken: string | null = null
      try { idToken = liff.getIDToken() } catch { idToken = null }
      if (!idToken) return
      return fetch(P4P.SUPABASE_URL + "/functions/v1/line-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: P4P.SUPABASE_KEY },
        body: JSON.stringify({ mode: "bind", access_token: ACCESS_TOKEN, id_token: idToken }),
      }).catch(function (err) { console.warn("line bind skipped:", err) })
    }).catch(function () { /* never blocks the upload */ })
  }

  /** Send message objects into the chat AS THE PHYSICIAN — free, not a push. */
  function sendToChat(messages: unknown[]): Promise<boolean> {
    return liffReady.then(function (ok) {
      if (!ok || !liff.isInClient()) return false
      return liff.sendMessages(messages).then(function () { return true })
    }).catch(function (err) {
      console.warn("liff.sendMessages failed:", err)
      return false
    })
  }

  // ── Identity + month chips ───────────────────────────────────────────────
  function renderIdentity(): void {
    if (!identity) return
    identityEl.classList.remove("skeleton")
    var name = identity.full_name || "-"
    var dept = identity.department ? " — " + identity.department : ""
    identityEl.innerHTML = "<strong>" + esc(name) + "</strong>" + esc(dept)

    // in_roster:false is ADVISORY, never a block (design §5.5 gap 2): the
    // usual cause is a spelling difference between `physicians` and the
    // roster, which the worker's fuzzy matcher resolves later. Blocking here
    // would lock out exactly the physicians who most need to submit.
    if (identity.in_roster === false) {
      rosterNotice.className = "notice warn"
      rosterNotice.textContent = "ไม่พบชื่อท่านในรายชื่อเดือนนี้ — ส่งได้ตามปกติ ระบบจะจับคู่ให้ภายหลัง หากคิดว่าไม่ถูกต้อง กรุณาติดต่อผู้ดูแล"
      show(rosterNotice)
    } else {
      hide(rosterNotice)
    }
  }

  function renderDeadline(): void {
    var late = P4P.isLateFor(selectedMonth)
    deadlineNotice.className = "notice " + (late ? "warn" : "info")
    deadlineNotice.textContent = late
      ? "เลยกำหนดส่งของเดือนนี้แล้ว (" + P4P.deadlineDisplay(selectedMonth) + ") — ระบบยังบันทึกคะแนนให้ตามปกติ แต่การจัดอันดับจะนับว่าส่งช้า"
      : "กำหนดส่ง " + P4P.deadlineDueDisplay(selectedMonth)
  }

  function renderMonths(submittedByMonth: Record<string, string>): void {
    monthsEl.innerHTML = ""
    MONTHS.forEach(function (key) {
      var monthIdx = parseInt(key.split("_")[1], 10) - 1
      var accent = (P4P.COLOR_ARRAY[monthIdx] || [])[1] || "#ccc"
      var btn = document.createElement("button")
      btn.type = "button"
      btn.className = "chip"
      btn.setAttribute("aria-pressed", key === selectedMonth ? "true" : "false")
      btn.dataset.month = key

      var submitted = submittedByMonth && submittedByMonth[key]
      btn.innerHTML =
        '<span class="m-name"><span class="m-dot" style="background:' + esc(accent) + '"></span>' +
        esc(P4P.monthKeyDisplay(key)) + "</span>" +
        '<span class="m-sub">' +
        (submitted ? "ส่งแล้ว " + esc(P4P.shortDate(submitted)) : esc(P4P.deadlineDueDisplay(key))) +
        "</span>"

      btn.addEventListener("click", function () {
        if (selectedMonth === key) return
        selectedMonth = key
        // Array.from(...).forEach(...) rather than Array.prototype.forEach.call
        // (what this originally called) — identical iteration order and
        // side effects, just typed cleanly against a NodeList without
        // widening strictBindCallApply's `this` check to `any`.
        Array.from(monthsEl.querySelectorAll(".chip")).forEach(function (c) {
          var el = c as HTMLElement
          el.setAttribute("aria-pressed", el.dataset.month === key ? "true" : "false")
        })
        renderDeadline()
        renderConfirm()
        loadIdentity()
      })
      monthsEl.appendChild(btn)
    })
  }

  // Each chip shows this physician's own submitted_at for that month, which
  // my_p4p_identity() returns per month — six calls, all tiny, run in
  // parallel so the chips fill in together rather than one at a time.
  function loadMonthSubmissions(): Promise<void> {
    return Promise.all(MONTHS.map(function (key) {
      return db.rpc("my_p4p_identity", { p_month: key }).then(function (r) {
        return [key, r.data && r.data.submitted_at] as [string, string | null]
      }).catch(function () { return [key, null] as [string, string | null] })
    })).then(function (pairs) {
      var map: Record<string, string> = {}
      pairs.forEach(function (p) { if (p[1]) map[p[0]] = p[1] })
      renderMonths(map)
    })
  }

  function loadIdentity(): Promise<void> {
    return db.rpc("my_p4p_identity", { p_month: selectedMonth }).then(function (r) {
      if (r.error) throw r.error
      identity = r.data || null
      renderIdentity()
      renderConfirm()
    }).catch(function (err) {
      console.warn("my_p4p_identity failed:", err)
      identityEl.classList.remove("skeleton")
      identityEl.textContent = "ไม่สามารถโหลดข้อมูลผู้ใช้ได้"
    })
  }

  // ── File picking ─────────────────────────────────────────────────────────
  fileButton.addEventListener("click", function () { fileInput.click() })

  fileInput.addEventListener("change", function () {
    var file = fileInput.files && fileInput.files[0]
    hide(fileErrorEl)
    pickedFile = null
    hide(stepConfirm)
    hide(fileNameEl)
    if (!file) return

    var check = P4P.validateUploadFile(file)
    if (!check.ok) {
      fileErrorEl.textContent = check.message || ""
      show(fileErrorEl)
      return
    }

    P4P.checkMagicBytes(file).then(function (looksLikeXlsx) {
      if (!looksLikeXlsx) {
        fileErrorEl.textContent = "ไฟล์นี้ไม่ใช่ไฟล์ Excel (.xlsx) จริง — อาจถูกเปลี่ยนนามสกุลไฟล์ กรุณาบันทึกใหม่เป็น .xlsx"
        show(fileErrorEl)
        return
      }
      pickedFile = file as File
      fileNameEl.innerHTML = esc(file!.name) +
        ' <span class="sz">(' + (file!.size / 1024).toFixed(0) + " KB)</span>"
      show(fileNameEl)
      renderConfirm()
      show(stepConfirm)
    })
  })

  function renderConfirm(): void {
    if (!pickedFile) return
    var who = (identity && identity.full_name) || "ท่าน"
    confirmLine.innerHTML =
      "ส่งไฟล์ <b>" + esc(pickedFile.name) + "</b> เป็น P4P ของเดือน <b>" +
      esc(P4P.monthKeyDisplay(selectedMonth)) + "</b> ในชื่อ <b>" + esc(who as string) + "</b>"
  }

  // ── Upload ───────────────────────────────────────────────────────────────
  function randomId(): string {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID()
    var b = new Uint8Array(16)
    ;((window.crypto || {}) as Crypto).getRandomValues ? crypto.getRandomValues(b) : b.forEach(function (_, i) { b[i] = Math.floor(Math.random() * 256) })
    // Array.from(b, ...) rather than Array.prototype.map.call(b, ...) (what
    // this originally called) — same per-byte transform and join, just typed
    // cleanly against a Uint8Array without widening strictBindCallApply's
    // `this` check to `any`.
    return Array.from(b, function (x) { return ("0" + x.toString(16)).slice(-2) }).join("")
  }

  // Raw XHR rather than supabase-js's storage client, for one reason: upload
  // progress events. These files are tens of KB — the bar is for a bad
  // connection, not a big file.
  function putObject(path: string, file: File, onProgress: (frac: number) => void): Promise<void> {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest()
      xhr.open("POST", P4P.SUPABASE_URL + "/storage/v1/object/" + BUCKET + "/" + path)
      xhr.setRequestHeader("Authorization", "Bearer " + ACCESS_TOKEN)
      xhr.setRequestHeader("apikey", P4P.SUPABASE_KEY)
      xhr.setRequestHeader("x-upsert", "false")
      xhr.setRequestHeader("Content-Type", file.type ||
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      xhr.upload.addEventListener("progress", function (e) {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total)
      })
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) return resolve()
        reject(new Error("storage " + xhr.status + ": " + xhr.responseText))
      }
      xhr.onerror = function () { reject(new Error("network error while uploading")) }
      xhr.send(file)
    })
  }

  function resultCard(html: string): void {
    resultBody.innerHTML = html
    show(stepResult)
  }

  function showInstantResult(payload: UploadScorePayload): void {
    resultTitle.textContent = "ส่งไฟล์สำเร็จ"
    var late = payload.is_late
    resultCard(
      '<div id="result-score">' + esc(receipt.formatScore(payload.score)) + "</div>" +
      '<div id="result-rows">' +
      "<div><span>ชื่อแพทย์</span><span>" + esc(payload.display_name || (identity && identity.full_name) || "-") + "</span></div>" +
      "<div><span>กลุ่มงาน</span><span>" + esc(payload.department || (identity && identity.department) || "-") + "</span></div>" +
      "<div><span>เดือน / ปี</span><span>" + esc(payload.display_date) + "</span></div>" +
      "<div><span>สถานะ</span><span>" + (late ? "เกินกำหนด" : "ตรงเวลา") + "</span></div>" +
      "</div>" +
      '<div class="notice ' + (late ? "warn" : "ok") + '">' +
      (late ? "บันทึกคะแนนแล้ว แต่การจัดอันดับจะนับว่าส่งช้า" : "บันทึกคะแนนเรียบร้อยแล้ว") +
      "</div>"
    )

    // The receipt goes into the chat as the physician's own message — free,
    // and it is the copy they keep. The page already has every fact it needs,
    // so nothing waits on a webhook here.
    sendToChat([receipt.buildScoreReceipt({
      displayName: (payload.display_name || (identity && identity.full_name) || "") as string,
      department: (payload.department || (identity && identity.department) || "") as string,
      monthKey: payload.month_key as string,
      score: payload.score,
      receivedAt: payload.received_at as string,
      isLate: !!payload.is_late,
    })])
  }

  function showDeferredResult(): void {
    resultTitle.textContent = "กำลังตรวจสอบ"
    resultCard(
      '<div class="notice info">ระบบได้รับไฟล์ของท่านแล้ว กำลังตรวจสอบคะแนน ' +
      "และจะแจ้งผลทางแชท LINE ภายในไม่กี่นาที</div>" +
      '<div id="result-rows"><div><span>เดือน / ปี</span><span>' +
      esc(P4P.monthKeyDisplay(selectedMonth)) + "</span></div></div>"
    )

    // A TEXT message (not a Flex) on purpose: only text fires a webhook, and
    // that webhook is what earns the bot a free reply carrying the "ดูผลคะแนน"
    // button (design §7.5 step ②). The bot ignores what this says.
    sendToChat([{ type: "text", text: "ส่งไฟล์ P4P " + P4P.monthKeyDisplay(selectedMonth) }])
    pollForResult()
  }

  function showRejected(payload: UploadScorePayload): void {
    resultTitle.textContent = "ส่งไฟล์ไม่สำเร็จ"
    resultCard(
      '<div class="notice err">' + esc(receipt.errorText(payload.error as string)) + "</div>" +
      (payload.detail ? '<div class="notice warn">' + esc(payload.detail) + "</div>" : "")
    )
    show(againButton)
  }

  // A fallback for a physician still watching the page — the primary path to
  // a deferred result is the chat message, not this poll.
  function pollForResult(): void {
    var tries = 0
    var timer = setInterval(function () {
      tries += 1
      if (tries > 24) return clearInterval(timer) // ~2 minutes
      db.rpc("my_p4p_uploads", { p_limit: 5 }).then(function (r) {
        var rows = r.data || []
        var row = rows.filter(function (x: any) { return x.month_key === selectedMonth })[0]
        if (!row) return
        loadHistory()
        if (row.status === "done") {
          clearInterval(timer)
          showInstantResult({
            score: row.score,
            month_key: row.month_key,
            display_date: P4P.monthKeyDisplay(row.month_key),
            is_late: P4P.isLateFor(row.month_key, row.received_at),
            received_at: row.received_at,
            display_name: identity && identity.full_name,
            department: identity && identity.department,
          })
        } else if (row.status === "failed" || row.status === "rejected") {
          clearInterval(timer)
          showRejected({ error: row.error_type || "other", detail: "" })
        }
      }).catch(function () { /* keep polling */ })
    }, 5000)
  }

  submitButton.addEventListener("click", function () {
    if (!pickedFile) return
    var file = pickedFile
    submitButton.disabled = true
    hide(stepConfirm)
    hide(stepResult)
    hide(againButton)
    show(stepUploading)
    progressBar.style.width = "0%"
    progressLabel.textContent = "กำลังอัปโหลด…"

    // <uid>/<month_key>/<uuid>.xlsx — the bucket is NOT part of this path
    // (storage.objects keeps it in bucket_id), and the leading uid is what
    // the storage policy pins to auth.uid().
    var objectPath = UID + "/" + selectedMonth + "/" + randomId() + ".xlsx"

    putObject(objectPath, file, function (frac) {
      progressBar.style.width = Math.round(frac * 100) + "%"
    })
      .then(function () {
        progressBar.style.width = "100%"
        progressLabel.textContent = "กำลังตรวจสอบไฟล์…"
        return db.rpc("enqueue_p4p_upload", {
          p_object_path: objectPath,
          p_month_key: selectedMonth,
          p_filename: file.name,
          p_size_bytes: file.size,
        })
      })
      .then(function (r) {
        if (r.error) throw r.error
        var queueId = r.data && r.data.queue_id
        if (!queueId) throw new Error("enqueue returned no queue_id")
        return fetch("/upload/score", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ queue_id: queueId }),
        })
      })
      .then(function (resp) {
        return resp.json().then(function (payload) { return { status: resp.status, payload: payload } })
      })
      .then(function (out) {
        hide(stepUploading)
        submitButton.disabled = false
        if (out.status === 401) {
          location.replace("/verify/?return=" + encodeURIComponent("/upload/") + "&reason=expired")
          return
        }
        if (out.payload && out.payload.error) return showRejected(out.payload)
        if (out.payload && out.payload.pending) return showDeferredResult()
        showInstantResult(out.payload)
      })
      .catch(function (err) {
        console.error(err)
        hide(stepUploading)
        submitButton.disabled = false
        resultTitle.textContent = "ส่งไฟล์ไม่สำเร็จ"
        // A PostgREST error carries the RPC's own Thai message (e.g. the
        // duplicate-submission one) — show it rather than a generic failure.
        var msg = (err && (err.message || err.error_description)) || "เกิดข้อผิดพลาด กรุณาลองใหม่"
        resultCard('<div class="notice err">' + esc(msg) + "</div>")
        show(againButton)
      })
      .then(loadHistory)
  })

  againButton.addEventListener("click", function () {
    hide(stepResult)
    hide(againButton)
    pickedFile = null
    fileInput.value = ""
    hide(fileNameEl)
    hide(stepConfirm)
  })

  // ── History ──────────────────────────────────────────────────────────────
  var STATUS_LABEL: Record<string, [string, string]> = {
    pending: ["pending", "รอตรวจ"],
    processing: ["pending", "กำลังตรวจ"],
    done: ["done", "สำเร็จ"],
    failed: ["failed", "ไม่สำเร็จ"],
    rejected: ["failed", "ไม่สำเร็จ"],
  }

  function loadHistory(): Promise<void> {
    return db.rpc("my_p4p_uploads", { p_limit: 10 }).then(function (r) {
      if (r.error) throw r.error
      var rows = r.data || []
      historyList.innerHTML = ""
      if (rows.length === 0) return show(historyEmpty)
      hide(historyEmpty)
      rows.forEach(function (row: any) {
        var pair = STATUS_LABEL[row.status] || ["pending", row.status]
        var chipText = pair[1]
        // A scored row gets its own separate score pill rather than folding
        // the number into the status text ("สำเร็จ 1,842.50" as one string) —
        // two badges read at a glance, one long one does not.
        var scoreChip = ""
        if (row.status === "done" && row.score !== null && row.score !== undefined) {
          scoreChip = '<span class="score-chip">' + esc(receipt.formatScore(row.score)) + "</span>"
        } else if (pair[0] === "failed" && row.error_type) {
          chipText += " · " + row.error_type
        }
        var li = document.createElement("li")
        li.innerHTML =
          "<span>" + esc(P4P.monthKeyDisplay(row.month_key)) +
          '<br><span class="h-when">' + esc(P4P.shortDateTime(row.received_at)) + "</span></span>" +
          '<span class="chip-group"><span class="status-chip ' + pair[0] + '">' + esc(chipText) + "</span>" + scoreChip + "</span>"
        historyList.appendChild(li)
      })
    }).catch(function (err) {
      console.warn("my_p4p_uploads failed:", err)
    })
  }

  // ── ?probe=1 — the LIFF capability check design §7.5 asks for ────────────
  // Folded into this page rather than a throwaway /preflight one precisely
  // because this is the page whose LIFF context matters, launched the way we
  // actually launch it (from the rich menu).
  function runProbe(): void {
    var probeEl = document.getElementById("probe") as HTMLElement
    var out: Record<string, unknown> = { liff_id: LIFF_ID || "(not set)", ua: navigator.userAgent }
    show(document.getElementById("step-probe") as HTMLElement)
    liffReady.then(function (ok) {
      out.init = ok
      if (ok) {
        out.isInClient = liff.isInClient()
        out.isLoggedIn = liff.isLoggedIn()
        out.os = liff.getOS()
        out.version = liff.getVersion()
        out.lineVersion = liff.getLineVersion()
        try { out.context = liff.getContext() } catch (e) { out.context = String(e) }
        try { out.idToken = liff.getIDToken() ? "present" : "null (no openid scope?)" } catch (e) { out.idToken = String(e) }
      }
      probeEl.textContent = JSON.stringify(out, null, 2)
    })
    // Calls liff.sendMessages() directly rather than through sendToChat(),
    // which swallows its error by design (§ so a failed receipt never blocks
    // a real upload) — this is the one place that error is worth surfacing,
    // since "OK"/"FAILED" alone can't distinguish missing chat_message.write
    // scope from isInClient()===false from a dead LIFF session.
    document.getElementById("probe-send")!.addEventListener("click", function () {
      liffReady.then(function (ok) {
        if (!ok) return "sendMessages: SKIPPED (liff.init failed)"
        if (!liff.isInClient()) return "sendMessages: SKIPPED (not isInClient — opened outside LINE's in-app browser)"
        return liff.sendMessages([{ type: "text", text: "P4P probe " + new Date().toISOString() }])
          .then(function () { return "sendMessages: OK" })
          .catch(function (err) {
            return "sendMessages: FAILED — " + (err && (err.message || JSON.stringify(err)))
          })
      }).then(function (line) {
        probeEl.textContent = line + "\n" + probeEl.textContent
      })
    })
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  P4P.ready!.then(function () {
    renderMonths({})
    renderDeadline()
    bindLineAccount()
    loadIdentity()
    loadMonthSubmissions()
    loadHistory()
    if (PROBE) runProbe()
  })
})()
