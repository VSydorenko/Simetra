import { fileObjectKey, isFileObjectKey } from "simetra/model"
import { FileStoreError, type FileStore } from "./file-store"

/** Age after which an object without a row may be deleted (platform spec §8.2). */
export const RECONCILE_GRACE_MS = 24 * 60 * 60 * 1000

/** Ids per `storage_rows_exist` call and per `storage_row_page` page. */
const PAGE = 1000
// Запобіжник: понад 5 % переліченого І понад 20 об'єктів — нічого не видаляти
const GUARD_RATIO = 0.05
const GUARD_MIN = 20
/**
 * Скільки сиріт один прогін пам'ятає поіменно: решта лише рахується (для
 * запобіжника) і піде наступним прогоном — пам'ять не росте з розміром бакета
 */
export const ORPHAN_KEEP = 100_000

/**
 * Why a run deleted nothing on purpose: a bucket of another database
 * (`instance`), the marker of a copied or restored database (`binding`), a
 * standby (`recovery`) or the deletion guard (`guard`).
 */
export type ReconcileRefusal = "instance" | "binding" | "recovery" | "guard"

/** What the reconciliation reports to its `log` option. */
export type ReconcileLogEntry =
  | { kind: "refused"; reason: ReconcileRefusal; message: string }
  | { kind: "unknown-prefix"; prefix: string }
  | { kind: "row-without-bytes"; object: string; id: string }

/** Options of `CommandRuntime.reconcileFiles`. */
export interface ReconcileOptions {
  log: (entry: ReconcileLogEntry) => void
}

/** The outcome of one reconciliation run. */
export interface ReconcileReport {
  /** File objects found under the prefixes of objects with `storage`. */
  listed: number
  deleted: number
  /** Why the run deleted nothing on purpose; `null` — it did not refuse. */
  refused: ReconcileRefusal | null
  /** Object prefixes in the bucket the catalog does not know (only logged). */
  unknownPrefixes: string[]
  /** Rows of objects with `storage` that have no bytes in the bucket. */
  rowsWithoutBytes: number
  /** Attach records of finished transactions removed from the database. */
  pendingSwept: number
}

/** The database side of the reconciliation: all calls run under the storage role. */
export interface ReconcileSource {
  /** `pg_is_in_recovery()`: a standby (or a restore) deletes nothing. */
  inRecovery(): Promise<boolean>
  /** The database binding string (`parseBinding`), read fresh. */
  instance(): Promise<string>
  /** Removes `storage_pending` records of finished transactions; their count. */
  sweepPending(): Promise<number>
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
 * Курсор по сторінках `storage_row_page`: пам'ять — одна сторінка, а не всі
 * рядки об'єкта. Порядок id — порядок uuid у Postgres, а він збігається з
 * лексикографічним порядком ключів бакета для канонічних uuid малими літерами
 */
function rowCursor(source: ReconcileSource, object: string) {
  let page: string[] = []
  let at = 0
  let last: string | null = null
  let done = false
  const peek = async (): Promise<string | undefined> => {
    if (at >= page.length && !done) {
      page = await source.rowPage(object, last)
      at = 0
      if (page.length < PAGE) done = true
      if (page.length > 0) last = page.at(-1)!
    }
    return page[at]
  }
  return { peek, next: () => void at++ }
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
  { log }: ReconcileOptions,
  // Вік — параметр ядра лише для тестів (рантайм завжди дає 24 год): значення
  // поза ≥ 0 зробило б кандидатом кожен об'єкт, зокрема щойно завантажений
  graceMs: number = RECONCILE_GRACE_MS,
  // Так само лише для тестів
  keep: number = ORPHAN_KEEP
): Promise<ReconcileReport> {
  if (!Number.isFinite(graceMs) || graceMs < 0)
    throw new RangeError("graceMs must be a finite number >= 0")
  const report: ReconcileReport = {
    listed: 0,
    deleted: 0,
    refused: null,
    unknownPrefixes: [],
    rowsWithoutBytes: 0,
    pendingSwept: 0,
  }
  const refuse = (reason: ReconcileRefusal, message: string) => {
    report.refused = reason
    log({ kind: "refused", reason, message })
    return report
  }
  const inRecovery = "the database is in recovery (a standby or a restore)"
  // Репліка чи відновлення: байти, записані після знімка, ще невидимі — нічого
  // не видаляти й нічого не писати в базу
  if (await source.inRecovery()) return refuse("recovery", inRecovery)
  try {
    await store.checkInstance(await source.instance())
  } catch (error) {
    if (!(error instanceof FileStoreError)) throw error
    if (error.reason === "foreign-bucket")
      return refuse("instance", error.message)
    if (error.reason === "binding-changed")
      return refuse("binding", error.message)
    throw error
  }
  report.pendingSwept = await source.sweepPending()

  const known = new Set(objectIds.map((id) => `o/${id}/`))
  for await (const prefix of store.listPrefixes()) {
    if (known.has(prefix)) continue
    report.unknownPrefixes.push(prefix)
    log({ kind: "unknown-prefix", prefix })
  }

  // Година за базою, не за годинником host-а (Р13)
  const now = await source.now()
  const orphans: Orphan[] = []
  let orphanCount = 0
  for (const object of objectIds) {
    const prefix = `o/${object}/`
    const rows = rowCursor(source, object)
    // Рядок без байтів у переліку міг з'явитися вже після нього (байти пишуться
    // до рядка, а перелік їх ще не бачив): не дефект, якщо `get` знаходить байти
    const withoutBytes = async (id: string) => {
      const found = await store.get(fileObjectKey(object, id))
      if (found !== null) {
        await found.body.cancel()
        return
      }
      report.rowsWithoutBytes++
      log({ kind: "row-without-bytes", object, id })
    }
    let batch: Orphan[] = []
    const flush = async () => {
      const present = await source.rowsExist(
        object,
        batch.map((o) => o.id)
      )
      for (const o of batch) {
        if (present.has(o.id)) continue
        orphanCount++
        if (orphans.length < keep) orphans.push(o)
      }
      batch = []
    }
    for await (const entry of store.list(prefix)) {
      if (!isFileObjectKey(entry.key)) continue
      report.listed++
      const id = entry.key.slice(prefix.length)
      // Зливання двох упорядкованих потоків: рядки до цього id не мають байтів
      for (let r = await rows.peek(); r !== undefined && r <= id;) {
        if (r < id) await withoutBytes(r)
        rows.next()
        r = await rows.peek()
      }
      if (now - entry.lastModified.getTime() < graceMs) continue
      batch.push({ object, key: entry.key, id })
      if (batch.length === PAGE) await flush()
    }
    if (batch.length > 0) await flush()
    for (let r = await rows.peek(); r !== undefined; r = await rows.peek()) {
      await withoutBytes(r)
      rows.next()
    }
  }

  if (orphanCount > GUARD_MIN && orphanCount > report.listed * GUARD_RATIO) {
    return refuse(
      "guard",
      `${orphanCount} of ${report.listed} listed objects have no row`
    )
  }

  // Перелік міг тривати довго: промоція репліки за цей час теж зупиняє видалення
  if (await source.inRecovery()) return refuse("recovery", inRecovery)

  // Друга перевірка безпосередньо перед видаленням, по об'єктах
  const byObject = new Map<string, Orphan[]>()
  for (const o of orphans) {
    const list = byObject.get(o.object)
    if (list === undefined) byObject.set(o.object, [o])
    else list.push(o)
  }
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
