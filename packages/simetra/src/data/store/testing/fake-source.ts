import {
  CommandFailure,
  type CommandError,
  type CommandResult,
  type Operation,
  type ReadQuery,
  type ReadRows,
} from "simetra/model"
import { matches, rowComparator } from "../filter"
import type { CoreSource, Key, ObjectName, ObjectSpec, Values } from "../types"

/**
 * Фейковий сервер і керований транспорт для тестів ядра й спайків 2–3.
 * Сервер — джерело правди з версіями рядків, перевіркою `expectedVersion`,
 * лінивими полями (списочна форма їх не віддає) і ТЧ власника.
 */

interface StoredRow {
  version: number
  values: Values
}

const refName = (ref: { kind: string; name: string }) =>
  `${ref.kind}.${ref.name}`
const sid = (obj: ObjectName, owner: Key, section: string) =>
  `${obj}\u0000${owner}\u0000${section}`

export class FakeServer {
  readonly tables = new Map<ObjectName, Map<Key, StoredRow>>()
  readonly sections = new Map<string, Record<string, unknown>[]>()
  readonly specs = new Map<ObjectName, ObjectSpec>()
  /** Понад стільки ключів у запиті за ключами — `response-too-large`. */
  maxRowsPerKeysResponse = Infinity
  /** Лічильник викликів джерела (для перевірок «без запиту»). */
  reads = 0
  runs = 0

  constructor(objects: readonly ObjectSpec[]) {
    for (const spec of objects) {
      const name = refName(spec.ref)
      this.specs.set(name, spec)
      this.tables.set(name, new Map())
    }
  }

  private table(obj: ObjectName) {
    const t = this.tables.get(obj)
    if (t === undefined) throw new Error(`unknown object ${obj}`)
    return t
  }

  /** Засіяти рядки з версією 1 (чи заданою). */
  seed(
    obj: ObjectName,
    rows: readonly ({ id: Key; version?: number } & Record<string, unknown>)[]
  ) {
    for (const { id, version, ...values } of rows) {
      this.table(obj).set(id, { version: version ?? 1, values })
    }
  }

  seedLines(
    obj: ObjectName,
    owner: Key,
    section: string,
    lines: readonly Record<string, unknown>[]
  ) {
    this.sections.set(
      sid(obj, owner, section),
      lines.map((l) => ({ ...l }))
    )
  }

  /** Чужа зміна: нова версія рядка. */
  edit(obj: ObjectName, key: Key, values: Values): number {
    const row = this.table(obj).get(key)
    if (row === undefined) throw new Error(`no row ${key}`)
    row.version++
    row.values = { ...row.values, ...values }
    return row.version
  }

  editLines(
    obj: ObjectName,
    owner: Key,
    section: string,
    lines: readonly Record<string, unknown>[]
  ): number {
    this.sections.set(
      sid(obj, owner, section),
      lines.map((l) => ({ ...l }))
    )
    const row = this.table(obj).get(owner)
    if (row === undefined) throw new Error(`no row ${owner}`)
    return ++row.version
  }

  /** Чуже видалення. */
  remove(obj: ObjectName, key: Key) {
    this.table(obj).delete(key)
  }

  row(obj: ObjectName, key: Key) {
    return this.table(obj).get(key)
  }

  private listRow(obj: ObjectName, key: Key, row: StoredRow, card: boolean) {
    const lazy = new Set(card ? [] : (this.specs.get(obj)?.lazy ?? []))
    const values = Object.fromEntries(
      Object.entries(row.values).filter(([f]) => !lazy.has(f))
    )
    return { id: key, version: row.version, ...values }
  }

  read(query: ReadQuery): ReadRows {
    this.reads++
    const obj = refName(query.object)
    const t = this.table(obj)
    if ("tabularSection" in query) {
      if (!("owner" in query))
        throw new Error("fake: section page not supported")
      const owner = t.get(query.owner)
      return {
        rows:
          owner === undefined
            ? []
            : (
                this.sections.get(
                  sid(obj, query.owner, query.tabularSection)
                ) ?? []
              ).map((l) => ({ ...l })),
        ownerVersion: owner?.version ?? 0,
      }
    }
    if ("id" in query) {
      const row = t.get(query.id)
      return {
        rows: row === undefined ? [] : [this.listRow(obj, query.id, row, true)],
      }
    }
    if ("count" in query) throw new Error("fake: count not supported")
    const spec = this.specs.get(obj)
    const fields = { id: "uuid" as const, ...(spec?.fields ?? {}) }
    const where = query.where
    if (
      where !== undefined &&
      "op" in where &&
      where.attribute === "id" &&
      where.op === "in"
    ) {
      const keys = where.value as Key[]
      if (keys.length > this.maxRowsPerKeysResponse) {
        throw new CommandFailure({
          code: "command.invalid",
          reason: "response-too-large",
        })
      }
    }
    let rows = [...t].map(([key, row]) => ({
      key,
      values: { id: key, ...row.values },
      row,
    }))
    rows = rows.filter((r) => matches(fields, r.values, where))
    rows.sort(rowComparator(fields, query.orderBy, "en-US"))
    const from = query.offset ?? 0
    return {
      rows: rows
        .slice(from, from + query.limit)
        .map((r) => this.listRow(obj, r.key, r.row, false)),
    }
  }

  /** Атомарне застосування пакета: усе або нічого. */
  run(operations: readonly Operation[]): CommandResult {
    this.runs++
    const fail = (error: CommandError): never => {
      throw new CommandFailure(error)
    }
    // Перевірка до змін: пакет атомарний.
    for (const op of operations) {
      const t = this.table(refName(op.object))
      if (op.action === "create") {
        if (op.id !== undefined && t.has(op.id))
          fail({ code: "command.constraint" })
        continue
      }
      const row = t.get(op.id)
      if (row === undefined)
        fail({ code: "command.conflict", reason: "version" })
      else if (row.version !== op.expectedVersion)
        fail({ code: "command.conflict", reason: "version" })
    }
    const rows: Record<string, unknown>[] = []
    const changes: CommandResult["changes"] = []
    for (const op of operations) {
      const obj = refName(op.object)
      const t = this.table(obj)
      if (op.action === "create") {
        const id = op.id ?? crypto.randomUUID()
        const row = { version: 1, values: { ...(op.values ?? {}) } }
        t.set(id, row)
        for (const [name, lines] of Object.entries(op.tabularSections ?? {}))
          this.sections.set(sid(obj, id, name), lines)
        rows.push(this.listRow(obj, id, row, false))
        changes.push({ object: op.object, id, version: 1, operation: "create" })
        continue
      }
      const row = t.get(op.id) as StoredRow
      if (op.action === "delete") {
        t.delete(op.id)
        rows.push({ id: op.id, version: row.version })
        changes.push({
          object: op.object,
          id: op.id,
          version: row.version,
          operation: "delete",
        })
        continue
      }
      row.version++
      if (op.action === "update") {
        row.values = { ...row.values, ...(op.values ?? {}) }
        for (const [name, lines] of Object.entries(op.tabularSections ?? {}))
          this.sections.set(sid(obj, op.id, name), lines)
      } else row.values = { ...row.values, deletionMark: true }
      // Відповідь `run` — списочна форма: без лінивих полів і рядків ТЧ.
      rows.push(this.listRow(obj, op.id, row, false))
      changes.push({
        object: op.object,
        id: op.id,
        version: row.version,
        operation: op.action,
      })
    }
    return { rows, changes }
  }
}

export interface PendingCall {
  readonly kind: "read" | "run"
  readonly query?: ReadQuery
  readonly operations?: readonly Operation[]
  readonly signal: AbortSignal
  /** Відповісти станом сервера на мить відповіді. */
  answer(): void
  /**
   * `read`: відповісти станом сервера на мить запиту — як асинхронна
   * репліка чи запит, що обігнав пізнішу зміну.
   */
  answerStale(): void
  /** Відмовити, нічого не застосувавши. */
  fail(error: CommandError): void
  /** `run`: застосувати на сервері, а викликачу дати відмову (невідомий результат). */
  applyThenFail(error: CommandError): void
}

/**
 * Керований транспорт: кожен виклик чекає, поки тест відповість. Відповідь
 * доходить і після обриву `signal` — так перевіряється, що ядро відкидає
 * пізні відповіді своїми поколіннями, а не завдяки транспорту.
 */
export function controlledSource(server: FakeServer) {
  const calls: PendingCall[] = []
  let auto = false
  let sent = 0
  const source: CoreSource = {
    read(query, signal) {
      sent++
      return new Promise<ReadRows>((resolve, reject) => {
        let early: ReadRows | undefined
        let earlyError: unknown
        try {
          early = server.read(query)
        } catch (e) {
          earlyError = e
        }
        const call: PendingCall = {
          answerStale: () => {
            if (early !== undefined) resolve(early)
            else reject(earlyError)
          },
          kind: "read",
          query,
          signal,
          answer: () => {
            try {
              resolve(server.read(query))
            } catch (e) {
              reject(e)
            }
          },
          fail: (error) => reject(new CommandFailure(error)),
          applyThenFail: (error) => reject(new CommandFailure(error)),
        }
        if (auto) call.answer()
        else calls.push(call)
      })
    },
    run(operations, signal) {
      sent++
      return new Promise<CommandResult>((resolve, reject) => {
        const call: PendingCall = {
          answerStale: () => {
            try {
              resolve(server.run(operations))
            } catch (e) {
              reject(e)
            }
          },
          kind: "run",
          operations,
          signal,
          answer: () => {
            try {
              resolve(server.run(operations))
            } catch (e) {
              reject(e)
            }
          },
          fail: (error) => reject(new CommandFailure(error)),
          applyThenFail: (error) => {
            try {
              server.run(operations)
            } catch {
              // Сервер відмовив сам — викликач однаково бачить `error`.
            }
            reject(new CommandFailure(error))
          },
        }
        if (auto) call.answer()
        else calls.push(call)
      })
    },
  }
  /** Дати мікрозадачам ядра відпрацювати. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return {
    source,
    calls,
    /** Скільки запитів ядро надіслало (на мить запиту, а не відповіді). */
    get sent() {
      return sent
    },
    /** Відповідати одразу (без черги). */
    setAuto(value: boolean) {
      auto = value
    },
    /** Взяти найстаріший виклик (чи за індексом). */
    take(index = 0): PendingCall {
      const [call] = calls.splice(index, 1)
      if (call === undefined) throw new Error("no call in flight")
      return call
    },
    /** Відповідати на все, поки черга не спорожніє. */
    async drain() {
      await settle()
      while (calls.length > 0) {
        calls.shift()?.answer()
        await settle()
      }
    },
    settle,
  }
}
