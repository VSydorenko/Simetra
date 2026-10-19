import { describe, it, expect } from "vitest"
import { logicalTypeOf, pgTypeOf } from "../physical"
import { LOGICAL_TYPES, type ValueType } from "../schemas"

const NO_ENUMS: ReadonlySet<string> = new Set()

// Параметрні набори виведено з LOGICAL_TYPES: новий логічний тип без набору
// валить тест, а не лишається неперевіреним.
const PARAMETERS: Record<(typeof LOGICAL_TYPES)[number], Partial<ValueType>[]> =
  {
    UUID: [{}],
    String: [{ length: 1 }, { length: 50 }, { length: 10485760 }],
    Text: [{}],
    Integer: [{}],
    SmallInt: [{}],
    BigInt: [{}],
    Numeric: [
      {},
      { precision: 10 },
      { precision: 12, scale: 0 },
      { precision: 15, scale: 2 },
      { precision: 4, scale: 4 },
    ],
    Boolean: [{}],
    Date: [{}],
    DateTime: [{}],
    Bytes: [{}],
    Json: [{}],
    Ref: [{}],
  }

const values: ValueType[] = LOGICAL_TYPES.flatMap((type) =>
  PARAMETERS[type].flatMap((p) => [
    { type, ...p } as ValueType,
    { type, ...p, array: true } as ValueType,
  ])
)

describe("logicalTypeOf", () => {
  it("inverse of pgTypeOf is exact", () => {
    for (const v of values) {
      const pg = pgTypeOf(v)
      const back = logicalTypeOf(pg, NO_ENUMS)
      expect(back.form, pg).toBe("logical")
      if (back.form === "logical") expect(pgTypeOf(back.value)).toBe(pg)
    }
  })

  it("uuid is UUID", () => {
    expect(logicalTypeOf("uuid", NO_ENUMS)).toEqual({
      form: "logical",
      value: { type: "UUID" },
    })
  })

  it("reads parameters", () => {
    expect(logicalTypeOf("character varying(50)", NO_ENUMS)).toEqual({
      form: "logical",
      value: { type: "String", length: 50 },
    })
    expect(logicalTypeOf("numeric(15,2)", NO_ENUMS)).toEqual({
      form: "logical",
      value: { type: "Numeric", precision: 15, scale: 2 },
    })
    expect(logicalTypeOf("text[]", NO_ENUMS)).toEqual({
      form: "logical",
      value: { type: "Text", array: true },
    })
  })

  it("numeric without scale", () => {
    // pgTypeOf друкує голе `numeric` лише для Numeric без precision;
    // `numeric(p)` вона не породжує (завжди `numeric(p,0)`), тож це не образ.
    expect(logicalTypeOf("numeric", NO_ENUMS)).toEqual({
      form: "logical",
      value: { type: "Numeric" },
    })
    expect(logicalTypeOf("numeric(10)", NO_ENUMS).form).toBe("raw")
  })

  it("unknown type is raw", () => {
    for (const pg of [
      "timestamp without time zone",
      "citext",
      "json",
      "character varying",
      "character(3)",
      "numeric(0,0)",
      "integer[][]",
      "character varying(0)",
      "public.mood",
    ]) {
      expect(logicalTypeOf(pg, NO_ENUMS)).toEqual({ form: "raw", pgType: pg })
    }
  })

  describe("enums", () => {
    const enums = new Set([
      "public.order_status",
      "app.Mood Ring",
      "app.kind",
      "other.kind",
    ])

    it("enum in scope is the physical pair", () => {
      expect(logicalTypeOf("public.order_status", enums)).toEqual({
        form: "enum",
        schema: "public",
        name: "order_status",
      })
      expect(logicalTypeOf("order_status", enums)).toEqual({
        form: "enum",
        schema: "public",
        name: "order_status",
      })
      expect(logicalTypeOf('app."Mood Ring"', enums)).toEqual({
        form: "enum",
        schema: "app",
        name: "Mood Ring",
      })
    })

    it("an ambiguous unqualified name is raw", () => {
      expect(logicalTypeOf("kind", enums).form).toBe("raw")
    })

    it("an enum array and an unknown enum are raw", () => {
      expect(logicalTypeOf("public.order_status[]", enums).form).toBe("raw")
      expect(logicalTypeOf("public.other", enums).form).toBe("raw")
    })
  })
})
