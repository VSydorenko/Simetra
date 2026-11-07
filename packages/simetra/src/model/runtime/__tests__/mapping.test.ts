import { describe, expect, it } from "vitest"
import type { WireOperation } from "../envelope"
import type { CommandError } from "../errors"
import {
  catalogIndex,
  changesFromWire,
  changesToWire,
  errorFromWire,
  errorToWire,
  operationFromWire,
  operationToWire,
} from "../mapping"
import type { Operation } from "../operation"
import type { Change } from "../result"
import {
  MEMBERSHIP_ID,
  OBJECT_ID,
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
