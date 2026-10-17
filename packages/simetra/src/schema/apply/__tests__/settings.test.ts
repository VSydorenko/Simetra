import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { DATA_SETTINGS } from "simetra/schema"

/**
 * Перелік закріплених налаштувань даних живе в спеці промоції §7.2 разом із
 * причинами; код тримає лише пари. Тест не дає їм розійтися.
 */
describe("DATA_SETTINGS", () => {
  it("DATA_SETTINGS matches the pinned list of the promotion spec", () => {
    const spec = readFileSync(
      resolve(
        __dirname,
        "../../../../../../docs/superpowers/specs/2026-10-06-promotion-design.md"
      ),
      "utf8"
    )
    const start = spec.indexOf("**Закріплені налаштування даних.**")
    const end = spec.indexOf("Не закріплюються", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const pinned = spec
      .slice(start, end)
      .split("\n")
      .flatMap((line) => {
        const m = /^- `([^`=]+?) = ([^`]+)`/.exec(line)
        return m === null ? [] : [{ name: m[1]!, value: m[2]! }]
      })
    expect(pinned).toHaveLength(15)
    expect(DATA_SETTINGS).toEqual(pinned)
  })
})
