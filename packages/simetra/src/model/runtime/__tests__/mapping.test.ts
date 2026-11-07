import { describe, expect, it } from "vitest"
import type { WireOperation, WireReadQuery, WireReadResult } from "../envelope"
import type { CommandError } from "../errors"
import {
  catalogIndex,
  changesFromWire,
  changesToWire,
  errorFromWire,
  errorToWire,
  operationFromWire,
  operationToWire,
  readQueryFromWire,
  readQueryToWire,
  readResultFromWire,
  readResultToWire,
} from "../mapping"
import type { Operation } from "../operation"
import type { ReadQuery, ReadResult } from "../read"
import type { Change } from "../result"
import { WireDecodeError, WireEncodeError } from "../wire"
import {
  MEMBERSHIP_ID,
  OBJECT_ID,
  ORGANIZATION_ID,
  SECTION_ID,
  catalogEntry,
  catalogEntryAttribute,
  catalogEntrySection,
} from "./entries"

const ID = "11111111-1111-4111-8111-111111111111"
const LINE_ID = "22222222-2222-4222-8222-222222222222"
const LINE_ID_2 = "33333333-3333-4333-8333-333333333333"
const TARGET_ID = "44444444-4444-4444-8444-444444444444"
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000999"
const TASK = { kind: "Catalog", name: "Task" } as const

const base = catalogEntry()
// Колонки відмінні від імен (`title_col`, `qty_col`), `BigInt` — для значень,
// які мапінг передає як є: тест бачить і переклад імені, і переклад значення.
const task = catalogEntry({
  creatorMembership: MEMBERSHIP_ID,
  attributes: [
    ...base.attributes.map((a) =>
      a.name === "title" ? { ...a, column: "title_col" } : a
    ),
    catalogEntryAttribute({
      name: "amount",
      column: "amount_col",
      type: "BigInt",
      maxLength: undefined,
    }),
  ],
  tabularSections: [
    catalogEntrySection({
      attributes: catalogEntrySection().attributes.map((a) =>
        a.name === "qty" ? { ...a, column: "qty_col" } : a
      ),
    }),
  ],
})

const membership = catalogEntry({
  id: MEMBERSHIP_ID,
  name: "Member",
  key: "member_id",
  attributes: [
    catalogEntryAttribute({ name: "user", column: "user_id", type: "UUID" }),
  ],
  tabularSections: [],
})

const index = catalogIndex([task, membership])

const createOp: Operation = {
  action: "create",
  object: TASK,
  values: {
    org: ID,
    title: "a",
    status: "Open",
    subject: { type: "Catalog.Project", id: TARGET_ID },
    amount: 12n,
  },
  tabularSections: {
    lines: [
      { ref: LINE_ID, qty: 1, comment: "x" },
      { ref: LINE_ID_2, qty: 2 },
    ],
  },
  creatorMember: { user: ID },
}

const createWire: WireOperation = {
  action: "create",
  object: OBJECT_ID,
  values: {
    org_id: ID,
    title_col: "a",
    status: "open",
    subject_type: "project",
    subject_id: TARGET_ID,
    amount_col: "12",
  },
  tabularSections: {
    [SECTION_ID]: [
      { id: LINE_ID, qty_col: 1, comment: "x" },
      { id: LINE_ID_2, qty_col: 2 },
    ],
  },
  creatorMember: { user_id: ID },
}

describe("operationToWire / operationFromWire", () => {
  it("maps a create with a pair, an enumeration, two lines and creatorMember", () => {
    expect(operationToWire(index, createOp)).toEqual({
      ok: true,
      value: createWire,
    })
    // `BigInt` сервер отримує текстом: його приводить валідація `runtime.run`.
    expect(operationFromWire(index, createWire)).toEqual({
      ok: true,
      value: {
        ...createOp,
        values: { ...createOp.values, amount: "12" },
      },
    })
  })

  it.each<[string, Operation, WireOperation]>([
    [
      "update",
      {
        action: "update",
        object: TASK,
        id: ID,
        expectedVersion: 3,
        values: { title: "b" },
        tabularSections: { lines: [] },
      },
      {
        action: "update",
        object: OBJECT_ID,
        id: ID,
        expectedVersion: 3,
        values: { title_col: "b" },
        tabularSections: { [SECTION_ID]: [] },
      },
    ],
    [
      "markDeletion",
      {
        action: "markDeletion",
        object: TASK,
        id: ID,
        expectedVersion: 1,
        mark: true,
      },
      {
        action: "markDeletion",
        object: OBJECT_ID,
        id: ID,
        expectedVersion: 1,
        mark: true,
      },
    ],
    [
      "delete",
      { action: "delete", object: TASK, id: ID, expectedVersion: 2 },
      { action: "delete", object: OBJECT_ID, id: ID, expectedVersion: 2 },
    ],
  ])("maps %s both ways", (_, logical, wire) => {
    expect(operationToWire(index, logical)).toEqual({ ok: true, value: wire })
    expect(operationFromWire(index, wire)).toEqual({ ok: true, value: logical })
  })

  it("leaves a field absent from values or a line absent, not null (В9)", () => {
    const logical: Operation = {
      action: "update",
      object: TASK,
      id: ID,
      expectedVersion: 1,
      values: { title: "a" },
      tabularSections: { lines: [{ ref: LINE_ID }] },
    }
    const mapped = operationToWire(index, logical)
    expect(mapped).toEqual({
      ok: true,
      value: {
        action: "update",
        object: OBJECT_ID,
        id: ID,
        expectedVersion: 1,
        values: { title_col: "a" },
        tabularSections: { [SECTION_ID]: [{ id: LINE_ID }] },
      },
    })
    if (!mapped.ok) return
    expect(operationFromWire(index, mapped.value)).toEqual({
      ok: true,
      value: logical,
    })
  })

  // Ім'я з прототипу в каталозі: успадкована властивість входу — не поле.
  it("treats an inherited name of a catalog attribute as absent", () => {
    const odd = catalogEntry({
      attributes: [
        catalogEntryAttribute({ name: "constructor", column: "ctor_col" }),
        catalogEntryAttribute({ name: "ctorName", column: "constructor" }),
      ],
      tabularSections: [],
    })
    const oddIndex = catalogIndex([odd])
    const op: Operation = {
      action: "update",
      object: TASK,
      id: ID,
      expectedVersion: 1,
      values: {},
    }
    const wire: WireOperation = { ...op, object: OBJECT_ID, values: {} }
    expect(operationToWire(oddIndex, op)).toEqual({ ok: true, value: wire })
    expect(operationFromWire(oddIndex, wire)).toEqual({ ok: true, value: op })
  })

  it("passes a malformed BigInt to the server as is", () => {
    const mapped = operationFromWire(index, {
      ...createWire,
      values: { amount_col: "abc" },
    })
    expect(mapped).toEqual({
      ok: true,
      value: { ...createOp, values: { amount: "abc" } },
    })
  })

  it.each<[string, WireOperation, string]>([
    [
      "an unknown label",
      { action: "create", object: OBJECT_ID, values: { status: "pending" } },
      "status",
    ],
    [
      "a logical name instead of a label",
      { action: "create", object: OBJECT_ID, values: { status: "Open" } },
      "status",
    ],
    [
      "an unknown pair label",
      {
        action: "create",
        object: OBJECT_ID,
        values: { subject_type: "nope", subject_id: TARGET_ID },
      },
      "subject",
    ],
    [
      "a pair without its label",
      {
        action: "create",
        object: OBJECT_ID,
        values: { subject_id: TARGET_ID },
      },
      "subject",
    ],
    [
      "a pair without its id",
      {
        action: "create",
        object: OBJECT_ID,
        values: { subject_type: "project" },
      },
      "subject",
    ],
    [
      "creatorMember of an object without a membership catalog",
      { action: "create", object: MEMBERSHIP_ID, creatorMember: {} },
      "creatorMember",
    ],
  ])(
    "operationFromWire: %s is invalid at the logical path",
    (_, wire, path) => {
      expect(operationFromWire(index, wire)).toEqual({
        ok: false,
        invalid: { code: "command.invalid", path },
      })
    }
  )

  it.each<[string, Operation, string]>([
    [
      "a BigInt of the wrong type",
      { action: "create", object: TASK, values: { amount: 1.5 } },
      "amount",
    ],
    [
      "a line value of the wrong type",
      {
        action: "create",
        object: TASK,
        tabularSections: { lines: [{ ref: LINE_ID, qty: "x" }] },
      },
      "lines.0.qty",
    ],
  ])("operationToWire: %s is invalid at the logical path", (_, op, path) => {
    expect(operationToWire(index, op)).toEqual({
      ok: false,
      invalid: { code: "command.invalid", path },
    })
  })

  it.each<[string, WireOperation, object]>([
    [
      "an unknown object",
      { action: "create", object: UNKNOWN_ID },
      { object: UNKNOWN_ID },
    ],
    [
      "an unknown section id",
      {
        action: "create",
        object: OBJECT_ID,
        tabularSections: { [UNKNOWN_ID]: [] },
      },
      { object: OBJECT_ID, section: UNKNOWN_ID },
    ],
    [
      "an unknown header column",
      { action: "create", object: OBJECT_ID, values: { title: "a" } },
      { object: OBJECT_ID, column: "title" },
    ],
    [
      "an unknown line column",
      {
        action: "create",
        object: OBJECT_ID,
        tabularSections: { [SECTION_ID]: [{ qty: 1 }] },
      },
      { object: OBJECT_ID, section: SECTION_ID, column: "qty" },
    ],
    [
      "an unknown member column",
      { action: "create", object: OBJECT_ID, creatorMember: { user: ID } },
      { object: MEMBERSHIP_ID, column: "user" },
    ],
  ])("operationFromWire: %s is unknown", (_, wire, unknown) => {
    expect(operationFromWire(index, wire)).toEqual({ ok: false, unknown })
  })

  it.each<[string, Operation, object]>([
    [
      "an unknown object",
      { action: "create", object: { kind: "Catalog", name: "Nope" } },
      { object: "Catalog.Nope" },
    ],
    [
      "an unknown attribute",
      { action: "create", object: TASK, values: { title_col: "a" } },
      { object: OBJECT_ID, name: "title_col" },
    ],
    [
      "an unknown section",
      { action: "create", object: TASK, tabularSections: { nope: [] } },
      { object: OBJECT_ID, name: "nope" },
    ],
    [
      "an unknown line attribute",
      {
        action: "create",
        object: TASK,
        tabularSections: { lines: [{ qty_col: 1 }] },
      },
      { object: OBJECT_ID, section: SECTION_ID, name: "qty_col" },
    ],
    [
      "an unknown member attribute",
      { action: "create", object: TASK, creatorMember: { user_id: ID } },
      { object: MEMBERSHIP_ID, name: "user_id" },
    ],
  ])("operationToWire: %s is unknown", (_, op, unknown) => {
    expect(operationToWire(index, op)).toEqual({ ok: false, unknown })
  })

  it.each(["__proto__", "constructor", "a.b", '"x'])(
    "a hostile name %s is unknown and leaves the prototype alone",
    (name) => {
      const json = JSON.stringify(name)
      const values = JSON.parse(`{${json}:{"title":"x"}}`) as Record<
        string,
        unknown
      >
      expect(
        operationToWire(index, { action: "create", object: TASK, values })
      ).toEqual({ ok: false, unknown: { object: OBJECT_ID, name } })
      expect(
        operationFromWire(index, {
          action: "create",
          object: OBJECT_ID,
          values,
        })
      ).toEqual({ ok: false, unknown: { object: OBJECT_ID, column: name } })
      expect(
        operationToWire(index, {
          action: "create",
          object: TASK,
          tabularSections: { lines: [values] },
        })
      ).toEqual({
        ok: false,
        unknown: { object: OBJECT_ID, section: SECTION_ID, name },
      })
      expect(
        operationFromWire(index, {
          action: "create",
          object: OBJECT_ID,
          tabularSections: JSON.parse(`{${json}:[]}`) as Record<
            string,
            Record<string, unknown>[]
          >,
        })
      ).toEqual({ ok: false, unknown: { object: OBJECT_ID, section: name } })
      expect(({} as Record<string, unknown>).title).toBeUndefined()
    }
  )
})

describe("errorToWire / errorFromWire", () => {
  it("maps the path and the attributes of a header, a pair and a section", () => {
    const logical: CommandError = {
      code: "command.constraint",
      kind: "unique",
      object: TASK,
      operation: "update",
      path: "lines.qty",
      attributes: ["title", "subject", "lines.qty"],
    }
    const wire = errorToWire(index, logical)
    expect(wire).toEqual({
      code: "command.constraint",
      kind: "unique",
      object: OBJECT_ID,
      operation: "update",
      path: `${SECTION_ID}.qty_col`,
      attributes: ["title_col", "subject_id", `${SECTION_ID}.qty_col`],
    })
    expect(errorFromWire(index, wire)).toEqual(logical)
  })

  it("keeps the path and the attributes of an error without an object", () => {
    const bare = {
      code: "command.invalid" as const,
      path: "lines.qty",
      attributes: ["title"],
    }
    expect(errorToWire(index, bare)).toEqual(bare)
    expect(errorFromWire(index, bare)).toEqual(bare)
  })
})

describe("changesToWire / changesFromWire", () => {
  it("maps the object of every change and keeps the rest", () => {
    const logical: Change[] = [
      {
        object: TASK,
        scopeKind: "k",
        scope: ID,
        id: ID,
        version: 2,
        operation: "update",
      },
      { object: TASK, id: LINE_ID, version: 1, operation: "create" },
    ]
    const wire = [
      {
        object: OBJECT_ID,
        scopeKind: "k",
        scope: ID,
        id: ID,
        version: 2,
        operation: "update" as const,
      },
      {
        object: OBJECT_ID,
        id: LINE_ID,
        version: 1,
        operation: "create" as const,
      },
    ]
    expect(changesToWire(index, logical)).toEqual({ ok: true, value: wire })
    expect(changesFromWire(index, wire)).toEqual({ ok: true, value: logical })
  })

  it("reports an unknown object of a change", () => {
    expect(
      changesFromWire(index, [
        { object: UNKNOWN_ID, id: ID, version: 1, operation: "create" },
      ])
    ).toEqual({ ok: false, unknown: { object: UNKNOWN_ID } })
  })
})

// Читання: ключ і версія з колонками, відмінними від імен, щоб переклад
// імені платформних полів був видимий; ціль `include` — довідник організацій.
const reader = { ...task, key: "task_id", versionColumn: "row_version" }
const organization = catalogEntry({
  id: ORGANIZATION_ID,
  name: "Organization",
  key: "org_key",
  attributes: [catalogEntryAttribute({ name: "title", column: "org_title" })],
  tabularSections: [],
})
const readIndex = catalogIndex([reader, organization])
const PROJECT = { type: "Catalog.Project", id: TARGET_ID }
const WIRE_PROJECT = { type: "project", id: TARGET_ID }

describe("readQueryToWire / readQueryFromWire", () => {
  // Третій елемент — логічна форма після повернення, коли вона інша:
  // `BigInt` сервер отримує текстом, як в операції.
  it.each<[string, ReadQuery, WireReadQuery, ReadQuery?]>([
    [
      "a list with and/or/not and every operator",
      {
        object: TASK,
        where: {
          and: [
            { attribute: "title", op: "eq", value: "a" },
            {
              or: [
                { attribute: "version", op: "gt", value: 3 },
                { attribute: "amount", op: "lte", value: 12n },
              ],
            },
            {
              not: { attribute: "status", op: "in", value: ["Open", "Closed"] },
            },
            { attribute: "subject", op: "ne", value: PROJECT },
            { attribute: "subject", op: "in", value: [PROJECT, null] },
            { attribute: "ref", op: "lt", value: ID },
            { attribute: "title", op: "gte", value: "b" },
            { attribute: "version", op: "lte", value: 9 },
            { attribute: "status", op: "isNull" },
            { attribute: "title", op: "contains", value: "x" },
            { attribute: "title", op: "startsWith", value: "y" },
            { attribute: "status", op: "eq", value: null },
          ],
        },
        orderBy: [
          { attribute: "title", direction: "asc", nulls: "last" },
          { attribute: "ref", direction: "desc" },
        ],
        offset: 10,
        limit: 50,
        include: ["org"],
      },
      {
        object: OBJECT_ID,
        where: {
          and: [
            { attribute: "title_col", op: "eq", value: "a" },
            {
              or: [
                { attribute: "row_version", op: "gt", value: "3" },
                { attribute: "amount_col", op: "lte", value: "12" },
              ],
            },
            {
              not: { attribute: "status", op: "in", value: ["open", "closed"] },
            },
            { attribute: "subject_id", op: "ne", value: WIRE_PROJECT },
            { attribute: "subject_id", op: "in", value: [WIRE_PROJECT, null] },
            { attribute: "task_id", op: "lt", value: ID },
            { attribute: "title_col", op: "gte", value: "b" },
            { attribute: "row_version", op: "lte", value: "9" },
            { attribute: "status", op: "isNull" },
            { attribute: "title_col", op: "contains", value: "x" },
            { attribute: "title_col", op: "startsWith", value: "y" },
            { attribute: "status", op: "eq", value: null },
          ],
        },
        orderBy: [
          { attribute: "title_col", direction: "asc", nulls: "last" },
          { attribute: "task_id", direction: "desc" },
        ],
        offset: 10,
        limit: 50,
        include: ["org_id"],
      },
      // Повернення: `BigInt` лишається текстом.
      undefined,
    ],
    [
      "a count of the object",
      {
        object: TASK,
        where: { attribute: "version", op: "eq", value: 1 },
        count: true,
      },
      {
        object: OBJECT_ID,
        where: { attribute: "row_version", op: "eq", value: "1" },
        count: true,
      },
    ],
    [
      "a card with named sections and include",
      { object: TASK, id: ID, tabularSections: ["lines"], include: ["org"] },
      {
        object: OBJECT_ID,
        id: ID,
        tabularSections: [SECTION_ID],
        include: ["org_id"],
      },
    ],
    [
      "a card with every section",
      { object: TASK, id: ID, tabularSections: true },
      { object: OBJECT_ID, id: ID, tabularSections: true },
    ],
    [
      "the lines of one owner",
      { object: TASK, tabularSection: "lines", owner: ID },
      { object: OBJECT_ID, tabularSection: SECTION_ID, owner: ID },
    ],
    [
      "a section as the target of a list",
      {
        object: TASK,
        tabularSection: "lines",
        where: {
          and: [
            { attribute: "parent", op: "eq", value: ID },
            { attribute: "qty", op: "gte", value: 2 },
            { attribute: "lineNumber", op: "lt", value: 5 },
            { attribute: "ref", op: "in", value: [LINE_ID] },
          ],
        },
        orderBy: [{ attribute: "lineNumber", direction: "asc" }],
        limit: 10,
      },
      {
        object: OBJECT_ID,
        tabularSection: SECTION_ID,
        where: {
          and: [
            { attribute: "parent_id", op: "eq", value: ID },
            { attribute: "qty_col", op: "gte", value: 2 },
            { attribute: "line_number", op: "lt", value: 5 },
            { attribute: "id", op: "in", value: [LINE_ID] },
          ],
        },
        orderBy: [{ attribute: "line_number", direction: "asc" }],
        limit: 10,
      },
    ],
    [
      "a count of a section",
      {
        object: TASK,
        tabularSection: "lines",
        where: { attribute: "comment", op: "isNull" },
        count: true,
      },
      {
        object: OBJECT_ID,
        tabularSection: SECTION_ID,
        where: { attribute: "comment", op: "isNull" },
        count: true,
      },
    ],
  ])("maps %s both ways", (_, logical, wire, back) => {
    expect(readQueryToWire(readIndex, logical)).toEqual({
      ok: true,
      value: wire,
    })
    const expected =
      back ??
      (JSON.parse(
        JSON.stringify(logical, (_key, value: unknown) =>
          typeof value === "bigint" ? String(value) : value
        )
      ) as ReadQuery)
    expect(readQueryFromWire(readIndex, wire)).toEqual({
      ok: true,
      value: expected,
    })
  })

  it.each<[string, WireReadQuery, object]>([
    [
      "an unknown object",
      { object: UNKNOWN_ID, limit: 1 },
      { object: UNKNOWN_ID },
    ],
    [
      "a filter by a logical name",
      {
        object: OBJECT_ID,
        where: { attribute: "title", op: "eq", value: "a" },
        limit: 1,
      },
      { object: OBJECT_ID, column: "title" },
    ],
    [
      "a filter by the label column of a pair",
      {
        object: OBJECT_ID,
        where: { not: { attribute: "subject_type", op: "isNull" } },
        limit: 1,
      },
      { object: OBJECT_ID, column: "subject_type" },
    ],
    [
      "an unknown sort column",
      {
        object: OBJECT_ID,
        orderBy: [{ attribute: "nope", direction: "asc" }],
        limit: 1,
      },
      { object: OBJECT_ID, column: "nope" },
    ],
    [
      "an unknown include column",
      { object: OBJECT_ID, id: ID, include: ["org"] },
      { object: OBJECT_ID, column: "org" },
    ],
    [
      "an unknown section id of a card",
      { object: OBJECT_ID, id: ID, tabularSections: [UNKNOWN_ID] },
      { object: OBJECT_ID, section: UNKNOWN_ID },
    ],
    [
      "an unknown section id of a section list",
      { object: OBJECT_ID, tabularSection: UNKNOWN_ID, limit: 1 },
      { object: OBJECT_ID, section: UNKNOWN_ID },
    ],
    [
      "an unknown line column",
      {
        object: OBJECT_ID,
        tabularSection: SECTION_ID,
        where: { attribute: "qty", op: "eq", value: 1 },
        count: true,
      },
      { object: OBJECT_ID, section: SECTION_ID, column: "qty" },
    ],
    [
      "a hostile column",
      {
        object: OBJECT_ID,
        where: { attribute: "__proto__", op: "isNull" },
        limit: 1,
      },
      { object: OBJECT_ID, column: "__proto__" },
    ],
  ])("readQueryFromWire: %s is unknown", (_, wire, unknown) => {
    expect(readQueryFromWire(readIndex, wire)).toEqual({ ok: false, unknown })
  })

  it.each<[string, ReadQuery, object]>([
    [
      "an unknown object",
      { object: { kind: "Catalog", name: "Nope" }, limit: 1 },
      { object: "Catalog.Nope" },
    ],
    [
      "a filter by a physical column",
      {
        object: TASK,
        where: { attribute: "title_col", op: "isNull" },
        limit: 1,
      },
      { object: OBJECT_ID, name: "title_col" },
    ],
    [
      "an unknown section",
      { object: TASK, tabularSection: "nope", owner: ID },
      { object: OBJECT_ID, name: "nope" },
    ],
    [
      "an unknown section of a card",
      { object: TASK, id: ID, tabularSections: ["nope"] },
      { object: OBJECT_ID, name: "nope" },
    ],
    [
      "a header attribute in a section filter",
      {
        object: TASK,
        tabularSection: "lines",
        where: { attribute: "title", op: "isNull" },
        limit: 1,
      },
      { object: OBJECT_ID, section: SECTION_ID, name: "title" },
    ],
  ])("readQueryToWire: %s is unknown", (_, query, unknown) => {
    expect(readQueryToWire(readIndex, query)).toEqual({ ok: false, unknown })
  })

  const listWhere = (where: unknown) =>
    ({ object: OBJECT_ID, where, limit: 1 }) as WireReadQuery

  it.each<[string, WireReadQuery, string]>([
    [
      "an unknown label",
      listWhere({ attribute: "status", op: "eq", value: "pending" }),
      "where.value",
    ],
    [
      "a logical name instead of a label",
      listWhere({
        and: [{ attribute: "status", op: "in", value: ["open", "Open"] }],
      }),
      "where.and.0.value.1",
    ],
    [
      "an unknown pair label",
      listWhere({
        attribute: "subject_id",
        op: "eq",
        value: { ...WIRE_PROJECT, type: "nope" },
      }),
      "where.value",
    ],
    [
      "a pair target as a logical reference",
      listWhere({ not: { attribute: "subject_id", op: "eq", value: PROJECT } }),
      "where.not.value",
    ],
    [
      "a pair with an extra key",
      listWhere({
        attribute: "subject_id",
        op: "eq",
        value: { ...WIRE_PROJECT, extra: 1 },
      }),
      "where.value",
    ],
    [
      "a pair that is not an object",
      listWhere({ attribute: "subject_id", op: "eq", value: TARGET_ID }),
      "where.value",
    ],
    [
      "a version that is a number",
      listWhere({ attribute: "row_version", op: "eq", value: 3 }),
      "where.value",
    ],
    [
      "a version that is not an integer",
      listWhere({ attribute: "row_version", op: "eq", value: "3.5" }),
      "where.value",
    ],
    [
      "a version past a safe integer",
      listWhere({
        attribute: "row_version",
        op: "gt",
        value: "9007199254740993",
      }),
      "where.value",
    ],
  ])(
    "readQueryFromWire: %s is invalid at the logical path",
    (_, wire, path) => {
      expect(readQueryFromWire(readIndex, wire)).toEqual({
        ok: false,
        invalid: { code: "command.invalid", path },
      })
    }
  )

  it("passes a malformed BigInt to the server as is", () => {
    expect(
      readQueryFromWire(
        readIndex,
        listWhere({ attribute: "amount_col", op: "eq", value: "abc" })
      )
    ).toEqual({
      ok: true,
      value: {
        object: TASK,
        where: { attribute: "amount", op: "eq", value: "abc" },
        limit: 1,
      },
    })
  })

  it.each<[string, unknown, string]>([
    [
      "an unknown name",
      { attribute: "status", op: "eq", value: "Pending" },
      "where.value",
    ],
    [
      "an unknown pair target",
      {
        attribute: "subject",
        op: "in",
        value: [{ type: "Catalog.Nope", id: TARGET_ID }],
      },
      "where.value.0",
    ],
    [
      "a version that is not an integer",
      { attribute: "version", op: "eq", value: 1.5 },
      "where.value",
    ],
  ])("readQueryToWire: %s is invalid at the logical path", (_, where, path) => {
    expect(
      readQueryToWire(readIndex, { object: TASK, where, limit: 1 } as ReadQuery)
    ).toEqual({ ok: false, invalid: { code: "command.invalid", path } })
  })
})

describe("readResultToWire / readResultFromWire", () => {
  const row = { ref: ID, version: 2, title: "a", status: "Open", amount: 12n }
  const wireRow = {
    task_id: ID,
    row_version: "2",
    title_col: "a",
    status: "open",
    amount_col: "12",
  }
  const line = { ref: LINE_ID, parent: ID, lineNumber: 1, qty: 3 }
  const wireLine = { id: LINE_ID, parent_id: ID, line_number: "1", qty_col: 3 }
  const list: ReadQuery = { object: TASK, limit: 10, include: ["org"] }
  const ownerLines: ReadQuery = {
    object: TASK,
    tabularSection: "lines",
    owner: ID,
  }

  it.each<[string, ReadQuery, ReadResult, WireReadResult]>([
    [
      "a page with included targets",
      list,
      {
        rows: [row],
        included: { "Catalog.Organization": [{ ref: TARGET_ID, title: "o" }] },
      },
      {
        rows: [wireRow],
        included: {
          [ORGANIZATION_ID]: [{ org_key: TARGET_ID, org_title: "o" }],
        },
      },
    ],
    [
      "a card with its sections",
      { object: TASK, id: ID, tabularSections: true },
      { rows: [{ ...row, tabularSections: { lines: [line] } }] },
      { rows: [{ ...wireRow, tabularSections: { [SECTION_ID]: [wireLine] } }] },
    ],
    [
      "the lines of one owner with its version",
      ownerLines,
      { rows: [line], ownerVersion: 4 },
      { rows: [wireLine], ownerVersion: "4" },
    ],
    [
      "a section page",
      { object: TASK, tabularSection: "lines", limit: 5 },
      { rows: [line] },
      { rows: [wireLine] },
    ],
    ["a count", { object: TASK, count: true }, { count: 5 }, { count: 5 }],
    [
      "a capped section count",
      { object: TASK, tabularSection: "lines", count: true },
      { count: 10_000, capped: true },
      { count: 10_000, capped: true },
    ],
  ])("maps %s both ways", (_, query, logical, wire) => {
    expect(readResultToWire(readIndex, query, logical)).toEqual(wire)
    expect(readResultFromWire(readIndex, query, wire)).toEqual(logical)
  })

  // Рядок рантайму може нести момент у формі входу (дріб і зсув): дріт однаковий
  // для обох джерел — фіксованої ширини UTC, і в голові, і в рядку ТЧ.
  it("normalises a DateTime of a runtime row on the wire", () => {
    const at = catalogEntryAttribute({
      name: "at",
      column: "at_col",
      type: "DateTime",
    })
    const stamp = catalogEntry({
      name: "Stamp",
      attributes: [at],
      tabularSections: [catalogEntrySection({ attributes: [at] })],
    })
    const raw = "2026-11-07T15:30:00.5+05:30"
    const normal = "2026-11-07T10:00:00.500000Z"
    expect(
      readResultToWire(
        catalogIndex([stamp]),
        {
          object: { kind: "Catalog", name: "Stamp" },
          id: ID,
          tabularSections: true,
        },
        { rows: [{ at: raw, tabularSections: { lines: [{ at: raw }] } }] }
      )
    ).toEqual({
      rows: [
        {
          at_col: normal,
          tabularSections: { [SECTION_ID]: [{ at_col: normal }] },
        },
      ],
    })
  })

  // Старий клієнт переживає розширення моделі, як `decodeRow` з невідомою
  // колонкою: ціль, якої клієнтський каталог не знає, не валить читання.
  it("ignores included rows of an object the client does not know", () => {
    expect(
      readResultFromWire(readIndex, list, {
        rows: [],
        included: { [UNKNOWN_ID]: [{ id: ID }] },
      })
    ).toEqual({ rows: [], included: {} })
  })

  it("throws on an included object the server catalog does not know", () => {
    expect(() =>
      readResultToWire(readIndex, list, {
        rows: [],
        included: { "Catalog.Nope": [] },
      })
    ).toThrow(WireEncodeError)
  })

  it.each([3, "x", "9007199254740993"])(
    "refuses an ownerVersion %j that is not a safe integer text",
    (ownerVersion) => {
      expect(() =>
        readResultFromWire(readIndex, ownerLines, {
          rows: [],
          ownerVersion,
        } as WireReadResult)
      ).toThrow(WireDecodeError)
    }
  )
})
