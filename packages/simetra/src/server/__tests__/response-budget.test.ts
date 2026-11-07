import {
  BATCH_MAX,
  catalogIndex,
  jsonBytes,
  LIMIT_REASONS,
  RESPONSE_BUDGET_BYTES,
  type WireChange,
  type WireOperation,
  type WireReadQuery,
  type WireReadResult,
  type WireRow,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { fitResponse, fitRunResult } from "../response-budget"
import { ID, link, region, sample } from "./fixtures"

const index = catalogIndex([sample, region, link])
const HASH = "hash-1"
const SECTION = sample.tabularSections[0]!.id
const TOO_LARGE = {
  code: "command.invalid",
  reason: LIMIT_REASONS.responseTooLarge,
}
const MIB = 1024 * 1024

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

/** Розмір відповіді так, як її серіалізує обробник. */
const responseSize = (value: unknown, serverHash = HASH) =>
  jsonBytes({ ok: true, value, serverHash })

// Рядок посилань: `code` — наповнювач заданої довжини, `region_id` — ціль.
const linkRow = (
  n: number,
  bytes: number,
  target = uuid(1000 + n)
): WireRow => ({
  id: uuid(n),
  version: "1",
  code: "x".repeat(bytes),
  region_id: target,
})
const regionRow = (id: string, bytes = 10): WireRow => ({
  id,
  version: "1",
  code: "r".repeat(bytes),
})

const linkPage = (fields: object = {}) =>
  ({
    object: link.id,
    limit: 200,
    include: ["region_id"],
    ...fields,
  }) as WireReadQuery

describe("fitResponse: сторінка", () => {
  it("відповідь у межах бюджету — без змін", () => {
    const result: WireReadResult = { rows: [linkRow(1, 10)], included: {} }
    expect(fitResponse(index, linkPage(), result, HASH)).toBe(result)
  })

  it("найдовший непорожній префікс з more і included лише лишених рядків", () => {
    // Чотири рядки по ~1 МіБ уміщуються, п'ятий — ні.
    const rows = [1, 2, 3, 4, 5, 6].map((n) => linkRow(n, 1_000_000))
    // Ціль, на яку не посилається жоден рядок, теж відкидається.
    const targets = [...rows.map((r) => r.region_id as string), uuid(9999)]
    const result: WireReadResult = {
      rows,
      included: { [region.id]: targets.map((id) => regionRow(id)) },
    }
    const fitted = fitResponse(index, linkPage(), result, HASH)
    expect(fitted).toStrictEqual({
      rows: rows.slice(0, 4),
      included: { [region.id]: targets.slice(0, 4).map((id) => regionRow(id)) },
      more: true,
    })
    expect(responseSize(fitted)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES)
  })

  it("дві колонки на ту саму ціль — рядок цілі один раз", () => {
    const target = uuid(77)
    const rows = [1, 2, 3, 4, 5].map((n) => ({
      ...linkRow(n, 1_000_000, target),
      backup_id: target,
    }))
    const result: WireReadResult = {
      rows,
      included: { [region.id]: [regionRow(target)] },
    }
    const fitted = fitResponse(
      index,
      linkPage({ include: ["region_id", "backup_id"] }),
      result,
      HASH
    )
    expect(fitted).toStrictEqual({
      rows: rows.slice(0, 4),
      included: { [region.id]: [regionRow(target)] },
      more: true,
    })
  })

  it("великий рядок included посеред сторінки зупиняє префікс", () => {
    const rows = [1, 2, 3].map((n) => linkRow(n, MIB))
    const result: WireReadResult = {
      rows,
      included: {
        [region.id]: rows.map((r, i) =>
          regionRow(r.region_id as string, i === 1 ? 3 * MIB : 10)
        ),
      },
    }
    expect(fitResponse(index, linkPage(), result, HASH)).toStrictEqual({
      rows: rows.slice(0, 1),
      included: { [region.id]: [regionRow(rows[0]!.region_id as string)] },
      more: true,
    })
  })

  it("сторінка ТЧ з ownerVersion — префікс з more", () => {
    const line = (n: number) => ({
      id: uuid(n),
      parent_id: ID,
      line_number: String(n),
      extra_col: "y".repeat(MIB),
    })
    const rows = [1, 2, 3, 4, 5].map(line)
    const fitted = fitResponse(
      index,
      {
        object: sample.id,
        tabularSection: SECTION,
        limit: 200,
        where: { attribute: "parent_id", op: "eq", value: ID },
      } as WireReadQuery,
      { rows, ownerVersion: "7" },
      HASH
    )
    expect(fitted).toStrictEqual({
      rows: rows.slice(0, 3),
      ownerVersion: "7",
      more: true,
    })
  })

  it("перший рядок понад бюджет — response-too-large", () => {
    const result: WireReadResult = { rows: [linkRow(1, 5 * MIB)] }
    expect(fitResponse(index, linkPage(), result, HASH)).toStrictEqual(
      TOO_LARGE
    )
  })
})

describe("fitResponse: без обрізання", () => {
  const over: WireReadResult = {
    rows: [1, 2, 3, 4, 5].map((n) => linkRow(n, MIB)),
  }
  const key = (where: object) => linkPage({ where })

  it.each<[string, WireReadQuery]>([
    ["eq за ключем", key({ attribute: "id", op: "eq", value: uuid(1) })],
    [
      "in за ключем",
      key({ attribute: "id", op: "in", value: [uuid(1), uuid(2)] }),
    ],
    [
      "in за ключем глибоко в or і not",
      key({
        and: [
          { attribute: "code", op: "isNull" },
          { or: [{ not: { attribute: "id", op: "in", value: [uuid(1)] } }] },
        ],
      }),
    ],
    ["картка", { object: link.id, id: uuid(1) } as WireReadQuery],
    [
      "ТЧ власника",
      {
        object: sample.id,
        tabularSection: SECTION,
        owner: ID,
      } as WireReadQuery,
    ],
    [
      "сторінка ТЧ з in за ключем рядка",
      {
        object: sample.id,
        tabularSection: SECTION,
        limit: 10,
        where: { attribute: "id", op: "in", value: [uuid(1)] },
      } as WireReadQuery,
    ],
  ])("%s — response-too-large", (_, query) => {
    expect(fitResponse(index, query, over, HASH)).toStrictEqual(TOO_LARGE)
  })

  it("ne за ключем — сторінка, обрізається", () => {
    const fitted = fitResponse(
      index,
      key({ attribute: "id", op: "ne", value: uuid(1) }),
      over,
      HASH
    )
    expect(fitted).toMatchObject({ more: true })
  })

  it("лічильник — без змін", () => {
    const count: WireReadResult = { count: 3 }
    const query = { object: link.id, count: true } as WireReadQuery
    expect(fitResponse(index, query, count, HASH)).toBe(count)
  })
})

describe("fitResponse: межу перетинають неповторні поля", () => {
  // Наповнювач рівно до межі з коротким значенням поля: на один байт
  // довше — понад бюджет. Так тест ловить і лінійний підрахунок, і поле,
  // яке база загубила.
  const exact = <T extends WireReadResult>(
    shape: (filler: string) => T,
    hash: string
  ): T => {
    const base = responseSize(shape(""), hash)
    return shape("z".repeat(RESPONSE_BUDGET_BYTES - base))
  }
  const card = { object: link.id, id: uuid(1) } as WireReadQuery

  it("serverHash", () => {
    const shape = (code: string): WireReadResult => ({
      rows: [{ ...linkRow(1, 0), code }],
      included: { [region.id]: [regionRow(uuid(1001))] },
    })
    const result = exact(shape, "h")
    expect(responseSize(result, "h")).toBe(RESPONSE_BUDGET_BYTES)
    expect(fitResponse(index, card, result, "h")).toBe(result)
    expect(fitResponse(index, card, result, "hh")).toStrictEqual(TOO_LARGE)
  })

  it("ownerVersion", () => {
    const owner = {
      object: sample.id,
      tabularSection: SECTION,
      owner: ID,
    } as WireReadQuery
    const shape = (extra: string): WireReadResult => ({
      rows: [{ id: uuid(1), extra_col: extra }, { id: uuid(2) }],
      ownerVersion: "9",
    })
    const result = exact(shape, HASH)
    expect(fitResponse(index, owner, result, HASH)).toBe(result)
    expect(
      fitResponse(index, owner, { ...result, ownerVersion: "10" }, HASH)
    ).toStrictEqual(TOO_LARGE)
  })

  it("more: перший рядок уміщується лише без more — response-too-large", () => {
    const shape = (code: string) => ({
      rows: [{ ...linkRow(1, 0), code }],
    })
    const first = exact(shape, HASH).rows
    // Без `more` відповідь з першим рядком рівно в межі; другий рядок
    // змушує різати, а обрізана відповідь несе `more` і вже не вміщується.
    const result: WireReadResult = { rows: [...first, linkRow(2, 0)] }
    expect(fitResponse(index, linkPage(), result, HASH)).toStrictEqual(
      TOO_LARGE
    )
  })
})

describe("fitRunResult", () => {
  const update = (object: string): WireOperation => ({
    action: "update",
    object,
    id: ID,
    expectedVersion: 1,
  })
  const change = (n: number): WireChange => ({
    object: link.id,
    id: uuid(n),
    version: 1,
    operation: "update",
  })

  it("рядки — без лінивих колонок і без ТЧ", () => {
    const rows: WireRow[] = [
      { id: ID, version: "2", code: "a", archive_id: uuid(5) },
      {
        id: ID,
        version: "3",
        code_col: "b",
        tabularSections: { [SECTION]: [] },
      },
    ]
    const result = { rows, changes: [change(1), change(2)] }
    expect(
      fitRunResult(index, [update(link.id), update(sample.id)], result, HASH)
    ).toStrictEqual({
      rows: [
        { id: ID, version: "2", code: "a" },
        { id: ID, version: "3", code_col: "b" },
      ],
      changes: result.changes,
    })
  })

  it("понад бюджет — без rows", () => {
    const rows: WireRow[] = [{ id: ID, code: "x".repeat(5 * MIB) }]
    const changes = [change(1)]
    expect(
      fitRunResult(index, [update(link.id)], { rows, changes }, HASH)
    ).toStrictEqual({ changes })
  })

  it("ліниві колонки не рахуються в бюджет", () => {
    const rows: WireRow[] = [{ id: ID, archive_id: "x".repeat(5 * MIB) }]
    expect(
      fitRunResult(index, [update(link.id)], { rows, changes: [] }, HASH)
    ).toStrictEqual({ rows: [{ id: ID }], changes: [] })
  })

  it.each<[string, WireOperation[], WireRow[]]>([
    [
      "рядків менше за операції",
      [update(link.id), update(link.id)],
      [{ id: ID }],
    ],
    ["рядків більше за операції", [update(link.id)], [{ id: ID }, { id: ID }]],
    ["об'єкт поза каталогом", [update(uuid(4242))], [{ id: ID }]],
  ])("%s — виняток (дефект сервера)", (_, operations, rows) => {
    expect(() =>
      fitRunResult(index, operations, { rows, changes: [] }, HASH)
    ).toThrow()
  })

  it("найбільший набір changes уміщується в бюджет", () => {
    // Фази пакета й `ctx.run` — до BATCH_MAX кожних; поля — найдовші форми.
    const changes: WireChange[] = Array.from(
      { length: 2 * BATCH_MAX },
      (_, n) => ({
        object: uuid(n),
        scopeKind: uuid(n),
        scope: uuid(n),
        id: uuid(n),
        version: Number.MAX_SAFE_INTEGER,
        operation: "markDeletion",
      })
    )
    const value = fitRunResult(index, [], { rows: [], changes }, HASH)
    expect(value).toStrictEqual({ rows: [], changes })
    expect(responseSize({ changes })).toBeLessThan(RESPONSE_BUDGET_BYTES / 10)
  })
})
