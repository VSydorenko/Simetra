import {
  LIMIT_REASONS,
  operationToWire,
  type CatalogIndex,
  type CommandError,
  type Operation,
} from "simetra/model"
import { DataError } from "../errors"
import { keyId, pairId } from "./epoch"
import type { ObjectState } from "./forms"
import type { RowEntry } from "./object-store"
import type { Session } from "./session"
import type { RowViews } from "./snapshot"
import type { CoreRunResult, CoreSource } from "./source"
import type {
  CloseReason,
  CoreLogEntry,
  GenerationToken,
  Key,
  Mutation,
  MutationResult,
  MutationState,
  ObjectName,
  RowMutation,
  Values,
  Writer,
} from "./types"
import type { rereadKey } from "./writer"

type RereadOptions = Parameters<typeof rereadKey>[3]

/*
 * Журнал власних мутацій (спека П4-B §6.1 `Overlay`, §7.1, §7.2; план
 * B3-4-Л). Тонкий зріз М3: лише `update` з політикою `await`, одна мутація на
 * ключ (Р1), без рядків у журналі (Р2) — показ бере підтверджений рядок
 * сховища, а журнал дає рядку лише стан і дії (Р5). Кожна зміна журналу —
 * усередині `commit`, тож разом із записом рядка вона дає одне сповіщення.
 */

/** The journal limit (P4-B spec §6.2): a new key over it is `data.journal-full`. */
export const JOURNAL_MAX = 500

let mutationSeq = 0
const nextMutationId = () => `m${++mutationSeq}`

/**
 * The refusal a mutation settles with once its runtime is closed: the same
 * error the transport wrapper gives a request after the close.
 */
export function closedError(reason: CloseReason): CommandError {
  return reason === "session-changed"
    ? {
        code: "command.unauthenticated",
        reason: LIMIT_REASONS.sessionChanged,
      }
    : { code: "command.unavailable", reason: LIMIT_REASONS.disposed }
}

/** A mutation of a closed runtime: settled with the close, never sent. */
export function closedMutation(reason: CloseReason): Mutation {
  return Object.freeze({
    id: nextMutationId(),
    settled: Promise.resolve<MutationResult>({
      ok: false,
      error: closedError(reason),
    }),
  })
}

/** The options of `update`; `expectedVersion` is the base (§7.1). */
export interface UpdateOptions {
  readonly expectedVersion: number
}

/** The journal of own mutations of one core. */
export interface Overlay {
  /**
   * Starts an `update` (P4-B spec §7.1). Throws synchronously, before the
   * journal and the transport: `TypeError` for a name outside the catalog,
   * `DataError` `data.version-required`, `data.mutation-pending`,
   * `data.journal-full`.
   */
  update(
    object: ObjectName,
    key: Key,
    values: Values,
    options: UpdateOptions
  ): Mutation
  /** The mutation a row view of the entry shows (`createRowViews`). */
  mutationOf(object: ObjectName, key: Key, e: RowEntry): RowMutation | undefined
  /** Inside a `commit`: a purge or `removed` erased the fields (Р11). */
  erase(object: ObjectName, key: Key): void
  /** Inside a `commit`: the purge of a pair erased the fields (Р11). */
  eraseScope(object: ObjectName, scope: string | null): void
  /** Settles every live mutation with the close and empties the journal. */
  close(reason: CloseReason): void
  /** Mutations in the journal plus attempts not yet settled (inspection). */
  size(): number
}

/** One attempt of a mutation: one `run` (§7.1). */
interface Attempt {
  readonly id: string
  /** The session epoch at the start: tombstones and marks compare to it. */
  readEpoch: number
  /** The stored scope of the key at the start; `undefined` — no row. */
  scope: string | null | undefined
  /** While true the attempt may write; cancel, settle or close end it. */
  live: boolean
  token: GenerationToken
  readonly settled: Promise<MutationResult>
  resolve(result: MutationResult): void
}

/** A mutation in the journal. */
interface JournalEntry {
  readonly object: ObjectName
  readonly key: Key
  /** `undefined` — erased by a purge or `removed` (Р11): no `retry`. */
  values: Values | undefined
  readonly expectedVersion: number
  state: MutationState
  error: CommandError | undefined
  attempt: Attempt
  /** Row mutation views by the flags of the entry they were built for. */
  readonly views: Map<string, RowMutation>
}

const sameKey = (a: Key, b: Key) => a.toLowerCase() === b.toLowerCase()

// Збій запису після відповіді сервера (§7.3): відмова — стан мутації з
// кодом; «недоступно» — результат невідомий; решта — `failed`. Повну
// таблицю кодів дає задача 3 плану.
function stateOf(error: CommandError): MutationState {
  if (error.code === "command.conflict") return "conflict"
  if (error.code === "command.unavailable") return "unknown"
  return "failed"
}

export function createOverlay(deps: {
  session: Session
  source: CoreSource
  index: CatalogIndex
  objectOf(name: ObjectName): ObjectState
  rowViews: RowViews
  /** `CoreSession.commit`: the writer is the only way to write the store. */
  commit(fn: (writer: Writer) => void, token: GenerationToken): boolean
  /** Re-reads the key by key (`rereadKey`). */
  reread(object: ObjectName, key: Key, options: RereadOptions): void
  log(entry: CoreLogEntry): void
}): Overlay {
  const { session, source, index, objectOf, rowViews, commit } = deps
  const journal = new Map<string, JournalEntry>()
  // Спроби, чий `settled` ще не розв'язано, — і ті, що вже поза журналом
  // (скасовані в польоті): закриття розв'язує всі.
  const unsettled = new Set<Attempt>()

  const touch = (entry: JournalEntry) => {
    // Ревізія — лише для ключа зі слотом сховища: рядка без слота не
    // показує жоден вигляд.
    if (objectOf(entry.object).rows.get(entry.key) !== undefined)
      rowViews.touch(entry.object, entry.key)
  }

  const changed = (entry: JournalEntry) => {
    entry.views.clear()
    touch(entry)
  }

  const current = (entry: JournalEntry, attempt: Attempt) =>
    journal.get(keyId(entry.object, entry.key)) === entry &&
    entry.attempt === attempt

  function newAttempt(entry: Pick<JournalEntry, "object" | "key">): Attempt {
    let resolve!: (result: MutationResult) => void
    const settled = new Promise<MutationResult>((r) => (resolve = r))
    const attempt: Attempt = {
      id: nextMutationId(),
      readEpoch: session.epochs.now(),
      scope: objectOf(entry.object).rows.get(entry.key)?.scope,
      live: true,
      token: session.childToken(() => attempt.live),
      settled,
      resolve(result) {
        if (!unsettled.delete(attempt)) return
        attempt.live = false
        resolve(Object.freeze(result))
      },
    }
    unsettled.add(attempt)
    return attempt
  }

  const mutationOfAttempt = (attempt: Attempt): Mutation =>
    Object.freeze({ id: attempt.id, settled: attempt.settled })

  /** Removes the entry in the current `commit` (one notification with the row). */
  function drop(entry: JournalEntry) {
    const id = keyId(entry.object, entry.key)
    if (journal.get(id) === entry) journal.delete(id)
    touch(entry)
  }

  function send(entry: JournalEntry, attempt: Attempt) {
    const o = objectOf(entry.object)
    const operation: Operation = {
      action: "update",
      object: o.ref,
      id: entry.key,
      expectedVersion: entry.expectedVersion,
      values: entry.values ?? {},
    }
    source.run(operation).then(
      (result) => onResult(entry, attempt, result),
      (error: unknown) => {
        // Дефект шляху запису, а не відмова сервера: `settled` однаково
        // осідає (§7.1 — ніколи не відхиляється).
        deps.log({ kind: "listener-failed", error })
        onResult(entry, attempt, {
          ok: false,
          error: { code: "command.internal" },
        })
      }
    )
  }

  function onResult(
    entry: JournalEntry,
    attempt: Attempt,
    result: CoreRunResult
  ) {
    // Скасовано чи закрито: відповідь нічого не пише (Р9, токен спроби).
    if (!attempt.live) {
      attempt.resolve(
        result.ok
          ? { ok: true, rows: result.rows.map(() => undefined) }
          : { ok: false, error: result.error }
      )
      return
    }
    if (!result.ok) {
      fail(entry, attempt, result.error)
      return
    }
    const o = objectOf(entry.object)
    const row = result.rows[0]
    // Рядок `run` — без лінивих колонок (§4.5): змінене ліниве поле він не
    // підтверджує, тож власник отримує його з форми картки до осідання (Р4).
    const lazy = o.lazyFields.some((f) => Object.hasOwn(entry.values ?? {}, f))
    const owned = () => (o.rows.get(entry.key)?.owners ?? 0) > 0
    let form: "list" | "card" | undefined
    if (row === undefined) form = lazy && owned() ? "card" : "list"
    else {
      const ran = commit((writer) => {
        if (lazy && owned()) {
          form = "card"
          return
        }
        // Повний рядок тієї самої епохи: осідання з рядка `run` без
        // перечитування; ключ без власника не пише нічого (§7.2, крок 5).
        const skipped = writer.writeBack(
          entry.object,
          [row],
          result.epoch,
          attempt.readEpoch
        )
        if (skipped.length > 0) {
          form = lazy ? "card" : "list"
          return
        }
        // Запис рядка й зняття мутації — одне сповіщення (§7.2, крок 3).
        drop(entry)
        attempt.resolve({
          ok: true,
          rows: [buried(entry, attempt) ? undefined : row],
        })
      }, attempt.token)
      if (!ran) {
        attempt.resolve({ ok: true, rows: [undefined] })
        return
      }
      if (form === undefined) return
    }
    const change = result.changes.find(
      (c) =>
        c.object.kind === o.ref.kind &&
        c.object.name === o.ref.name &&
        sameKey(c.id, entry.key)
    )
    const version = row?.version ?? change?.version ?? entry.expectedVersion + 1
    reread(entry, attempt, form, { version, epoch: result.epoch })
  }

  /**
   * The key without a confirmed row of the result: re-read by key before
   * settling (§7.2 step 4); the mutation leaves in the `commit` that writes
   * the re-read row. A failure leaves the key `stale` (`unconfirmed`).
   */
  function reread(
    entry: JournalEntry,
    attempt: Attempt,
    form: "list" | "card",
    unconfirmed: { version: number; epoch: string }
  ) {
    deps.reread(entry.object, entry.key, {
      form,
      unconfirmed,
      onCommit(outcome) {
        if (!attempt.live) {
          attempt.resolve({ ok: true, rows: [undefined] })
          return
        }
        const row =
          outcome.kind === "read" && !buried(entry, attempt)
            ? outcome.row
            : undefined
        drop(entry)
        attempt.resolve({ ok: true, rows: [row] })
      },
    })
  }

  /** A key or pair tombstone newer than the start of the attempt (§7.1). */
  function buried(entry: JournalEntry, attempt: Attempt): boolean {
    const { epochs } = session
    return (
      epochs.buriedSince(keyId(entry.object, entry.key), attempt.readEpoch) ||
      (attempt.scope !== undefined &&
        epochs.buriedSince(
          pairId(entry.object, attempt.scope),
          attempt.readEpoch
        ))
    )
  }

  function fail(entry: JournalEntry, attempt: Attempt, error: CommandError) {
    // Рантайм закрито: ні стану, ні перечитування (§7.3).
    if (
      error.code === "command.unavailable" &&
      error.reason === LIMIT_REASONS.disposed
    ) {
      attempt.resolve({ ok: false, error })
      return
    }
    const state = stateOf(error)
    commit(() => {
      entry.state = state
      entry.error = error
      attempt.resolve({ ok: false, error })
      changed(entry)
    }, attempt.token)
    attempt.resolve({ ok: false, error })
    // Запис міг відбутися: `unavailable` — результат невідомий; `internal`
    // буває й після `COMMIT` (епоха без рядка, Р10). Значень з відповіді
    // немає, тож ключ перечитується (Р6).
    // Ключ без власника перечитувати нема для кого.
    if (
      (state === "unknown" || error.code === "command.internal") &&
      (objectOf(entry.object).rows.get(entry.key)?.owners ?? 0) > 0
    )
      deps.reread(entry.object, entry.key, { form: "list" })
  }

  /** Starts an attempt of the entry in one `commit` and sends it. */
  function start(entry: JournalEntry, attempt: Attempt, replace: boolean) {
    const id = keyId(entry.object, entry.key)
    commit(() => {
      if (replace) journal.set(id, entry)
      entry.attempt = attempt
      entry.state = "pending"
      entry.error = undefined
      changed(entry)
    }, session.token())
    send(entry, attempt)
  }

  function buildView(entry: JournalEntry, e: RowEntry): RowMutation {
    const removed = e.removed !== undefined
    const hidden = e.stale.hidden !== undefined
    const { state, attempt } = entry
    const drops = () => {
      if (!current(entry, attempt)) return
      commit(() => {
        attempt.live = false
        drop(entry)
      }, session.token())
    }
    const canCancel =
      state === "failed" ||
      state === "conflict" ||
      (removed && state === "pending")
    const canRetry =
      state === "failed" && entry.values !== undefined && !hidden && !removed
    return Object.freeze({
      id: attempt.id,
      state,
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(canRetry ? { retry: () => retry(entry, attempt) } : {}),
      ...(canCancel ? { cancel: drops } : {}),
      ...(state === "unknown" ? { dismiss: drops } : {}),
    })
  }

  function retry(entry: JournalEntry, attempt: Attempt): Mutation | undefined {
    const e = objectOf(entry.object).rows.get(entry.key)
    if (
      !current(entry, attempt) ||
      entry.state !== "failed" ||
      entry.values === undefined ||
      e?.stale.hidden !== undefined ||
      e?.removed !== undefined ||
      !session.token().valid
    )
      return undefined
    const next = newAttempt(entry)
    start(entry, next, false)
    return mutationOfAttempt(next)
  }

  return {
    update(object, key, values, options) {
      const o = objectOf(object)
      const expectedVersion = (options as Partial<UpdateOptions> | undefined)
        ?.expectedVersion
      if (
        typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1
      )
        throw new DataError("data.version-required")
      // Ім'я поза каталогом — дефект викликача: синхронно, до журналу й
      // транспорту, а не відмовою `settled`. Значення, що не кодується, —
      // відмова `command.invalid` з `path` (§7.3), її дає спроба.
      const mapped = operationToWire(index, {
        action: "update",
        object: o.ref,
        id: key,
        expectedVersion,
        values,
      })
      if (!mapped.ok && "unknown" in mapped)
        throw new TypeError(`update: ${object} has no such attribute`)
      if (!session.token().valid)
        return closedMutation(session.closed ?? "disposed")
      const existing = journal.get(keyId(object, key))
      if (existing?.state === "pending")
        throw new DataError("data.mutation-pending")
      if (existing === undefined && journal.size >= JOURNAL_MAX)
        throw new DataError("data.journal-full")
      const attempt = newAttempt({ object, key })
      const entry: JournalEntry = {
        object,
        key,
        values: Object.freeze({ ...values }),
        expectedVersion,
        state: "pending",
        error: undefined,
        attempt,
        views: new Map(),
      }
      start(entry, attempt, true)
      return mutationOfAttempt(attempt)
    },

    mutationOf(object, key, e) {
      const entry = journal.get(keyId(object, key))
      if (entry === undefined) return undefined
      const flags = `${e.removed !== undefined}/${e.stale.hidden !== undefined}`
      let view = entry.views.get(flags)
      if (view === undefined) {
        view = buildView(entry, e)
        entry.views.set(flags, view)
      }
      return view
    },

    erase(object, key) {
      const entry = journal.get(keyId(object, key))
      if (entry === undefined || entry.values === undefined) return
      entry.values = undefined
      changed(entry)
    },

    eraseScope(object, scope) {
      for (const entry of journal.values()) {
        if (entry.object !== object || entry.values === undefined) continue
        const at = entry.attempt.scope
        if (at !== undefined && at !== scope) continue
        entry.values = undefined
        changed(entry)
      }
    },

    close(reason) {
      const error = closedError(reason)
      for (const attempt of [...unsettled])
        attempt.resolve({ ok: false, error })
      journal.clear()
    },

    size: () => journal.size + unsettled.size,
  }
}
