import {
  LIMIT_REASONS,
  operationToWire,
  type CatalogIndex,
  type CommandError,
  type Operation,
} from "simetra/model"
import { DataError, type DataErrorCode } from "../errors"
import { closedError, closedMutation, nextMutationId } from "./closed-mutation"
import { NO_DEFECTS, type Defects } from "./defects"
import { heldEpoch, keyId, pairId } from "./epoch"
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
  WritePolicy,
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

/** The options of `update`; `expectedVersion` is the base (§7.1). */
export interface UpdateOptions {
  readonly expectedVersion: number
}

/** The journal of own mutations of one core. */
export interface Overlay {
  /**
   * Starts an `update` (P4-B spec §7.1). Throws synchronously, before the
   * journal and the transport, only for a caller error: `TypeError` for a
   * name outside the catalog, `DataError` `data.version-required`. A refusal
   * by the write state — `data.mutation-pending`, `data.journal-full` — is a
   * mutation that settles failed with that `DataError`, the journal and the
   * row unchanged.
   */
  update(
    object: ObjectName,
    key: Key,
    values: Values,
    options: UpdateOptions
  ): Mutation
  /** The mutation a row view of the entry shows (`createRowViews`). */
  mutationOf(object: ObjectName, key: Key, e: RowEntry): OwnMutation | undefined
  /** Inside a `commit`: a purge or `removed` erased the fields (Р11). */
  erase(object: ObjectName, key: Key): void
  /** Inside a `commit`: the purge of a pair erased the fields (Р11). */
  eraseScope(object: ObjectName, scope: string | null): void
  /** Settles every live mutation with the close and empties the journal. */
  close(reason: CloseReason): void
  /** Mutations in the journal plus attempts not yet settled (inspection). */
  size(): number
  /** The mutations in the journal (inspection). */
  entries(): JournalInspection[]
}

/** One mutation of the journal as the model test sees it. */
export interface JournalInspection {
  readonly object: ObjectName
  readonly key: Key
  /** The id of the current attempt. */
  readonly id: string
  readonly policy: WritePolicy
  readonly state: MutationState
  /** The fields were erased by a purge or `removed` (Р11). */
  readonly erased: boolean
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

/** The own mutation of a row view: its write mode and its actions. */
export interface OwnMutation {
  readonly policy: WritePolicy
  readonly view: RowMutation
}

/** A mutation in the journal. */
interface JournalEntry {
  readonly object: ObjectName
  readonly key: Key
  /** The write mode: the row view reads the shown values through it. */
  readonly policy: WritePolicy
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

/*
 * Таблиця «код → стан і дія» для запису (§7.3). `reread` — перечитати ключ за
 * ключем (лише з власником); `stale` — позначка й запит `version`, без повтору;
 * `close` — сесію закрито, мутація нічого не показує. `unavailable` на `run`
 * (зокрема тайм-аут чи обрив транспорту, які раннер зводить до нього) —
 * результат невідомий; `command.timeout` — відмова БД до `COMMIT`, тож `failed`.
 * `internal` може йти й після `COMMIT` (Р10), тож ключ теж перечитується.
 */
interface Policy {
  readonly state: MutationState | "closed"
  readonly reread: boolean
  readonly stale: boolean
}

function policyOf(error: CommandError): Policy {
  switch (error.code) {
    case "command.conflict":
      return { state: "conflict", reread: true, stale: false }
    case "command.forbidden":
    case "command.internal":
      return { state: "failed", reread: true, stale: false }
    case "command.stale-client":
      return { state: "failed", reread: false, stale: true }
    case "command.unavailable":
      return { state: "unknown", reread: true, stale: false }
    case "command.unauthenticated":
      return error.reason === LIMIT_REASONS.sessionChanged
        ? { state: "closed", reread: false, stale: false }
        : { state: "failed", reread: false, stale: false }
    default:
      // `invalid` (з логічним `path`), `busy`, `timeout` і решта: лише стан і дії.
      return { state: "failed", reread: false, stale: false }
  }
}

export function createOverlay(deps: {
  session: Session
  source: CoreSource
  index: CatalogIndex
  objectOf(name: ObjectName): ObjectState
  rowViews: RowViews
  /** `CoreSession.commit`: the writer is the only way to write the store. */
  commit(fn: (writer: Writer) => void, token: GenerationToken): boolean
  /** Whether the object is marked stale-client: no write passes (§10). */
  isStale(object: ObjectName): boolean
  /** A server refusal `stale-client`: `onStaleClient` and a `version` request. */
  staleClient(object: ObjectName): void
  /** Re-reads the key by key (`rereadKey`). */
  reread(object: ObjectName, key: Key, options: RereadOptions): void
  log(entry: CoreLogEntry): void
  /** Deliberate defects of the model test's self-check. */
  defects?: Defects
}): Overlay {
  const { session, source, index, objectOf, rowViews, commit } = deps
  const defects = deps.defects ?? NO_DEFECTS
  // Дефект самотесту: відповідь скасованої спроби пишеться — і токеном
  // сесії, бо токен спроби її вже не пропустив би.
  const afterCancel = () => defects.has("answer-after-cancel")
  const tokenOf = (attempt: Attempt) =>
    afterCancel() ? session.token() : attempt.token
  // Індекс журналу — черга записів ключа (шов #208: кілька записів ключа,
  // база з попереднього); у М3 у черзі рівно один запис (Р1), тож межа
  // журналу рахує ключі.
  const journal = new Map<ObjectName, Map<Key, JournalEntry[]>>()
  let keys = 0
  const entryOf = (object: ObjectName, key: Key) =>
    journal.get(object)?.get(key)?.[0]
  const entriesOf = function* () {
    for (const byKey of journal.values())
      for (const queue of byKey.values()) yield* queue
  }
  const place = (entry: JournalEntry) => {
    let byKey = journal.get(entry.object)
    if (byKey === undefined) journal.set(entry.object, (byKey = new Map()))
    if (!byKey.has(entry.key)) keys++
    byKey.set(entry.key, [entry])
  }
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
    entryOf(entry.object, entry.key) === entry && entry.attempt === attempt

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

  /** A mutation refused by the write state: settled failed, never sent. */
  const refused = (code: DataErrorCode): Mutation =>
    Object.freeze({
      id: nextMutationId(),
      settled: Promise.resolve<MutationResult>(
        Object.freeze({ ok: false, error: new DataError(code) })
      ),
    })

  const mutationOfAttempt = (attempt: Attempt): Mutation =>
    Object.freeze({ id: attempt.id, settled: attempt.settled })

  /** Removes the entry in the current `commit` (one notification with the row). */
  function drop(entry: JournalEntry) {
    const byKey = journal.get(entry.object)
    if (byKey?.get(entry.key)?.[0] === entry) {
      byKey.delete(entry.key)
      keys--
      if (byKey.size === 0) journal.delete(entry.object)
    }
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
    // Позначений об'єкт запису не приймає (§10): відмова без транспорту, і
    // без `onStaleClient` — відповіді сервера не було.
    if (deps.isStale(entry.object)) {
      queueMicrotask(() =>
        onResult(
          entry,
          attempt,
          { ok: false, error: { code: "command.stale-client", object: o.ref } },
          true
        )
      )
      return
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
    result: CoreRunResult,
    local = false
  ) {
    // Скасовано чи закрито: відповідь нічого не пише (Р9, токен спроби).
    if (!attempt.live && !afterCancel()) {
      attempt.resolve(
        result.ok
          ? { ok: true, rows: result.rows.map(() => undefined) }
          : { ok: false, error: result.error }
      )
      return
    }
    if (!result.ok) {
      fail(entry, attempt, result.error, local)
      return
    }
    const o = objectOf(entry.object)
    const row = result.rows[0]
    // Рядок `run` — без лінивих колонок (§4.5): змінене ліниве поле він не
    // підтверджує, тож власник отримує його з форми картки до осідання (Р4).
    const lazy = o.lazyFields.some((f) => Object.hasOwn(entry.values ?? {}, f))
    const owned = () => (o.rows.get(entry.key)?.owners ?? 0) > 0
    let form: "list" | "card" | undefined
    let separate = false
    // Перечитування ключа без власника нічого не пише (§7.2, крок 5), тож
    // без значень з відповіді (немає `rows` чи інша епоха) він осідає з
    // `rows: [undefined]` без читання.
    const unread = () => {
      drop(entry)
      attempt.resolve({ ok: true, rows: [undefined] })
    }
    if (row === undefined) {
      if (!owned()) {
        commit(unread, tokenOf(attempt))
        attempt.resolve({ ok: true, rows: [undefined] })
        return
      }
      form = lazy ? "card" : "list"
    } else {
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
          if (owned()) form = lazy ? "card" : "list"
          else unread()
          return
        }
        if (defects.has("settle-separate-commit")) {
          separate = true
          return
        }
        // Запис рядка й зняття мутації — одне сповіщення (§7.2, крок 3).
        drop(entry)
        attempt.resolve({
          ok: true,
          rows: [marked(entry, attempt) ? undefined : row],
        })
      }, tokenOf(attempt))
      if (!ran) {
        attempt.resolve({ ok: true, rows: [undefined] })
        return
      }
      if (separate) {
        commit(() => {
          drop(entry)
          attempt.resolve({
            ok: true,
            rows: [marked(entry, attempt) ? undefined : row],
          })
        }, tokenOf(attempt))
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
        if (!attempt.live && !afterCancel()) {
          attempt.resolve({ ok: true, rows: [undefined] })
          return
        }
        const row =
          outcome.kind === "read" && !marked(entry, attempt)
            ? outcome.row
            : undefined
        drop(entry)
        attempt.resolve({ ok: true, rows: [row] })
      },
    })
  }

  /**
   * A mark newer than the start of the attempt (§7.1): a key or pair
   * tombstone, a `hide` of the key, or an eviction horizon — an evicted
   * tombstone may have been the purge of this key, as on the read path
   * (§6.2 rule 1). `settled` then carries no row.
   */
  function marked(entry: JournalEntry, attempt: Attempt): boolean {
    const { epochs } = session
    const since = (id: string) =>
      epochs.buriedSince(id, attempt.readEpoch) ||
      epochs.evictedSince(id, attempt.readEpoch)
    const id = keyId(entry.object, entry.key)
    return (
      since(id) ||
      epochs.hiddenSince(id, attempt.readEpoch) ||
      (attempt.scope !== undefined &&
        since(pairId(entry.object, attempt.scope)))
    )
  }

  function fail(
    entry: JournalEntry,
    attempt: Attempt,
    error: CommandError,
    local: boolean
  ) {
    // Рантайм закрито: ні стану, ні перечитування (§7.3).
    if (
      error.code === "command.unavailable" &&
      error.reason === LIMIT_REASONS.disposed
    ) {
      attempt.resolve({ ok: false, error })
      return
    }
    const policy = policyOf(error)
    if (policy.state === "closed") {
      // `session-changed` закриває рантайм; без нього (ядро саме) запис
      // просто не лишається висіти в журналі.
      commit(() => {
        drop(entry)
        attempt.resolve({ ok: false, error })
      }, tokenOf(attempt))
      attempt.resolve({ ok: false, error })
      return
    }
    commit(() => {
      entry.state = policy.state as MutationState
      entry.error = error
      attempt.resolve({ ok: false, error })
      changed(entry)
    }, tokenOf(attempt))
    attempt.resolve({ ok: false, error })
    if (policy.stale && !local) deps.staleClient(entry.object)
    // Значень з відповіді немає, тож ключ перечитується (Р6); ключ без
    // власника перечитувати нема для кого.
    if (
      policy.reread &&
      (objectOf(entry.object).rows.get(entry.key)?.owners ?? 0) > 0
    ) {
      const lazy = objectOf(entry.object).lazyFields.some((f) =>
        Object.hasOwn(entry.values ?? {}, f)
      )
      deps.reread(entry.object, entry.key, { form: lazy ? "card" : "list" })
    }
  }

  /** Starts an attempt of the entry in one `commit` and sends it. */
  function start(entry: JournalEntry, attempt: Attempt, replace: boolean) {
    commit(() => {
      if (replace) place(entry)
      entry.attempt = attempt
      entry.state = "pending"
      entry.error = undefined
      changed(entry)
      if (defects.has("predict-before-answer")) {
        // Дефект самотесту: значення мутації в рядку сховища до відповіді.
        const e = objectOf(entry.object).rows.get(entry.key)
        if (e?.row !== undefined)
          e.row = {
            ...e.row,
            versionEpoch: heldEpoch(e.row.versionEpoch),
            values: { ...e.row.values, ...entry.values },
          }
      }
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
      // Стан запису — не помилка викликача: та сама форма відмови, що й від
      // сервера (`settled` з `failed`), без журналу й транспорту (§7.1).
      const existing = entryOf(object, key)
      if (existing?.state === "pending") return refused("data.mutation-pending")
      if (existing === undefined && keys >= JOURNAL_MAX)
        return refused("data.journal-full")
      const attempt = newAttempt({ object, key })
      const entry: JournalEntry = {
        object,
        key,
        policy: "await",
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
      const entry = entryOf(object, key)
      if (entry === undefined) return undefined
      const flags = `${e.removed !== undefined}/${e.stale.hidden !== undefined}`
      let view = entry.views.get(flags)
      if (view === undefined) {
        view = buildView(entry, e)
        entry.views.set(flags, view)
      }
      return { policy: entry.policy, view }
    },

    erase(object, key) {
      const entry = entryOf(object, key)
      if (entry === undefined || entry.values === undefined) return
      entry.values = undefined
      changed(entry)
    },

    eraseScope(object, scope) {
      for (const queue of journal.get(object)?.values() ?? []) {
        const entry = queue[0]
        if (entry === undefined || entry.values === undefined) continue
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
      keys = 0
    },

    size: () => keys + unsettled.size,

    entries: () =>
      [...entriesOf()].map((entry) => ({
        object: entry.object,
        key: entry.key,
        id: entry.attempt.id,
        policy: entry.policy,
        state: entry.state,
        erased: entry.values === undefined,
      })),
  }
}
