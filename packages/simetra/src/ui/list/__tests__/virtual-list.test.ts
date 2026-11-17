// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { RowView } from "simetra/data/react"
import { VirtualList, type VirtualListProps } from "../virtual-list"

// jsdom не має розкладки: виміри підміняються. Висота слота береться з
// `heights` за ключем рядка (за замовчуванням EST), верх слота — сума висот
// усіх рядків перед ним мінус прокрутка області. Це «істина» розкладки, тож
// зсув видимих після зміни висоти видно в `getBoundingClientRect`, а не в
// стилях, які jsdom не розкладає.
const EST = 50
const VIEW = 200
let heights = new Map<string, number>()
const scrollTops = new WeakMap<Element, number>()

const heightOf = (key: string) => heights.get(key) ?? EST
const keyAt = (i: number) => `r${i}`

function topOf(slot: Element): number {
  const scroller = slot.closest("[data-scroll]")!
  const index = Number(slot.getAttribute("data-index"))
  let start = 0
  for (let i = 0; i < index; i++) start += heightOf(keyAt(i))
  return start - (scrollTops.get(scroller) ?? 0)
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return scrollTops.get(this) ?? 0
    },
    set(this: Element, v: number) {
      scrollTops.set(this, v)
    },
  })
  // Розмір області читає `getRect` віртуалізатора.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => VIEW,
  })
  // Без `scrollHeight` віртуалізатор бачить «надпрокрутку» і не пише корекцію.
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => 100 * EST,
  })
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 1000,
  })
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute("data-scroll"))
      return { top: 0, bottom: VIEW, height: VIEW } as DOMRect
    if (this.hasAttribute("data-index")) {
      const top = topOf(this)
      const h = heightOf(this.getAttribute("data-row-key") ?? "")
      return { top, bottom: top + h, height: h } as DOMRect
    }
    return { top: 0, bottom: 0, height: 0 } as DOMRect
  }
})

afterEach(() => {
  cleanup()
  heights = new Map()
})

function makeRows(n: number, bump = 0): RowView[] {
  return Array.from({ length: n }, (_, i) => ({
    key: keyAt(i),
    version: 1 + (i === 2 ? bump : 0),
    values: { name: `n${i}` },
    state: "synced" as const,
    staleFields: [],
  }))
}

function props(
  rows: RowView[],
  extra: Partial<VirtualListProps> = {}
): VirtualListProps {
  return {
    rows,
    rowHeight: EST,
    height: VIEW,
    setVisibleRange: () => {},
    renderRow: (row) => createElement("span", null, String(row.key)),
    ...extra,
  }
}

const slotKeys = (c: HTMLElement) =>
  [...c.querySelectorAll("[data-row-key]")].map((e) =>
    e.getAttribute("data-row-key")
  )

describe("VirtualList", () => {
  it("renders the visible rows with overscan and keys slots by row key", () => {
    const { container } = render(
      createElement(VirtualList, props(makeRows(100)))
    )
    const keys = slotKeys(container)
    expect(keys[0]).toBe("r0")
    // 200px / 50px = 4 видимих + запас
    expect(keys.length).toBeGreaterThanOrEqual(4)
    expect(keys.length).toBeLessThan(20)
  })

  it("server render gives the same range as the first client render", () => {
    const html = renderToString(
      createElement(VirtualList, props(makeRows(100)))
    )
    const serverKeys = [...html.matchAll(/data-row-key="([^"]+)"/g)].map(
      (m) => m[1]
    )
    const { container } = render(
      createElement(VirtualList, props(makeRows(100)))
    )
    expect(slotKeys(container)).toEqual(serverKeys)
    expect(serverKeys.length).toBeGreaterThan(0)
  })

  it("a removed row keeps a slot of the same height", () => {
    const rows = makeRows(10)
    rows[1] = { key: "r1", state: "removed" }
    const { container } = render(createElement(VirtualList, props(rows)))
    const slots = [...container.querySelectorAll<HTMLElement>("[data-row-key]")]
    expect(slots[1]!.style.height).toBe(`${EST}px`)
    expect(slots[1]!.style.height).toBe(slots[0]!.style.height)
  })

  it("shows loading slots on the edges not reached", () => {
    const { container } = render(
      createElement(
        VirtualList,
        props(makeRows(3), {
          atStart: false,
          atEnd: false,
          renderPlaceholder: (edge) => createElement("i", null, edge),
        })
      )
    )
    expect(container.querySelector('[data-loading="before"]')).not.toBeNull()
    expect(container.querySelector('[data-loading="after"]')).not.toBeNull()
  })

  it("remounts by chain and starts at the end for target end", () => {
    const ui = (chain: number, target: "start" | "end" | "keep") =>
      createElement(VirtualList, props(makeRows(100), { chain, target }))
    const { container, rerender } = render(ui(1, "start"))
    const first = container.querySelector("[data-scroll]")
    rerender(ui(1, "start"))
    expect(container.querySelector("[data-scroll]")).toBe(first)
    rerender(ui(2, "keep"))
    expect(container.querySelector("[data-scroll]")).toBe(first)
    rerender(ui(3, "end"))
    expect(container.querySelector("[data-scroll]")).not.toBe(first)
    expect(slotKeys(container).at(-1)).toBe("r99")
  })

  it("a height growth above the visible rows shifts the scroll by exactly the growth", () => {
    const view = (rows: RowView[]): ReactNode =>
      createElement(
        VirtualList,
        props(rows, {
          measure: true,
          // Новий вміст (версія) росте під час рендеру, тож якір, прочитаний
          // на початку рендеру, ще бачить стару розкладку, а layout-ефект —
          // нову, як у браузері.
          renderRow: (row) => {
            if (row.state !== "removed" && row.version > 1)
              heights.set(String(row.key), EST + 30)
            return createElement("span", null, "x")
          },
        })
      )
    const { container, rerender } = render(view(makeRows(30)))
    const scroller = container.querySelector<HTMLElement>("[data-scroll]")!
    // Видимі рядки r5..r8; r0..r4 над ними.
    act(() => {
      scroller.scrollTop = 250
      fireEvent.scroll(scroller)
    })
    const anchorKey = "r5"
    const slotTop = () =>
      container
        .querySelector(`[data-row-key="${anchorKey}"]`)!
        .getBoundingClientRect().top
    expect(slotTop()).toBe(0)
    const before = scroller.scrollTop

    act(() => {
      rerender(view(makeRows(30, 1)))
    })
    expect(scroller.scrollTop - before).toBe(30)
    expect(slotTop()).toBe(0)
  })

  it("a client-only mount reports the visible range at once", () => {
    const setVisibleRange = vi.fn()
    render(
      createElement(VirtualList, props(makeRows(100), { setVisibleRange }))
    )
    expect(setVisibleRange).toHaveBeenCalledWith({ first: 0, last: 3 })
  })

  it("a hydrated mount reports the range only after the first scroll; lists are independent", () => {
    const hydrated = vi.fn()
    const mounted = vi.fn()
    const html = renderToString(
      createElement(VirtualList, props(makeRows(100)))
    )
    const host = document.createElement("div")
    host.innerHTML = html
    document.body.append(host)
    let root!: Root
    act(() => {
      root = hydrateRoot(
        host,
        createElement(
          VirtualList,
          props(makeRows(100), { setVisibleRange: hydrated })
        )
      )
    })
    expect(hydrated).not.toHaveBeenCalled()
    // Другий список, змонтований на клієнті, від першого не залежить.
    const other = render(
      createElement(
        VirtualList,
        props(makeRows(100), { setVisibleRange: mounted })
      )
    )
    expect(mounted).toHaveBeenCalledWith({ first: 0, last: 3 })
    expect(hydrated).not.toHaveBeenCalled()
    act(() => {
      fireEvent.scroll(host.querySelector<HTMLElement>("[data-scroll]")!)
    })
    expect(hydrated).toHaveBeenCalledWith({ first: 0, last: 3 })
    act(() => root.unmount())
    other.unmount()
    host.remove()
  })

  it("the virtualizer's own compensation of a grown row is off (the anchor alone corrects)", () => {
    // ResizeObserver приходить після commit: вбудована компенсація дала б
    // другу корекцію `scrollTop` (спайк 4 §6). Бібліотека не пише в прокрутку.
    // Віртуалізатор має два спостерігачі (область і слоти): рядки спостерігає лише один.
    const observers: { cb: ResizeObserverCallback; seen: Set<Element> }[] = []
    class FakeObserver {
      readonly seen = new Set<Element>()
      constructor(cb: ResizeObserverCallback) {
        observers.push({ cb, seen: this.seen })
      }
      observe(node: Element) {
        this.seen.add(node)
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver)
    ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      FakeObserver
    const writes: number[] = []
    const proto = HTMLElement.prototype as unknown as {
      scrollTo?: (o: ScrollToOptions) => void
    }
    proto.scrollTo = function (this: HTMLElement, o: ScrollToOptions) {
      writes.push(o.top ?? 0)
      this.scrollTop = o.top ?? 0
    }
    try {
      const { container } = render(
        createElement(
          VirtualList,
          props(makeRows(30), {
            measure: true,
            renderRow: () => createElement("span", null, "x"),
          })
        )
      )
      const scroller = container.querySelector<HTMLElement>("[data-scroll]")!
      act(() => {
        scroller.scrollTop = 250
        fireEvent.scroll(scroller)
      })
      writes.length = 0
      const slot = container.querySelector<HTMLElement>('[data-row-key="r2"]')!
      heights.set("r2", EST + 30)
      act(() => {
        const own = observers.find((o) => o.seen.has(slot))!
        own.cb(
          [
            {
              target: slot,
              borderBoxSize: [{ blockSize: EST + 30, inlineSize: 1000 }],
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver
        )
      })
      expect(writes).toEqual([])
      expect(scroller.scrollTop).toBe(250)
    } finally {
      delete proto.scrollTo
      vi.unstubAllGlobals()
      delete (window as unknown as { ResizeObserver?: unknown }).ResizeObserver
    }
  })
})
