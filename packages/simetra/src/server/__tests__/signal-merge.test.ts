import { randomUUID } from "node:crypto"
import {
  PLATFORM_SCHEMA,
  SIGNAL_INVALIDATE_FUNCTION_NAME,
  SIGNAL_MERGE_MODE,
  SIGNAL_MODE_SETTING,
  ZERO_UUID,
  runtimeCatalogSchema,
  type Operation,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { createCommandRuntime } from "../runtime"
import type { Call } from "./fake-database"
import { fakeDatabase } from "./fake-database"
import {
  COMPANY,
  catalog,
  client,
  commandObject,
  region,
  REGION,
} from "./fixtures"
import { CLIENT, answer, session, setup, type Override } from "./harness"

/**
 * Режим злиття сигналів у T3 (спека П4-B §8.2): лік сигнальних фаз
 * транзакції, перемикання налаштування за порогом і `invalidate` пари.
 * Поріг тут явний — 50, незалежно від типового.
 */

const THRESHOLD = 50
const OTHER_COMPANY = "77777777-7777-4777-8777-777777777777"
const PLAIN = { kind: "Catalog" as const, name: "Plain" }

/** Несигнальний об'єкт поруч зі сигнальними `Client` і `Region`. */
const plain = commandObject({
  id: "00000000-0000-4000-8000-000000000041",
  name: "Plain",
  table: "plain",
  signal: false,
})
const mergeCatalog = runtimeCatalogSchema.parse({
  ...catalog,
  objects: [client, region, plain],
})

// Текстом, як оператори обв'язки: сталі T0 звіряє тест нижче.
const MERGE = {
  text: "SELECT set_config('simetra.signal_mode', 'merge', true)",
  params: [],
}
const INVALIDATE_TEXT = `SELECT "${PLATFORM_SCHEMA}"."${SIGNAL_INVALIDATE_FUNCTION_NAME}"($1::uuid, $2::uuid, $3::uuid)`
const invalidate = (object: string, kind: string, scope: string) => ({
  text: INVALIDATE_TEXT,
  params: [object, kind, scope],
})

/** Ядро повертає рядок зі скоупом свого входу: пари розрізняються скоупом. */
const echoCore: Override = (text, params) => {
  if (!text.endsWith("AS r")) return undefined
  const item = JSON.parse(params[0]!) as Record<string, unknown>
  return {
    rows: [{ r: JSON.stringify({ version: 1, code: "A", ...item }) }],
  }
}

const createIn = (
  object: typeof CLIENT | typeof PLAIN,
  company = COMPANY
): Operation => ({
  action: "create",
  object,
  id: randomUUID(),
  values: { code: "A", company },
})
const createRegion = (): Operation => ({
  action: "create",
  object: REGION,
  id: randomUUID(),
  values: { code: "R" },
})
const clients = (n: number, company = COMPANY) =>
  Array.from({ length: n }, () => createIn(CLIENT, company))

const statements = (calls: Call[]) =>
  calls.filter(
    (c): c is { text: string; params: (string | null)[] } => "text" in c
  )
/** Індекси викликів ядра в черзі: ядро — оператор `… AS r`. */
const coreIndexes = (calls: Call[]) =>
  calls.flatMap((c, i) => ("text" in c && c.text.endsWith("AS r") ? [i] : []))
const mergeIndexes = (calls: Call[]) =>
  calls.flatMap((c, i) => ("text" in c && c.text === MERGE.text ? [i] : []))
const invalidates = (calls: Call[]) =>
  statements(calls).filter((c) => c.text === INVALIDATE_TEXT)

const mergeSetup = (
  options: Parameters<typeof setup>[1] = {},
  override: Override = () => undefined
) =>
  setup((text, params) => override(text, params) ?? echoCore(text, params), {
    catalog: mergeCatalog,
    signalMergeThreshold: THRESHOLD,
    ...options,
  })

describe("signal merge mode", () => {
  it("names the setting and the value of T0", () => {
    expect(MERGE.text).toContain(
      `'${SIGNAL_MODE_SETTING}', '${SIGNAL_MERGE_MODE}'`
    )
  })

  it("sends no merge setting for 49 signal phases", async () => {
    const { db, runtime } = await mergeSetup()
    await runtime.run(session, clients(THRESHOLD - 1))
    expect(mergeIndexes(db.calls)).toEqual([])
    expect(invalidates(db.calls)).toEqual([])
  })

  it("sets merge mode right after the core of the 50th signal phase", async () => {
    const { db, runtime } = await mergeSetup()
    await runtime.run(session, clients(THRESHOLD))
    const cores = coreIndexes(db.calls)
    expect(cores).toHaveLength(THRESHOLD)
    expect(mergeIndexes(db.calls)).toEqual([cores.at(-1)! + 1])
    // Фаза, що досягла порогу, свій сигнал уже надіслала: `invalidate` немає.
    expect(invalidates(db.calls)).toEqual([])
  })

  it("never switches back: one setting, one invalidate per pair, nothing resets the mode", async () => {
    const { db, runtime } = await mergeSetup()
    await runtime.run(session, clients(THRESHOLD + 3))
    const cores = coreIndexes(db.calls)
    expect(mergeIndexes(db.calls)).toEqual([cores[THRESHOLD - 1]! + 1])
    // Одна пара (скоуп, об'єкт) — один `invalidate`, одразу за першим
    // ядром після вмикання режиму.
    expect(db.calls[cores[THRESHOLD]! + 1]).toEqual(
      invalidate(client.id, client.scopeKindId!, COMPANY)
    )
    expect(invalidates(db.calls)).toHaveLength(1)
    // Після claims режим ніхто не перевизначає: лише налаштування злиття.
    const claims = statements(db.calls).findIndex((c) =>
      c.text.includes("request.jwt.claims")
    )
    expect(
      statements(db.calls)
        .slice(claims + 1)
        .filter((c) => c.text.includes(SIGNAL_MODE_SETTING))
    ).toEqual([MERGE])
  })

  it("gives each pair touched after the switch exactly one invalidate", async () => {
    const { db, runtime } = await mergeSetup()
    await runtime.run(session, [
      ...clients(THRESHOLD),
      createIn(CLIENT, OTHER_COMPANY),
      createIn(CLIENT),
      createRegion(),
      createIn(CLIENT, OTHER_COMPANY),
      createRegion(),
    ])
    expect(invalidates(db.calls)).toEqual([
      invalidate(client.id, client.scopeKindId!, OTHER_COMPANY),
      invalidate(client.id, client.scopeKindId!, COMPANY),
      // Нескоуплений об'єкт — нульові вид і скоуп (Р9).
      invalidate(region.id, ZERO_UUID, ZERO_UUID),
    ])
  })

  it("counts no non-signal phase and sends it no invalidate", async () => {
    const { db, runtime } = await mergeSetup()
    await runtime.run(session, [
      ...clients(THRESHOLD - 1),
      ...Array.from({ length: 10 }, () => createIn(PLAIN)),
    ])
    expect(mergeIndexes(db.calls)).toEqual([])

    db.calls.splice(0)
    await runtime.run(session, [
      ...clients(THRESHOLD),
      createIn(PLAIN),
      createIn(PLAIN, OTHER_COMPANY),
    ])
    expect(mergeIndexes(db.calls)).toHaveLength(1)
    expect(invalidates(db.calls)).toEqual([])
  })

  it("counts the phases of ctx.run", async () => {
    // Кожна несигнальна операція пакета запускає одну сигнальну фазу
    // `ctx.run`: усі сигнальні фази транзакції — вкладені.
    const { db, runtime } = await mergeSetup({
      objectModules: {
        "Catalog.Plain": {
          async beforeWrite({ ctx, draft }) {
            await ctx.run(createIn(CLIENT))
            return draft
          },
        },
      },
    })
    await runtime.run(
      session,
      Array.from({ length: THRESHOLD }, () => createIn(PLAIN))
    )
    const clientCores = db.calls.flatMap((c, i) =>
      "text" in c && c.text.includes("client_save") ? [i] : []
    )
    expect(clientCores).toHaveLength(THRESHOLD)
    expect(mergeIndexes(db.calls)).toEqual([clientCores.at(-1)! + 1])
  })

  it("starts the count from zero on a 40001 retry", async () => {
    // Лише COMMIT команди: транзакція створення рантайму теж його шле.
    let commits: number | undefined
    const { db, runtime } = await mergeSetup({}, (text) =>
      text === "COMMIT" && commits !== undefined && commits++ === 0
        ? { error: { code: "40001", message: "retry" } }
        : undefined
    )
    commits = 0
    // 30 + 30 перейшли б поріг, якби лік спроби 1 переходив у спробу 2.
    await runtime.run(session, clients(30))
    expect(commits).toBe(2)
    expect(mergeIndexes(db.calls)).toEqual([])
  })

  it("switches after the first phase with the threshold 1", async () => {
    const { db, runtime } = await mergeSetup({ signalMergeThreshold: 1 })
    await runtime.run(session, clients(2))
    const cores = coreIndexes(db.calls)
    expect(mergeIndexes(db.calls)).toEqual([cores[0]! + 1])
    expect(db.calls[cores[1]! + 1]).toEqual(
      invalidate(client.id, client.scopeKindId!, COMPANY)
    )
  })

  // Типовий поріг — з бенчмарку `bench:signals` (спека П4-B §8.2): поріг +
  // `invalidate` вміщуються в історію каналу (`history_size` 100, Р23).
  it("switches after the 90th signal phase by default", async () => {
    const { db, runtime } = await mergeSetup({
      signalMergeThreshold: undefined,
    })
    await runtime.run(session, clients(89))
    expect(mergeIndexes(db.calls)).toEqual([])
    db.calls.splice(0)
    await runtime.run(session, clients(90))
    expect(mergeIndexes(db.calls)).toEqual([coreIndexes(db.calls).at(-1)! + 1])
  })

  it.each([0, 1.5, -1])("refuses the threshold %s", async (threshold) => {
    const db = fakeDatabase({ query: (text) => answer(text) })
    await expect(
      createCommandRuntime({
        database: db.database,
        catalog: mergeCatalog,
        signalMergeThreshold: threshold,
      })
    ).rejects.toThrow()
    expect(db.calls).toEqual([])
  })
})
