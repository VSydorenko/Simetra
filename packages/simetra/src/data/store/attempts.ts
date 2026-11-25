import { CommandFailure } from "simetra/model"
import { DataError } from "../errors"
import type {
  AdmissionCondition,
  AttemptKind,
  ReadCause,
  ReadTarget,
  ReadWhy,
  SettleOutcome,
  SiteCode,
} from "./sync/vocabulary"

/*
 * Діагностика спроб читання цілі «вигляд» (спека ядра синхронізації §5.13,
 * §5.5): подія «спробу розпочато» і подія «осіло» з одним закритим наслідком.
 * Лише облік: слухач не змінює поведінки, його виняток ковтається. Вигляд і
 * його сторінка несуть той самий непрозорий ідентифікатор цілі, що й
 * `watchReads` та `sync()`.
 */

/** Ціль спроби: вигляд чи його сторінка. */
export type AttemptTarget = Extract<ReadTarget, { kind: "view" | "page" }>

export type AttemptEvent = { readonly attempt: number } & (
  | ({
      readonly phase: "started"
      readonly kind: AttemptKind
      readonly target: AttemptTarget
      readonly site: SiteCode
    } & ReadCause)
  | {
      readonly phase: "settled"
      readonly kind: AttemptKind
      readonly target: AttemptTarget
      readonly outcome: SettleOutcome
      /** Умова допуску, за якою запиту не було (`stale-object`), якщо вона відома. */
      readonly skip?: AdmissionCondition
      /** Код помилки збою (`failed`): оракул відрізняє відмову сервера від відмови ядра. */
      readonly error?: string
    }
)

/** What the readers of views report: the start and the settle of an attempt. */
export interface Attempts {
  /** Registers the start and returns the number the reads of the attempt carry. */
  start(kind: AttemptKind, target: AttemptTarget, why: ReadWhy): number
  settle(
    attempt: number,
    kind: AttemptKind,
    target: AttemptTarget,
    outcome: SettleOutcome,
    detail?: SettleDetail
  ): void
}

/** Що ще відомо про осідання: умова допуску й код помилки збою. */
export interface SettleDetail {
  readonly skip?: AdmissionCondition
  readonly error?: string
}

/** Деталь збою за помилкою читання. */
export const failureOf = (error: unknown): SettleDetail => {
  const skip = skipOf(error)
  const code =
    error instanceof CommandFailure
      ? error.error.code
      : error instanceof DataError
        ? error.code
        : "command.internal"
  return { ...(skip === undefined ? {} : { skip }), error: code }
}

/** Умова допуску, за якою запиту не було: відмова `stale-client` без запиту. */
export const skipOf = (error: unknown): AdmissionCondition | undefined =>
  error instanceof CommandFailure && error.error.code === "command.stale-client"
    ? "stale-object"
    : undefined

// Один лічильник на процес: два ядра над одним фейковим джерелом ділять збирач
// тестів, і номери їхніх спроб не мають збігатися.
let next = 0

export function createAttempts() {
  const listeners = new Set<(event: AttemptEvent) => void>()
  const emit = (event: AttemptEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // Діагностика не змінює поведінки.
      }
    }
  }
  const attempts: Attempts = {
    start(kind, target, why) {
      const attempt = ++next
      emit({ phase: "started", attempt, kind, target, ...why })
      return attempt
    },
    settle(attempt, kind, target, outcome, detail) {
      emit({
        phase: "settled",
        attempt,
        kind,
        target,
        outcome,
        ...detail,
      })
    },
  }
  return {
    attempts,
    watch(listener: (event: AttemptEvent) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
