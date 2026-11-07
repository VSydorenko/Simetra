import { describe, expect, expectTypeOf, it } from "vitest"
import { standardElementId } from "../../schemas/element-id"
import {
  wireChangeSchema,
  wireCommandErrorSchema,
  wireOperationSchema,
  type WireChange,
  type WireCommandError,
} from "../envelope"
import type { CommandError } from "../errors"
import type { Change } from "../result"
import { OBJECT_ID, SECTION_ID } from "./entries"

const ID = "11111111-1111-4111-8111-111111111111"
const REF = { kind: "Catalog", name: "Task" }

describe("wire schemas", () => {
  // Помилка й зміна — інтерфейси, не схеми: поле, додане до логічної форми
  // без форми передачі, має зламати перевірку типів.
  it("carry the same fields as the logical error and change", () => {
    expectTypeOf<keyof WireCommandError>().toEqualTypeOf<keyof CommandError>()
    expectTypeOf<keyof WireChange>().toEqualTypeOf<keyof Change>()
  })

  it.each([
    ["a create by object id", true, { action: "create", object: OBJECT_ID }],
    [
      "a create with physical values, member and sections by id",
      true,
      {
        action: "create",
        object: OBJECT_ID,
        values: { title_col: "a" },
        creatorMember: { user_id: ID },
        tabularSections: {
          [SECTION_ID]: [{ id: ID }],
          [standardElementId(OBJECT_ID, { logicalName: "roles" })]: [],
        },
      },
    ],
    [
      "an update",
      true,
      { action: "update", object: OBJECT_ID, id: ID, expectedVersion: 2 },
    ],
    [
      "a markDeletion",
      true,
      {
        action: "markDeletion",
        object: OBJECT_ID,
        id: ID,
        expectedVersion: 1,
        mark: true,
      },
    ],
    [
      "a delete",
      true,
      { action: "delete", object: OBJECT_ID, id: ID, expectedVersion: 1 },
    ],
    ["an object that is a reference", false, { action: "create", object: REF }],
    ["an object that is not a UUID", false, { action: "create", object: "x" }],
    [
      "a section key that is not an element id",
      false,
      { action: "create", object: OBJECT_ID, tabularSections: { lines: [] } },
    ],
    [
      "a version that is not an integer",
      false,
      { action: "delete", object: OBJECT_ID, id: ID, expectedVersion: "1" },
    ],
  ])("wireOperationSchema: %s", (_, ok, value) => {
    expect(wireOperationSchema.safeParse(value).success).toBe(ok)
  })

  it.each([
    ["a bare code", true, { code: "command.invalid" }],
    [
      "a constraint with physical fields",
      true,
      {
        code: "command.constraint",
        object: OBJECT_ID,
        operation: "update",
        kind: "unique",
        path: `${SECTION_ID}.qty`,
        attributes: ["title_col", `${SECTION_ID}.qty`],
      },
    ],
    [
      "a model mismatch",
      true,
      {
        code: "command.model-mismatch",
        hashes: { catalog: "a", applied: null },
      },
    ],
    ["an object reference", false, { code: "command.invalid", object: REF }],
    ["an unknown code", false, { code: "command.nope" }],
  ])("wireCommandErrorSchema: %s", (_, ok, value) => {
    expect(wireCommandErrorSchema.safeParse(value).success).toBe(ok)
  })

  it.each([
    [
      "a change by object id",
      true,
      { object: OBJECT_ID, id: ID, version: 1, operation: "create" },
    ],
    [
      "a scoped change",
      true,
      {
        object: OBJECT_ID,
        scopeKind: "k",
        scope: ID,
        id: ID,
        version: 2,
        operation: "update",
      },
    ],
    [
      "an object reference",
      false,
      { object: REF, id: ID, version: 1, operation: "create" },
    ],
  ])("wireChangeSchema: %s", (_, ok, value) => {
    expect(wireChangeSchema.safeParse(value).success).toBe(ok)
  })
})
