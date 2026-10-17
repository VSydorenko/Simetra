import { describe, it, expect } from "vitest"
import { customTableSchema, pgEnumSchema } from "../schemas"

const base = {
  kind: "CustomTable",
  name: "Orders",
  columns: [{ name: "id", type: "BigInt" }],
}

function table(extra: Record<string, unknown>) {
  return { ...base, ...extra }
}

function rules(schema: { safeParse: (v: unknown) => unknown }, input: unknown) {
  const res = schema.safeParse(input) as {
    success: boolean
    error?: { issues: { params?: { rule?: string } }[] }
  }
  if (res.success) return []
  return res.error!.issues.map((i) => i.params?.rule ?? "?")
}

describe("customTableSchema", () => {
  it("accepts table without primary key", () => {
    const res = customTableSchema.parse(base)
    expect(res.primaryKey).toBeUndefined()
    expect(res.uniques).toEqual([])
    expect(res.indexes).toEqual([])
  })

  it("accepts composite primary key and composite foreign key with actions", () => {
    const res = customTableSchema.parse(
      table({
        columns: [
          { name: "a", type: "Integer", notNull: true },
          { name: "b", type: "Integer", notNull: true },
        ],
        primaryKey: { columns: ["a", "b"] },
        foreignKeys: [
          {
            columns: ["a", "b"],
            references: {
              object: { kind: "CustomTable", name: "Parent" },
              columns: ["x", "y"],
            },
            onDelete: "cascade",
            deferrable: "initiallyDeferred",
          },
        ],
      })
    )
    expect(res.foreignKeys[0]).toMatchObject({
      onDelete: "cascade",
      onUpdate: "noAction",
      deferrable: "initiallyDeferred",
    })
  })

  it("accepts external foreign key to auth.users", () => {
    const res = customTableSchema.safeParse(
      table({
        columns: [{ name: "userId", type: "UUID" }],
        foreignKeys: [
          {
            columns: ["userId"],
            references: {
              external: { schema: "auth", table: "users", columns: ["id"] },
            },
          },
        ],
      })
    )
    expect(res.success).toBe(true)
  })

  it("an external foreign key into schema simetra is reserved", () => {
    expect(
      rules(
        customTableSchema,
        table({
          columns: [{ name: "userId", type: "UUID" }],
          foreignKeys: [
            {
              columns: ["userId"],
              references: {
                external: {
                  schema: "simetra",
                  table: "identities",
                  columns: ["id"],
                },
              },
            },
          ],
        })
      )
    ).toEqual(["schema.reserved"])
  })

  it("accepts partial, expression and nulls-not-distinct indexes", () => {
    const res = customTableSchema.parse(
      table({
        columns: [{ name: "email", type: "Text" }],
        indexes: [
          {
            unique: true,
            keys: [{ expression: "lower(email)" }],
            where: "deleted_at IS NULL",
            nullsNotDistinct: true,
          },
        ],
      })
    )
    expect(res.indexes[0]).toMatchObject({ method: "btree", include: [] })
  })

  it("accepts identity always on BigInt", () => {
    expect(
      customTableSchema.safeParse(
        table({ columns: [{ name: "id", type: "BigInt", identity: "always" }] })
      ).success
    ).toBe(true)
  })

  it("rejects identity on Text", () => {
    expect(
      rules(
        customTableSchema,
        table({ columns: [{ name: "id", type: "Text", identity: "always" }] })
      )
    ).toContain("customTable.identity-type")
  })

  it("accepts PgEnum column by reference", () => {
    const res = customTableSchema.safeParse(
      table({
        columns: [
          {
            name: "status",
            type: "PgEnum",
            enum: { kind: "PgEnum", name: "OrderStatus" },
          },
        ],
      })
    )
    expect(res.success).toBe(true)
  })

  it("rejects PgEnum column without enum", () => {
    expect(
      rules(
        customTableSchema,
        table({ columns: [{ name: "s", type: "PgEnum" }] })
      )
    ).toEqual(["customTable.column-type"])
  })

  it("crossScope is an unknown key on a custom table column", () => {
    const cases = [
      { name: "a", type: "Text", crossScope: true },
      {
        name: "d",
        type: "Ref",
        ref: { kind: "Catalog", name: "X" },
        crossScope: true,
      },
      {
        name: "b",
        type: "PgEnum",
        enum: { kind: "PgEnum", name: "E" },
        crossScope: true,
      },
      { name: "c", type: "Raw", pgType: "citext", crossScope: true },
    ]
    for (const column of cases) {
      const res = customTableSchema.safeParse(table({ columns: [column] }))
      expect(res.success).toBe(false)
      expect(
        res.error?.issues.map((i) => [
          i.code,
          i.path.join("/"),
          (i as { keys?: string[] }).keys,
        ])
      ).toEqual([["unrecognized_keys", "columns/0", ["crossScope"]]])
    }
  })

  it("union variants of constraints and indexes stay strict without rejecting each other", () => {
    const valid = customTableSchema.safeParse(
      table({
        columns: [
          { name: "id", type: "BigInt" },
          { name: "ext", type: "UUID" },
        ],
        foreignKeys: [
          {
            columns: ["ext"],
            references: {
              external: { schema: "auth", table: "users", columns: ["id"] },
            },
          },
        ],
        indexes: [{ keys: [{ column: "id" }, { expression: "lower(x)" }] }],
      })
    )
    expect(valid.success).toBe(true)
    expect(valid.data?.foreignKeys[0]?.onDelete).toBe("noAction")
    expect(valid.data?.indexes[0]?.method).toBe("btree")

    const extra = customTableSchema.safeParse(
      table({
        uniques: [{ columns: ["id"], where: "id > 0" }],
        indexes: [{ keys: [{ column: "id", unique: true }] }],
      })
    )
    expect(
      extra.error?.issues.map((i) => [
        i.code,
        i.path.join("/"),
        (i as { keys?: string[] }).keys,
      ])
    ).toEqual([
      ["unrecognized_keys", "uniques/0", ["where"]],
      ["unrecognized_keys", "indexes/0/keys/0", ["unique"]],
    ])
  })

  it("accepts Raw pgType", () => {
    expect(
      customTableSchema.safeParse(
        table({ columns: [{ name: "c", type: "Raw", pgType: "citext" }] })
      ).success
    ).toBe(true)
  })

  it("rejects Raw together with length", () => {
    const res = customTableSchema.safeParse(
      table({
        columns: [{ name: "c", type: "Raw", pgType: "citext", length: 10 }],
      })
    )
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues[0]).toMatchObject({
        path: ["columns", 0, "length"],
        params: { rule: "customTable.column-type" },
      })
    }
  })

  it("rejects Raw without pgType and logical type with pgType", () => {
    expect(
      rules(customTableSchema, table({ columns: [{ name: "c", type: "Raw" }] }))
    ).toEqual(["customTable.column-type"])
    expect(
      rules(
        customTableSchema,
        table({ columns: [{ name: "c", type: "Text", pgType: "text" }] })
      )
    ).toEqual(["customTable.column-type"])
  })

  it("still applies logical type rules to columns", () => {
    expect(
      rules(
        customTableSchema,
        table({ columns: [{ name: "c", type: "String" }] })
      )
    ).toEqual(["type.length-required"])
  })

  it("rowLevelSecurity defaults to off and accepts enabled and forced only", () => {
    expect(customTableSchema.parse(base).rowLevelSecurity).toBe("off")
    for (const value of ["enabled", "forced"]) {
      expect(
        customTableSchema.parse(table({ rowLevelSecurity: value }))
          .rowLevelSecurity
      ).toBe(value)
    }
    expect(
      customTableSchema.safeParse(table({ rowLevelSecurity: "on" })).success
    ).toBe(false)
  })

  it("custom table has no derived settings", () => {
    expect(customTableSchema.shape).not.toHaveProperty("autoAddPrimaryKey")
    expect(customTableSchema.shape).not.toHaveProperty(
      "standardAttributeOverrides"
    )
  })
})

describe("pgEnumSchema", () => {
  it("keeps value order", () => {
    const res = pgEnumSchema.parse({
      kind: "PgEnum",
      name: "OrderStatus",
      values: ["new", "paid", "shipped"],
    })
    expect(res.values).toEqual(["new", "paid", "shipped"])
  })

  it("rejects duplicate values", () => {
    expect(
      rules(pgEnumSchema, {
        kind: "PgEnum",
        name: "OrderStatus",
        values: ["new", "paid", "new"],
      })
    ).toEqual(["pgEnum.value-duplicate"])
  })

  it("requires at least one value", () => {
    expect(
      pgEnumSchema.safeParse({ kind: "PgEnum", name: "E", values: [] }).success
    ).toBe(false)
  })
})
