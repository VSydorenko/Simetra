// Контракт TanStack Virtual, на якому стоїть вікно (спайк 4). Ламається —
// оновлення змінило поведінку, від якої залежить відсутність стрибка.
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import { Virtualizer } from "@tanstack/react-virtual"

const require = createRequire(import.meta.url)

function make(onWrite: (offset: number) => void) {
  const el = { scrollTop: 300, scrollHeight: 10_000, clientHeight: 600 } as any
  const win = {
    requestAnimationFrame: (f: any) => setTimeout(f, 0),
    cancelAnimationFrame: clearTimeout,
    performance,
  } as any
  el.ownerDocument = { defaultView: win }
  const v = new Virtualizer<any, any>({
    count: 100,
    estimateSize: () => 50,
    getScrollElement: () => el,
    scrollToFn: (offset, { adjustments = 0 }) => onWrite(offset + adjustments),
    observeElementRect: (_i, cb) => cb({ width: 1000, height: 600 }),
    observeElementOffset: (_i, cb) => cb(300, false),
    initialOffset: 300,
  })
  v._willUpdate()
  v.getVirtualItems()
  return v
}

describe("TanStack Virtual: контракт вікна", () => {
  it("версія virtual-core закріплена (контракт перевірено на ній)", () => {
    const pkg = JSON.parse(
      readFileSync(
        createRequire(require.resolve("@tanstack/react-virtual")).resolve(
          "@tanstack/virtual-core/package.json"
        ),
        "utf8"
      )
    )
    expect(pkg.version).toBe("3.19.11")
  })

  it("вбудована корекція росту рядка над видимими є (за замовчуванням)", () => {
    const writes: number[] = []
    const v = make((o) => writes.push(o))
    writes.length = 0
    v.resizeItem(0, 120)
    expect(writes).toEqual([370])
  })

  it("shouldAdjustScrollPositionOnItemSizeChange = () => false вимикає її (корекцію робить власний якір)", () => {
    const writes: number[] = []
    const v = make((o) => writes.push(o))
    v.shouldAdjustScrollPositionOnItemSizeChange = () => false
    writes.length = 0
    v.resizeItem(0, 120)
    expect(writes).toEqual([])
  })
})
