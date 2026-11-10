import { describe, expect, expectTypeOf, it } from "vitest"
import type { z } from "zod"
import { standardElementId } from "../../schemas/element-id"
import {
  dataRequestSchema,
  dataResponseSchema,
  versionValueSchema,
  wireChangeSchema,
  wireCommandErrorSchema,
  wireOperationSchema,
  wireReadPartSchema,
  wireReadPartsResultSchema,
  wireReadQuerySchema,
  wireReadResultSchema,
  type DataRequest,
  type WireReadPart,
  type WireReadParts,
  type WireReadQuery,
  type WireReadResult,
  type WireChange,
  type WireOperation,
  type WireCommandError,
} from "../envelope"
import type { CommandError } from "../errors"
import { READ_BATCH_MAX, type KnownVersions } from "../read"
import type { Change } from "../result"
import { OBJECT_ID, SECTION_ID } from "./entries"

const ID = "11111111-1111-4111-8111-111111111111"
const REF = { kind: "Catalog", name: "Task" }
const EPOCH = "0123456789abcdef".repeat(4)
const KNOWN = { epoch: EPOCH, keys: [ID], versions: ["3"] }

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

  it.each<[string, Record<string, unknown>]>([
    ["a list", { object: OBJECT_ID, limit: 10 }],
    ["a card", { object: OBJECT_ID, id: ID }],
  ])("wireReadQuerySchema: known on %s", (_, query) => {
    const parsed = wireReadQuerySchema.safeParse({ ...query, known: KNOWN })
    expect(parsed.data).toEqual({ ...query, known: KNOWN })
  })

  it("refuses a malformed known on a list at its path", () => {
    const parsed = wireReadQuerySchema.safeParse({
      object: OBJECT_ID,
      limit: 10,
      known: { ...KNOWN, versions: ["0"] },
    })
    expect(parsed.error?.issues[0]?.path).toEqual(["known", "versions", 0])
  })

  // `known` з `include` — B3-3: id цілей маркерного рядка будівнику ще не
  // відомі. Причина — щоб клієнт відрізнив форму від хибного поля.
  it.each<[string, Record<string, unknown>]>([
    ["a count", { object: OBJECT_ID, count: true }],
    [
      "a section page",
      { object: OBJECT_ID, tabularSection: SECTION_ID, limit: 1 },
    ],
    [
      "a section count",
      { object: OBJECT_ID, tabularSection: SECTION_ID, count: true },
    ],
    [
      "the lines of one owner",
      { object: OBJECT_ID, tabularSection: SECTION_ID, owner: ID },
    ],
    [
      "a card with sections",
      { object: OBJECT_ID, id: ID, tabularSections: true },
    ],
    [
      "a card with named sections",
      { object: OBJECT_ID, id: ID, tabularSections: [SECTION_ID] },
    ],
    ["a card with include", { object: OBJECT_ID, id: ID, include: ["org_id"] }],
    [
      "a list with include",
      { object: OBJECT_ID, limit: 1, include: ["org_id"] },
    ],
  ])("wireReadQuerySchema: known on %s is known-form", (_, query) => {
    const parsed = wireReadQuerySchema.safeParse({ ...query, known: KNOWN })
    const [issue] = parsed.error?.issues ?? []
    expect(issue?.path).toEqual(["known"])
    expect((issue as { params?: unknown } | undefined)?.params).toEqual({
      reason: "known-form",
    })
  })

  it.each<[string, boolean, unknown]>([
    [
      "a query",
      true,
      { type: "query", query: { object: OBJECT_ID, limit: 1, known: KNOWN } },
    ],
    [
      "a count query",
      true,
      { type: "query", query: { object: OBJECT_ID, count: true } },
    ],
    ["a version", true, { type: "version" }],
    ["a version with a query", false, { type: "version", query: {} }],
    ["a query without one", false, { type: "query" }],
    ["a rights part", false, { type: "rights" }],
    [
      "a logical query",
      false,
      { type: "query", query: { object: REF, limit: 1 } },
    ],
  ])("wireReadPartSchema: %s", (_, ok, value) => {
    expect(wireReadPartSchema.safeParse(value).success).toBe(ok)
  })

  it("keeps the known-form reason inside a part", () => {
    const parsed = wireReadPartSchema.safeParse({
      type: "query",
      query: { object: OBJECT_ID, count: true, known: KNOWN },
    })
    const [issue] = parsed.error?.issues ?? []
    expect(issue?.path).toEqual(["query", "known"])
    expect((issue as { params?: unknown } | undefined)?.params).toEqual({
      reason: "known-form",
    })
  })

  it("types a query part as a wire query with known", () => {
    expectTypeOf<
      Extract<WireReadPart, { type: "query" }>["query"]
    >().toEqualTypeOf<WireReadQuery>()
    expectTypeOf<
      Extract<WireReadQuery, { limit: number; tabularSection?: never }>
    >().toHaveProperty("known")
    expectTypeOf<
      Extract<WireReadQuery, { limit: number; tabularSection?: never }>["known"]
    >().toEqualTypeOf<KnownVersions | undefined>()
  })

  const HASH = "a".repeat(64)
  it.each<[string, boolean, unknown]>([
    [
      "rows with markers, a count, a version value and an error",
      true,
      {
        epoch: EPOCH,
        items: [
          { ok: true, value: { rows: [{ id: ID }, 0, { $known: 1 }] } },
          { ok: true, value: { count: 2 } },
          {
            ok: true,
            value: { snapshotHash: "h", objects: { [OBJECT_ID]: HASH } },
          },
          {
            ok: false,
            error: { code: "command.unavailable", reason: "batch-aborted" },
          },
        ],
      },
    ],
    [
      "a version-only response without an epoch",
      true,
      {
        epoch: null,
        items: [{ ok: true, value: { snapshotHash: "h", objects: {} } }],
      },
    ],
    [
      `${READ_BATCH_MAX} items`,
      true,
      {
        epoch: null,
        items: Array.from({ length: READ_BATCH_MAX }, () => ({
          ok: true,
          value: { count: 0 },
        })),
      },
    ],
    [
      `${READ_BATCH_MAX + 1} items`,
      false,
      {
        epoch: null,
        items: Array.from({ length: READ_BATCH_MAX + 1 }, () => ({
          ok: true,
          value: { count: 0 },
        })),
      },
    ],
    ["no items", false, { epoch: null, items: [] }],
    ["no epoch key", false, { items: [{ ok: true, value: { count: 0 } }] }],
    [
      "a short epoch",
      false,
      { epoch: "ab", items: [{ ok: true, value: { count: 0 } }] },
    ],
    [
      "an ok item with an error",
      false,
      {
        epoch: null,
        items: [
          { ok: true, value: { count: 0 }, error: { code: "command.invalid" } },
        ],
      },
    ],
    [
      "a value of another form",
      false,
      { epoch: null, items: [{ ok: true, value: { rows: [], count: 1 } }] },
    ],
  ])("wireReadPartsResultSchema: %s", (_, ok, value) => {
    expect(wireReadPartsResultSchema.safeParse(value).success).toBe(ok)
  })

  it("types a part value as a read result or a version value", () => {
    type Value = Extract<WireReadParts["items"][number], { ok: true }>["value"]
    expectTypeOf<Value>().toEqualTypeOf<
      WireReadResult | z.infer<typeof versionValueSchema>
    >()
    expectTypeOf<WireReadParts["epoch"]>().toEqualTypeOf<string | null>()
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
    ["an unchanged-row marker", true, { rows: [{ id: ID }, 0, 7] }],
    [
      "a partial marker with copy columns",
      true,
      { rows: [{ $known: 2, title_col: "a" }] },
    ],
    ["a negative marker", false, { rows: [-1] }],
    ["a fractional marker", false, { rows: [1.5] }],
    ["a marker as text", false, { rows: ["1"] }],
    // Форма передачі не знає колонки ключа: об'єкт з `$known` може бути й
    // повним рядком з фізичною колонкою `$known`. Хибний маркер відхиляє
    // декодер (`readResultFromWire`), який ключ знає.
    [
      "an object with a negative $known as a row",
      true,
      { rows: [{ $known: -1 }] },
    ],
    [
      "a marker among included rows",
      false,
      { rows: [], included: { [OBJECT_ID]: [0] } },
    ],
  ])("wireReadResultSchema: %s", (_, ok, value) => {
    expect(wireReadResultSchema.safeParse(value).success).toBe(ok)
  })
})

describe("data envelope", () => {
  const HASH = "a".repeat(64)
  const op = { action: "create", object: OBJECT_ID }
  const part = { type: "query", query: { object: OBJECT_ID, id: ID } }
  const read = { type: "read", items: [part] }
  const parts = (n: number) => ({
    subject: "s",
    request: { type: "read", items: Array.from({ length: n }, () => part) },
  })
  it.each([
    ["a read of one part", true, parts(1)],
    [`a read of ${READ_BATCH_MAX} parts`, true, parts(READ_BATCH_MAX)],
    ["a read of no parts", false, parts(0)],
    [`a read of ${READ_BATCH_MAX + 1} parts`, false, parts(READ_BATCH_MAX + 1)],
    // Частину перевіряє власна схема (обробник): конверт бере будь-яку, тож
    // хибна частина відмовляє лише собі.
    [
      "a read with an unknown part type",
      true,
      { subject: "s", request: { type: "read", items: [{ type: "x" }] } },
    ],
    // Без шимів: стара форма й окремий `version` — відмова (`stale-client`
    // ставить обробник).
    [
      "a read of one query",
      false,
      { subject: "s", request: { type: "read", query: part.query } },
    ],
    [
      "a version request",
      false,
      { subject: "s", request: { type: "version" } },
    ],
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
    ["a missing subject", false, { request: read }],
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

  it(`refuses more than ${READ_BATCH_MAX} parts with the batch limit reason`, () => {
    const parsed = dataRequestSchema.safeParse(parts(READ_BATCH_MAX + 1))
    // Запит — union видів: причину несе гілка `read` (на сервері її дістає
    // `decidingIssue`).
    const [union] = parsed.error?.issues ?? []
    expect(union?.code).toBe("invalid_union")
    const [issue] = (union as z.core.$ZodIssueInvalidUnion).errors[0] ?? []
    expect(issue?.path).toEqual(["items"])
    expect((issue as { params?: unknown } | undefined)?.params).toEqual({
      reason: "batch-too-large",
    })
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
