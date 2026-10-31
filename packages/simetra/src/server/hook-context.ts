import { AsyncLocalStorage } from "node:async_hooks"
import type {
  CommandError,
  HookContext,
  Operation,
  RuntimeObject,
} from "simetra/model"
import { decodeRow } from "./decode"
import { CommandFailure } from "./errors"
import { prepareRead } from "./read"
import type { Transaction } from "./transaction"

/** The async context of a running command: its attempt and phase depth. */
export interface Frame {
  /** Знімається, коли команда завершилась: далі виклики — не вкладені. */
  readonly command: { active: boolean }
  readonly tx: Transaction
  readonly depth: number
}

/** A phase as its hooks see it. */
export interface HookPhase {
  object: RuntimeObject
  op: Operation
  /** Новий на кожну фазу: дані хуків не переходять у фазу `ctx.run` і в повтор. */
  additionalProperties: Map<string, unknown>
  /** Validates and runs a phase started by `ctx.run`. */
  runNested(operation: unknown): Promise<Record<string, unknown>>
}

// Одне сховище на модуль для всіх екземплярів рантайму (Р-A3-11): хук, що
// викликає `run` іншого екземпляра, інакше взяв би друге з'єднання й чекав
// би на замок своєї ж транзакції. Лише `run` і `exit` — без `enterWith`.
const frames = new AsyncLocalStorage<Frame>()

const INTERNAL: CommandError = { code: "command.internal" }

/** Runs `work` as the async context of a command attempt. */
export function inCommand<T>(frame: Frame, work: () => Promise<T>): Promise<T> {
  return frames.run(frame, work)
}

/** Runs `work` outside any command (`afterCommit` actions). */
export function outsideCommand<T>(work: () => T): T {
  return frames.exit(work)
}

/**
 * `run` чи `read` будь-якого рантайму в асинхронному контексті активної
 * команди — `command.nested` (спека П4 §6.5). Відмова закриває чергу тієї
 * команди: перехопивши її, хук не продовжить команду (Р-A3-15).
 */
export function rejectNested(): void {
  const frame = frames.getStore()
  if (frame?.command.active === true) {
    frame.tx.abort({ code: "command.nested" })
  }
}

interface Scope {
  live: boolean
  pending: Set<Promise<unknown>>
}

/**
 * Calls one hook with its `ctx`, then waits for every `ctx` call the hook
 * started. The first failure of the attempt wins even when the hook caught
 * it; a hook's own exception is `command.internal`, logged.
 */
export async function callHook<T>(
  tx: Transaction,
  phase: HookPhase,
  hook: (ctx: HookContext) => T | Promise<T>
): Promise<T> {
  const scope: Scope = { live: true, pending: new Set() }
  let outcome: { value: T } | undefined
  try {
    outcome = { value: await hook(contextOf(tx, phase, scope)) }
  } catch (error) {
    // Відмова `ctx` (і перехоплена раніше) уже закрила чергу; інакше —
    // власний виняток хука: назовні лише код, текст — у журнал.
    if (tx.terminal === undefined) {
      tx.state.log({ kind: "hook", error })
      tx.close({
        failure: new CommandFailure(INTERNAL),
        retry: false,
        destroy: false,
      })
    }
  }
  scope.live = false
  // T3 чекає й ті виклики `ctx`, яких хук не чекав: інакше вони йшли б
  // у чергу після кроку, що вже мав їх бачити.
  await Promise.allSettled(scope.pending)
  if (tx.terminal !== undefined) throw tx.terminal.failure
  return outcome!.value
}

function contextOf(tx: Transaction, phase: HookPhase, scope: Scope) {
  const { object, op } = phase
  // Метод `ctx` діє, лише поки виконується його хук, і лише в асинхронному
  // контексті своєї спроби (Р-A3-15): збережений `ctx` інакше виконав би
  // запит у чужій транзакції з чужими claims.
  const valid = () => scope.live && frames.getStore()?.tx === tx
  const misuse = () => {
    tx.state.log({
      kind: "hook",
      error: new Error("hook context used outside its hook"),
    })
    return new CommandFailure(INTERNAL)
  }
  const track = <R>(work: () => Promise<R>): Promise<R> => {
    let promise: Promise<R>
    if (!valid()) {
      promise = Promise.reject(misuse())
    } else if (tx.terminal !== undefined) {
      // Після першої відмови — жодного звернення до порту.
      promise = Promise.reject(tx.terminal.failure)
    } else {
      promise = work()
      scope.pending.add(promise)
    }
    // Відмову вже записано в `tx.terminal` чи в журнал; хук, що не чекав
    // виклику, не має породити unhandled rejection.
    promise.catch(() => undefined)
    return promise
  }
  const ctx: HookContext = {
    object: { kind: object.kind, name: object.name },
    id: op.id,
    action: op.action,
    isNew: op.action === "create",
    ...(op.action === "markDeletion" ? { mark: op.mark } : {}),
    additionalProperties: phase.additionalProperties,
    user: tx.user,
    ...(tx.act === undefined ? {} : { act: { sub: tx.act.sub } }),
    run: (operation) =>
      track(async () => {
        const frame = frames.getStore()!
        // Глибина — з поточної фази в ALS, а не з `ctx`: захоплений
        // кореневий `ctx` не обнуляє її.
        const depth = frame.depth + 1
        if (depth > tx.state.maxDepth) tx.abort({ code: "command.depth" })
        return frames.run({ ...frame, depth }, () => phase.runNested(operation))
      }),
    read: (query) =>
      track(async () => {
        const prepared = prepareRead(tx.state.catalog, query)
        if ("error" in prepared) tx.abort(prepared.error)
        const { object: target, statement } = prepared
        // Та сама транзакція й роль команд: хук читає те, що бачить ядро.
        const { rows } = await tx.enqueue([statement], {
          kind: "read",
          object: target,
        })
        try {
          return rows.map((r) => {
            if (typeof r.row !== "string")
              throw new Error("read row is not text")
            return decodeRow(target, r.row)
          })
        } catch (error) {
          tx.anomaly(error)
        }
      }),
    reject(code, path) {
      if (!valid()) throw misuse()
      tx.abort({
        code: "command.rejected",
        reason: code,
        ...(path === undefined ? {} : { path }),
      })
    },
    afterCommit(fn) {
      if (!valid()) throw misuse()
      tx.afterCommit.push(fn)
    },
  }
  return Object.freeze(ctx)
}
