import { CommandFailure } from "simetra/model"
import type { ObjectName } from "./types"
import type {
  AdmissionCondition,
  AttemptKind,
  ReadCause,
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
export interface AttemptTarget {
  readonly kind: "view" | "page"
  readonly object: ObjectName
  readonly id: number
}

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
    }
)

/** What the readers of views report: the start and the settle of an attempt. */
export interface Attempts {
  /** Registers the start and returns the number the reads of the attempt carry. */
  start(
    kind: AttemptKind,
    target: AttemptTarget,
    why: ReadCause & { readonly site: SiteCode }
  ): number
  settle(
    attempt: number,
    kind: AttemptKind,
    target: AttemptTarget,
    outcome: SettleOutcome,
    skip?: AdmissionCondition
  ): void
}

/** Умова допуску, за якою запиту не було: відмова `stale-client` без запиту. */
export const skipOf = (error: unknown): AdmissionCondition | undefined =>
  error instanceof CommandFailure && error.error.code === "command.stale-client"
    ? "stale-object"
    : undefined

export function createAttempts() {
  const listeners = new Set<(event: AttemptEvent) => void>()
  let next = 0
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
    settle(attempt, kind, target, outcome, skip) {
      emit({
        phase: "settled",
        attempt,
        kind,
        target,
        outcome,
        ...(skip === undefined ? {} : { skip }),
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
