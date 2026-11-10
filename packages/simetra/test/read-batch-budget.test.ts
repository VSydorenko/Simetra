import { describe, expect, it } from "vitest"
import {
  catalogIndex,
  jsonBytes,
  RESPONSE_BUDGET_BYTES,
  type SourceAdapter,
  type WireCommandError,
  type WireReadParts,
  type WireReadResult,
} from "simetra/model"
import {
  catalogEntry,
  catalogEntryAttribute,
} from "../src/model/runtime/__tests__/entries"
import {
  createCoreSource,
  createReadLimiter,
  readKeys,
} from "../src/data/store/source"
import { createFakeSource } from "../src/data/store/testing/fake-source"
import { fitParts } from "../src/server/response-budget"

/*
 * Пакетне читання за ключами над справжнім бюджетом відповіді сервера
 * (P4-B план B1c; спека П4-B §4.1, §4.5): частини одного запиту ділять
 * бюджет, і `batch-budget` отримує навіть перша частина, що вміщується лише
 * сама. Тест стоїть поза ярусами: T4 не імпортує T3, а тут потрібні обидва —
 * джерело ядра й `fitParts`.
 */

const base = catalogEntry()
// Неліниве текстове поле без межі довжини (`load` не задано): читання за
// ключами його несе.
const task = catalogEntry({
  attributes: [
    ...base.attributes,
    catalogEntryAttribute({
      name: "body",
      column: "body",
      type: "Text",
      required: false,
      insert: true,
      update: true,
    }),
  ],
})
const OBJECTS = [task]
const TASK = { kind: "Catalog", name: "Task" } as const
const S = "00000000-0000-4000-8000-0000000000b1"
const HASH = "hash-1"
const BATCH_BUDGET: WireCommandError = {
  code: "command.unavailable",
  reason: "batch-budget",
}

const key = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

/**
 * Адаптер, що відповідає як обробник `read`: частини виконуються по черзі
 * через `fitParts`, після `overflow` решта — `batch-budget` без виконання.
 * Рядок `n` несе `body` з `sizes.get(n)` символів.
 */
function budgeted(sizes: ReadonlyMap<number, number>) {
  const fake = createFakeSource({ objects: OBJECTS })
  for (const [n, bytes] of sizes) {
    fake.insert(TASK, {
      ref: key(n),
      org: S,
      title: `t${n}`,
      body: "x".repeat(bytes),
    })
  }
  const index = catalogIndex(OBJECTS)
  const responses: WireReadParts[] = []
  const values: WireReadResult[] = []
  const adapter: SourceAdapter = {
    capabilities: fake.adapter.capabilities,
    async read(parts) {
      const budget = fitParts(
        index,
        parts.map((part) => {
          if (part.type !== "query") throw new Error("query parts only")
          return { query: part.query }
        }),
        HASH
      )
      const failed = new Map<number, WireCommandError>()
      let stopped = false
      for (const [i, part] of parts.entries()) {
        if (stopped) {
          failed.set(i, BATCH_BUDGET)
          continue
        }
        const answer = await fake.adapter.read([part])
        const item = answer.items[0]!
        if (!item.ok || !("rows" in item.value))
          throw new Error("fake refused a part")
        values.push(item.value)
        stopped = budget.fit(i, item.value) === "overflow"
      }
      const value = budget.finish(null, failed)
      if ("code" in value) throw new Error(`response refused: ${value.code}`)
      responses.push(value)
      return value
    },
  }
  const source = createCoreSource(() => adapter, index, createReadLimiter(4))
  return { source, fake, responses, values }
}

const reasonsOf = (response: WireReadParts) =>
  response.items.map((i) => (i.ok ? "ok" : (i.error.reason ?? i.error.code)))

describe("batched key reads under the response budget", () => {
  it("a part that fits only alone, ahead of small parts: every part ends ok", async () => {
    const sizes = new Map([1, 2, 3, 4].map((n) => [n, 10] as const))
    const { source, fake, responses, values } = budgeted(sizes)
    // Розмір відповіді з одним рядком 1 — під епоху, якою міряє бюджет.
    await readKeys(source, task, [key(1)], { keysPerRequest: 1 })
    const alone = jsonBytes({
      ok: true,
      value: { epoch: "0".repeat(64), items: [{ ok: true, value: values[0] }] },
      serverHash: HASH,
    })
    // Сам рядок 1 вміщується з запасом 100 байтів, менше за резерв трьох
    // невиконаних частин після нього.
    fake.edit(TASK, key(1), {
      body: "x".repeat(10 + RESPONSE_BUDGET_BYTES - alone - 100),
    })
    responses.length = 0
    const keys = [...sizes.keys()].map(key)
    const rows = await readKeys(source, task, keys, { keysPerRequest: 1 })
    expect(reasonsOf(responses[0]!)).toEqual([
      "batch-budget",
      "batch-budget",
      "batch-budget",
      "batch-budget",
    ])
    expect(rows.map((r) => r.key)).toEqual(keys)
  })

  it("parts over half the budget each: every part ends ok", async () => {
    const sizes = new Map(
      Array.from(
        { length: 8 },
        (_, i) => [i + 1, Math.ceil(RESPONSE_BUDGET_BYTES * 0.6)] as const
      )
    )
    const { source, responses } = budgeted(sizes)
    const keys = [...sizes.keys()].map(key)
    const rows = await readKeys(source, task, keys, { keysPerRequest: 1 })
    expect(reasonsOf(responses[0]!)).toEqual([
      "ok",
      ...Array.from({ length: 7 }, () => "batch-budget"),
    ])
    expect(rows.map((r) => r.key)).toEqual(keys)
  })
})
