import type { CatalogEntry, ReadQuery } from "simetra/model"
import {
  ORGANIZATION_ID,
  catalogEntry,
} from "../../../model/runtime/__tests__/entries"
import { createCore, inspectCore, type CoreSession } from "../core"
import { createCoreSource, createReadLimiter } from "../source"
import {
  createFakeSource,
  type FakeRead,
  type FakeSource,
} from "../testing/fake-source"
import {
  DEFAULT_CORE_LIMITS,
  type CoreLimits,
  type CoreLogEntry,
  type Key,
  type Values,
  type ViewHandle,
  type ViewSnapshot,
} from "../types"

/**
 * Обв'язка тестів виглядів ядра: справжнє ядро над фейковим сервером через
 * справжні `createCoreSource` і обмежувач — тест бачить запити так, як їх
 * побачив би сервер, а не виклики внутрішніх функцій.
 */

export const TASK = "Catalog.Task"
export const ORG = "Catalog.Organization"
export const S = "00000000-0000-4000-8000-0000000000b1"

export const task: CatalogEntry = catalogEntry()
export const org: CatalogEntry = catalogEntry({
  id: ORGANIZATION_ID,
  name: "Organization",
  kindLabel: "organization",
  table: { schema: "public", name: "organization" },
  scopeColumn: "id",
  attributes: [],
  tabularSections: [],
})
export const OBJECTS = [task, org]

export const key = (n: number): Key =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

export interface CoreHarness {
  readonly fake: FakeSource
  readonly core: CoreSession
  readonly log: CoreLogEntry[]
  readonly inspect: ReturnType<typeof inspectCore>
}

export function setup(
  options: {
    limits?: Partial<CoreLimits>
    strict?: boolean
    mode?: "auto" | "manual"
  } = {}
): CoreHarness {
  const fake = createFakeSource({ objects: OBJECTS, mode: options.mode })
  const limits = { ...DEFAULT_CORE_LIMITS, ...options.limits }
  const source = createCoreSource(
    () => fake.adapter,
    fake.index,
    createReadLimiter(limits.readParallel)
  )
  const log: CoreLogEntry[] = []
  const core = createCore({
    subject: "u1",
    source,
    index: fake.index,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.strict === undefined ? {} : { strict: options.strict }),
    log: (e) => log.push(e),
  })
  return { fake, core, log, inspect: inspectCore(core) }
}

/** Рядок задачі для фейкового сервера; скоуп — `S`. */
export const taskValues = (n: number, values: Values = {}): Values => ({
  ref: key(n),
  org: S,
  title: `t${n}`,
  notes: `body ${n}`,
  ...values,
})

export const seed = (fake: FakeSource, from: number, to: number) => {
  for (let n = from; n <= to; n++) fake.insert(TASK, taskValues(n))
}

/** Дає дійти всім мікрозадачам відповідей (фейк доставляє мікрозадачею). */
export const settle = async (rounds = 200) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/** Ключі читання за ключами (`in` за ключем у логічній формі). */
export const keysOf = (query: ReadQuery | undefined): unknown[] => {
  if (query === undefined || !("where" in query)) return []
  const where = query.where
  return where !== undefined &&
    "op" in where &&
    where.op === "in" &&
    where.attribute === "ref"
    ? (where.value as unknown[])
    : []
}

export const isCard = (read: { query: ReadQuery | undefined }) =>
  read.query !== undefined && "id" in read.query
export const isSection = (read: { query: ReadQuery | undefined }) =>
  read.query !== undefined && "tabularSection" in read.query
export const isKeys = (read: { query: ReadQuery | undefined }) =>
  keysOf(read.query).length > 0
export const isPage = (read: { query: ReadQuery | undefined }) =>
  read.query !== undefined &&
  "limit" in read.query &&
  !("tabularSection" in read.query) &&
  keysOf(read.query).length === 0

export const readsOf = (fake: FakeSource, object: string) =>
  fake.log.filter(
    (r) =>
      r.query !== undefined &&
      `${r.query.object.kind}.${r.query.object.name}` === object
  )

/** Підписка, що рахує сповіщення й пам'ятає знімок кожного. */
export function watch(handle: ViewHandle) {
  const seen: ViewSnapshot[] = []
  const unsubscribe = handle.subscribe(() => seen.push(handle.getSnapshot()))
  return { seen, unsubscribe }
}

export const valuesOf = (snapshot: ViewSnapshot) =>
  snapshot.rows.map((r) => (r.state === "removed" ? undefined : r.values))

export const keysIn = (snapshot: ViewSnapshot) =>
  snapshot.rows.map((r) => r.key)

export type { FakeRead }
