import { describe, expect, it } from "vitest"
import { isTextEncodedType } from "../runtime"

describe("isTextEncodedType", () => {
  it.each(["bigint", "numeric(12,2)", "numeric", "numeric[]", "bigint[]"])(
    "encodes %s as text",
    (type) => {
      expect(isTextEncodedType(type)).toBe(true)
    }
  )

  it.each(["integer", "text", "numeric_x", "smallint", "jsonb"])(
    "keeps %s native",
    (type) => {
      expect(isTextEncodedType(type)).toBe(false)
    }
  )
})
