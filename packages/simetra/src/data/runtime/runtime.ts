import {
  CommandFailure,
  LIMIT_REASONS,
  PAYLOAD_MAX_BYTES,
  catalogIndex,
  clientCatalogSchema,
  errorFromWire,
  jsonBytes,
  type CommandError,
  type DataRequest,
  type DataResponse,
  type DataTransport,
  type SourceAdapter,
} from "simetra/model"
import {
  selectSource,
  serverFunctionAdapter,
  serverFunctionPort,
} from "../adapter"
import { createWriter } from "../data-writer"
import { createCore, limitsOf } from "../store/core"
import { createCoreSource, createReadLimiter } from "../store/source"
import type {
  CloseReason,
  CoreLimits,
  CoreLogEntry,
  CoreSnapshot,
  ViewSpec,
} from "../store/types"
import { bindRuntimeHandle, type RuntimeRequest } from "./handle"

/** The data runtime of one user session (P4-B spec §6.1). */
export interface DataRuntime {
  /** The session `sub`; every request of this runtime carries it. */
  readonly subject: string
  /** Closes the runtime; later requests are refused without the transport. */
  dispose(): void
  /**
   * Holds the view `spec` until its first subscription or `ttlMs` (default
   * 5 s) and resolves after its first load: for a router loader (P4-B spec
   * §6.1, §6.6). Throws synchronously on a refused spec (`TypeError`, `DataError`).
   */
  preload(spec: ViewSpec, options?: { ttlMs?: number }): Promise<void>
  /** The list strategy of `object` (`"<kind>.<name>"`): `window` unless the settings name it. */
  residencyOf(object: string): "full" | "window"
  readonly disposed: boolean
  /**
   * The snapshot of the ready held views for the client (P4-B spec §6.6):
   * `meta` names the subject the rows were read for. Throws
   * `TypeError` once the runtime is disposed, and while a write is in the
   * journal. The server calls it, then `dispose()`.
   */
  dehydrate(): DataSnapshot
  /**
   * Takes a snapshot before the first render: every view of it is held,
   * loaded and ready. Throws `TypeError`, writing nothing, when the `format`
   * is unknown, `meta.subject` is not this runtime's, the runtime was already
   * hydrated or holds views. Does nothing after `dispose()`. A snapshot of
   * another subject never enters this runtime.
   */
  hydrate(snapshot: DataSnapshot): void
  /**
   * Ends the hydration, once: reconciles with the server (the catalog
   * version, one re-read of every visible view) in one microtask. A repeat
   * does nothing, so StrictMode is safe.
   */
  endHydration(): void
  /** Whether the host shows the application; starts as `options.visible`. */
  readonly visible: boolean
  /**
   * Marks the application hidden; the host calls it on `visibilitychange`
   * to `hidden`. Idempotent, sends nothing, and does nothing after
   * `dispose()`.
   */
  suspend(): void
  /**
   * Marks the application visible again; the host calls it on
   * `visibilitychange` to `visible` and on `focus`. Does nothing after
   * `dispose()`. A call less than a second after the
   * last accepted one only sets `visible`. An accepted call asks for the
   * catalog version and re-reads the visible views last refreshed longer ago
   * than `limits.resumeMinIntervalMs` (or never), in one microtask.
   */
  resume(): void
}

/**
 * What the server hands to the client runtime (P4-B spec §6.6): plain JSON,
 * the same after `JSON.parse(JSON.stringify(...))`.
 */
export interface DataSnapshot {
  readonly meta: SnapshotMeta
  readonly core: CoreSnapshot
}

/** Who a {@link DataSnapshot} was taken for. */
export interface SnapshotMeta {
  /** The session `sub` of the runtime that took it. */
  readonly subject: string
}

export interface DataRuntimeOptions {
  /** The client catalog (`client-catalog.json`); validated on creation. */
  catalog: unknown
  transport: DataTransport
  /** The session `sub`. */
  subject: string
  /**
   * Called once when the server, or an override adapter, reports
   * `session-changed`; the runtime is already closed by then.
   */
  onSessionChanged?: () => void
  /**
   * Called once per object, on its transition to stale (its kernel differs
   * from the server's or a part of a read or write is refused
   * `command.stale-client`; P4-B spec §10). It only offers a reload: the runtime never reloads itself,
   * so unsaved forms of other objects are not lost.
   */
  onStaleClient?: (object: string) => void
  /** The initial `visible` of the runtime (default `true`). */
  visible?: boolean
  /** The runtime journal (default `console.warn`); see {@link DataLogEntry}. */
  log?: (entry: DataLogEntry) => void
  /**
   * Source adapters (P4-B spec §5.1). `override` maps a logical object name
   * `"<kind>.<name>"` to a factory of its adapter; a name outside the catalog
   * is a `TypeError`. Each factory is called once on creation with this
   * runtime's `subject` and transport wrapper `send`: the adapter either
   * reads through `send` (it sets `subject`) or checks the `sub` of its own
   * credentials against `subject` itself (PostgREST adapter, §5.3). A
   * `CommandFailure` `command.unauthenticated` `session-changed` from an
   * override closes the runtime and calls `onSessionChanged` once, as the
   * same response of the transport does.
   */
  sources?: {
    override?: Readonly<
      Record<
        string,
        (context: {
          subject: string
          send: (request: DataRequest["request"]) => Promise<unknown>
        }) => SourceAdapter
      >
    >
  }
  /**
   * The list strategy per object (P4-B spec §5.1, Рд19): a map of logical
   * names `"<kind>.<name>"` to `full` or `window`; an object not named is
   * `window`. A name outside the catalog is a `TypeError`.
   */
  residency?: Readonly<Record<string, "full" | "window">>
  /** The row limit of a `full` view (default 5 000); overrides `limits.fullLimit`. */
  fullLimit?: number
  /** `full` over its limit fails with `data.full-too-large` (default `false`). */
  strict?: boolean
  /** Memory and request limits of the core (P4-B spec §6.2); positive integers. */
  limits?: Partial<CoreLimits>
}

/**
 * An entry of the runtime journal (P4-B spec §6.1). `transport-failed`: the
 * transport threw or rejected; the caller saw `command.unavailable`. The
 * other kinds come from the data core.
 */
export type DataLogEntry =
  { kind: "transport-failed"; error: unknown } | CoreLogEntry

// Відмова рантайму після звичайного `dispose()` (вихід, зміна користувача з
// боку host-а): сесії рантайму вже немає, а проміс викликача мусить
// завершитися, а не висіти. Окрема причина, бо write-back і перечитування
// B3-3 мусять відрізнити «рантайм закрито — нічого не робити» від «сервер
// недоступний — перечитати»: без неї таблиця §7.3 перечитувала б після
// `dispose()`.
const DISPOSED: CommandError = {
  code: "command.unavailable",
  reason: LIMIT_REASONS.disposed,
}

// Зміна сесії, яку побачило ядро у відповіді `rights` (Р7): та сама відмова,
// що її дає сервер, тож викликачі бачать один код.
const SESSION_CHANGED: CommandError = {
  code: "command.unauthenticated",
  reason: LIMIT_REASONS.sessionChanged,
}

const hasVersionPart = (request: RuntimeRequest): boolean =>
  request.type === "read" &&
  request.items.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "version"
  )

const isSessionChanged = (error: CommandError) =>
  error.code === "command.unauthenticated" &&
  error.reason === LIMIT_REASONS.sessionChanged

/** Creates the data runtime of one user session (P4-B spec §6.1). */
export function createDataRuntime(options: DataRuntimeOptions): DataRuntime {
  const catalog = clientCatalogSchema.parse(options.catalog)
  const index = catalogIndex(catalog.objects)
  const { transport, subject, onSessionChanged } = options
  // Усі перевірки — до першої фабрики адаптера: відмова створення не лишає
  // по собі адаптерів із побічними діями.
  const overrides = Object.entries(options.sources?.override ?? {})
  for (const [name] of overrides) {
    if (!index.byRef.has(name)) {
      throw new TypeError(`sources.override: unknown object ${name}`)
    }
  }
  const residency = new Map<string, "full" | "window">()
  for (const [name, strategy] of Object.entries(options.residency ?? {})) {
    const entry = index.byRef.get(name)
    if (entry === undefined) {
      throw new TypeError(`residency: unknown object ${name}`)
    }
    if (strategy !== "full" && strategy !== "window") {
      throw new TypeError(`residency: ${name} must be "full" or "window"`)
    }
    residency.set(entry.id, strategy)
  }
  const { fullLimit } = options
  if (
    fullLimit !== undefined &&
    (!Number.isSafeInteger(fullLimit) || fullLimit < 1)
  ) {
    throw new TypeError("fullLimit must be a positive integer")
  }
  // Межі перевіряються тут, до обмежувача й фабрик: кожна хибна межа —
  // той самий `TypeError` ядра, а не `RangeError` обмежувача.
  const limits = limitsOf({
    ...options.limits,
    ...(fullLimit === undefined ? {} : { fullLimit }),
  })
  const sink = options.log ?? ((entry: DataLogEntry) => console.warn(entry))
  const log = (entry: DataLogEntry) => {
    try {
      sink(entry)
    } catch {
      // Журнал недоступний — результат запиту від нього не залежить.
    }
  }
  // Причина закриття: після неї кожна відповідь, зокрема пізня, відхиляється
  // нею — рядки попереднього користувача викликачу не доходять.
  let closedWith: CommandError | undefined

  // Закриття рантайму — це закриття його ядра: одна purge-пачка (кожен
  // вигляд — `purged` з причиною), потім жодного запиту й запису (§6.1).
  // `closedWith` ставиться до `core.close`, щоб слухач purge-пачки вже не
  // відправив запиту.
  const close = (error: CommandError, reason: CloseReason) => {
    if (closedWith !== undefined) return
    closedWith = error
    try {
      core.close(reason)
    } catch {
      // Ядро не закривається всередині `commit` (кидає, лишаючись живим);
      // туди `dispose()` доходить, наприклад, з журналу host-а на
      // `full-truncated`. Закриття відкладається на мікрозадачу — вона
      // настає після `commit` і його сповіщення, — а запити рантайм
      // відхиляє вже зараз.
      queueMicrotask(() => core.close(reason))
    }
  }

  // `session-changed` з будь-якого шляху — відповідь транспорту чи відмова
  // адаптера-перевизначення, що сам звіряє `sub` (§5.3): спершу закрити,
  // потім колбек — host у колбеку створює рантайм нового користувача, і
  // старий на цей момент уже не відповідає нікому. Колбек — один раз: після
  // першого закриття решта відмов сюди не доходить. Обидва шляхи кличуть це
  // після `await` чи в обробнику промісу, тобто поза будь-яким `commit`.
  const sessionChanged = (error: CommandError) => {
    if (closedWith !== undefined) return
    close(error, "session-changed")
    try {
      onSessionChanged?.()
    } catch (thrown) {
      // Збій колбека host-а не підміняє відмову запиту: викликач однаково
      // бачить `session-changed`, а збій виходить окремо, як неперехоплений.
      queueMicrotask(() => {
        throw thrown
      })
    }
  }

  // Відмова `session-changed` адаптера-перевизначення закриває рантайм так
  // само, як відповідь транспорту: інакше лишились би тільки помилка
  // вигляду, а решта виглядів — з рядками старого суб'єкта. Обробник
  // промісу завжди виконується мікрозадачею, тож навіть синхронний кидок
  // `read` закриває рантайм поза `commit`.
  const watchSessionChanged = (adapter: SourceAdapter): SourceAdapter => ({
    capabilities: adapter.capabilities,
    read(items) {
      let pending: ReturnType<SourceAdapter["read"]>
      try {
        pending = adapter.read(items)
      } catch (error) {
        pending = Promise.reject(error)
      }
      return pending.catch((error: unknown) => {
        if (error instanceof CommandFailure && isSessionChanged(error.error))
          sessionChanged(error.error)
        throw error
      })
    },
  })

  const send = async (request: RuntimeRequest): Promise<unknown> => {
    if (closedWith !== undefined) throw new CommandFailure(closedWith)
    const body: DataRequest = { subject, request }
    // Та сама міра й той самий код, що в host-а (§4.5): межу хоста
    // ловить лише чужий клієнт.
    if (jsonBytes(body) > PAYLOAD_MAX_BYTES) {
      throw new CommandFailure({
        code: "command.invalid",
        reason: LIMIT_REASONS.payloadTooLarge,
      })
    }
    let response: DataResponse
    try {
      response = await transport(body)
    } catch (error) {
      // Закритий рантайм важить більше за збій: `AbortError` після
      // `dispose()` чи пізня відмова — це «закрито», а не «недоступно».
      if (closedWith !== undefined) throw new CommandFailure(closedWith)
      // Сирий виняток обійшов би таблицю §7.3: для `run` «недоступно» —
      // результат невідомий, і ядро перечитує ключі без повтору. Оригінал
      // іде в журнал, викликач бачить лише код.
      log({ kind: "transport-failed", error })
      throw new CommandFailure({ code: "command.unavailable" })
    }
    // Відповідь, що прийшла після закриття, нікуди не йде (спека §11, інв. 12).
    if (closedWith !== undefined) throw new CommandFailure(closedWith)
    // Хеш звіряється лише після перевірки закриття (вище): відповідь закритого
    // рантайму не запускає `version`. Відповідь з частиною `version` хеш лише
    // оновлює.
    const seen = () => {
      if (typeof response.serverHash === "string")
        core.serverHash(response.serverHash, hasVersionPart(request))
    }
    if (response.ok) {
      seen()
      staleParts(request, response.value)
      return response.value
    }
    const error = errorFromWire(index, response.error)
    if (isSessionChanged(error)) sessionChanged(error)
    else {
      seen()
      staleRead(request, error)
    }
    throw new CommandFailure(error)
  }

  // Відмова всього `read` — `stale-client` (запит старого розгортання, §10):
  // об'єкт відмови, а без нього — кожен об'єкт частин запиту. Викликається
  // лише після перевірки закриття, як і `staleParts`.
  const staleRead = (request: RuntimeRequest, error: CommandError) => {
    if (request.type !== "read" || error.code !== "command.stale-client") return
    if (error.object !== undefined) {
      core.staleClient(`${error.object.kind}.${error.object.name}`)
      return
    }
    const objects = new Set<string>()
    for (const part of request.items) {
      const id = (part as { query?: { object?: unknown } }).query?.object
      const entry = typeof id === "string" ? index.byId.get(id) : undefined
      if (entry !== undefined) objects.add(`${entry.kind}.${entry.name}`)
    }
    for (const object of objects) core.staleClient(object)
  }

  // Відмова частини `read` — `stale-client`, хоч би яка причина (колонка поза
  // переліком, невідомий об'єкт, інший kernelHash): сервер причини не несе, тож
  // ядро ставить липку позначку об'єкта (§10). Викликається лише після
  // перевірки закриття.
  const staleParts = (request: RuntimeRequest, value: unknown) => {
    if (request.type !== "read" || typeof value !== "object" || value === null)
      return
    const items = (value as { items?: unknown }).items
    if (!Array.isArray(items)) return
    items.forEach((item: unknown, slot) => {
      const error = (item as { ok?: unknown; error?: unknown } | null)?.error
      if (
        (item as { ok?: unknown } | null)?.ok !== false ||
        (error as { code?: unknown } | null)?.code !== "command.stale-client"
      )
        return
      const part = request.items[slot] as
        { query?: { object?: unknown } } | undefined
      const id = (error as { object?: unknown }).object ?? part?.query?.object
      const entry = typeof id === "string" ? index.byId.get(id) : undefined
      if (entry !== undefined) core.staleClient(`${entry.kind}.${entry.name}`)
    })
  }

  const serverFunction = serverFunctionAdapter(send)
  const adapters = new Map<string, SourceAdapter>()
  const source = createCoreSource(
    (object) =>
      selectSource({
        profile: catalog.provider,
        override: adapters.get(`${object.kind}.${object.name}`),
        serverFunction,
      }),
    index,
    createReadLimiter(limits.readParallel),
    // Запис і версія каталогу — завжди Server Function, навіть коли об'єкт
    // читає адаптер-перевизначення (§5.1).
    serverFunctionPort(send, serverFunction)
  )
  const core = createCore({
    subject,
    source,
    index,
    limits,
    residency,
    ...(options.strict === undefined ? {} : { strict: options.strict }),
    ...(options.visible === undefined ? {} : { visible: options.visible }),
    log,
    snapshotHash: catalog.snapshotHash,
    rightsSnapshot: catalog.rightsSnapshot === true,
    // Інший користувач у відповіді `rights` (Р7) — той самий шлях, що й
    // відмова `session-changed` транспорту: ядро кличе це поза `commit`.
    onSessionChanged: () => sessionChanged(SESSION_CHANGED),
    ...(options.onStaleClient === undefined
      ? {}
      : { onStaleClient: options.onStaleClient }),
  })
  // Фабрики — після обгортки `send` і ядра: адаптер отримує саме цей
  // `subject` і саме цю обгортку, тож його запити несуть суб'єкт рантайму.
  for (const [name, factory] of overrides) {
    adapters.set(name, watchSessionChanged(factory({ subject, send })))
  }

  const runtime: DataRuntime = {
    subject,
    get disposed() {
      return closedWith !== undefined
    },
    dispose: () => close(DISPOSED, "disposed"),
    dehydrate: () => ({
      meta: { subject },
      core: core.dehydrate(),
    }),
    hydrate(snapshot) {
      if (closedWith !== undefined) return
      const meta = (snapshot as { meta?: unknown } | null)?.meta as
        { subject?: unknown } | undefined
      if (typeof meta?.subject !== "string")
        throw new TypeError("snapshot: meta is malformed")
      // Знімок іншого суб'єкта не входить у цей рантайм: ні рядка, ні
      // підмножини; сервер на звірці однаково відповів би `session-changed`.
      if (meta.subject !== subject)
        throw new TypeError("snapshot: the subject differs from the runtime's")
      core.hydrate(snapshot.core)
    },
    // Збірку клієнта, що розійшлась зі збіркою рендера, ловить `version`, який
    // звірка ядра шле завжди: розбіжність іде шляхом `stale-client`.
    endHydration() {
      if (closedWith === undefined) core.endHydration()
    },
    get visible() {
      return core.visible
    },
    suspend() {
      if (closedWith === undefined) core.suspend()
    },
    resume() {
      if (closedWith === undefined) core.resume()
    },
    preload: (spec, preloadOptions) => core.preload(spec, preloadOptions),
    residencyOf: (object) => core.residencyOf(object),
  }
  bindRuntimeHandle(runtime, { send, core, writer: createWriter(core) })
  return runtime
}
