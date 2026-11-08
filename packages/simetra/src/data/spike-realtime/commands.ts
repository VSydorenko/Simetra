import type { FakeCore, Row } from "./core"

/**
 * Транспорт команд над ядром (спайк 3, бриф п. 5): черга за ключем,
 * тайм-аут, мапінг відмов §7.3 у стан рядка. Без автоповтору: повтор —
 * явна дія користувача (`retry`) чи рішення хоста.
 */

export type CommandOp =
  | {
      action: "update"
      object: string
      id: string
      values: Record<string, unknown>
      expectedVersion: number | undefined
      /** Ключ ідемпотентності: той самий на повторі тієї самої зміни. */
      mutationId: string
    }
  | {
      action: "delete"
      object: string
      id: string
      expectedVersion: number | undefined
      mutationId: string
    }

export type CommandResult =
  | { ok: true; rows: readonly Row[] }
  | {
      ok: false
      code:
        | "command.conflict"
        | "command.busy"
        | "command.timeout"
        | "command.unavailable"
        | "command.forbidden"
        | "command.invalid"
    }

export interface CommandRunnerOptions {
  core: FakeCore
  send: (op: CommandOp) => Promise<CommandResult>
  /** Перечитування ключа після конфлікту чи невідомого результату. */
  reread: (object: string, id: string) => Promise<Row | undefined>
  /** Клієнтський тайм-аут `run`: після нього результат невідомий. */
  timeoutMs?: number
}

/** Чим закінчилась зміна для викликача. */
export type CommandOutcome =
  | "synced"
  | "failed"
  | "conflict"
  /** Результат невідомий і перечитати не вдалося. */
  | "unknown"
  | "closed"

export function createCommandRunner(options: CommandRunnerOptions) {
  const { core, send, reread } = options
  const timeoutMs = options.timeoutMs ?? 15_000
  /** Хвіст черги ключа: наступна зміна ключа стартує після осідання попередньої. */
  const queues = new Map<string, Promise<unknown>>()
  let sent = 0

  const withTimeout = (op: CommandOp) =>
    new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, code: "command.unavailable" }),
        timeoutMs
      )
      send(op).then(
        (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        () => {
          clearTimeout(timer)
          resolve({ ok: false, code: "command.unavailable" })
        }
      )
    })

  const enqueue = <T>(qk: string, work: () => Promise<T>): Promise<T> => {
    const prev = queues.get(qk) ?? Promise.resolve()
    const next = prev.then(work, work)
    queues.set(
      qk,
      next.catch(() => {})
    )
    return next
  }

  async function execute(
    tx: ReturnType<FakeCore["begin"]>,
    draft: CommandOp
  ): Promise<CommandOutcome> {
    if (core.closed) return "closed"
    // База — на старті обробника, після осідання попередньої зміни ключа
    // (§7.1): друга з двох швидких правок бере версію першої.
    const op: CommandOp = {
      ...draft,
      expectedVersion: core.versionOf(draft.object, draft.id),
    }
    sent += 1
    const result = await withTimeout(op)
    if (core.closed) return "closed"
    if (result.ok) {
      tx.settle({ ok: true, rows: result.rows })
      return "synced"
    }
    switch (result.code) {
      case "command.conflict": {
        const row = await reread(op.object, op.id).catch(() => undefined)
        if (core.closed) return "closed"
        tx.settle({
          ok: false,
          kind: "conflict",
          error: result,
          ...(row !== undefined ? { serverRow: row } : {}),
        })
        if (row !== undefined)
          core.apply(
            { object: op.object, rows: [row], origin: "command" },
            core.generation()
          )
        return "conflict"
      }
      case "command.unavailable": {
        // Результат невідомий: перечитати ключ. Версія зросла й значення
        // збігаються — зміна, найімовірніше, наша: показати підтвердженим.
        // Без ключа ідемпотентності це евристика (чужа зміна з тими самими
        // значеннями теж пройде) — див. звіт.
        core.markUnknown(tx.txId)
        const row = await reread(op.object, op.id).catch(() => "error" as const)
        if (core.closed) return "closed"
        // Перечитати не вдалося: `unknown` лишається на місці до наступного
        // перечитування (повтор — лише явною дією).
        if (row === "error") return "unknown"
        const base = op.expectedVersion ?? 0
        const landed =
          op.action === "delete"
            ? row === undefined
            : row !== undefined &&
              row.version > base &&
              Object.entries(op.values).every(([k, v]) => row[k] === v)
        if (landed) {
          tx.settle({ ok: true, rows: row === undefined ? [] : [row] })
          return "synced"
        }
        tx.settle({ ok: false, kind: "failed", error: result })
        return "failed"
      }
      default:
        // busy, timeout, forbidden, invalid — відомий відкат: `failed` на місці.
        tx.settle({ ok: false, kind: "failed", error: result })
        return "failed"
    }
  }

  return {
    get sent() {
      return sent
    },
    update(object: string, id: string, values: Record<string, unknown>) {
      const tx = core.begin(object, id, values)
      const op: CommandOp = {
        action: "update",
        object,
        id,
        values,
        expectedVersion: undefined,
        mutationId: crypto.randomUUID(),
      }
      return {
        txId: tx.txId,
        op,
        done: enqueue(`${object}:${id}`, () => execute(tx, op)),
      }
    },
    delete(object: string, id: string) {
      const tx = core.begin(object, id, {}, { delete: true })
      const op: CommandOp = {
        action: "delete",
        object,
        id,
        expectedVersion: undefined,
        mutationId: crypto.randomUUID(),
      }
      return {
        txId: tx.txId,
        op,
        done: enqueue(`${object}:${id}`, () => execute(tx, op)),
      }
    },
  }
}
