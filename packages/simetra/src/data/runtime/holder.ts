import type { CloseReason } from "../store/types"
import type { DataRuntime, DataSnapshot } from "./runtime"

/**
 * The public holder of the runtime a host's hooks read (P4-B spec §6.4). It
 * lives outside `react`, so a server consumer builds and swaps runtimes
 * without the peer.
 */
export interface RuntimeHolder {
  /** The held runtime; `undefined` before the first one and after a close. */
  current(): DataRuntime | undefined
  /**
   * Why the holder holds no runtime (`replace(undefined, reason)`); `undefined`
   * while it holds one, or before the first.
   */
  closed(): CloseReason | undefined
  /**
   * Swaps the runtime (sign-out, subject change, an SSR snapshot of another
   * `subject`): the previous one is disposed if still alive, then the
   * listeners run, so a mounted hook moves to `next` without the rows of the
   * previous runtime. `next === undefined` leaves the holder closed with
   * `reason` (default `signed-out`); with a runtime `reason` is ignored.
   */
  replace(next: DataRuntime | undefined, reason?: CloseReason): void
  /**
   * Builds the runtime of the snapshot's subject with `create`, hydrates it
   * and swaps it in (P4-B spec §6.6). The runtime `create` returns must have
   * that `subject` and must be a new live runtime (not the held one, not a
   * disposed one): otherwise `TypeError` and the held runtime is untouched.
   * On any refusal after `create` the new runtime is disposed before the
   * error leaves. The host then calls `endHydration()` of the new runtime.
   */
  hydrateFrom(
    snapshot: DataSnapshot,
    create: (subject: string) => DataRuntime
  ): void
  /** Subscribes to swaps; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/** Creates a runtime holder, optionally with its first runtime. */
export function createRuntimeHolder(initial?: DataRuntime): RuntimeHolder {
  let current = initial
  let closed: CloseReason | undefined
  const listeners = new Set<() => void>()
  const holder: RuntimeHolder = {
    current: () => current,
    closed: () => closed,
    replace(next, reason = "signed-out") {
      const previous = current
      current = next
      closed = next === undefined ? reason : undefined
      // Попередній рантайм закривається до сповіщення: слухач не повинен
      // встигнути знову прочитати з нього.
      if (previous !== undefined && previous !== next) previous.dispose()
      for (const listener of [...listeners]) listener()
    },
    hydrateFrom(snapshot, create) {
      const subject = (snapshot as { meta?: { subject?: unknown } } | null)
        ?.meta?.subject
      if (typeof subject !== "string")
        throw new TypeError("snapshot: meta is malformed")
      const next = create(subject)
      // Уже тримаємий або закритий рантайм не гідрується: інакше catch нижче
      // закрив би живий рантайм холдера, а replace не змінив би нічого.
      if (next === current)
        throw new TypeError("snapshot: create returned the held runtime")
      if (next.disposed)
        throw new TypeError("snapshot: create returned a disposed runtime")
      try {
        if (next.subject !== subject)
          throw new TypeError(
            "snapshot: the created runtime has another subject"
          )
        next.hydrate(snapshot)
      } catch (error) {
        next.dispose()
        throw error
      }
      holder.replace(next)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return holder
}
