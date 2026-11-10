import {
  BATCH_MAX,
  catalogIndex,
  jsonBytes,
  LIMIT_REASONS,
  RESPONSE_BUDGET_BYTES,
  type WireChange,
  type WireCommandError,
  type WireOperation,
  type WireReadQuery,
  type WireReadResult,
  type WireRow,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { fitParts, fitRunResult } from "../response-budget"
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

// Епоха завдовжки з ту, якою міряє бюджет: межі в тестах — точні.
const EPOCH = "e".repeat(64)

/** Розмір відповіді `read` з однією частиною так, як її серіалізує обробник. */
const responseSize = (value: unknown, serverHash = HASH) =>
  jsonBytes({
    ok: true,
    value: { epoch: EPOCH, items: [{ ok: true, value }] },
    serverHash,
  })

/** Бюджет запиту з однієї частини: значення частини чи її помилка. */
function fitOne(
  query: WireReadQuery,
  result: WireReadResult,
  serverHash: string
) {
  const budget = fitParts(index, [{ query }], serverHash)
  budget.fit(0, result)
  const out = budget.finish(EPOCH, new Map())
  if ("code" in out) throw new Error(`whole response refused: ${out.code}`)
  const item = out.items[0]!
  return item.ok ? item.value : item.error
}

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

describe("fitParts, одна частина: сторінка", () => {
  it("відповідь у межах бюджету — без змін", () => {
    const result: WireReadResult = { rows: [linkRow(1, 10)], included: {} }
    expect(fitOne(linkPage(), result, HASH)).toBe(result)
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
    const fitted = fitOne(linkPage(), result, HASH)
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
    const fitted = fitOne(
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
    expect(fitOne(linkPage(), result, HASH)).toStrictEqual({
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
    const fitted = fitOne(
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
    expect(fitOne(linkPage(), result, HASH)).toStrictEqual(TOO_LARGE)
  })
})

describe("fitParts, одна частина: без обрізання", () => {
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
    expect(fitOne(query, over, HASH)).toStrictEqual(TOO_LARGE)
  })

  it("ne за ключем — сторінка, обрізається", () => {
    const fitted = fitOne(
      key({ attribute: "id", op: "ne", value: uuid(1) }),
      over,
      HASH
    )
    expect(fitted).toMatchObject({ more: true })
  })

  it("лічильник — без змін", () => {
    const count: WireReadResult = { count: 3 }
    const query = { object: link.id, count: true } as WireReadQuery
    expect(fitOne(query, count, HASH)).toBe(count)
  })
})

describe("fitParts, одна частина: точна межа обрізання", () => {
  // Префікс із двох рядків і двох їхніх цілей — рівно бюджет: так тест
  // тримає кому між рядками й кому між рядками `included` однієї цілі.
  const targets = [1, 2, 3].map((n) => uuid(2000 + n))
  const page = (filler: string): WireReadResult => ({
    rows: [
      { ...linkRow(1, 0, targets[0]), code: filler },
      linkRow(2, 10, targets[1]),
      linkRow(3, 10, targets[2]),
    ],
    included: { [region.id]: targets.map((id) => regionRow(id)) },
  })
  const prefix = (result: WireReadResult, kept: number) => {
    if (!("rows" in result)) throw new Error("rows expected")
    return {
      rows: result.rows.slice(0, kept),
      included: { [region.id]: result.included![region.id]!.slice(0, kept) },
      more: true,
    }
  }
  const sized = (extra: number) => {
    const base = responseSize(prefix(page(""), 2))
    return page("z".repeat(RESPONSE_BUDGET_BYTES - base + extra))
  }

  it("префікс рівно в бюджеті — 2 рядки з more", () => {
    const result = sized(0)
    const fitted = fitOne(linkPage(), result, HASH)
    expect(fitted).toStrictEqual(prefix(result, 2))
    expect(responseSize(fitted)).toBe(RESPONSE_BUDGET_BYTES)
  })

  it("на байт понад бюджет — 1 рядок з more", () => {
    const result = sized(1)
    expect(fitOne(linkPage(), result, HASH)).toStrictEqual(prefix(result, 1))
  })
})

describe("fitParts, одна частина: межу перетинають неповторні поля", () => {
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
    expect(fitOne(card, result, "h")).toBe(result)
    expect(fitOne(card, result, "hh")).toStrictEqual(TOO_LARGE)
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
    expect(fitOne(owner, result, HASH)).toBe(result)
    expect(
      fitOne(owner, { ...result, ownerVersion: "10" }, HASH)
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
    expect(fitOne(linkPage(), result, HASH)).toStrictEqual(TOO_LARGE)
  })
})

describe("fitParts: кілька частин", () => {
  const BATCH_BUDGET: WireCommandError = {
    code: "command.unavailable",
    reason: "batch-budget",
  }
  const card = (n: number) =>
    ({ object: link.id, id: uuid(n) }) as WireReadQuery
  const rowsOf = (bytes: number, n = 1): WireReadResult => ({
    rows: [linkRow(n, bytes)],
  })
  const itemsOf = (out: ReturnType<ReturnType<typeof fitParts>["finish"]>) => {
    if ("code" in out) throw new Error(`whole response refused: ${out.code}`)
    return out.items
  }

  it("частини в межах бюджету — без змін, кожна accept", () => {
    const budget = fitParts(
      index,
      [{ query: card(1) }, { query: card(2) }],
      HASH
    )
    const first = rowsOf(10, 1)
    const second = rowsOf(10, 2)
    expect(budget.fit(0, first)).toBe("accept")
    expect(budget.fit(1, second)).toBe("accept")
    expect(itemsOf(budget.finish(EPOCH, new Map()))).toStrictEqual([
      { ok: true, value: first },
      { ok: true, value: second },
    ])
  })

  it("частина понад залишок, що окремо вміщується — batch-budget, далі overflow", () => {
    const slots = [{ query: card(1) }, { query: card(2) }, { query: card(3) }]
    const budget = fitParts(index, slots, HASH)
    expect(budget.fit(0, rowsOf(3 * MIB, 1))).toBe("accept")
    expect(budget.fit(1, rowsOf(2 * MIB, 2))).toBe("overflow")
    // Рантайм, що не зупинився на overflow, однаково не додає рядків.
    expect(budget.fit(2, rowsOf(10, 3))).toBe("overflow")
    const items = itemsOf(budget.finish(EPOCH, new Map()))
    expect(items.slice(1)).toStrictEqual([
      { ok: false, error: BATCH_BUDGET },
      { ok: false, error: BATCH_BUDGET },
    ])
  })

  it("невиконані частини — з помилкою рантайму", () => {
    const budget = fitParts(
      index,
      [{ query: card(1) }, { query: card(2) }],
      HASH
    )
    expect(budget.fit(0, rowsOf(5 * MIB, 1))).toBe("accept")
    expect(
      itemsOf(budget.finish(EPOCH, new Map([[1, BATCH_BUDGET]])))
    ).toStrictEqual([
      { ok: false, error: TOO_LARGE },
      { ok: false, error: BATCH_BUDGET },
    ])
  })

  it("частина, що не вміщується й сама, — response-too-large, наступні виконуються", () => {
    const budget = fitParts(
      index,
      [{ query: card(1) }, { query: card(2) }],
      HASH
    )
    expect(budget.fit(0, rowsOf(5 * MIB, 1))).toBe("accept")
    const second = rowsOf(10, 2)
    expect(budget.fit(1, second)).toBe("accept")
    expect(itemsOf(budget.finish(EPOCH, new Map()))).toStrictEqual([
      { ok: false, error: TOO_LARGE },
      { ok: true, value: second },
    ])
  })

  it("сторінка понад залишок — непорожній префікс з more, далі overflow", () => {
    const budget = fitParts(
      index,
      [{ query: card(1) }, { query: linkPage({ include: undefined }) }],
      HASH
    )
    expect(budget.fit(0, rowsOf(2 * MIB, 1))).toBe("accept")
    const rows = [2, 3, 4].map((n) => linkRow(n, MIB))
    expect(budget.fit(1, { rows })).toBe("overflow")
    expect(itemsOf(budget.finish(EPOCH, new Map()))[1]).toStrictEqual({
      ok: true,
      value: { rows: rows.slice(0, 1), more: true },
    })
  })

  it("сторінка без рядка в залишку, що окремо вміщується, — batch-budget", () => {
    const budget = fitParts(
      index,
      [{ query: card(1) }, { query: linkPage({ include: undefined }) }],
      HASH
    )
    expect(budget.fit(0, rowsOf(3 * MIB, 1))).toBe("accept")
    const rows = [2, 3].map((n) => linkRow(n, MIB))
    expect(budget.fit(1, { rows })).toBe("overflow")
    expect(itemsOf(budget.finish(EPOCH, new Map()))[1]).toStrictEqual({
      ok: false,
      error: BATCH_BUDGET,
    })
  })

  it("частина, що вміщується лише сама, — резерв невиконаних частин її витісняє", () => {
    const shape = (code: string): WireReadResult => ({
      rows: [{ ...linkRow(1, 0), code }],
    })
    const exact = shape(
      "z".repeat(RESPONSE_BUDGET_BYTES - responseSize(shape("")))
    )
    const alone = fitParts(index, [{ query: card(1) }], HASH)
    expect(alone.fit(0, exact)).toBe("accept")
    expect(itemsOf(alone.finish(EPOCH, new Map()))).toStrictEqual([
      { ok: true, value: exact },
    ])
    // Рівно в бюджеті разом із короткою помилкою другої частини: резерв під
    // невиконану частину більший за таку помилку, тож місця частині немає.
    const pair = (code: string) =>
      jsonBytes({
        ok: true,
        value: {
          epoch: EPOCH,
          items: [
            { ok: true, value: shape(code) },
            { ok: false, error: BATCH_BUDGET },
          ],
        },
        serverHash: HASH,
      })
    const tight = shape("z".repeat(RESPONSE_BUDGET_BYTES - pair("")))
    const batch = fitParts(
      index,
      [{ query: card(1) }, { query: card(2) }],
      HASH
    )
    expect(batch.fit(0, tight)).toBe("overflow")
    expect(
      itemsOf(batch.finish(EPOCH, new Map([[1, BATCH_BUDGET]])))
    ).toStrictEqual([
      { ok: false, error: BATCH_BUDGET },
      { ok: false, error: BATCH_BUDGET },
    ])
  })

  it("готові елементи (відмова частини, version) займають бюджет", () => {
    const detail = "d".repeat(3 * MIB)
    const failedPart = {
      ok: false as const,
      error: { code: "command.invalid" as const, detail },
    }
    const budget = fitParts(
      index,
      [{ item: failedPart }, { query: card(1) }],
      HASH
    )
    expect(budget.fit(0, rowsOf(2 * MIB, 1))).toBe("overflow")
    expect(itemsOf(budget.finish(EPOCH, new Map()))).toStrictEqual([
      failedPart,
      { ok: false, error: BATCH_BUDGET },
    ])
  })

  it("відповідь понад бюджет через помилки рантайму — response-too-large цілком", () => {
    const budget = fitParts(
      index,
      [{ query: card(1) }, { query: card(2) }],
      HASH
    )
    expect(budget.fit(0, rowsOf(10, 1))).toBe("accept")
    const huge = {
      code: "command.internal" as const,
      detail: "d".repeat(5 * MIB),
    }
    expect(budget.finish(EPOCH, new Map([[1, huge]]))).toStrictEqual(TOO_LARGE)
  })

  it("частина без рішення й без помилки — виняток (дефект сервера)", () => {
    const budget = fitParts(index, [{ query: card(1) }], HASH)
    expect(() => budget.finish(EPOCH, new Map())).toThrow()
  })

  it("маркери серед рядків сторінки міряються й ріжуться як рядки", () => {
    const budget = fitParts(
      index,
      [{ query: linkPage({ include: undefined }) }],
      HASH
    )
    const rows = [0, { $known: 1, code: "c" }, linkRow(3, 5 * MIB)]
    // Обрізана сторінка вичерпала бюджет: після неї частини не виконуються.
    expect(budget.fit(0, { rows })).toBe("overflow")
    expect(itemsOf(budget.finish(null, new Map()))).toStrictEqual([
      { ok: true, value: { rows: rows.slice(0, 2), more: true } },
    ])
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
