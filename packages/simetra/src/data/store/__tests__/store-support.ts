import type { CatalogEntry } from "simetra/model"
import { catalogEntry } from "../../../model/runtime/__tests__/entries"
import type { Defects } from "../defects"
import { createObjectStore, type ObjectStore } from "../object-store"
import { createSectionStore, type SectionStore } from "../section-store"
import { createSession, type Scope, type Session } from "../session"
import {
  DEFAULT_CORE_LIMITS,
  type CoreLimits,
  type CoreLogEntry,
  type Key,
  type ServerRow,
  type Values,
} from "../types"

/**
 * Спільна обв'язка тестів сховищ: справжня сесія (епоха, `commit`) і
 * сховища одного об'єкта; кожен виклик сховища йде в окремому `commit`, як
 * у ядрі, тож тест бачить і межу області запису, і пачку сповіщень.
 */

export const OBJECT = "Catalog.Task"
export const K1 = "00000000-0000-4000-8000-0000000000a1"
export const K2 = "00000000-0000-4000-8000-0000000000a2"
export const K3 = "00000000-0000-4000-8000-0000000000a3"
export const S = "00000000-0000-4000-8000-0000000000b1"
export const T = "00000000-0000-4000-8000-0000000000b2"

/** A header row of the default test object; `org` is its scope field. */
export const row = (
  key: Key,
  version: number,
  values: Values = {}
): ServerRow => ({
  key,
  version,
  values: { ref: key, version, org: S, title: `t${version}`, ...values },
})

/** The same row without the scope field (a partial write). */
export const partial = (
  key: Key,
  version: number,
  values: Values = {}
): ServerRow => ({ key, version, values: { ref: key, version, ...values } })

export interface Harness {
  readonly session: Session
  readonly store: ObjectStore
  readonly sections: SectionStore
  readonly log: CoreLogEntry[]
  write<T>(fn: (scope: Scope) => T): T
  now(): number
}

export function harness(
  options: {
    limits?: Partial<CoreLimits>
    entry?: CatalogEntry
    defects?: Defects
  } = {}
): Harness {
  const log: CoreLogEntry[] = []
  const session = createSession({
    subject: "u1",
    limits: { ...DEFAULT_CORE_LIMITS, ...options.limits },
    log: (e) => log.push(e),
  })
  const store = createObjectStore({
    object: OBJECT,
    entry: options.entry ?? catalogEntry(),
    session,
    log: (e) => log.push(e),
    defects: options.defects,
  })
  const sections = createSectionStore({ object: OBJECT, session, rows: store })
  return {
    session,
    store,
    sections,
    log,
    write<T>(fn: (scope: Scope) => T): T {
      let result: T | undefined
      let done = false
      session.commit((scope) => {
        result = fn(scope)
        done = true
      }, session.token())
      if (!done) throw new Error("commit refused")
      return result as T
    },
    now: () => session.epochs.now(),
  }
}
