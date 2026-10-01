import { describe, expect, it } from "vitest"
import { compile, type CompileResult } from "simetra/compiler"
import { attribute, catalog, metaFiles, project } from "./helpers"

const ITEM = "catalogs/Item/Item.meta.json"

async function compileWith(
  entries: Record<string, unknown>
): Promise<CompileResult> {
  return compile(metaFiles({ "project.meta.json": project(), ...entries }))
}

function codes(result: CompileResult): [string, string, string][] {
  return result.diagnostics.map((d) => [d.code, d.file, d.pointer])
}

describe("project timezone", () => {
  it("unknown timezone", async () => {
    for (const timezone of ["Mars/Olympus", "+05:00", "Etc/GMT+5:30"]) {
      const result = await compileWith({
        "project.meta.json": project({ timezone }),
      })
      expect(codes(result), timezone).toEqual([
        ["project.timezone-unknown", "project.meta.json", "/timezone"],
      ])
      expect(result.diagnostics[0]!.params).toEqual({ timezone })
    }
  })

  it("Europe/Kyiv is accepted and kept verbatim", async () => {
    const result = await compileWith({
      "project.meta.json": project({ timezone: "Europe/Kyiv" }),
    })
    expect(result.diagnostics).toEqual([])
    expect(result.model?.project.timezone).toBe("Europe/Kyiv")
  })

  it("UTC and Europe/Kyiv are accepted", async () => {
    for (const timezone of [
      "UTC",
      "Europe/Kyiv",
      "America/New_York",
      "Etc/GMT+5",
      "Etc/GMT-3",
    ]) {
      const result = await compileWith({
        "project.meta.json": project({ timezone }),
      })
      expect(result.diagnostics, timezone).toEqual([])
    }
  })
})

describe("default value checks", () => {
  /** Коди діагностик каталогу `Item` з одним реквізитом `field`. */
  async function check(
    type: Record<string, unknown>,
    defaultValue: unknown
  ): Promise<string[]> {
    const result = await compileWith({
      [ITEM]: catalog("Item", {
        attributes: [attribute("field", { ...type, defaultValue })],
      }),
    })
    return result.diagnostics.map((d) => `${d.code} ${d.pointer}`)
  }
  const INVALID = ["type.default-invalid /attributes/0/defaultValue"]

  it("Date takes YYYY-MM-DD of a real day", async () => {
    expect(await check({ type: "Date" }, "2026-02-28")).toEqual([])
    expect(await check({ type: "Date" }, "2026-02-30")).toEqual(INVALID)
    expect(await check({ type: "Date" }, "28.02.2026")).toEqual(INVALID)
    expect(await check({ type: "Date" }, "2026-2-1")).toEqual(INVALID)
    // Роки 0–99 — звичайні роки, а не 1900+ (пастка `Date.UTC`).
    expect(await check({ type: "Date" }, "0050-01-01")).toEqual([])
    expect(await check({ type: "Date" }, "0050-02-30")).toEqual(INVALID)
    // Року 0 у Postgres немає: за 0001-01-01 іде 0001-12-31 BC.
    expect(await check({ type: "Date" }, "0001-01-01")).toEqual([])
    expect(await check({ type: "Date" }, "0000-01-01")).toEqual(INVALID)
    expect(await check({ type: "DateTime" }, "0000-12-31T00:00:00Z")).toEqual(
      INVALID
    )
  })

  it("DateTime takes ISO 8601 with a zone", async () => {
    for (const value of [
      "2026-10-01T12:30:00Z",
      "2026-10-01T12:30:00.250+03:00",
      "2026-10-01T12:30-05:00",
      "2026-10-01T12:30:00+03",
      "2026-10-01T12:30:00+15:59",
    ]) {
      expect(await check({ type: "DateTime" }, value), value).toEqual([])
    }
    for (const value of [
      "2026-10-01T12:30:00",
      "2026-10-01",
      "2026-13-01T00:00:00Z",
      "2026-10-01T24:00:00Z",
      "2026-10-01T12:30:00+16:00",
      "2026-10-01T12:30:00-23",
      "now",
    ]) {
      expect(await check({ type: "DateTime" }, value), value).toEqual(INVALID)
    }
  })

  it("String fits its length in characters", async () => {
    expect(await check({ type: "String", length: 3 }, "ґїє")).toEqual([])
    expect(await check({ type: "String", length: 3 }, "UAH!")).toEqual(INVALID)
  })

  it("Numeric fits precision and scale", async () => {
    const money = { type: "Numeric", precision: 5, scale: 2 }
    expect(await check(money, 999.99)).toEqual([])
    expect(await check(money, "-123.40")).toEqual([])
    expect(await check(money, "0.5")).toEqual([])
    expect(await check(money, 1000)).toEqual(INVALID)
    expect(await check(money, "1.234")).toEqual(INVALID)
    expect(await check({ type: "Numeric", precision: 3 }, 1.5)).toEqual(INVALID)
    expect(await check({ type: "Numeric", precision: 3 }, "999")).toEqual([])
    expect(await check({ type: "Numeric" }, "123456789.123456789")).toEqual([])
  })

  it("Integer and SmallInt take an integer in range", async () => {
    expect(await check({ type: "Integer" }, 2 ** 31 - 1)).toEqual([])
    expect(await check({ type: "SmallInt" }, -32768)).toEqual([])
    expect(await check({ type: "SmallInt" }, 32768)).toEqual(INVALID)
    expect(await check({ type: "Integer" }, 2 ** 31)).toEqual(INVALID)
  })

  it("BigInt takes a safe integer or an int8 integer string", async () => {
    expect(await check({ type: "BigInt" }, 2 ** 40)).toEqual([])
    expect(await check({ type: "BigInt" }, "-9223372036854775808")).toEqual([])
    expect(await check({ type: "BigInt" }, "9223372036854775807")).toEqual([])
    expect(await check({ type: "BigInt" }, "9223372036854775808")).toEqual(
      INVALID
    )
    expect(await check({ type: "BigInt" }, "12.5")).toEqual(INVALID)
    expect(await check({ type: "BigInt" }, 2 ** 60)).toEqual(INVALID)
  })

  it("Boolean takes true or false", async () => {
    expect(await check({ type: "Boolean" }, true)).toEqual([])
    expect(await check({ type: "Boolean" }, "true")).toEqual([
      "type.default-mismatch /attributes/0/defaultValue",
    ])
  })
})
