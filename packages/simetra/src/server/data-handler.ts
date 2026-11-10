import {
  catalogIndex,
  changesToWire,
  isPlainObject,
  CommandFailure,
  dataRequestSchema,
  encodeRow,
  errorToWire,
  LIMIT_REASONS,
  operationFromWire,
  readPartFromWire,
  readResultToWire,
  sessionClaimsSchema,
  wireCommandErrorSchema,
  wireReadPartSchema,
  type CatalogEntry,
  type CatalogIndex,
  type CommandError,
  type DataRequest,
  type DataResponse,
  type Mapped,
  type Operation,
  type ReadPart,
  type ReadPartValue,
  type SessionClaims,
  type VersionValue,
  type WireCommandError,
  type WireOperation,
} from "simetra/model"
import { z } from "zod"
import { checkCompatibility } from "./compatibility"
import { checkRequestOrigin, type RequestOrigin } from "./origin"
import { decidingIssue, issueReason, operationRefusalPath } from "./read"
import {
  fitParts,
  fitRunResult,
  type ReadSlot,
  type WireReadItem,
} from "./response-budget"
import type { CommandRuntime } from "./runtime"

/**
 * Обробник конверта передачі (спека П4-B §4.5): кроки 0–6 між T4 і рантаймом.
 * Обробник безстановий: індекс каталогу будується раз при створенні, а все
 * про запит — лише в аргументах виклику.
 */

type Request = DataRequest["request"]
type RunRequest = Extract<Request, { type: "run" }>
type ReadRequest = Extract<Request, { type: "read" }>

/**
 * Дефект сервера (`unknown` мапінгу після звірки): назовні — лише
 * `command.internal`, а в журнал іде те, що мапінг не впізнав.
 */
class Defect extends Error {
  constructor(readonly detail: unknown) {
    super("data handler defect")
    this.name = "Defect"
  }
}

const FORBIDDEN: WireCommandError = {
  code: "command.forbidden",
  reason: LIMIT_REASONS.origin,
}

const guid = z.guid()

// Ключ ТЧ логічного рядка (`encodeRow`).
const SECTIONS = "tabularSections"

// Будь-який виняток правила походження — відмова: `origin` без аргументу
// (нетипізований виклик) чи ворожий об'єкт не мають пропустити запит.
function originRefused(origin: RequestOrigin, request: unknown): boolean {
  try {
    return checkRequestOrigin(origin, request) !== undefined
  } catch {
    return true
  }
}

/**
 * Запит старого розгортання: тип, якого сервер не знає (окремий `version`
 * до B1c), чи `read` без `items` (одиночний `query`). Стара вкладка має
 * дізнатися про нове розгортання (`stale-client`), а не отримати `invalid`.
 */
function staleRequest(raw: unknown): boolean {
  try {
    const request = (raw as Raw)?.request
    if (!isPlainObject(request)) return false
    const { type } = request
    if (type === "read") return !Object.hasOwn(request, "items")
    return typeof type === "string" && type !== "run"
  } catch {
    return false
  }
}

/** Значення мапінгу, або його відмова `invalid`; `unknown` — дефект. */
function mappedOrRefused<T>(
  result: Mapped<T>
): { value: T } | { refused: CommandError } {
  if (result.ok) return { value: result.value }
  if ("invalid" in result) return { refused: result.invalid }
  throw new Defect(result.unknown)
}

/** Відмова мапінгу — у форму передачі з `object` операції чи запиту (Р3). */
function mappingRefusal(
  index: CatalogIndex,
  object: string,
  error: CommandError
): WireCommandError {
  const entry = index.byId.get(object)
  return errorToWire(
    index,
    entry === undefined
      ? error
      : { ...error, object: { kind: entry.kind, name: entry.name } }
  )
}

/** Сирий об'єкт операції чи запиту: читання — у `try`, лише UUID. */
function rawObject(read: () => unknown): string | undefined {
  try {
    const parsed = guid.safeParse(read())
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

type Raw = { request?: Record<string, unknown> } | null | undefined

/**
 * Відмова схеми конверта (крок 1) чи частини читання у формі передачі.
 * Шлях — від операції чи запиту, як у логічній формі (`schemaRefusal` у
 * `phase.ts`, `readRefusal` у `read.ts`): префікс `request` і `operation` /
 * `batch.<i>` / `items.<i>.query` прибирається, бо T4 мапить шлях записом
 * об'єкта, а не конверта (частину розбирає окрема схема, тож її шлях
 * приходить префіксом `prefix`); шлях
 * операції — без `tabularSections`, перший сегмент — `<id ТЧ>`; без
 * `object` шлях операції пакета зберігає її індекс. ТЧ понад
 * межу — лише `<id ТЧ>`; пакет понад межу — без шляху й об'єкта.
 */
function envelopeRefusal(
  index: CatalogIndex,
  raw: unknown,
  error: z.ZodError,
  prefix: readonly PropertyKey[] = []
): WireCommandError {
  const reason = issueReason(error)
  if (reason === LIMIT_REASONS.batchTooLarge) {
    return { code: "command.invalid", reason }
  }
  let path: readonly PropertyKey[] = [
    ...prefix,
    ...(decidingIssue(error)?.path ?? []),
  ]
  const request = () => (raw as Raw)?.request
  let object: string | undefined
  // Префікс прибирається, лише коли за ним щось лишається: відсутнє поле
  // самого конверта (`request`, `operation`) зберігає свій шлях.
  // Шлях операції — тією самою нормалізацією, що й логічна відмова
  // (`operationRefusalPath`); запит читання її не має: його `tabularSections`
  // — перелік, а не ТЧ.
  let operation = false
  let opIndex: number | undefined
  const [root, field, at] = path
  if (root === "request" && path.length > 1) {
    if (field === "operation" && path.length > 2) {
      object = rawObject(
        () => (request()?.[field] as { object?: unknown } | undefined)?.object
      )
      operation = true
      path = path.slice(2)
    } else if (field === "items" && typeof at === "number") {
      // Частина читання (B1c): шлях — від її запиту, як в одиночного читання
      // раніше; поле самої частини (`type`, `query`) — від частини.
      if (path[3] === "query" && path.length > 4) {
        object = rawObject(
          () =>
            (
              (request()?.items as { query?: { object?: unknown } }[])[at]
                ?.query as { object?: unknown } | undefined
            )?.object
        )
        path = path.slice(4)
      } else {
        path = path.slice(3)
      }
    } else if (field === "batch" && typeof at === "number" && path.length > 3) {
      object = rawObject(
        () =>
          (request()?.batch as { object?: unknown }[] | undefined)?.[at]?.object
      )
      operation = true
      opIndex = at
      path = path.slice(3)
    } else {
      path = path.slice(1)
    }
  }
  const segments = operation ? operationRefusalPath(path) : path.map(String)
  if (reason === LIMIT_REASONS.tabularTooLarge) {
    return {
      code: "command.invalid",
      reason,
      path: segments.at(-1) ?? "",
      ...(object === undefined ? {} : { object }),
    }
  }
  // Сегмент `id` операції чи картки — ключ запису: на дроті це колонка
  // ключа відомого об'єкта (спека П4-B §4.0).
  const entry = object === undefined ? undefined : index.byId.get(object)
  if (entry !== undefined && segments[0] === "id") segments[0] = entry.key
  // Без `object` операцію пакета називає лише її індекс.
  if (opIndex !== undefined && object === undefined) {
    segments.unshift(String(opIndex))
  }
  return {
    code: "command.invalid",
    ...(reason === undefined ? {} : { reason }),
    ...(segments.length === 0 ? {} : { path: segments.join(".") }),
    ...(object === undefined ? {} : { object }),
  }
}

/** Запис об'єкта рядка результату `run`; поза каталогом — дефект сервера. */
function entryOf(
  index: CatalogIndex,
  object: string | undefined
): CatalogEntry {
  const entry = object === undefined ? undefined : index.byId.get(object)
  if (entry === undefined) {
    throw new Error("run result row without a catalog object")
  }
  return entry
}

/**
 * Логічний рядок `run` без того, що відповідь однаково не несе (Рд26, Рд27):
 * ТЧ і лінивих атрибутів. Кодувати їх — зайва робота, а відмова кодека в
 * них зробила б уже закомічену команду `command.internal`. Що несе рядок
 * `run`, визначає `fitRunResult`; тут лише не кодується відкинуте ним.
 */
function runHeader(
  entry: CatalogEntry,
  row: Record<string, unknown>
): Record<string, unknown> {
  const skip = new Set([
    SECTIONS,
    ...entry.attributes.filter((a) => a.load === "lazy").map((a) => a.name),
  ])
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !skip.has(key))
  )
}

/**
 * Creates the data handler of the transport (P4-B spec §4.5): checks the
 * request origin, the envelope, the session and the compatibility with the
 * runtime catalog, maps the wire form to the logical one, calls the runtime
 * and fits the encoded value into the response budget. Every response
 * carries `serverHash` — the catalog's `snapshotHash`. A `CommandFailure`
 * becomes an error value in wire form; any other exception is
 * `command.internal` with no text and goes to `log` (default
 * `console.error`). The handler keeps no state between calls.
 */
export function createDataHandler(
  runtime: CommandRuntime,
  options: { log?: (error: unknown) => void } = {}
): (
  session: SessionClaims,
  request: unknown,
  origin: RequestOrigin
) => Promise<DataResponse> {
  const { catalog } = runtime
  const serverHash = catalog.snapshotHash
  // Один індекс на життя обробника: звірка, мапінг і бюджет бачать той самий.
  const index = catalogIndex(catalog.objects)
  // Одне значення на всі відповіді `version`, тож заморожене: викликач у
  // процесі, що змінив би його, інакше змінив би й наступні відповіді.
  const version: VersionValue = Object.freeze({
    snapshotHash: serverHash,
    objects: Object.freeze(
      Object.fromEntries(catalog.objects.map((o) => [o.id, o.kernelHash]))
    ),
  })
  const sink = options.log ?? ((error: unknown) => console.error(error))
  const log = (error: unknown) => {
    try {
      sink(error)
    } catch {
      // журнал недоступний — відповідь однаково йде назовні кодом
    }
  }
  const failure = (error: WireCommandError): DataResponse => ({
    ok: false,
    // Сувора схема: поле поза `CommandError` (зокрема текст) не виходить —
    // така помилка стає `command.internal` у зовнішньому `catch`.
    error: wireCommandErrorSchema.parse(error),
    serverHash,
  })

  const partFailure = (error: WireCommandError): WireReadItem => ({
    ok: false,
    // Та сама сувора схема, що й у відповіді цілком (`failure`).
    error: wireCommandErrorSchema.parse(error),
  })

  /**
   * Кроки 1, 3, 4 для однієї частини: відмова схеми, звірки чи мапінгу —
   * лише цій частині. Невідомий тип частини — `invalid`, а не `stale-client`:
   * новіший клієнт на старішому сервері не має перезавантажуватись (звірку
   * версій тримає хеш каталогу).
   */
  function slotOf(
    items: readonly unknown[],
    at: number
  ): { slot: ReadSlot; part?: ReadPart } {
    let parsed: ReturnType<typeof wireReadPartSchema.safeParse>
    try {
      parsed = wireReadPartSchema.safeParse(items[at])
    } catch {
      return { slot: { item: partFailure({ code: "command.invalid" }) } }
    }
    const refused = (error: WireCommandError) => ({
      slot: { item: partFailure(error) },
    })
    if (!parsed.success) {
      return refused(
        envelopeRefusal(index, { request: { items } }, parsed.error, [
          "request",
          "items",
          at,
        ])
      )
    }
    const wire = parsed.data
    if (wire.type === "version") {
      return { slot: { item: { ok: true, value: version } } }
    }
    const stale = checkCompatibility(index, wire)
    if (stale !== undefined) return refused(stale)
    const part = mappedOrRefused(readPartFromWire(index, wire))
    if ("refused" in part) {
      const { object } = wire.query as { object: string }
      return refused(mappingRefusal(index, object, part.refused))
    }
    return { slot: { query: wire.query }, part: part.value }
  }

  async function read(
    claims: SessionClaims,
    request: ReadRequest
  ): Promise<DataResponse> {
    const slots: ReadSlot[] = []
    const parts: ReadPart[] = []
    request.items.forEach((_, at) => {
      const { slot, part } = slotOf(request.items, at)
      slots.push(slot)
      if (part !== undefined) parts.push(part)
    })
    // Крок 6: бюджет міряє кожну частину до наступної (`fit`), тож частина
    // після переповнення бази не бачить.
    const budget = fitParts(index, slots, serverHash)
    const fitted = new Set<number>()
    let defect: { error: unknown } | undefined
    const fit = (part: number, value: ReadPartValue) => {
      if (defect !== undefined) return "overflow"
      fitted.add(part)
      try {
        return budget.fit(
          part,
          readResultToWire(index, parts[part]!.query, value)
        )
      } catch (error) {
        // Кодек відхилив значення рантайму — дефект сервера. Виняток із `fit`
        // рантайм узяв би за збій бази; тут лише зупинка, а відмова — вся
        // відповідь `command.internal` після `readParts`.
        defect = { error }
        return "overflow"
      }
    }
    const result =
      parts.length === 0
        ? { epoch: null, items: [] }
        : await runtime.readParts(claims, parts, { fit })
    const failed = new Map<number, WireCommandError>()
    result.items.forEach((outcome, part) => {
      if (!outcome.ok) {
        failed.set(part, errorToWire(index, outcome.error))
      } else if (!fitted.has(part)) {
        // Рантайм, що не викликав `fit`: бюджет однаково вирішує сам.
        fit(part, outcome.value)
      }
    })
    if (defect !== undefined) throw new Defect(defect.error)
    for (const [part, error] of failed) {
      failed.set(part, wireCommandErrorSchema.parse(error))
    }
    const value = budget.finish(result.epoch, failed)
    return "code" in value
      ? failure(errorToWire(index, value))
      : { ok: true, value, serverHash }
  }

  async function run(
    claims: SessionClaims,
    request: RunRequest
  ): Promise<DataResponse> {
    const operations: readonly WireOperation[] =
      request.batch ??
      (request.operation === undefined ? [] : [request.operation])
    const logical: Operation[] = []
    for (const wire of operations) {
      const op = mappedOrRefused(operationFromWire(index, wire))
      if ("refused" in op) {
        return failure(mappingRefusal(index, wire.object, op.refused))
      }
      logical.push(op.value)
    }
    // Одна операція йде як є, а не пакетом з однієї: так межі й шляхи
    // відмови T3 — ті самі, що в запиті клієнта.
    const result = await runtime.run(
      claims,
      request.batch === undefined ? logical[0]! : logical,
      { fullTabularArrays: true }
    )
    const rows = result.rows.map((row, i) => {
      const entry = entryOf(index, operations[i]?.object)
      return encodeRow(entry, runHeader(entry, row))
    })
    const changes = mappedOrRefused(changesToWire(index, result.changes))
    if ("refused" in changes) throw new Defect(changes.refused)
    return {
      ok: true,
      value: fitRunResult(
        index,
        operations,
        { rows, changes: changes.value },
        serverHash
      ),
      serverHash,
    }
  }

  async function handle(
    session: SessionClaims,
    raw: unknown,
    origin: RequestOrigin
  ): Promise<DataResponse> {
    // Крок 0 — до будь-якого розбору: відмова походження на невалідному
    // конверті — `forbidden`, а не `invalid`.
    if (originRefused(origin, raw)) return failure(FORBIDDEN)
    // Крок 1.
    let parsed: ReturnType<typeof dataRequestSchema.safeParse>
    try {
      parsed = dataRequestSchema.safeParse(raw)
    } catch {
      // Геттер, що кидає, чи відкликаний `Proxy` у вході.
      return failure({ code: "command.invalid" })
    }
    if (!parsed.success) {
      return failure(
        staleRequest(raw)
          ? { code: "command.stale-client" }
          : envelopeRefusal(index, raw, parsed.error)
      )
    }
    // Повторна звірка типу: крок 0 читав сирий вхід, а розбір читає його
    // вдруге, тож геттер чи `Proxy` міг підмінити `read` на `run`. Розібране
    // значення — звичайні дані, і рішення приймається на ньому.
    if (originRefused(origin, parsed.data)) return failure(FORBIDDEN)
    const { subject, request } = parsed.data
    // Крок 2: далі йдуть розібрані claims, а не сирий об'єкт викликача.
    let claims: SessionClaims
    try {
      const checked = sessionClaimsSchema.safeParse(session)
      if (!checked.success) return failure({ code: "command.unauthenticated" })
      claims = checked.data
    } catch {
      return failure({ code: "command.unauthenticated" })
    }
    if (subject !== claims.sub) {
      return failure({
        code: "command.unauthenticated",
        reason: LIMIT_REASONS.sessionChanged,
      })
    }
    // Крок 3: помилка звірки — уже форми передачі, з UUID із запиту. Частини
    // читання звіряються кожна окремо (`slotOf`).
    if (request.type === "run") {
      const stale = checkCompatibility(index, request)
      if (stale !== undefined) return failure(stale)
    }
    // Кроки 4–6.
    try {
      return request.type === "read"
        ? await read(claims, request)
        : await run(claims, request)
    } catch (error) {
      if (error instanceof CommandFailure) {
        return failure(errorToWire(index, error.error))
      }
      throw error
    }
  }

  return async (session, request, origin) => {
    try {
      return await handle(session, request, origin)
    } catch (error) {
      log(error instanceof Defect ? error.detail : error)
      return { ok: false, error: { code: "command.internal" }, serverHash }
    }
  }
}
