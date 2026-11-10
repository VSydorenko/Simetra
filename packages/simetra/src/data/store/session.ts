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

/** Discarded answers in a row after which the session is unavailable (Р12). */
export const DISCARDS_MAX = 8

/** The pause before the first re-read after a discarded answer; doubles. */
export const DISCARD_PAUSE_MS = 100

/**
 * The version epoch state of a session (P4-B plan B1c, Р5–Р8, Р12, Р13).
 * Versions compare only within one epoch; the session follows one current
 * epoch and keeps every epoch it switched from until it closes.
 */
export interface VersionEpochs {
  /** The current version epoch; `null` until the first non-empty one. */
  current(): string | null
  /** The epoch the last switch left; `null` — the session never switched. */
  previous(): string | null
  /** The session epoch of the last switch; 0 — never. */
  switchedAt(): number
  /**
   * An answer proves a row of the current epoch: its epoch is the current
   * non-empty one and its read started after the last switch (Р13).
   */
  proves(epoch: string | null | undefined, startEpoch: number): boolean
  /** Answers discarded in a row; an applied answer resets it. */
  discards(): number
  /**
   * {@link DISCARDS_MAX} answers in a row were discarded: every later answer
   * is discarded too and views get `command.unavailable`. The only way out
   * is a new session (Р12, exception Р36): the database keeps answering from
   * an epoch the session already left.
   */
  unavailable(): boolean
}

/** The session of the core: the single change point (P4-B spec §6.1). */
export interface Session {
  readonly subject: string
  /** Aborted when the session closes. */
  readonly signal: AbortSignal
  readonly closed: CloseReason | undefined
  readonly epochs: Epochs
  readonly versions: VersionEpochs
  /**
   * The single check before an answer is written to the store (P4-B plan
   * B1c, Р6, Р7, Р12), called inside `commit` once per answer in the order
   * of application. `null` applies and changes nothing. The first non-empty
   * epoch becomes current without a switch. Another non-empty epoch is a
   * switch (the session epoch moves, `onSwitch` listeners run) and the
   * answer applies — unless the epoch was left before or the read started
   * before the last switch: then the answer is discarded.
   */
  acceptEpoch(epoch: string | null, startEpoch: number): "apply" | "discard"
  /**
   * Called inside the `commit` of a switch with the epoch it left, before the
   * answer that caused it is written.
   */
  onSwitch(listener: (previous: string) => void): void
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
  const listeners = new Set<() => void>()
  const closeHooks: Array<() => void> = []
  let closed: CloseReason | undefined
  let closing = false
  let inCommit = false

  let current: string | null = null
  let previous: string | null = null
  let switchedAt = 0
  let discards = 0
  let unavailable = false
  // Усі покинуті епохи до кінця сесії (Р12): витіснена могла б повернутись
  // як нова й перемикати епоху на кожній відповіді під час PITR.
  const abandoned = new Set<string>()
  const switchListeners: Array<(previous: string) => void> = []

  const versions: VersionEpochs = {
    current: () => current,
    previous: () => previous,
    switchedAt: () => switchedAt,
    proves: (epoch, startEpoch) =>
      current !== null && epoch === current && startEpoch >= switchedAt,
    discards: () => discards,
    unavailable: () => unavailable,
  }

  function discard(): "discard" {
    discards++
    if (discards >= DISCARDS_MAX) unavailable = true
    return "discard"
  }

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
    versions,
    acceptEpoch(epoch, startEpoch) {
      if (!inCommit) throw new Error("acceptEpoch outside commit")
      if (unavailable) return "discard"
      if (epoch === null || epoch === current) {
        discards = 0
        return "apply"
      }
      if (current === null) {
        // Перша непорожня епоха: `null`-відповіді до неї порівнювались як
        // завжди (Р6), тож скидати нічого.
        current = epoch
        discards = 0
        return "apply"
      }
      // Відповідь покинутої епохи чи читання, що почалось до перемикання,
      // не впорядкована з рядками поточної (Р7, Р12).
      if (abandoned.has(epoch) || startEpoch < switchedAt) return discard()
      abandoned.add(current)
      previous = current
      current = epoch
      switchedAt = epochs.next()
      discards = 0
      epochs.adopt(previous)
      for (const listener of switchListeners) listener(previous)
      return "apply"
    },
    onSwitch(listener) {
      if (closed === undefined) switchListeners.push(listener)
    },
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
        sessionController.abort(reason)
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
        switchListeners.length = 0
        abandoned.clear()
        current = null
        previous = null
      }
    },
  }
}
