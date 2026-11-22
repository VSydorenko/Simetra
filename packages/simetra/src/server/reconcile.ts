import { isFileObjectKey } from "simetra/model"
import { FileStoreError, type FileStore } from "./file-store"

/** Age after which an object without a row may be deleted (platform spec §8.2). */
export const RECONCILE_GRACE_MS = 24 * 60 * 60 * 1000

/** Ids per `storage_rows_exist` call and per `storage_row_page` page. */
const PAGE = 1000
// Запобіжник: понад 5 % переліченого І понад 20 об'єктів — нічого не видаляти
const GUARD_RATIO = 0.05
const GUARD_MIN = 20

/** What the reconciliation reports to its `log` option. */
export type ReconcileLogEntry =
  | { kind: "refused"; reason: "instance" | "guard"; message: string }
  | { kind: "unknown-prefix"; prefix: string }
  | { kind: "row-without-bytes"; object: string; id: string }

/** Options of `CommandRuntime.reconcileFiles`. */
export interface ReconcileOptions {
  log: (entry: ReconcileLogEntry) => void
  /**
   * Minimum age of an orphan, measured by the database clock; default
   * {@link RECONCILE_GRACE_MS}. A smaller value is for tests only.
   */
  graceMs?: number
}

/** The outcome of one reconciliation run. */
export interface ReconcileReport {
  /** File objects found under the prefixes of objects with `storage`. */
  listed: number
  deleted: number
  /** Why the run deleted nothing on purpose; `null` — it did not refuse. */
  refused: "instance" | "guard" | null
  /** Object prefixes in the bucket the catalog does not know (only logged). */
  unknownPrefixes: string[]
  /** Rows of objects with `storage` that have no bytes in the bucket. */
  rowsWithoutBytes: number
}

/** The database side of the reconciliation: all calls run under the storage role. */
export interface ReconcileSource {
  instance(): Promise<string>
  /** Database `now()` in epoch milliseconds. */
  now(): Promise<number>
  /** The ids of `ids` (≤ 1000) that have a row, tenants not filtered. */
  rowsExist(object: string, ids: readonly string[]): Promise<Set<string>>
  /** Up to 1000 row ids after `after`, ascending. */
  rowPage(object: string, after: string | null): Promise<string[]>
}

interface Orphan {
  object: string
  key: string
  id: string
}

/**
 * Звірка бакета з базою (§8.2): єдине місце, де байти видаляються. Усе, що
 * може зашкодити, перевіряється до першого видалення: маркер бакета, запобіжник;
 * кожна сирота перед видаленням перевіряється ще раз.
 */
export async function reconcile(
  objectIds: readonly string[],
  source: ReconcileSource,
  store: FileStore,
  { log, graceMs = RECONCILE_GRACE_MS }: ReconcileOptions
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    listed: 0,
    deleted: 0,
    refused: null,
    unknownPrefixes: [],
    rowsWithoutBytes: 0,
  }
  try {
    await store.checkInstance(await source.instance())
  } catch (error) {
    if (!(error instanceof FileStoreError) || error.reason !== "foreign-bucket")
      throw error
    report.refused = "instance"
    log({ kind: "refused", reason: "instance", message: error.message })
    return report
  }

  const known = new Set(objectIds.map((id) => `o/${id}/`))
  for await (const prefix of store.listPrefixes()) {
    if (known.has(prefix)) continue
    report.unknownPrefixes.push(prefix)
    log({ kind: "unknown-prefix", prefix })
  }

  // Година за базою, не за годинником host-а (Р13)
  const now = await source.now()
  const orphans: Orphan[] = []
  for (const object of objectIds) {
    const prefix = `o/${object}/`
    // Рядки — до переліку: рядок, що з'явився під час нього, не дефект
    const rows = new Set<string>()
    for (let after: string | null = null; ;) {
      const page = await source.rowPage(object, after)
      for (const id of page) rows.add(id)
      if (page.length < PAGE) break
      after = page.at(-1)!
    }
    let batch: Orphan[] = []
    const flush = async () => {
      const present = await source.rowsExist(
        object,
        batch.map((o) => o.id)
      )
      for (const o of batch) if (!present.has(o.id)) orphans.push(o)
      batch = []
    }
    for await (const entry of store.list(prefix)) {
      if (!isFileObjectKey(entry.key)) continue
      report.listed++
      const id = entry.key.slice(prefix.length)
      rows.delete(id)
      if (now - entry.lastModified.getTime() < graceMs) continue
      batch.push({ object, key: entry.key, id })
      if (batch.length === PAGE) await flush()
    }
    if (batch.length > 0) await flush()
    for (const id of rows) log({ kind: "row-without-bytes", object, id })
    report.rowsWithoutBytes += rows.size
  }

  if (
    orphans.length > GUARD_MIN &&
    orphans.length > report.listed * GUARD_RATIO
  ) {
    report.refused = "guard"
    log({
      kind: "refused",
      reason: "guard",
      message: `${orphans.length} of ${report.listed} listed objects have no row`,
    })
    return report
  }

  // Друга перевірка безпосередньо перед видаленням, по об'єктах
  const byObject = new Map<string, Orphan[]>()
  for (const o of orphans)
    byObject.set(o.object, [...(byObject.get(o.object) ?? []), o])
  for (const [object, list] of byObject) {
    for (let i = 0; i < list.length; i += PAGE) {
      const chunk = list.slice(i, i + PAGE)
      const present = await source.rowsExist(
        object,
        chunk.map((o) => o.id)
      )
      for (const o of chunk) {
        if (present.has(o.id)) continue
        await store.delete(o.key)
        report.deleted++
      }
    }
  }
  return report
}
