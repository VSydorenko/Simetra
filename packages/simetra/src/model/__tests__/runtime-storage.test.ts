import { describe, expect, it } from "vitest"
import { COMMAND_CORE_ERRORS, STORAGE_ERRORS, fileObjectKey } from "../runtime"

const OBJECT = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
const ROW = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c"

describe("fileObjectKey", () => {
  it("is o/<object>/<row>, derived from the two ids alone", () => {
    expect(fileObjectKey(OBJECT, ROW)).toBe(`o/${OBJECT}/${ROW}`)
  })

  it.each([
    ["a name for the object", "Attachment", ROW],
    ["a path in the row id", OBJECT, "../x"],
    ["an empty row id", OBJECT, ""],
    ["an uppercase id", OBJECT.toUpperCase(), ROW],
    ["a prefixed id", OBJECT, `${ROW}/x`],
  ])("refuses %s", (_name, objectId, rowId) => {
    expect(() => fileObjectKey(objectId, rowId)).toThrow()
  })
})

describe("STORAGE_ERRORS", () => {
  it("has its own errcode, apart from every command core one", () => {
    const core = [
      COMMAND_CORE_ERRORS.invalid.errcode,
      COMMAND_CORE_ERRORS.context.errcode,
      COMMAND_CORE_ERRORS.forbidden.errcode,
      COMMAND_CORE_ERRORS.conflict.errcode,
    ]
    expect(core).not.toContain(STORAGE_ERRORS.errcode)
    expect(STORAGE_ERRORS.errcode).toMatch(/^[0-9A-Z]{5}$/)
  })

  it("lists the three refusal reasons", () => {
    expect([
      STORAGE_ERRORS.attachMissing,
      STORAGE_ERRORS.attachInvalid,
      STORAGE_ERRORS.quotaExceeded,
    ]).toEqual(["attach-missing", "attach-invalid", "quota-exceeded"])
  })
})
