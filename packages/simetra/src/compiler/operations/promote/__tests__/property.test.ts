import { describe, expect, it } from "vitest"
import type { PhysicalSnapshot, PhysicalTable } from "simetra/model"
import type { ConversionClass } from "../../inputs"
import { propertyRefusals } from "../property"

type Table = Partial<
  Pick<PhysicalTable, "uniques" | "indexes" | "checks" | "columns">
>

const table = (name: string, parts: Table): PhysicalTable =>
  ({
    schema: "app",
    name,
    origin: { objectId: "t" },
    rowLevelSecurity: "off",
    columns: [],
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
    ...parts,
  }) as unknown as PhysicalTable

const snapshot = (...tables: PhysicalTable[]): PhysicalSnapshot => ({
  tables,
  enumTypes: [],
})

const column = (name: string) =>
  ({ name, type: "integer", notNull: true }) as PhysicalTable["columns"][number]

// Таблиця `s` стає `catalog_s`, колонка `o` — `order_no`.
const tablesOldToNew = new Map([["app.s", "catalog_s"]])
const columnsOldToNew = new Map([["app.s.o", "order_no"]])

const refusals = (
  before: Table,
  after: Table,
  objects: { kind: "constraint" | "index"; name: string }[],
  cls: ConversionClass = "property"
) =>
  propertyRefusals({
    before: snapshot(table("s", { columns: [column("o")], ...before })),
    after: snapshot(
      table("catalog_s", { columns: [column("order_no")], ...after })
    ),
    conversions: objects.map((o) => ({
      subject: `S#${o.name}`,
      class: cls,
      objects: [{ ...o, schema: "app", table: "s" }],
    })),
    tablesOldToNew,
    columnsOldToNew,
  })

const unique = (
  columns: string[],
  extra: Partial<PhysicalTable["uniques"][number]> = {}
): PhysicalTable["uniques"][number] => ({
  name: "u",
  columns,
  nullsNotDistinct: false,
  ...extra,
})

const index = (
  parts: Partial<PhysicalTable["indexes"][number]> = {}
): PhysicalTable["indexes"][number] => ({
  name: "i",
  unique: true,
  method: "btree",
  keys: [{ column: "o" }],
  include: [],
  nullsNotDistinct: false,
  ...parts,
})

const constraint = [{ kind: "constraint" as const, name: "u" }]
const idx = [{ kind: "index" as const, name: "i" }]

const detail = (found: ReturnType<typeof propertyRefusals>) =>
  found.map((d) => [d.code, d.params?.detail])

describe("propertyRefusals", () => {
  it("refuses a deferred unique that the kind recreates as immediate", () => {
    const found = refusals(
      { uniques: [unique(["o"], { deferrable: "initiallyDeferred" })] },
      { uniques: [unique(["order_no"])] },
      constraint
    )
    expect(found).toHaveLength(1)
    expect(found[0]!.code).toBe("promote.property-not-equivalent")
    expect(String(found[0]!.params?.detail)).toContain(
      "deferrable: initiallyDeferred → no"
    )
  })

  it("refuses NULLS NOT DISTINCT lost", () => {
    const found = refusals(
      { uniques: [unique(["o"], { nullsNotDistinct: true })] },
      { uniques: [unique(["order_no"])] },
      constraint
    )
    expect(String(found[0]!.params?.detail)).toContain(
      "nullsNotDistinct: true → false"
    )
  })

  it("refuses a partial unique index recreated as full", () => {
    const found = refusals(
      { indexes: [index({ where: "(o > 0)" })] },
      { indexes: [index({ keys: [{ column: "order_no" }] })] },
      idx
    )
    expect(String(found[0]!.params?.detail)).toContain(
      "where: (o > 0) → (none)"
    )
  })

  it("refuses a property with nothing recreated", () => {
    const found = refusals(
      { uniques: [unique(["o"])] },
      { uniques: [unique(["other"])] },
      constraint
    )
    expect(detail(found)).toEqual([
      ["promote.property-not-equivalent", "no element on these columns"],
    ])
  })

  it("refuses a check recreated with another expression", () => {
    const found = refusals(
      { checks: [{ name: "u", expression: "(o > 0)" }] },
      { checks: [{ name: "c", expression: "(order_no > 5)" }] },
      constraint
    )
    expect(String(found[0]!.params?.detail)).toContain("expression")
  })

  it("accepts a check recreated with the same expression", () => {
    expect(
      refusals(
        { checks: [{ name: "u", expression: "(o > 0)" }] },
        { checks: [{ name: "c", expression: "(order_no > 0)" }] },
        constraint
      )
    ).toEqual([])
  })

  it("accepts an equivalent recreation", () => {
    expect(
      refusals(
        { uniques: [unique(["o"])], indexes: [index({ where: "(o > 0)" })] },
        {
          uniques: [unique(["order_no"])],
          indexes: [
            index({ keys: [{ column: "order_no" }], where: "(o > 0)" }),
          ],
        },
        [...constraint, ...idx]
      )
    ).toEqual([])
  })

  it("ignores other classes", () => {
    expect(
      refusals(
        { uniques: [unique(["o"], { deferrable: "initiallyDeferred" })] },
        { uniques: [unique(["order_no"])] },
        constraint,
        "removed"
      )
    ).toEqual([])
  })
})
