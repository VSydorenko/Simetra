import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { PINNED_SESSION_SETTINGS } from "simetra/model"
import { DATA_SETTINGS } from "simetra/schema"

/**
 * Спека промоції §7.2 називає власні налаштування кроків даних (шлях пошуку й
 * обхід RLS) і спільний набір платформи `PINNED_SESSION_SETTINGS` між ними;
 * значення й причини спільного набору — у коді T0. Тест не дає спеці й
 * `DATA_SETTINGS` розійтися.
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
    expect(pinned).toEqual([
      { name: "search_path", value: "pg_catalog, pg_temp" },
      { name: "row_security", value: "off" },
    ])
    expect(spec.slice(start, end)).toContain("`PINNED_SESSION_SETTINGS`")
    expect(DATA_SETTINGS).toEqual([
      pinned[0],
      ...PINNED_SESSION_SETTINGS,
      pinned[1],
    ])
  })
})
