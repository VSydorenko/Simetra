import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ORGANIZATION_ID,
  OBJECT_ID,
  SCOPE_KIND_ID,
} from "../../../model/runtime/__tests__/entries"
import { channelTopic, readResultFromWire, type ReadRows } from "simetra/model"
import { DataError } from "../../errors"
import { coreInternals, type CoreSession, type DefectFlag } from "../core"
import { visibleRow } from "../object-store"
import type { Subset } from "../subsets"
import type { FakeRead } from "../testing/fake-source"
import type {
  CloseReason,
  Key,
  ObjectName,
  RowView,
  ViewHandle,
  ViewSnapshot,
  ViewSpec,
} from "../types"
import { ORG, S, TASK, key, keysOf, setup } from "./core-support"

/*
 * Модельний тест ядра — гейт блоку (план П4-B3-2, задача 10; спека П4-B §11,
 * §12). Випадкові переплетення над фейковим сервером з історією: утримання
 * виглядів, відповіді на будь-який запит у польоті в будь-якому порядку
 * (зокрема пізні — після звільнення, `purge` чи `close`), чужі правки,
 * видалення й переїзди між скоупами, зміна видимості (RLS), `purge`,
 * `revalidate`, позначки, плин часу й `close`. Після кожного кроку модель
 * перевіряє інваріанти ядра; самотест вмикає навмисні дефекти
 * (`inspectCore().defects`) і чекає червоного.
 *
 * Еталон — не друга реалізація ядра, а сервер з історією і журнал
 * доставлених відповідей: кожне показане значення мусить прийти з
 * відповіді, яку модель доставила, і дорівнювати стану сервера на мить того
 * читання; значення після `removed` чи `purge` — лише з читання, яке
 * почалось після позначки.
 */

const T = "00000000-0000-4000-8000-0000000000b2"
const SCOPES = [S, T] as const
const KEYS = [key(1), key(2), key(3), key(4), key(5)]
const [K1, K2, K3, K4, K5] = KEYS as [Key, Key, Key, Key, Key]
const ORG_KEYS = [S, T]
const TITLES = ["a", "m", "t", "z"]

// П7: межі моделі малі, щоб витіснення пам'яті версій і надгробків і
// межа виглядів траплялись у кожному прогоні, а не раз на тисячу.
const LIMITS = {
  seenMax: 3,
  tombstonesMax: 3,
  horizonBuckets: 16,
  viewsMax: 8,
  fullPageSize: 3,
}
const RELEASE_MS = 1_000

const SPECS: readonly ViewSpec[] = [
  { kind: "keys", object: TASK, keys: [K1, K2] },
  { kind: "keys", object: TASK, keys: [K2, K3, K5] },
  { kind: "card", object: TASK, key: K1 },
  { kind: "card", object: TASK, key: K3 },
  { kind: "section", object: TASK, owner: K1, section: "lines" },
  {
    kind: "full",
    object: TASK,
    orderBy: [{ attribute: "title", direction: "asc" }],
    include: ["org"],
  },
  {
    kind: "full",
    object: TASK,
    where: { attribute: "title", op: "gte", value: "m" },
    orderBy: [{ attribute: "title", direction: "desc" }],
  },
  { kind: "keys", object: TASK, keys: [K4] },
  { kind: "keys", object: TASK, keys: [K1] },
  { kind: "keys", object: ORG, keys: [S, T] },
  { kind: "keys", object: ORG, keys: [S] },
]
/** Вигляди прокрутки: списки й картки без `full` (він тримає все). */
const SCROLL = SPECS.flatMap((spec, v) => (spec.kind === "full" ? [] : [v]))
const isList = (spec: ViewSpec) => spec.kind === "keys" || spec.kind === "full"

const channel = (object: ObjectName, scope: string) =>
  channelTopic({
    kind: "changes",
    scopeKindId: SCOPE_KIND_ID,
    scope,
    object: object === TASK ? OBJECT_ID : ORGANIZATION_ID,
  })
const CHANNELS = [
  channel(TASK, S),
  channel(TASK, T),
  channel(ORG, S),
  channel(ORG, T),
]

type How = "ok" | "stale" | "forbidden" | "missing" | "unavailable"

type Step =
  | { t: "sub"; v: number }
  | { t: "unsub"; v: number; release: boolean }
  | { t: "churn"; v: number; scroll: boolean }
  | { t: "preload"; v: number; short: boolean }
  | { t: "slow"; v: number }
  | { t: "refresh"; v: number; showNew: boolean }
  | { t: "visible"; v: number; on: boolean }
  | { t: "answer"; pick: number; how: How; at: number }
  | { t: "edit"; k: number; title: number }
  | { t: "delete"; k: number }
  | { t: "move"; k: number }
  | { t: "lines"; qty: number }
  | { t: "create"; scope: number }
  | { t: "access"; which: number }
  | { t: "purgeKey"; org: boolean; k: number }
  | { t: "purgeScope"; org: boolean; scope: number }
  | { t: "revalidate"; org: boolean; visibleOnly: boolean }
  | { t: "markStale"; k: number; plus: number }
  | { t: "disconnect"; channel: number; clear: boolean }
  | { t: "markViews"; v: number; one: boolean; needs: boolean; news: boolean }
  | { t: "time"; ms: number }
  | { t: "close"; reason: CloseReason }

const view = fc.nat(SPECS.length - 1)
const k = fc.nat(KEYS.length - 1)
const one = <T extends Step["t"]>(t: T) => fc.constant(t)

/**
 * Ваги (бриф, крок 1): сума 223; `purge` (16 + 14), відсутній рядок і
 * застаріла репліка — по 30, тобто по ~13,5 % кроків (частина кроків
 * `answer` порожня, бо в польоті нічого нема, тож серед дійових кроків
 * частка вища, близько 15 %). Самотест тримає насіння, яке знаходить
 * дефекти за кількістю прогонів: зміна генератора (ваги, профілі, масиви
 * кроків) зсуває ці числа, тож після неї самотест перевіряють заново.
 */
const STEP: fc.Arbitrary<Step> = fc.oneof(
  { weight: 24, arbitrary: fc.record({ t: one("sub"), v: view }) },
  // `release` — відписка й плин часу до звільнення одним кроком: звільнення
  // ключів (пам'ять версій, надгробки слотів `removed`) трапляється частіше.
  {
    weight: 12,
    arbitrary: fc.record({ t: one("unsub"), v: view, release: fc.boolean() }),
  },
  // Вигляд відкрили, він завантажився й закрився (прокрутка, перехід):
  // ключі проходять крізь сховище, пам'ять версій і надгробки витісняються.
  // `scroll` — те саме для всіх списків і карток підряд, як прокрутка: пам'ять
  // версій переповнюється, поки давнє читання іншого вигляду ще в польоті.
  {
    weight: 10,
    arbitrary: fc.record({ t: one("churn"), v: view, scroll: fc.boolean() }),
  },
  {
    weight: 4,
    arbitrary: fc.record({ t: one("preload"), v: view, short: fc.boolean() }),
  },
  // Повільна мережа: читання підписки доходять лише в кінці прогону.
  { weight: 4, arbitrary: fc.record({ t: one("slow"), v: view }) },
  {
    weight: 10,
    arbitrary: fc.record({ t: one("refresh"), v: view, showNew: fc.boolean() }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: one("visible"), v: view, on: fc.boolean() }),
  },
  ...(
    [
      ["ok", 10],
      ["stale", 30],
      ["missing", 30],
      ["forbidden", 4],
      ["unavailable", 4],
    ] as const
  ).map(([how, weight]) => ({
    weight,
    arbitrary: fc.record({
      t: one("answer"),
      pick: fc.nat(7),
      how: fc.constant<How>(how),
      at: fc.nat(6),
    }),
  })),
  {
    weight: 8,
    arbitrary: fc.record({
      t: one("edit"),
      k,
      title: fc.nat(TITLES.length - 1),
    }),
  },
  { weight: 4, arbitrary: fc.record({ t: one("delete"), k }) },
  { weight: 6, arbitrary: fc.record({ t: one("move"), k }) },
  { weight: 2, arbitrary: fc.record({ t: one("lines"), qty: fc.nat(9) }) },
  { weight: 2, arbitrary: fc.record({ t: one("create"), scope: fc.nat(1) }) },
  { weight: 4, arbitrary: fc.record({ t: one("access"), which: fc.nat(2) }) },
  {
    weight: 16,
    arbitrary: fc.record({ t: one("purgeKey"), org: fc.boolean(), k }),
  },
  {
    weight: 14,
    arbitrary: fc.record({
      t: one("purgeScope"),
      org: fc.boolean(),
      scope: fc.nat(1),
    }),
  },
  {
    weight: 10,
    arbitrary: fc.record({
      t: one("revalidate"),
      org: fc.boolean(),
      visibleOnly: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: one("markStale"), k, plus: fc.nat(1) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: one("disconnect"),
      channel: fc.nat(CHANNELS.length),
      clear: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: one("markViews"),
      v: view,
      one: fc.boolean(),
      needs: fc.boolean(),
      news: fc.boolean(),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      t: one("time"),
      ms: fc.constantFrom(500, RELEASE_MS, 5_000),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: one("close"),
      reason: fc.constantFrom<CloseReason>(
        "disposed",
        "session-changed",
        "signed-out",
        "subject-changed"
      ),
    }),
  }
)

/** One read the model delivered: what it carried, by its arrival index. */
interface Delivery {
  readonly index: number
  readonly object: ObjectName
  readonly rows: ReadonlyMap<Key, number>
  /** A section read: its owner and owner version. */
  readonly owner?: { readonly key: Key; readonly version: number }
}

class ModelFailure extends Error {}

/**
 * Профіль прогону. `full` — кроки як згенеровано. Інші не тримають `full`
 * (він тримає кожен рядок об'єкта, і ключі не звільняються) і роблять
 * `purge` лише одного об'єкта: `purge` робить недійсними всі завантаження
 * свого об'єкта в польоті (П12), а давнє читання іншого має дійти пізно,
 * після витіснень. `scroll` — `purge` організацій і прокрутка задач:
 * витісняється переважно пам'ять версій; `burial` — `purge` задач (кожен
 * ховає кілька ключів), прокрутку замінено звичайною підпискою, давнє
 * читання — організацій: витісняються переважно надгробки. Так горизонт
 * однієї мапи не затуляє дефекту іншої.
 */
type Profile = "full" | "scroll" | "burial"

function leanStep(s: Step, profile: Profile): Step {
  if (s.t === "churn" && profile === "burial") return { t: "sub", v: s.v }
  // У `burial` завантаження задач у польоті скасовує їхній `purge`: давнє
  // читання — організацій.
  if (s.t === "slow" && profile === "burial") return { ...s, v: 9 + (s.v % 2) }
  if (s.t === "revalidate" && profile === "burial") return { ...s, org: true }
  if (
    (s.t === "sub" || s.t === "churn" || s.t === "preload") &&
    SPECS[s.v]!.kind === "full"
  )
    return { ...s, v: s.v === 5 ? 7 : 8 }
  if (s.t === "purgeKey" || s.t === "purgeScope")
    return { ...s, org: profile === "scroll" }
  return s
}

const fail = (label: string, message: string): never => {
  throw new ModelFailure(`${label}: ${message}`)
}

/** Дає дійти всім мікрозадачам: ядро не ставить макрозадач, крім таймерів. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

const id = (object: ObjectName, k: Key) => `${object}\u0000${k}`

async function runModel(
  steps: readonly Step[],
  preloaded: boolean,
  profile: Profile,
  defects: readonly DefectFlag[] = []
) {
  const { fake, core, log, inspect } = setup({ limits: LIMITS, mode: "manual" })
  for (const flag of defects) inspect.defects.add(flag)
  const internals = coreInternals(core)

  // Сервер: дві організації (скоупи), чотири задачі в двох скоупах, ТЧ K1.
  for (const org of ORG_KEYS) fake.insert(ORG, { ref: org })
  KEYS.slice(0, 4).forEach((k, i) =>
    fake.insert(TASK, {
      ref: k,
      org: i < 2 ? S : T,
      title: `t${i + 1}`,
      notes: `n${i + 1}`,
    })
  )
  let created = false
  const late: FakeRead[] = []
  let visibility: readonly string[] | undefined
  const deleted = new Set<string>()
  // Історія рядків ТЧ K1 у моделі: версія власника → кількості.
  const linesHistory: { at: number; qty: number[] }[] = []
  const setLines = (qty: number) => {
    const at = fake.setLines(TASK, K1, "lines", [
      { ref: key(900 + qty), qty, lineNumber: 1 },
    ])
    linesHistory.push({ at, qty: [qty] })
  }
  setLines(0)

  const handles: ViewHandle[] = SPECS.map((spec) => core.view(spec))
  const subs: ((() => void) | undefined)[] = SPECS.map(() => undefined)
  let frames = 0
  const errors: unknown[] = []

  // Журнал доставлених відповідей і бар'єри позначок.
  const deliveries = new Map<string, Delivery[]>()
  const sectionDeliveries: Delivery[] = []
  // Ключ, якого торкнувся `purge`: будь-який запис у сховищі — лише з
  // читання, що надійшло на сервер після нього (П12).
  const purgeBarrier = new Map<string, number>()
  // Власник, чиї рядки ТЧ прибрав `purge`: рядки ТЧ — лише з читання ТЧ
  // після нього (П12).
  const sectionBarrier = new Map<Key, number>()
  const barrierSections = (stepStart: number) => {
    if (objectOf(TASK).sections.get(K1, "lines") === undefined)
      sectionBarrier.set(K1, stepStart)
  }
  // Ключ, що став `removed`: значення — лише з читання після позначки (П15).
  const removedBarrier = new Map<string, number>()
  // `slot` — запис сховища: слот, що зник і з'явився знову між двома
  // перевірками, — вже інший слот, і його не порівнюємо з тим, що був.
  const wasRemoved = new Map<string, { divergent: boolean; slot: object }>()
  const maxVersion = new Map<string, number>()
  const storeVersion = new Map<string, number>()
  let closed:
    { frames: number; sent: number; snapshot: ViewSnapshot } | undefined

  const record = (read: FakeRead) => {
    const response = read.log.response
    if (response === undefined || read.query === undefined) return
    const index = fake.log.indexOf(read.log)
    const result = readResultFromWire(
      fake.index,
      read.query,
      response
    ) as ReadRows
    const object = read.object!
    if ("tabularSection" in read.query) {
      if (result.ownerVersion === undefined || !("owner" in read.query)) return
      sectionDeliveries.push({
        index,
        object,
        rows: new Map(),
        owner: { key: read.query.owner, version: result.ownerVersion },
      })
      return
    }
    const rows = new Map<Key, number>()
    for (const row of result.rows)
      rows.set(row.ref as Key, row.version as number)
    for (const [k, version] of rows) {
      const list = deliveries.get(id(object, k)) ?? []
      list.push({ index, object, rows: new Map([[k, version]]) })
      deliveries.set(id(object, k), list)
    }
  }

  const deliveredSince = (object: ObjectName, k: Key, index: number) =>
    (deliveries.get(id(object, k)) ?? []).some((d) => d.index >= index)
  const deliveredVersion = (object: ObjectName, k: Key, version: number) =>
    (deliveries.get(id(object, k)) ?? []).some((d) => d.rows.get(k) === version)

  const subscribe = (v: number, label: string) => {
    if (subs[v] !== undefined) return
    const held = [...internals.registry.subsets()]
    const spare = held.some((s) => s.listeners.size === 0)
    try {
      subs[v] = handles[v]!.subscribe(() => {
        frames++
      })
    } catch (error) {
      if (!(error instanceof DataError) || error.code !== "data.views-limit")
        throw error
      // Межа виглядів (П16): відмова лише тоді, коли звільнити нічого.
      const known = held.some((s) => s.form.spec === SPECS[v])
      if (known || held.length < LIMITS.viewsMax || spare)
        fail(label, `views-limit with ${held.length} held, spare ${spare}`)
    }
  }

  /** Склад видимих списків і покоління їхніх завантажень. */
  const lists = () =>
    SPECS.map((spec, v) => {
      if (subs[v] === undefined || !isList(spec) || closed !== undefined)
        return undefined
      const s = internals.registry.find(spec)
      return {
        keys: handles[v]!.getSnapshot().rows.map((r) => r.key),
        flight: s?.flight,
        gen: s?.gen,
        subset: s,
      }
    })

  const objectOf = (name: ObjectName) => internals.objects.get(name)!

  /** Показаний рядок (зі значеннями чи схований) проти сервера й позначок. */
  const checkRow = (
    label: string,
    object: ObjectName,
    row: RowView,
    where: string
  ) => {
    const at = `${where} ${object}/${row.key}`
    if (row.state === "removed") return
    const max = maxVersion.get(id(object, row.key)) ?? 0
    if (row.version < max && row.state !== "stale")
      fail(label, `${at}: version ${max} → ${row.version} as ${row.state}`)
    maxVersion.set(id(object, row.key), Math.max(max, row.version))
    const fields = Object.keys(row.values)
    // Схований горизонтом рядок значень не показує.
    if (fields.length === 0) return
    // Показаний рядок (і ціль `refs`) прибраного `purge` ключа — лише з
    // читання, що почалось після нього (П12).
    const purged = purgeBarrier.get(id(object, row.key))
    if (purged !== undefined && !deliveredSince(object, row.key, purged))
      fail(label, `${at}: shown after purge without a later read`)
    if (!deliveredVersion(object, row.key, row.version))
      fail(label, `${at}: version ${row.version} never delivered`)
    const server = fake.row(object, row.key, row.version)
    if (server === undefined || server.version !== row.version)
      fail(label, `${at}: no server row of version ${row.version}`)
    for (const field of fields) {
      if (field === "notes" && row.staleFields.includes(field)) continue
      if (!Object.is(row.values[field], server!.values[field]))
        fail(
          label,
          `${at}.${field} = ${String(row.values[field])}, server at ${row.version}: ${String(server!.values[field])}`
        )
    }
    const barrier = removedBarrier.get(id(object, row.key))
    if (barrier !== undefined && !deliveredSince(object, row.key, barrier))
      fail(label, `${at}: shown after removed without a later read`)
  }

  const checkSnapshot = (label: string, v: number, snap: ViewSnapshot) => {
    const spec = SPECS[v]!
    const where = `view ${v}`
    for (const row of snap.rows) {
      checkRow(label, spec.object, row, where)
      if (row.state === "removed" || row.refs === undefined) continue
      for (const ref of Object.values(row.refs)) {
        if (ref !== null) checkRow(label, ORG, ref, `${where} ref`)
      }
    }
    if (spec.kind === "card") {
      // Картка ключа зі сховища не дає знімка без рядка.
      const stored = objectOf(TASK).rows.get(spec.key) !== undefined
      if (stored && snap.status !== "purged" && snap.rows.length !== 1)
        fail(label, `${where}: card of a stored key without its row`)
    }
    if (spec.kind === "section" && snap.section !== undefined) {
      const owner = spec.owner
      const { ownerVersion, ownerState, lines } = snap.section
      // Без версії власника рядків ТЧ нема; власник `removed` чи схований —
      // без версії й рядків (§6.2, правило 5).
      if (ownerVersion === undefined && lines.length > 0)
        fail(label, `${where}: lines without an owner version`)
      const stored = objectOf(TASK).rows.get(owner)
      if (stored?.removed !== undefined && ownerState !== "removed")
        fail(label, `${where}: owner state ${ownerState}, slot removed`)
      if (
        ownerState === "removed" &&
        (ownerVersion !== undefined || lines.length > 0)
      )
        fail(label, `${where}: a removed owner shows ${lines.length} lines`)
    }
    if (spec.kind === "section" && snap.section?.ownerVersion !== undefined) {
      const version = snap.section.ownerVersion
      const owner = spec.owner
      const ok = sectionDeliveries.some(
        (d) => d.owner!.key === owner && d.owner!.version === version
      )
      if (!ok) fail(label, `${where}: owner version ${version} never read`)
      const header = objectOf(TASK).rows.get(owner)
      // ТЧ власника `removed` показує причину без рядків (§6.2, правило 5).
      if (header?.removed !== undefined)
        fail(label, `${where}: lines of a removed owner`)
      const readSince = (index: number) =>
        sectionDeliveries.some(
          (d) => d.owner!.key === owner && d.index >= index
        )
      const purged = sectionBarrier.get(owner)
      if (purged !== undefined && !readSince(purged))
        fail(label, `${where}: lines shown after purge`)
      // Після `removed` рядки повертає читання після позначки — ТЧ чи шапки,
      // що зняла `removed`.
      const removed = removedBarrier.get(id(TASK, owner))
      if (
        removed !== undefined &&
        !readSince(removed) &&
        !deliveredSince(TASK, owner, removed)
      )
        fail(label, `${where}: lines shown after removed`)
      const expected = linesHistory.filter((h) => h.at <= version).at(-1)!.qty
      const shown = snap.section.lines.map((l) => l.values.qty)
      if (JSON.stringify(shown) !== JSON.stringify(expected))
        fail(label, `${where}: lines ${String(shown)} ≠ ${String(expected)}`)
    }
  }

  const check = (label: string, stepStart: number) => {
    if (errors.length > 0)
      fail(label, `unexpected rejection ${String(errors[0])}`)
    if (closed !== undefined) {
      // Після `close` — жодного сповіщення, запиту й рядка; кожен хендл
      // (і новий) — та сама посилка `purged`.
      if (frames !== closed.frames) fail(label, "notified after close")
      if (fake.log.length !== closed.sent) fail(label, "requested after close")
      if (inspect.rowCount() !== 0) fail(label, "rows after close")
      for (const spec of SPECS) {
        if (core.view(spec).getSnapshot() !== closed.snapshot)
          fail(label, "a handle after close is not the purged snapshot")
      }
      for (const handle of handles) {
        if (handle.getSnapshot() !== closed.snapshot)
          fail(label, "a handle after close is not the purged snapshot")
      }
      // `close()` чистить усі службові мапи, таймери й контролери.
      for (const [name, size] of Object.entries(inspect.serviceSizes())) {
        if (size !== 0) fail(label, `${name} = ${size} after close`)
      }
      return
    }
    const violations = inspect.violations()
    if (violations.length > 0) fail(label, violations.join("; "))
    // Межі §6.2: читання, пам'ять версій, надгробки й горизонт.
    if (fake.inFlight > 4) fail(label, `${fake.inFlight} reads in flight`)
    const sizes = inspect.serviceSizes()
    if (sizes.seen > LIMITS.seenMax)
      fail(label, `seen ${sizes.seen} > ${LIMITS.seenMax}`)
    if (sizes.tombstones > LIMITS.tombstonesMax)
      fail(label, `tombstones ${sizes.tombstones} > ${LIMITS.tombstonesMax}`)
    if (sizes.horizon > LIMITS.horizonBuckets)
      fail(label, `horizon ${sizes.horizon} > ${LIMITS.horizonBuckets}`)

    for (const name of [TASK, ORG]) {
      const o = objectOf(name)
      for (const k of o.rows.keys()) {
        const e = o.rows.get(k)!
        const at = `${name}/${k}`
        // Версія не зменшується на жодному шляху запису: старший рядок —
        // лише з позначкою мінімальної версії чи схований горизонтом.
        const top = storeVersion.get(id(name, k)) ?? 0
        if (
          e.version < top &&
          (e.stale.minVersion?.v ?? -1) < top &&
          e.stale.seen === undefined
        )
          fail(label, `${at}: stored version ${top} → ${e.version}`)
        storeVersion.set(id(name, k), Math.max(top, e.version))
        const purge = purgeBarrier.get(id(name, k))
        if (purge !== undefined && !deliveredSince(name, k, purge))
          fail(label, `${at}: in the store after purge without a later read`)
        const before = wasRemoved.get(id(name, k))
        // Власник `removed` не лишає рядків ТЧ у сховищі (§6.2, правило 5).
        if (
          name === TASK &&
          e.removed !== undefined &&
          objectOf(TASK).sections.get(k, "lines") !== undefined
        )
          fail(label, `${at}: section lines stored for a removed owner`)
        if (e.removed !== undefined) {
          if (before === undefined) {
            removedBarrier.set(id(name, k), stepStart)
          }
          wasRemoved.set(id(name, k), {
            divergent: e.removed.divergent,
            slot: e,
          })
          continue
        }
        if (before !== undefined && visibleRow(e) !== undefined) {
          // Єдиний перехід «сховано → показано» без читання користувача —
          // розбіжний слот, і він пише `removed-restored` (П15).
          if (before.divergent && before.slot === e) {
            const n = (restoredInStep.get(name) ?? 0) + 1
            restoredInStep.set(name, n)
            const logged = log
              .slice(logAt)
              .reduce(
                (sum, x) =>
                  x.kind === "removed-restored" && x.object === name
                    ? sum + x.count
                    : sum,
                0
              )
            // Журнал рахує перехід на кожен ключ: розбіжних слотів, що
            // ожили за крок, не більше, ніж записів у журналі.
            if (logged < n)
              fail(
                label,
                `${at}: divergent slot restored, log counts ${logged}`
              )
          }
        }
        wasRemoved.delete(id(name, k))
        const values = visibleRow(e)
        if (values !== undefined) {
          const barrier = removedBarrier.get(id(name, k))
          if (barrier !== undefined && !deliveredSince(name, k, barrier))
            fail(label, `${at}: values after removed without a later read`)
        }
      }
      // Слот, що зник зі сховища, лишає бар'єр; позначку стану — ні.
      for (const key of [...wasRemoved.keys()]) {
        const [object, k] = key.split("\u0000") as [ObjectName, Key]
        if (object === name && o.rows.get(k) === undefined)
          wasRemoved.delete(key)
      }
    }

    handles.forEach((handle, v) => {
      checkSnapshot(label, v, handle.getSnapshot())
    })
  }

  /** `purge` прибирає ключі зі складу списків, а картка й ТЧ ключа — `purged`. */
  const checkPurged = (
    label: string,
    purged: { object: ObjectName; keys: Key[] }
  ) => {
    if (closed !== undefined) return
    const gone = new Set<Key>(purged.keys)
    SPECS.forEach((spec, v) => {
      if (subs[v] === undefined) return
      const snap = handles[v]!.getSnapshot()
      const where = `view ${v} after purge`
      if (spec.object === purged.object && isList(spec)) {
        for (const row of snap.rows) {
          if (gone.has(row.key))
            fail(label, `${where}: purged ${row.key} still in the composition`)
        }
      }
      for (const row of snap.rows) {
        if (row.state === "removed" || row.refs === undefined) continue
        for (const ref of Object.values(row.refs)) {
          if (ref !== null && purged.object === ORG && gone.has(ref.key))
            fail(label, `${where}: ref to purged ${ref.key}`)
        }
      }
      const target =
        spec.kind === "card"
          ? spec.key
          : spec.kind === "section"
            ? spec.owner
            : undefined
      if (
        target !== undefined &&
        spec.object === purged.object &&
        gone.has(target) &&
        snap.status !== "purged"
      )
        fail(
          label,
          `${where}: ${spec.kind} of purged ${target} is ${snap.status}`
        )
    })
  }

  let logAt = 0
  const restoredInStep = new Map<ObjectName, number>()

  const lean = profile !== "full"
  const plan = lean ? steps.map((s) => leanStep(s, profile)) : steps

  if (preloaded) {
    // Половина прогонів стартує з даними: список і `full` (чи другий список)
    // завантажені.
    const second = lean ? 9 : 5
    subs[0] = handles[0]!.subscribe(() => frames++)
    subs[second] = handles[second]!.subscribe(() => frames++)
    for (let i = 0; i < 50 && fake.pending.length > 0; i++) {
      await flush()
      while (fake.pending.length > 0) {
        const read = fake.take()
        read.answer()
        record(read)
      }
      await flush()
    }
    check("preload", 0)
  }

  // Покоління завантажень, які почала дія користувача (підписка, прокрутка,
  // `refresh`, `showNew`, `preload`, початкове завантаження), і чи належить
  // користувачу наступне завантаження з черги «trailing». Правило
  // стабільності виправдовує зміну складу лише завантаженням користувача.
  const userGens = new Map<Subset, Set<number>>()
  const lastGen = new Map<Subset, number>()
  const userNext = new Set<Subset>()
  const noteGens = (userStep: boolean) => {
    for (const s of internals.registry.subsets()) {
      const gens = userGens.get(s) ?? new Set<number>()
      const mine =
        userStep ||
        userNext.has(s) ||
        (s.flight !== undefined && gens.has(s.flight))
      const last = lastGen.get(s) ?? 0
      if (s.gen > last) {
        // Покоління, яке `purge` підняв у польоті, лишається завантаженням
        // користувача, чиє читання він перезапускає.
        if (mine) for (let g = last + 1; g <= s.gen; g++) gens.add(g)
        userGens.set(s, gens)
        lastGen.set(s, s.gen)
      }
      if (s.trailing && mine) userNext.add(s)
      else if (!s.trailing) userNext.delete(s)
    }
  }
  if (preloaded) noteGens(true)

  const live = (object: ObjectName, k: Key) =>
    fake.row(object, k) !== undefined && !deleted.has(id(object, k))

  const commit = (fn: Parameters<CoreSession["commit"]>[0]) => {
    core.commit(fn, core.token())
  }

  for (const [n, s] of plan.entries()) {
    const label = `step ${n} ${JSON.stringify(s)}`
    const stepStart = fake.log.length
    logAt = log.length
    restoredInStep.clear()
    const before = lists()
    let userViews = new Set<number>()
    let purgeStep = false
    let purgedScope: { object: ObjectName; scope: string } | undefined
    // Ключі, які `purge` кроку прибрав зі сховища (або назвав явно).
    let purgedKeys: { object: ObjectName; keys: Key[] } | undefined
    switch (s.t) {
      case "sub":
        subscribe(s.v, label)
        userViews = new Set([s.v])
        break
      case "unsub":
        subs[s.v]?.()
        subs[s.v] = undefined
        if (s.release) vi.advanceTimersByTime(RELEASE_MS)
        break
      case "churn": {
        const order = s.scroll
          ? SCROLL.map((_, i) => SCROLL[(s.v + i) % SCROLL.length]!)
          : [s.v]
        userViews = new Set(order)
        for (const v of order) {
          if (subs[v] !== undefined || closed !== undefined) continue
          subscribe(v, label)
          // Відповіді лише на читання цього кроку: завантаження вигляду.
          for (let round = 0; round < 20; round++) {
            await flush()
            const own = fake.pending.filter(
              (r) => fake.log.indexOf(r.log) >= stepStart
            )
            if (own.length === 0) break
            for (const read of own) {
              fake.take((r) => r === read).answer()
              record(read)
            }
          }
          // Інваріанти — і посеред прокрутки: інакше версії, які ядро
          // знало лише між завантаженням і звільненням, модель би не бачила.
          check(`${label} view ${v}`, stepStart)
          // `subscribe` записав відписку: `at` не звужений перевіркою вище.
          subs.at(v)?.()
          subs[v] = undefined
          vi.advanceTimersByTime(RELEASE_MS)
        }
        break
      }
      case "slow": {
        // Не більше двох: кожне займає місце обмежувача читань.
        if (subs[s.v] !== undefined || late.length >= 2) break
        subscribe(s.v, label)
        userViews = new Set([s.v])
        await flush()
        for (const read of fake.pending.filter(
          (r) => fake.log.indexOf(r.log) >= stepStart
        ))
          late.push(fake.take((r) => r === read))
        break
      }
      case "preload": {
        userViews = new Set([s.v])
        let promise: Promise<void> | undefined
        try {
          promise = core.preload(
            SPECS[s.v]!,
            s.short ? { ttlMs: 500 } : undefined
          )
        } catch (error) {
          if (
            !(error instanceof DataError) ||
            error.code !== "data.views-limit"
          )
            throw error
          const held = [...internals.registry.subsets()]
          if (
            held.length < LIMITS.viewsMax ||
            held.some((x) => x.listeners.size === 0)
          )
            fail(label, "preload refused with a spare hold")
        }
        promise?.catch((error: unknown) => errors.push(error))
        break
      }
      case "refresh":
        userViews = new Set([s.v])
        if (s.showNew) handles[s.v]!.showNew()
        else handles[s.v]!.refresh()
        break
      case "visible":
        core.setVisible(SPECS[s.v]!, s.on)
        break
      case "answer": {
        if (fake.pending.length === 0) break
        // Генератор зміщує `pick` до малих чисел, а модель бере з кінця
        // черги: свіжі відповіді частіше, давні читання довше лишаються в
        // польоті й доходять пізно — після звільнень, витіснень і `purge`.
        const read = fake.take(
          fake.pending.length - 1 - (s.pick % fake.pending.length)
        )
        if (s.how === "forbidden") {
          read.fail("command.forbidden")
          break
        }
        if (s.how === "unavailable") {
          read.fail("command.unavailable")
          break
        }
        if (s.how === "missing") {
          // Рядок відсутній: на мить виконання рядка, якого читання просить,
          // немає — сервер його видаляє (рідше) чи на мить ховає його скоуп
          // (RLS), і рядок повертається наступним читанням.
          const object = read.object!
          const query = read.query
          const asked =
            query === undefined
              ? []
              : "id" in query
                ? [query.id]
                : "owner" in query && "tabularSection" in query
                  ? [query.owner]
                  : keysOf(query).length > 0
                    ? (keysOf(query) as Key[])
                    : object === TASK
                      ? KEYS
                      : ORG_KEYS
          const gone = asked.filter((k) => live(object, k))
          const victim = gone[s.at % Math.max(gone.length, 1)]
          if (victim === undefined) read.answer()
          else if (s.at % 3 === 0) {
            fake.remove(object, victim)
            deleted.add(id(object, victim))
            read.answer()
          } else {
            const scope =
              object === ORG
                ? victim
                : (fake.row(TASK, victim)!.values.org as string)
            fake.setVisibleScopes(
              (visibility ?? SCOPES).filter((x) => x !== scope)
            )
            read.answer()
            fake.setVisibleScopes(visibility)
          }
        } else if (s.how === "stale") {
          // Застаріла репліка: стан на мить між запитом і зараз.
          const span = fake.clock - read.issuedAt
          read.answer(read.issuedAt + (s.at < 3 ? 0 : s.at % (span + 1)))
        } else read.answer()
        record(read)
        break
      }
      case "edit":
        if (live(TASK, KEYS[s.k]!))
          fake.edit(TASK, KEYS[s.k]!, { title: `${TITLES[s.title]}${n}` })
        break
      case "delete":
        if (live(TASK, KEYS[s.k]!)) {
          fake.remove(TASK, KEYS[s.k]!)
          deleted.add(id(TASK, KEYS[s.k]!))
        }
        break
      case "move": {
        const row = fake.row(TASK, KEYS[s.k]!)
        if (row !== undefined && live(TASK, KEYS[s.k]!))
          fake.edit(TASK, KEYS[s.k]!, { org: row.values.org === S ? T : S })
        break
      }
      case "lines":
        if (live(TASK, K1)) setLines(s.qty + 1)
        break
      case "create":
        if (!created) {
          created = true
          fake.insert(TASK, {
            ref: K5,
            org: SCOPES[s.scope],
            title: "c",
            notes: "n5",
          })
        }
        break
      case "access":
        visibility = s.which === 0 ? undefined : [s.which === 1 ? T : S]
        fake.setVisibleScopes(visibility)
        break
      case "purgeKey": {
        purgeStep = true
        const object = s.org ? ORG : TASK
        const target = s.org ? ORG_KEYS[s.k % 2]! : KEYS[s.k]!
        commit((w) => w.purge(object, { keys: [target] }))
        if (closed !== undefined) break
        purgedKeys = { object, keys: [target] }
        purgeBarrier.set(id(object, target), stepStart)
        if (object === TASK) barrierSections(stepStart)
        break
      }
      case "purgeScope": {
        purgeStep = true
        const object = s.org ? ORG : TASK
        const scope = SCOPES[s.scope]!
        const held = [...objectOf(object).rows.keys()]
        commit((w) => w.purge(object, { scope }))
        if (closed !== undefined) break
        purgedScope = { object, scope }
        purgedKeys = {
          object,
          keys: held.filter((k) => objectOf(object).rows.get(k) === undefined),
        }
        // П12: ключ, якого після purge у сховищі немає, повертає лише
        // читання, що почалось після нього.
        for (const k of object === TASK ? KEYS : ORG_KEYS) {
          if (objectOf(object).rows.get(k) === undefined)
            purgeBarrier.set(id(object, k), stepStart)
        }
        if (object === TASK) barrierSections(stepStart)
        break
      }
      case "revalidate":
        core
          .revalidate(s.org ? ORG : TASK, { visibleOnly: s.visibleOnly })
          .catch((error: unknown) => errors.push(error))
        break
      case "markStale": {
        const version = fake.row(TASK, KEYS[s.k]!)?.version ?? 1
        commit((w) => w.markStale(TASK, [KEYS[s.k]!], version + s.plus))
        break
      }
      case "disconnect": {
        const ch = CHANNELS[s.channel]
        commit((w) => {
          if (s.clear && ch !== undefined) w.clearDisconnected(ch)
          else w.markDisconnected(ch)
        })
        break
      }
      case "markViews": {
        const spec = SPECS[s.v]!
        commit((w) =>
          w.markViews(
            spec.object,
            { needsRefresh: s.needs, hasNewRows: s.news },
            s.one ? spec : undefined
          )
        )
        break
      }
      case "time":
        vi.advanceTimersByTime(s.ms)
        break
      case "close":
        if (closed !== undefined) break
        core.close(s.reason)
        closed = {
          frames,
          sent: fake.log.length,
          snapshot: handles[0]!.getSnapshot(),
        }
        if (
          closed.snapshot.status !== "purged" ||
          closed.snapshot.reason !== s.reason ||
          closed.snapshot.rows.length !== 0
        )
          fail(label, "close snapshot is not purged with the reason")
        break
    }
    await flush()
    if (purgedScope !== undefined) {
      const o = objectOf(purgedScope.object)
      for (const k of o.rows.keys()) {
        if (o.rows.get(k)!.scope === purgedScope.scope)
          fail(label, `${purgedScope.object}/${k} survived the scope purge`)
      }
    }
    check(label, stepStart)
    if (purgedKeys !== undefined) checkPurged(label, purgedKeys)
    noteGens(userViews.size > 0)
    // Правило стабільності: жодна системна подія, крім `purge`, не змінює
    // складу й порядку видимого списку; завантаження користувача — дія
    // користувача, його завершення й початок виправдані.
    const after = lists()
    before.forEach((b, v) => {
      const a = after[v]
      if (b === undefined || a === undefined) return
      if (b.subset !== a.subset) return
      const same =
        a.keys.length === b.keys.length &&
        a.keys.every((x, i) => x === b.keys[i])
      if (same) return
      // Завантаження, що тривало чи почалось на цьому кроці, — користувача?
      const mine = userGens.get(a.subset!)
      const touched = [b.flight]
      for (let g = (b.gen ?? 0) + 1; g <= (a.gen ?? 0); g++) touched.push(g)
      if (touched.some((g) => g !== undefined && mine?.has(g) === true)) return
      if (purgeStep) {
        // purge лише прибирає ключі, порядок решти той самий.
        const kept = b.keys.filter((x) => a.keys.includes(x))
        if (
          kept.length === a.keys.length &&
          kept.every((x, i) => x === a.keys[i])
        )
          return
      }
      fail(
        label,
        `view ${v} composition ${b.keys.join(",")} → ${a.keys.join(",")}`
      )
    })
  }

  // Пізні відповіді на все, що лишилось у польоті: повільні читання й
  // кожне друге з решти — застарілою реплікою (стан на мить запиту) після
  // всіх звільнень і витіснень прогону, інші — станом зараз.
  for (let i = 0; late.length > 0 || fake.pending.length > 0; i++) {
    if (i > 500) fail("drain", "reads never end")
    const stepStart = fake.log.length
    logAt = log.length
    restoredInStep.clear()
    const slow = late.shift()
    const read = slow ?? fake.take()
    read.answer(slow !== undefined || i % 2 === 0 ? read.issuedAt : fake.clock)
    record(read)
    await flush()
    check(`drain ${i}`, stepStart)
  }

  if (closed === undefined) await converge()

  /**
   * Збіжність до сервера: відновлюємо видимість, перечитуємо кожен
   * підписаний вигляд (`refresh`) і обидва об'єкти (`revalidate`), відповідаємо
   * на все станом зараз — і кожен показаний рядок, рядок `refs` та рядки ТЧ
   * мусять дорівнювати серверним (версія й значення) або бути `removed`,
   * коли сервер рядка не має.
   */
  async function converge() {
    // Таймери звільнення й TTL `preload` спрацьовують до перечитування: їхній
    // надгробок поховав би відповідь читання, що почалось раніше (за
    // задумом), і збіжність мірялась би проти артефакту моделі.
    vi.advanceTimersByTime(10_000)
    await flush()
    fake.setVisibleScopes(undefined)
    visibility = undefined
    for (let v = 0; v < SPECS.length; v++) {
      if (subs[v] !== undefined) handles[v]!.refresh()
    }
    let settled = 0
    const done = Promise.all(
      [TASK, ORG].map((o) =>
        core
          .revalidate(o, { visibleOnly: false })
          .catch((error: unknown) => errors.push(error))
      )
    ).then(() => settled++)
    let quiet = 0
    for (let i = 0; quiet < 3; i++) {
      if (i > 500) fail("converge", "reads never end")
      await flush()
      if (fake.pending.length === 0 && settled > 0) quiet++
      else quiet = 0
      const stepStart = fake.log.length
      logAt = log.length
      restoredInStep.clear()
      while (fake.pending.length > 0) {
        const read = fake.take()
        read.answer()
        record(read)
      }
      await flush()
      check(`converge ${i}`, stepStart)
    }
    await done
    SPECS.forEach((spec, v) => {
      if (subs[v] === undefined) return
      const snap = handles[v]!.getSnapshot()
      const where = `converge view ${v}`
      if (snap.status === "purged") return
      if (snap.status !== "ready")
        fail(where, `status ${snap.status} after refresh`)
      for (const row of snap.rows) sameAsServer(where, spec.object, row)
      // Рядок, який сервер має, мусить бути показаний: порожня готова
      // картка чи список без нього — втрата, а не збіжність.
      const wanted =
        spec.kind === "keys"
          ? spec.keys
          : spec.kind === "card"
            ? [spec.key]
            : []
      for (const k of wanted) {
        if (fake.row(spec.object, k) === undefined) continue
        const shown = snap.rows.find((r) => r.key === k)
        if (shown === undefined || shown.state === "removed")
          fail(where, `${spec.object}/${k}: on the server, view shows none`)
      }
      if (spec.kind === "full" && snap.atEnd) {
        // Склад `full` — рядки сервера, що проходять фільтр (рядок, що
        // зник із сервера, склад уже прибрав перезавантаження).
        const shown = snap.rows.map((r) => r.key)
        const expected = KEYS.filter((k) => {
          const row = fake.row(TASK, k)
          return (
            row !== undefined &&
            (spec.where === undefined ||
              String(row.values.title) >=
                String((spec.where as { value: unknown }).value))
          )
        })
        if ([...shown].sort().join() !== [...expected].sort().join())
          fail(where, `composition ${shown.join()} ≠ server ${expected.join()}`)
      }
      if (spec.kind === "section" && snap.section !== undefined) {
        const owner = fake.row(TASK, spec.owner)
        const { ownerState, ownerVersion, lines } = snap.section
        if (owner === undefined) {
          // Без шапки в сховищі (читання власника ТЧ не знайшло) стан
          // власника невідомий.
          if (
            (ownerState !== "removed" && ownerState !== "unknown") ||
            lines.length > 0
          )
            fail(
              where,
              `owner is gone, section ${ownerState} with ${lines.length} lines`
            )
        } else {
          if (ownerVersion !== owner.version)
            fail(
              where,
              `owner version ${String(ownerVersion)} ≠ ${owner.version}`
            )
          const expected = linesHistory.at(-1)!.qty
          const shown = lines.map((l) => l.values.qty)
          if (JSON.stringify(shown) !== JSON.stringify(expected))
            fail(where, `lines ${String(shown)} ≠ server ${String(expected)}`)
        }
      }
    })
  }

  function sameAsServer(where: string, object: ObjectName, row: RowView) {
    const at = `${where} ${object}/${row.key}`
    const server = fake.row(object, row.key)
    if (row.state === "removed") {
      if (server !== undefined)
        fail(where, `${at}: removed, the server has the row`)
      return
    }
    if (server === undefined)
      return fail(where, `${at}: ${row.state}, the server has no such row`)
    if (row.version !== server.version)
      fail(where, `${at}: version ${row.version} ≠ server ${server.version}`)
    const fields = Object.keys(row.values)
    if (fields.length === 0) fail(where, `${at}: values hidden after refresh`)
    for (const field of fields) {
      if (field === "notes" && row.staleFields.includes(field)) continue
      if (!Object.is(row.values[field], server.values[field]))
        fail(where, `${at}.${field} ≠ server`)
    }
    for (const [field, ref] of Object.entries(row.refs ?? {})) {
      if (ref !== null) sameAsServer(`${where} ref`, ORG, ref)
      else {
        // `null` — лише для цілі, якої сервер не показує; наявна ціль
        // не може лишитись порожньою (гонка власності `include`).
        const target = row.values[field]
        if (typeof target === "string" && fake.row(ORG, target) !== undefined)
          fail(where, `${at}.${field}: ref is null, the server has the target`)
      }
    }
  }
}

const RUNS = Number(process.env.CORE_MODEL_RUNS ?? 10_000)

const property = (defects: readonly DefectFlag[] = []) =>
  fc.asyncProperty(
    fc.array(STEP, { minLength: 10, maxLength: 80, size: "max" }),
    fc.boolean(),
    fc.constantFrom<Profile>("full", "scroll", "burial"),
    (steps, preloaded, profile) => runModel(steps, preloaded, profile, defects)
  )

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("core model", () => {
  it("holds the invariants over random interleavings", async () => {
    await fc.assert(property(), { numRuns: RUNS })
  }, 120_000)
})

const DEFECTS: readonly DefectFlag[] = [
  "no-token-check",
  "version-decrease",
  "no-tombstone",
  "no-horizon-tombstones",
  "no-horizon-seen",
  "removed-by-older-read",
  "purge-by-values",
  "purge-keeps-flights",
  "reread-changes-layout",
  "row-without-owner",
  "removed-keeps-sections",
  "revision-survives-row",
  "purge-keeps-views",
  "absent-row-ignored",
  "unbounded-seen",
  "system-reread-via-load",
]

// Какою перевіркою дефект ловиться, коли це важливо: нові перевірки
// (збіжність, межі пам'яті, `purge` картки, ТЧ у сховищі) не мають бути
// затулені старішими.
const CAUGHT_BY: Partial<Record<DefectFlag, RegExp>> = {
  "removed-keeps-sections": /section lines stored for a removed owner/,
  "purge-keeps-views": /card of purged/,
  "absent-row-ignored": /^converge/,
  "unbounded-seen": /seen \d+ > \d+/,
  "system-reread-via-load": /composition/,
}

describe("core model self-check", () => {
  it.each(DEFECTS)(
    "turns red with the defect %s",
    async (flag) => {
      // Стале насіння: самотест відтворюваний, а найдовший шлях до червоного
      // (дефект горизонту) займає кілька тисяч прогонів.
      const result = await fc.check(property([flag]), {
        numRuns: 10_000,
        seed: 1,
        // Достатньо знайти червоний прогін: ужимання контрприкладу лише
        // подовжує самотест.
        endOnFailure: true,
      })
      expect(result.failed, `${flag} not caught`).toBe(true)
      expect(result.errorInstance).toBeInstanceOf(ModelFailure)
      const caughtBy = CAUGHT_BY[flag]
      if (caughtBy !== undefined)
        expect((result.errorInstance as Error).message).toMatch(caughtBy)
    },
    120_000
  )
})
