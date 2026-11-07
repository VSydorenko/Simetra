import { describe, expect, expectTypeOf, it } from "vitest"
import { standardElementId } from "../../schemas/element-id"
import {
  dataRequestSchema,
  dataResponseSchema,
  versionValueSchema,
  wireChangeSchema,
  wireCommandErrorSchema,
  wireOperationSchema,
  wireReadQuerySchema,
  wireReadResultSchema,
  type DataRequest,
  type WireChange,
  type WireOperation,
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
    // Форма передачі шле повні масиви ТЧ (`fullTabularArrays`): `deleteIds`
    // у ній немає, тож поле — відмова суворої схеми.
    [
      "an update with deleteIds",
      false,
      {
        action: "update",
        object: OBJECT_ID,
        id: ID,
        expectedVersion: 2,
        tabularSections: { [SECTION_ID]: [] },
        deleteIds: { [SECTION_ID]: [ID] },
      },
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

  const where = { attribute: "title_col", op: "eq", value: "a" }

  it.each([
    [
      "a card with section ids",
      true,
      {
        object: OBJECT_ID,
        id: ID,
        tabularSections: [SECTION_ID],
        include: ["org_id"],
      },
    ],
    [
      "a card with every section",
      true,
      { object: OBJECT_ID, id: ID, tabularSections: true },
    ],
    [
      "a list",
      true,
      {
        object: OBJECT_ID,
        where,
        orderBy: [{ attribute: "title_col", direction: "asc" }],
        limit: 10,
      },
    ],
    ["a count", true, { object: OBJECT_ID, where, count: true }],
    [
      "the lines of one owner",
      true,
      { object: OBJECT_ID, tabularSection: SECTION_ID, owner: ID },
    ],
    [
      "a standard section page",
      true,
      {
        object: OBJECT_ID,
        tabularSection: standardElementId(OBJECT_ID, { logicalName: "roles" }),
        limit: 1,
      },
    ],
    [
      "a section count",
      true,
      { object: OBJECT_ID, tabularSection: SECTION_ID, count: true },
    ],
    ["an object that is a reference", false, { object: REF, limit: 1 }],
    [
      "a section by name",
      false,
      { object: OBJECT_ID, tabularSection: "lines", owner: ID },
    ],
    [
      "a card section by name",
      false,
      { object: OBJECT_ID, id: ID, tabularSections: ["lines"] },
    ],
    ["a list without a limit", false, { object: OBJECT_ID, where }],
  ])("wireReadQuerySchema: %s", (_, ok, value) => {
    expect(wireReadQuerySchema.safeParse(value).success).toBe(ok)
  })

  it("keeps the path of a refusal inside a wire query form", () => {
    const parsed = wireReadQuerySchema.safeParse({
      object: OBJECT_ID,
      tabularSection: SECTION_ID,
      limit: 0,
    })
    expect(parsed.error?.issues[0]?.path).toEqual(["limit"])
  })

  it.each([
    [
      "rows with included by object id",
      true,
      { rows: [{ id: ID }], included: { [OBJECT_ID]: [] } },
    ],
    ["owner lines with a version text", true, { rows: [], ownerVersion: "3" }],
    ["a capped count", true, { count: 10, capped: true }],
    [
      "included by reference",
      false,
      { rows: [], included: { "Catalog.Task": [] } },
    ],
    ["a version that is a number", false, { rows: [], ownerVersion: 3 }],
    ["a negative count", false, { count: -1 }],
  ])("wireReadResultSchema: %s", (_, ok, value) => {
    expect(wireReadResultSchema.safeParse(value).success).toBe(ok)
  })
})

describe("data envelope", () => {
  const HASH = "a".repeat(64)
  const op = { action: "create", object: OBJECT_ID }
  const read = { type: "read", query: { object: OBJECT_ID, id: ID } }
  it.each([
    ["a read", true, { subject: "s", request: read }],
    ["a version", true, { subject: "s", request: { type: "version" } }],
    [
      "a run of one operation",
      true,
      { subject: "s", request: { type: "run", operation: op } },
    ],
    [
      "a run of a batch",
      true,
      { subject: "s", request: { type: "run", batch: [op] } },
    ],
    [
      "kernels on a run",
      true,
      {
        subject: "s",
        request: { type: "run", operation: op, kernels: { [OBJECT_ID]: HASH } },
      },
    ],
    [
      "kernels on a batch run",
      true,
      {
        subject: "s",
        request: { type: "run", batch: [op], kernels: { [OBJECT_ID]: HASH } },
      },
    ],
    [
      "operation and batch together",
      false,
      { subject: "s", request: { type: "run", operation: op, batch: [op] } },
    ],
    ["a run with neither", false, { subject: "s", request: { type: "run" } }],
    [
      "an empty batch",
      false,
      { subject: "s", request: { type: "run", batch: [] } },
    ],
    ["a rights request", false, { subject: "s", request: { type: "rights" } }],
    [
      "a bad kernel hash",
      false,
      {
        subject: "s",
        request: { type: "run", operation: op, kernels: { [OBJECT_ID]: "x" } },
      },
    ],
    ["a missing subject", false, { request: { type: "version" } }],
    [
      "an update carrying deleteIds",
      false,
      {
        subject: "s",
        request: {
          type: "run",
          operation: {
            action: "update",
            object: OBJECT_ID,
            id: ID,
            expectedVersion: 1,
            deleteIds: {},
          },
        },
      },
    ],
  ])("request: %s -> %s", (_name, ok, value) => {
    expect(dataRequestSchema.safeParse(value).success).toBe(ok)
  })

  it.each([
    ["ok", true, { ok: true, value: { rows: [] }, serverHash: HASH }],
    [
      "an error",
      true,
      { ok: false, error: { code: "command.invalid" }, serverHash: HASH },
    ],
    [
      "ok without value (the key is required)",
      false,
      { ok: true, serverHash: HASH },
    ],
    ["ok without serverHash", false, { ok: true, value: 1 }],
    ["an error without error", false, { ok: false, serverHash: HASH }],
  ])("response: %s -> %s", (_name, ok, value) => {
    expect(dataResponseSchema.safeParse(value).success).toBe(ok)
  })

  it("types a run as exactly one of operation and batch", () => {
    type Run = Extract<DataRequest["request"], { type: "run" }>
    // @ts-expect-error both forms together
    const both: Run = { type: "run", operation: op as WireOperation, batch: [] }
    // @ts-expect-error neither form
    const neither: Run = { type: "run" }
    expect([both, neither]).toHaveLength(2)
  })

  it("accepts more on a read page and a version value", () => {
    expect(
      wireReadResultSchema.safeParse({ rows: [], more: true }).success
    ).toBe(true)
    expect(
      wireReadResultSchema.safeParse({ rows: [], more: false }).success
    ).toBe(false)
    expect(
      versionValueSchema.safeParse({
        snapshotHash: "h",
        objects: { [OBJECT_ID]: HASH },
      }).success
    ).toBe(true)
    expect(
      versionValueSchema.safeParse({
        snapshotHash: "h",
        objects: { [OBJECT_ID]: "x" },
      }).success
    ).toBe(false)
  })
})
