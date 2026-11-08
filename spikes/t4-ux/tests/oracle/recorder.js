// Записувач оракула мерехтіння. Вставляється до будь-якого скрипта сторінки
// (Playwright addInitScript). Знімає стан кожної зони `[data-region]` після
// кожної пачки мутацій DOM (суворіше за кадр: стан після кожної задачі), на
// кожну прокрутку і на кожному rAF (те, що йде на малювання), з геометрією.
;(() => {
  const log = {
    snaps: [],
    marks: [],
    shifts: [],
    appMutationsAfterParse: [],
    parsedAt: null,
    frame: 0,
  }
  window.__oracle = log
  let lastKey = ""
  let seq = 0

  function regionSnap(el) {
    const box = el.getBoundingClientRect()
    const scv = el.querySelector("[data-scroll]")
    const port = scv ? scv.getBoundingClientRect() : null
    const rows = []
    el.querySelectorAll("[data-row-key]").forEach((r) => {
      const rr = r.getBoundingClientRect()
      const cs = getComputedStyle(r)
      // Зобов'язання 10: прихований рядок (visibility, opacity) — відсутній
      // для правил присутності; колір і тло — частина значення рядка, тож
      // спалах (A → B → A) ловить правило value-aba.
      if (
        cs.visibility === "hidden" ||
        cs.opacity === "0" ||
        cs.display === "none"
      )
        return
      const fields = {}
      r.querySelectorAll("[data-field]").forEach((f) => {
        fields[f.getAttribute("data-field")] =
          f.tagName === "INPUT" ? f.value : f.textContent
      })
      fields.__style = `${cs.opacity}|${cs.color}|${cs.backgroundColor}`
      const st =
        r.querySelector("[data-state]") ||
        el.querySelector(".toolbar [data-state]")
      rows.push({
        // Рядок у видимій області прокрутки (поза нею — запас віртуалізатора).
        vis: !port || (rr.bottom > port.top && rr.top < port.bottom),
        key: r.getAttribute("data-row-key"),
        top: Math.round((rr.top - box.top) * 10) / 10,
        h: Math.round(rr.height * 10) / 10,
        fields,
        state: st ? st.getAttribute("data-state") : null,
      })
    })
    const sc = el.querySelector("[data-scroll]")
    // Покриття видимої області прокрутки рядками й слотами: найдовша смуга
    // без жодного рядка (порожнеча на місці списку).
    let gap = null
    if (sc && sc.scrollHeight > sc.clientHeight) {
      const vb = sc.getBoundingClientRect()
      const top = vb.top + sc.clientTop
      const bottom = top + sc.clientHeight
      const spans = []
      sc.querySelectorAll("[data-row-key],[data-loading]").forEach((r) => {
        const rr = r.getBoundingClientRect()
        if (rr.bottom > top && rr.top < bottom)
          spans.push([Math.max(top, rr.top), Math.min(bottom, rr.bottom)])
      })
      spans.sort((a, b) => a[0] - b[0])
      let at = top
      let worst = 0
      for (const [a, b] of spans) {
        if (a > at) worst = Math.max(worst, a - at)
        at = Math.max(at, b)
      }
      worst = Math.max(worst, bottom - at)
      gap = Math.round(worst)
    }
    return {
      name: el.getAttribute("data-region"),
      rows,
      skeleton: !!el.querySelector("[data-skeleton]"),
      scrollTop: sc ? sc.scrollTop : null,
      gap,
      text: (el.textContent || "").slice(0, 50000),
    }
  }

  function take(reason) {
    const regions = Array.from(document.querySelectorAll("[data-region]")).map(
      regionSnap
    )
    const key = JSON.stringify(regions)
    if (key === lastKey) return
    lastKey = key
    log.snaps.push({
      i: seq++,
      t: performance.now(),
      frame: log.frame,
      reason,
      seg: log.marks.length,
      regions,
    })
  }
  log.take = take

  window.__oracleMark = (name, opts) => {
    take("pre-mark")
    log.marks.push({
      name,
      opts: opts || {},
      t: performance.now(),
      at: log.snaps.length,
    })
  }

  document.addEventListener("readystatechange", () => {
    if (document.readyState === "interactive" && log.parsedAt === null) {
      log.parsedAt = performance.now()
      const app = document.getElementById("app")
      log.serverHtml = app ? app.innerHTML : null
      take("parsed")
    }
  })

  new MutationObserver((records) => {
    if (log.parsedAt !== null) {
      const app = document.getElementById("app")
      for (const r of records)
        if (app && app.contains(r.target)) {
          // Явний слот потоку (Suspense-межа лінивого значення, зарезервована
          // за розміром): доливання в нього — не гідратаційна розбіжність.
          const el = r.target.nodeType === 1 ? r.target : r.target.parentElement
          if (el && el.closest("[data-stream-slot]")) continue
          // Атрибут, записаний тим самим значенням (React так гідратує value
          // контрольованого input), видимої зміни не дає.
          if (
            r.type === "attributes" &&
            r.oldValue === r.target.getAttribute(r.attributeName)
          )
            continue
          log.appMutationsAfterParse.push({
            t: performance.now(),
            type: r.type,
            target:
              r.target.nodeName +
              (r.target.getAttribute
                ? "." + (r.target.getAttribute("class") || "")
                : ""),
            attr: r.attributeName,
            added: Array.from(r.addedNodes || [])
              .map((n) => n.nodeName)
              .join(","),
            removed: Array.from(r.removedNodes || [])
              .map((n) => n.nodeName)
              .join(","),
          })
        }
    }
    take("mo")
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
  })

  // Прокрутка елемента списку: знімок у capture-слухачі документа бачив би
  // DOM до обробника віртуалізатора (той малює синхронно у своєму
  // слухачі), тобто стан, якого браузер не малює. Для `[data-scroll]` стан
  // після обробників дають знімки MutationObserver (мікрозадача після
  // commit) і rAF (перед малюванням). Решта прокруток — як раніше.
  document.addEventListener(
    "scroll",
    (e) => {
      const t = e.target
      if (t && t.nodeType === 1 && t.hasAttribute("data-scroll")) return
      take("scroll")
    },
    true
  )

  const raf = () => {
    log.frame++
    take("raf")
    requestAnimationFrame(raf)
  }
  requestAnimationFrame(raf)

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        log.shifts.push({
          t: e.startTime,
          value: e.value,
          hadRecentInput: e.hadRecentInput,
          seg: log.marks.length,
          sources: (e.sources || []).map((src) => {
            const n = src.node
            const desc = n
              ? (
                  n.nodeName +
                  "." +
                  (n.className || "") +
                  " " +
                  (n.textContent || "").slice(0, 40)
                ).trim()
              : "?"
            const r = (x) =>
              [
                Math.round(x.x),
                Math.round(x.y),
                Math.round(x.width),
                Math.round(x.height),
              ].join(",")
            return desc + " " + r(src.previousRect) + " → " + r(src.currentRect)
          }),
        })
    }).observe({ type: "layout-shift", buffered: true })
  } catch {
    log.shiftsUnsupported = true
  }
})()
