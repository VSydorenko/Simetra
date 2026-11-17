// Контракт TanStack Virtual, на якому стоїть `VirtualList` (спайк 4 §6).
// Ламається — оновлення змінило поведінку, від якої залежить відсутність
// стрибка при рості рядка над видимими.
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { Virtualizer } from "@tanstack/react-virtual"
import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)
const own = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")
) as { devDependencies: Record<string, string> }

function version(path: string): string {
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version
}

function make(onWrite: (offset: number) => void) {
  const el = { scrollTop: 300, scrollHeight: 10_000, clientHeight: 600 }
  const win = {
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
    cancelAnimationFrame: clearTimeout,
    performance,
  }
  const v = new Virtualizer<never, never>({
    count: 100,
    estimateSize: () => 50,
    getScrollElement: () =>
      Object.assign(el, { ownerDocument: { defaultView: win } }) as never,
    scrollToFn: (offset, { adjustments = 0 }) => onWrite(offset + adjustments),
    observeElementRect: (_i, cb) => cb({ width: 1000, height: 600 }),
    observeElementOffset: (_i, cb) => cb(300, false),
    initialOffset: 300,
  })
  v._willUpdate()
  v.getVirtualItems()
  return v
}

describe("TanStack Virtual: контракт VirtualList", () => {
  it("версії react-virtual і virtual-core дорівнюють піну", () => {
    const reactVirtualJson =
      require.resolve("@tanstack/react-virtual/package.json")
    expect(version(reactVirtualJson)).toBe(
      own.devDependencies["@tanstack/react-virtual"]
    )
    const coreJson = createRequire(reactVirtualJson).resolve(
      "@tanstack/virtual-core/package.json"
    )
    // Контракт перевірено на цій версії ядра.
    expect(version(coreJson)).toBe("3.19.11")
  })

  it("вбудована корекція росту рядка над видимими є за замовчуванням", () => {
    const writes: number[] = []
    const v = make((o) => writes.push(o))
    writes.length = 0
    v.resizeItem(0, 120)
    expect(writes).toEqual([370])
  })

  it("shouldAdjustScrollPositionOnItemSizeChange = () => false вимикає її", () => {
    const writes: number[] = []
    const v = make((o) => writes.push(o))
    v.shouldAdjustScrollPositionOnItemSizeChange = () => false
    writes.length = 0
    v.resizeItem(0, 120)
    expect(writes).toEqual([])
  })
})
