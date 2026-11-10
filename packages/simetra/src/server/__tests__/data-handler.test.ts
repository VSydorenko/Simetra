import {
  BATCH_MAX,
  CommandFailure,
  LIMIT_REASONS,
  TABULAR_LINES_MAX,
  catalogIndex,
  dataResponseSchema,
  pathFromWire,
  pathToWire,
  runtimeCatalogSchema,
  versionValueSchema,
  wireReadResultSchema,
  type CommandError,
  type DataResponse,
  type ObjectModule,
  type RuntimeCatalog,
} from "simetra/model"
import { describe, expect, it, vi } from "vitest"
import { checkCompatibility } from "../compatibility"
import { createDataHandler } from "../data-handler"
import { prepareInput } from "../phase"
import type { RequestOrigin } from "../origin"
import type { CommandRuntime } from "../runtime"
import {
  COMPANY,
  ID,
  OTHER,
  REGION,
  client,
  link,
  region,
  sample,
} from "./fixtures"
import { session, setup, type Override } from "./harness"

// Справжня звірка; кейс «`unknown` після звірки» підміняє один виклик.
vi.mock("../compatibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compatibility")>()
  return { ...actual, checkCompatibility: vi.fn(actual.checkCompatibility) }
})

/**
 * Обробник конверта (спека П4-B §4.5) над справжнім рантаймом і порт-фейком
 * бази: лічильники викликів рантайму й порту показують, що відмова кроків 0–3
 * не доходить ні до перекладу, ні до бази.
 */

const handlerCatalog: RuntimeCatalog = runtimeCatalogSchema.parse({
  format: 1,
  snapshotHash: "hash-1",
  provider: "supabase",
  objects: [client, region, link, sample],
})
const HASH = handlerCatalog.snapshotHash

const SECTION = sample.tabularSections[0]!.id
const UNKNOWN = "00000000-0000-4000-8000-0000000000ee"
const KERNELS = {
  [client.id]: client.kernelHash,
  [link.id]: link.kernelHash,
  [sample.id]: sample.kernelHash,
}
const HTTP: RequestOrigin = {
  secFetchSite: "same-origin",
  origin: "https://app.example",
  expectedOrigin: "https://app.example",
}
const IN_PROCESS: RequestOrigin = { inProcess: true }
const SUBJECT = session.sub

const envelope = (request: unknown, subject: unknown = SUBJECT) => ({
  subject,
  request,
})
const runOf = (operation: object, kernels: object = KERNELS) =>
  envelope({ type: "run", operation, kernels })
const batchOf = (batch: object[], kernels: object = KERNELS) =>
  envelope({ type: "run", batch, kernels })
const readOf = (query: object) =>
  envelope({ type: "read", query: { object: region.id, limit: 10, ...query } })
const sampleRead = (query: object) => readOf({ object: sample.id, ...query })

const createClient = {
  action: "create",
  object: client.id,
  id: ID,
  values: { code: "A", company_id: COMPANY },
}
const deleteLink = {
  action: "delete",
  object: link.id,
  id: ID,
  expectedVersion: 1,
}

/** Рядок читання `region` у відповіді бази — для кейсу успішного читання. */
const regionRows: Override = (text) =>
  text.includes('"public"."region" t')
    ? { rows: [{ row: JSON.stringify({ id: ID, version: 2, code: "R" }) }] }
    : undefined

/** Лічильник викликів рантайму поверх справжнього: «порт не викликано». */
function counted(runtime: CommandRuntime) {
  const calls = { run: 0, read: 0 }
  const wrapped: CommandRuntime = {
    catalog: runtime.catalog,
    run: (...args) => {
      calls.run++
      return runtime.run(...args)
    },
    read: (...args) => {
      calls.read++
      return runtime.read(...args)
    },
    readParts: (...args) => runtime.readParts(...args),
  }
  return { runtime: wrapped, calls }
}

async function harness(
  override?: Override,
  objectModules?: Record<string, ObjectModule<object>>
) {
  const { db, runtime } = await setup(override, {
    catalog: handlerCatalog,
    ...(objectModules === undefined ? {} : { objectModules }),
  })
  const { runtime: wrapped, calls } = counted(runtime)
  const log = vi.fn()
  const handle = createDataHandler(wrapped, { log })
  return { db, calls, log, handle, runtime: wrapped }
}

/** Відповідь проходить схему конверта й несе `serverHash` каталогу. */
function checkedResponse(response: DataResponse): DataResponse {
  expect(dataResponseSchema.parse(response)).toStrictEqual(response)
  expect(response.serverHash).toBe(HASH)
  return response
}

const errorOf = (response: DataResponse) => {
  checkedResponse(response)
  if (response.ok)
    throw new Error(`expected a failure: ${JSON.stringify(response)}`)
  return response.error
}

const valueOf = (response: DataResponse) => {
  checkedResponse(response)
  if (!response.ok)
    throw new Error(`expected a value: ${JSON.stringify(response.error)}`)
  return response.value
}

/** Значення, будь-яке читання якого кидає. */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  return proxy
}

describe("createDataHandler: steps 0–3 never reach the runtime or the port", () => {
  const tabular = Array.from({ length: TABULAR_LINES_MAX + 1 }, () => ({}))
  const overflowing = {
    action: "create",
    object: sample.id,
    id: ID,
    tabularSections: { [SECTION]: tabular },
  }
  const HOSTILE = ["nope", '"code"', "public.code", "code;", "ctid"]

  it.each<[string, unknown, RequestOrigin, object]>([
    // Крок 0: походження перевіряється раніше за конверт.
    [
      "чужий сайт на невалідному конверті — forbidden, не invalid",
      { garbage: true },
      { secFetchSite: "cross-site", expectedOrigin: "https://app.example" },
      { code: "command.forbidden", reason: LIMIT_REASONS.origin },
    ],
    [
      "inProcess + run — forbidden",
      runOf(createClient),
      IN_PROCESS,
      { code: "command.forbidden", reason: LIMIT_REASONS.origin },
    ],
    [
      "без заголовків — forbidden",
      readOf({}),
      { expectedOrigin: "https://app.example" },
      { code: "command.forbidden", reason: LIMIT_REASONS.origin },
    ],
    // Крок 1: конверт.
    [
      "невалідний конверт — invalid",
      { subject: SUBJECT },
      HTTP,
      { code: "command.invalid", path: "request" },
    ],
    [
      "без subject",
      { request: { type: "version" } },
      HTTP,
      { code: "command.invalid", path: "subject" },
    ],
    [
      "вхід, що кидає при читанні — invalid без path",
      revoked(),
      HTTP,
      { code: "command.invalid" },
    ],
    [
      "пакет понад BATCH_MAX — batch-too-large без path",
      batchOf(Array.from({ length: BATCH_MAX + 1 }, () => deleteLink)),
      HTTP,
      { code: "command.invalid", reason: LIMIT_REASONS.batchTooLarge },
    ],
    [
      "ТЧ понад межу — <id ТЧ> з object",
      runOf(overflowing),
      HTTP,
      {
        code: "command.invalid",
        reason: LIMIT_REASONS.tabularTooLarge,
        path: SECTION,
        object: sample.id,
      },
    ],
    [
      "ТЧ понад межу в пакеті — без індексу пакета, object операції",
      batchOf([deleteLink, overflowing]),
      HTTP,
      {
        code: "command.invalid",
        reason: LIMIT_REASONS.tabularTooLarge,
        path: SECTION,
        object: sample.id,
      },
    ],
    [
      "update без expectedVersion — шлях від операції, з object",
      runOf({ action: "update", object: link.id, id: ID }),
      HTTP,
      { code: "command.invalid", path: "expectedVersion", object: link.id },
    ],
    [
      "пакет: шлях без batch.<i>, object операції за індексом",
      batchOf([deleteLink, { action: "update", object: client.id, id: ID }]),
      HTTP,
      { code: "command.invalid", path: "expectedVersion", object: client.id },
    ],
    [
      "object не UUID — без object",
      runOf({
        action: "delete",
        object: "Catalog.Link",
        id: ID,
        expectedVersion: 1,
      }),
      HTTP,
      { code: "command.invalid", path: "object" },
    ],
    [
      "читання: шлях від запиту, з object",
      readOf({ limit: 0 }),
      HTTP,
      { code: "command.invalid", path: "limit", object: region.id },
    ],
    // Крок 2: сесія.
    [
      "subject ≠ sub сесії — session-changed до звірки",
      // Запит ще й несумісний: відмова сесії йде раніше за звірку.
      { ...runOf({ ...createClient, object: UNKNOWN }, {}), subject: "user-2" },
      HTTP,
      {
        code: "command.unauthenticated",
        reason: LIMIT_REASONS.sessionChanged,
      },
    ],
    // Крок 3: звірка сумісності.
    [
      "невідомий UUID об'єкта",
      runOf({ ...createClient, object: UNKNOWN }),
      HTTP,
      { code: "command.stale-client", object: UNKNOWN },
    ],
    [
      "операція без запису в kernels",
      runOf(createClient, {}),
      HTTP,
      { code: "command.stale-client", object: client.id },
    ],
    [
      "пакет з однією несумісною операцією — відмова цілком",
      batchOf([deleteLink, createClient], { [link.id]: link.kernelHash }),
      HTTP,
      { code: "command.stale-client", object: client.id },
    ],
    ...HOSTILE.map((name): [string, unknown, RequestOrigin, object] => [
      `run: вороже ім'я ${name}`,
      runOf({ ...createClient, values: { [name]: "x" } }),
      HTTP,
      { code: "command.stale-client", object: client.id },
    ]),
    ...HOSTILE.map((name): [string, unknown, RequestOrigin, object] => [
      `read where: вороже ім'я ${name}`,
      sampleRead({ where: { attribute: name, op: "eq", value: "x" } }),
      HTTP,
      { code: "command.stale-client", object: sample.id },
    ]),
    [
      "read where: колонка мітки пари",
      sampleRead({
        where: { attribute: "subject_type", op: "eq", value: "x" },
      }),
      HTTP,
      { code: "command.stale-client", object: sample.id },
    ],
    [
      "read orderBy: колонка мітки пари",
      sampleRead({
        orderBy: [{ attribute: "subject_type", direction: "asc" }],
      }),
      HTTP,
      { code: "command.stale-client", object: sample.id },
    ],
    [
      "read include: колонка мітки пари",
      sampleRead({ include: ["subject_type"] }),
      HTTP,
      { code: "command.stale-client", object: sample.id },
    ],
  ])("%s", async (_, request, origin, expected) => {
    const { db, calls, handle } = await harness()
    expect(errorOf(await handle(session, request, origin))).toStrictEqual(
      expected
    )
    expect(calls).toStrictEqual({ run: 0, read: 0 })
    expect(db.calls).toStrictEqual([])
  })

  it.each<[string, unknown]>([
    ["без sub", { role: "authenticated" }],
    ["порожній sub", { sub: "" }],
    ["сесія, що кидає", revoked()],
  ])("невалідна сесія (%s) — unauthenticated", async (_, claims) => {
    const { db, calls, handle } = await harness()
    const response = await handle(
      claims as typeof session,
      runOf(createClient),
      HTTP
    )
    expect(errorOf(response)).toStrictEqual({ code: "command.unauthenticated" })
    expect(calls).toStrictEqual({ run: 0, read: 0 })
    expect(db.calls).toStrictEqual([])
  })

  it("re-checks the parsed type against inProcess: a type swapped after step 0 is forbidden", async () => {
    const { db, calls, handle } = await harness()
    let reads = 0
    // Перше читання (крок 0) бачить `read`, розбір конверта — уже `run`.
    const request = {
      operation: createClient,
      kernels: KERNELS,
      get type() {
        return reads++ === 0 ? "read" : "run"
      },
    }
    const response = await handle(session, envelope(request), IN_PROCESS)
    expect(reads).toBeGreaterThan(1)
    expect(errorOf(response)).toStrictEqual({
      code: "command.forbidden",
      reason: LIMIT_REASONS.origin,
    })
    expect(calls).toStrictEqual({ run: 0, read: 0 })
    expect(db.calls).toStrictEqual([])
  })

  it("without the origin argument does not compile and is forbidden at runtime", async () => {
    const { calls, handle } = await harness()
    // @ts-expect-error походження — обов'язковий аргумент обробника
    const response = await handle(session, envelope({ type: "version" }))
    expect(errorOf(response)).toStrictEqual({
      code: "command.forbidden",
      reason: LIMIT_REASONS.origin,
    })
    expect(calls).toStrictEqual({ run: 0, read: 0 })
  })
})

describe("createDataHandler: steps 4–6", () => {
  it("version — the runtime catalog, without the runtime or the port", async () => {
    const { db, calls, handle } = await harness()
    const value = valueOf(
      await handle(session, envelope({ type: "version" }), IN_PROCESS)
    )
    expect(versionValueSchema.parse(value)).toStrictEqual({
      snapshotHash: HASH,
      objects: {
        [client.id]: client.kernelHash,
        [region.id]: region.kernelHash,
        [link.id]: link.kernelHash,
        [sample.id]: sample.kernelHash,
      },
    })
    expect(calls).toStrictEqual({ run: 0, read: 0 })
    expect(db.calls).toStrictEqual([])
  })

  it("read under inProcess returns wire rows", async () => {
    const { calls, handle } = await harness(regionRows)
    const value = valueOf(await handle(session, readOf({}), IN_PROCESS))
    expect(value).toStrictEqual({
      rows: [{ id: ID, version: "2", code: "R" }],
    })
    expect(calls).toStrictEqual({ run: 0, read: 1 })
  })

  // Рядки по ~1,5 МіБ: два вміщуються в бюджет відповіді, три — ні.
  const bigRegionRows =
    (n: number): Override =>
    (text) =>
      text.includes('"public"."region" t')
        ? {
            rows: Array.from({ length: n }, (_, i) => ({
              row: JSON.stringify({
                id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
                version: 1,
                code: "x".repeat(1_500_000),
              }),
            })),
          }
        : undefined

  it("a page over the response budget is a strict prefix with more", async () => {
    const { handle } = await harness(bigRegionRows(3))
    const value = wireReadResultSchema.parse(
      valueOf(await handle(session, readOf({}), IN_PROCESS))
    )
    if (!("rows" in value)) throw new Error("expected rows")
    expect(value.more).toBe(true)
    expect(value.rows.length).toBeGreaterThan(0)
    expect(value.rows.length).toBeLessThan(3)
  })

  it("a key read over the response budget is response-too-large with serverHash", async () => {
    const { handle } = await harness(bigRegionRows(3))
    const ids = [1, 2, 3].map(
      (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    )
    const response = await handle(
      session,
      readOf({ where: { attribute: "id", op: "in", value: ids } }),
      IN_PROCESS
    )
    expect(errorOf(response)).toMatchObject({
      code: "command.invalid",
      reason: LIMIT_REASONS.responseTooLarge,
    })
    expect(response.serverHash).toBe(HASH)
  })

  it("a run result over the response budget has changes and no rows", async () => {
    const { handle } = await harness((text) =>
      text.endsWith("AS r")
        ? {
            rows: [
              {
                r: JSON.stringify({
                  id: ID,
                  version: 1,
                  code: "A",
                  company_id: COMPANY,
                  extra: "x".repeat(5 * 1024 * 1024),
                }),
              },
            ],
          }
        : undefined
    )
    const value = valueOf(await handle(session, runOf(createClient), HTTP))
    expect(value).not.toHaveProperty("rows")
    expect(value).toHaveProperty("changes")
  })

  it("run returns wire rows and changes; the call is fullTabularArrays", async () => {
    const { calls, handle, runtime } = await harness()
    const run = vi.spyOn(runtime, "run")
    const value = valueOf(await handle(session, runOf(createClient), HTTP))
    expect(run.mock.calls[0]?.[2]).toStrictEqual({ fullTabularArrays: true })
    expect(value).toStrictEqual({
      rows: [{ id: ID, version: "1", code: "A", company_id: COMPANY }],
      changes: [
        expect.objectContaining({
          object: client.id,
          id: ID,
          operation: "create",
        }),
      ],
    })
    expect(calls.run).toBe(1)
  })

  it("does not reconcile ctx.run phases: a hook writes an object outside kernels", async () => {
    const modules = {
      "Catalog.Client": {
        async beforeWrite({ ctx, draft }) {
          await ctx.run({
            action: "create",
            object: REGION,
            id: OTHER,
            values: { code: "R" },
          })
          return draft
        },
      } satisfies ObjectModule<object>,
    }
    const regionCore: Override = (text) =>
      text.includes("region_save")
        ? {
            rows: [{ r: JSON.stringify({ id: OTHER, version: 1, code: "R" }) }],
          }
        : undefined
    const { handle } = await harness(regionCore, modules)
    // `kernels` без `region`: фазу хука будує сервер своїм каталогом.
    const value = valueOf(
      await handle(
        session,
        runOf(createClient, { [client.id]: client.kernelHash }),
        HTTP
      )
    ) as { changes: { object: string }[] }
    expect(value.changes.map((c) => c.object)).toStrictEqual([
      region.id,
      client.id,
    ])
  })

  it("a filter by a lazy attribute is command.invalid, not stale-client", async () => {
    const { db, handle } = await harness()
    const error = errorOf(
      await handle(
        session,
        readOf({
          object: link.id,
          where: { attribute: "archive_id", op: "eq", value: ID },
        }),
        HTTP
      )
    )
    expect(error).toMatchObject({
      code: "command.invalid",
      reason: "lazy",
      object: link.id,
    })
    expect(db.calls).toStrictEqual([])
  })

  it("a mapping refusal is errorToWire with the object, before the runtime", async () => {
    const { calls, handle } = await harness()
    const error = errorOf(
      await handle(
        session,
        runOf({
          action: "create",
          object: sample.id,
          id: ID,
          values: { status_col: "bogus" },
        }),
        HTTP
      )
    )
    expect(error).toStrictEqual({
      code: "command.invalid",
      path: "status_col",
      object: sample.id,
    })
    expect(calls).toStrictEqual({ run: 0, read: 0 })
  })

  it("a CommandFailure is an error value with physical fields", async () => {
    const { handle } = await harness()
    const error = errorOf(
      await handle(
        session,
        runOf({
          action: "create",
          object: link.id,
          id: ID,
          values: { region_id: "not-a-uuid" },
        }),
        HTTP
      )
    )
    expect(error).toMatchObject({
      code: "command.invalid",
      path: "region_id",
      object: link.id,
    })
  })

  it("an unknown name from the mapping after the check is command.internal and logged", async () => {
    vi.mocked(checkCompatibility).mockReturnValueOnce(undefined)
    const { calls, handle, log } = await harness()
    const error = errorOf(
      await handle(
        session,
        runOf({ ...createClient, values: { ctid: "x" } }),
        HTTP
      )
    )
    expect(error).toStrictEqual({ code: "command.internal" })
    expect(log).toHaveBeenCalledOnce()
    expect(calls).toStrictEqual({ run: 0, read: 0 })
  })

  const SECRET = "relation secret_table does not exist"
  it.each<[string, Partial<CommandRuntime>, unknown]>([
    [
      "read throws a plain Error",
      { read: () => Promise.reject(new Error(SECRET)) },
      readOf({}),
    ],
    [
      "run throws a plain Error",
      { run: () => Promise.reject(new Error(SECRET)) },
      runOf(createClient),
    ],
    [
      "run rows do not match the operations",
      { run: () => Promise.resolve({ rows: [], changes: [] }) },
      runOf(createClient),
    ],
    [
      "a CommandFailure with a field outside the wire error",
      {
        run: () =>
          Promise.reject(
            new CommandFailure({
              code: "command.rejected",
              ...{ message: SECRET },
            })
          ),
      },
      runOf(createClient),
    ],
  ])("%s — command.internal without text, logged", async (_, fake, request) => {
    const { runtime } = await harness()
    const log = vi.fn()
    const handle = createDataHandler({ ...runtime, ...fake }, { log })
    const response = await handle(session, request, HTTP)
    expect(errorOf(response)).toStrictEqual({ code: "command.internal" })
    expect(JSON.stringify(response)).not.toContain("secret")
    expect(log).toHaveBeenCalledOnce()
  })

  it("version is frozen: a caller that mutates it does not change later responses", async () => {
    const { handle } = await harness()
    const first = valueOf(
      await handle(session, envelope({ type: "version" }), IN_PROCESS)
    ) as { objects: Record<string, string> }
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.objects)).toBe(true)
    const second = valueOf(
      await handle(session, envelope({ type: "version" }), IN_PROCESS)
    )
    expect(second).toStrictEqual(first)
  })

  it("encodes only the header of a run row: a section line the codec refuses does not fail a committed run", async () => {
    const { runtime } = await harness()
    // Рядок, який рантайм повернув би після `COMMIT`, з рядком ТЧ, номер
    // якого не ціле число: кодек його відхилив би (`WireEncodeError`).
    const row = {
      ref: ID,
      version: 1,
      code: "A",
      tabularSections: { lines: [{ ref: OTHER, lineNumber: 1.5 }] },
    }
    const log = vi.fn()
    const handle = createDataHandler(
      {
        ...runtime,
        run: () => Promise.resolve({ rows: [row], changes: [] }),
      },
      { log }
    )
    const value = valueOf(
      await handle(
        session,
        runOf({ action: "create", object: sample.id, id: ID }),
        HTTP
      )
    )
    expect(value).toStrictEqual({
      rows: [{ id: ID, version: "1", code_col: "A" }],
      changes: [],
    })
    expect(log).not.toHaveBeenCalled()
  })

  it("logs to console.error by default", async () => {
    const { runtime } = await harness()
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const failure = new Error(SECRET)
    const handle = createDataHandler({
      ...runtime,
      read: () => Promise.reject(failure),
    })
    expect(errorOf(await handle(session, readOf({}), HTTP))).toStrictEqual({
      code: "command.internal",
    })
    expect(spy).toHaveBeenCalledWith(failure)
    spy.mockRestore()
  })
})

/**
 * Шлях відмови схеми однаковий в обох шарах (спека П4-B §4.0): перший
 * сегмент шляху ТЧ — сама ТЧ (без структурного `tabularSections`), а
 * операцію пакета називає `object`, не індекс. Шлях конверта мапиться назад
 * у логічний записом T0 (`pathFromWire`). Поля рядка ТЧ схема не перевіряє
 * (рядок — `record`): їх шлях дає перевірка значень, не ця відмова.
 */
describe("schema refusal paths: the logical layer and the envelope agree", () => {
  const SAMPLE = { kind: "Catalog", name: "Sample" }
  const logicalUpdate = { action: "update", object: SAMPLE, id: ID }
  const wireUpdate = { action: "update", object: sample.id, id: ID }
  const logicalCreate = (lines: unknown[]) => ({
    action: "create",
    object: SAMPLE,
    id: ID,
    tabularSections: { lines },
  })
  const wireCreate = (lines: unknown[]) => ({
    action: "create",
    object: sample.id,
    id: ID,
    tabularSections: { [SECTION]: lines },
  })
  const logicalDelete = {
    ...logicalUpdate,
    action: "delete",
    expectedVersion: 1,
  }
  const wireDelete = { ...wireUpdate, action: "delete", expectedVersion: 1 }

  const logicalRefusal = (input: unknown): CommandError | undefined => {
    try {
      prepareInput(handlerCatalog, input)
    } catch (e) {
      if (e instanceof CommandFailure) return e.error
      throw e
    }
    return undefined
  }

  it.each<[string, unknown, object, string]>([
    ["a header field", logicalUpdate, runOf(wireUpdate), "expectedVersion"],
    [
      "a tabular line",
      logicalCreate([{}, 1]),
      runOf(wireCreate([{}, 1])),
      "lines.1",
    ],
    [
      "a header field of the second batch operation",
      [logicalDelete, logicalUpdate],
      batchOf([wireDelete, wireUpdate]),
      "expectedVersion",
    ],
    [
      "a tabular line of the second batch operation",
      [logicalDelete, logicalCreate([{}, 1])],
      batchOf([wireDelete, wireCreate([{}, 1])]),
      "lines.1",
    ],
  ])("%s", async (_, logical, wire, path) => {
    expect(logicalRefusal(logical)).toMatchObject({
      code: "command.invalid",
      path,
    })
    const { handle } = await harness()
    const refusal = errorOf(await handle(session, wire, HTTP))
    expect(refusal).toMatchObject({
      code: "command.invalid",
      object: sample.id,
    })
    const index = catalogIndex(handlerCatalog.objects)
    expect(pathFromWire(index, sample.id, refusal.path ?? "")).toBe(path)
    expect(pathToWire(index, sample.id, path)).toBe(refusal.path)
  })

  // Без `object` операцію пакета називає лише індекс: шлях його зберігає.
  const NOPE = { kind: "Catalog", name: "Nope" }
  it.each<[string, unknown, string]>([
    [
      "an unknown object and a bad field",
      [logicalDelete, { ...logicalUpdate, object: NOPE }],
      "1.expectedVersion",
    ],
    [
      "an object that is not a reference and a bad field",
      [logicalDelete, { ...logicalUpdate, object: "Catalog.Nope" }],
      "1.object",
    ],
    [
      // Перша операція проходить каталог: до другої відмова доходить лише так.
      "an unknown object of a valid operation",
      [
        { ...logicalDelete, object: { kind: "Catalog", name: "Link" } },
        { ...logicalDelete, object: NOPE },
      ],
      "1.object",
    ],
  ])("logical: %s keeps the operation index", (_, input, path) => {
    expect(logicalRefusal(input)).toStrictEqual({
      code: "command.invalid",
      path,
    })
  })

  it.each<[string, object, string]>([
    [
      "an object that is not a UUID and a bad field",
      batchOf([wireDelete, { ...wireUpdate, object: "Catalog.Link" }]),
      "1.object",
    ],
    [
      "an object that is not a UUID and a bad tabular line",
      batchOf([wireDelete, { ...wireCreate([{}, 1]), object: "Catalog.Link" }]),
      "1.object",
    ],
  ])("envelope: %s keeps the operation index", async (_, wire, path) => {
    const { handle } = await harness()
    expect(errorOf(await handle(session, wire, HTTP))).toStrictEqual({
      code: "command.invalid",
      path,
    })
  })
})

describe("CommandRuntime.catalog", () => {
  const frozenDeep = (value: unknown, seen = new Set<unknown>()): boolean => {
    if (value === null || typeof value !== "object" || seen.has(value)) {
      return true
    }
    seen.add(value)
    return (
      Object.isFrozen(value) &&
      Object.values(value).every((v) => frozenDeep(v, seen))
    )
  }

  it("is the parsed catalog, deep-frozen, the runtime's own copy", async () => {
    const { runtime } = await harness()
    expect(runtime.catalog).toStrictEqual(handlerCatalog)
    expect(runtime.catalog).not.toBe(handlerCatalog)
    expect(frozenDeep(runtime.catalog)).toBe(true)
    expect(Object.isFrozen(handlerCatalog)).toBe(false)
  })
})
