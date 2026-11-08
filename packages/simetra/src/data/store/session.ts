import { NO_DEFECTS, type Defects } from "./defects"
import { createEpochs, type Epochs } from "./epoch"
import type {
  CloseReason,
  CoreLimits,
  CoreLogEntry,
  GenerationToken,
} from "./types"

/** The write scope of one `commit`: store methods call `assert()`. */
export interface Scope {
  /** Throws `"write scope is closed"` outside the `commit` that issued it. */
  assert(): void
}

/** The session of the core: the single change point (P4-B spec §6.1). */
export interface Session {
  readonly subject: string
  /** Aborted when the session closes. */
  readonly signal: AbortSignal
  readonly closed: CloseReason | undefined
  readonly epochs: Epochs
  token(): GenerationToken
  /** Valid while the session is alive and `isValid()` is true. */
  childToken(isValid: () => boolean): GenerationToken
  /**
   * Runs `fn` in a write scope when `token` is valid and returns `true`;
   * otherwise logs `late-response` (with `what`) and returns `false`.
   * Throws when called inside another `commit`.
   */
  commit(
    fn: (scope: Scope) => void,
    token: GenerationToken,
    what?: string
  ): boolean
  /** Called once per `commit`; returns an unsubscribe function. */
  onFlush(listener: () => void): () => void
  /** Registers a clear-on-close hook for service maps of other modules. */
  onClose(hook: () => void): void
  /** Must be called outside `commit` (throws inside). Runs `purgeAll` in one batch, then aborts, invalidates and clears. */
  close(reason: CloseReason, purgeAll: (scope: Scope) => void): void
  /** A request controller; call `release()` when the request is done. */
  track(): { signal: AbortSignal; release(): void }
}

export function createSession(options: {
  subject: string
  limits: CoreLimits
  log: (entry: CoreLogEntry) => void
  defects?: Defects
}): Session {
  const { log } = options
  const defects = options.defects ?? NO_DEFECTS
  const epochs = createEpochs(options.limits, defects)
  const sessionController = new AbortController()
  const controllers = new Set<AbortController>()
  const listeners = new Set<() => void>()
  const closeHooks: Array<() => void> = []
  let closed: CloseReason | undefined
  let closing = false
  let inCommit = false

  const sessionToken: GenerationToken = {
    get valid() {
      return closed === undefined && !closing
    },
  }

  // Слухачі можуть робити commit: вкладена пачка доходить до решти слухачів
  // раніше за решту зовнішньої.
  // Слухач може закрити сесію або кинути: перед кожним викликом дивимось
  // на `closed`, а збій одного не зупиняє решту. Закриття зсередини слухача
  // запускає вкладений flush з purge-пачкою (кожен слухач її отримує, спека
  // §6.1); поточна пачка зупиняється, бо після close `closed` вже виставлено.
  function flush() {
    for (const listener of [...listeners]) {
      if (closed !== undefined) return
      try {
        listener()
      } catch (error) {
        log({ kind: "listener-failed", error })
      }
    }
  }

  function run(fn: (scope: Scope) => void) {
    if (inCommit) throw new Error("nested commit")
    let open = true
    const scope: Scope = {
      assert() {
        if (!open) throw new Error("write scope is closed")
      },
    }
    inCommit = true
    try {
      fn(scope)
    } finally {
      open = false
      inCommit = false
      // Сповіщаємо й після збою fn: часткові зміни вже у сховищі.
      flush()
    }
  }

  return {
    subject: options.subject,
    signal: sessionController.signal,
    get closed() {
      return closed
    },
    epochs,
    token: () => sessionToken,
    childToken: (isValid) => ({
      get valid() {
        return closed === undefined && !closing && isValid()
      },
    }),
    commit(fn, token, what = "commit") {
      if (!token.valid && !defects.has("no-token-check")) {
        log({ kind: "late-response", what })
        return false
      }
      run(fn)
      return true
    },
    onFlush(listener) {
      if (closed !== undefined) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onClose(hook) {
      // Модуль, що реєструється після закриття, чистить свої мапи одразу.
      if (closed !== undefined) {
        try {
          hook()
        } catch (error) {
          log({ kind: "listener-failed", error })
        }
        return
      }
      closeHooks.push(hook)
    },
    close(reason, purgeAll) {
      if (closed !== undefined || closing) return
      // close усередині commit не виконав би purge в межах пачки: кидаємо
      // до зміни стану, сесія лишається живою.
      if (inCommit) throw new Error("close inside commit")
      closing = true
      // purge йде до `closed`, але токени вже недійсні (closing): слухачі
      // отримують одну пачку й не можуть дописати після purge.
      try {
        run(purgeAll)
      } finally {
        closed = reason
        for (const c of controllers) c.abort()
        controllers.clear()
        sessionController.abort()
        epochs.clear()
        // Збій одного хука не повинен лишити решту мап і слухачів живими.
        for (const hook of closeHooks) {
          try {
            hook()
          } catch (error) {
            log({ kind: "listener-failed", error })
          }
        }
        closeHooks.length = 0
        listeners.clear()
      }
    },
    track() {
      const controller = new AbortController()
      if (closed !== undefined) {
        controller.abort()
        return { signal: controller.signal, release() {} }
      }
      controllers.add(controller)
      return {
        signal: controller.signal,
        release() {
          controllers.delete(controller)
        },
      }
    },
  }
}
