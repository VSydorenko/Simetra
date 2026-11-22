import { CommandFailure, type VersionValue } from "simetra/model"
import { DataError } from "../errors"
import {
  ReadLimiterClosed,
  type CorePart,
  type CoreReadItem,
  type CoreSource,
  type ReadOptions,
  type StoreSource,
} from "./source"

/** The batcher: a {@link StoreSource} that also knows its queue. */
// Оренди запису видає джерело ядра над збирачем, не сам збирач (§8.4).
export interface Batcher extends Omit<StoreSource, "lease"> {
  /** Whether a `version` part waits in the queue, not sent yet. */
  hasQueuedVersion(): boolean
  /** Whether a `rights` part waits in the queue, not sent yet. */
  hasQueuedRights(): boolean
}

interface Call {
  readonly parts: readonly CorePart[]
  readonly resolve: (items: CoreReadItem[]) => void
  readonly reject: (error: unknown) => void
}

// Відмова відображення запиту: кидається до будь-якого запиту, тож чужий
// пакет можна перечитати без дубля на сервері.
const isMappingRefusal = (error: unknown): boolean =>
  error instanceof DataError ||
  (error instanceof CommandFailure && error.error.code === "command.invalid")

/**
 * Wraps a core source with the read batcher (P4-B spec §6.7): the reads asked
 * for in one synchronous run — the views of one `commit`, a `version` part —
 * go to `source` as one call, so the source makes one request per adapter.
 * The window is one microtask and there is no timer: a read of the next tick
 * is the next call.
 *
 * `run`, `refuse` and `close` go past the queue without a delay. `close()` is
 * synchronous: the parts still queued reject with {@link ReadLimiterClosed}
 * and never reach the source. A part of an object refused while it queued
 * comes out as `command.stale-client` without a request.
 *
 * `onVersion` gets the value of every `version` part of an answer
 * synchronously, before any caller of that answer resumes: the core marks an
 * incompatible object before it can write rows of the same answer.
 * `onRights` does the same for the outcome of a `rights` part, a refusal of
 * the part included: the core sees a changed user before any part of the
 * answer is applied. A request refused as a whole never reaches it (the call
 * rejects).
 */
export function createBatcher(
  source: CoreSource,
  options: {
    /** Passed to every `source.read`: the session's sleep. */
    sleep: ReadOptions["sleep"]
    onRightsSent?: ReadOptions["onRightsSent"]
    onVersion?: (version: VersionValue) => void
    onRights?: (item: CoreReadItem) => void
  }
): Batcher {
  let queue: Call[] = []
  let scheduled = false
  let closed = false
  const refused = new Set<string>()

  const objectOf = (part: CorePart) =>
    part.type === "query" ? part.query.object : undefined
  const isRefused = (part: CorePart): boolean => {
    const object = objectOf(part)
    return object !== undefined && refused.has(`${object.kind}.${object.name}`)
  }

  const run = async (calls: readonly Call[]): Promise<void> => {
    const slots = calls.flatMap((call, at) =>
      call.parts.map((part, slot) => ({ at, slot, part }))
    )
    const sent = slots.filter(({ part }) => !isRefused(part))
    let items: CoreReadItem[] = []
    try {
      if (sent.length > 0) {
        items = (
          await source.read(
            sent.map(({ part }) => part),
            { sleep: options.sleep, onRightsSent: options.onRightsSent }
          )
        ).items
      }
    } catch (error) {
      if (calls.length > 1 && isMappingRefusal(error)) {
        // Один хибний запит не відмовляє чужим читанням того ж такту.
        await Promise.all(calls.map((call) => run([call])))
        return
      }
      for (const call of calls) call.reject(error)
      return
    }
    try {
      // Спершу `rights`: `onVersion` пише в сховище, а знімок (і зміна
      // користувача) мусить бути прийнятий раніше за будь-який запис пакета.
      sent.forEach(({ part }, i) => {
        if (part.type === "rights") options.onRights?.(items[i]!)
      })
      for (const item of items) {
        if (item.ok && "type" in item && item.type === "version") {
          options.onVersion?.(item.version)
        }
      }
    } catch (error) {
      for (const call of calls) call.reject(error)
      return
    }
    const answers = calls.map((call) =>
      call.parts.map((part): CoreReadItem => ({
        ok: false,
        error: { code: "command.stale-client", object: objectOf(part)! },
      }))
    )
    sent.forEach(({ at, slot }, i) => {
      answers[at]![slot] = items[i]!
    })
    calls.forEach((call, at) => call.resolve(answers[at]!))
  }

  const flush = () => {
    scheduled = false
    const calls = queue
    queue = []
    if (calls.length > 0) void run(calls)
  }

  return {
    hasQueuedVersion: () =>
      queue.some((call) => call.parts.some((part) => part.type === "version")),
    hasQueuedRights: () =>
      queue.some((call) => call.parts.some((part) => part.type === "rights")),
    run: (operation) => source.run(operation),
    refuse(object) {
      refused.add(object)
      source.refuse?.(object)
    },
    close() {
      closed = true
      const waiting = queue
      queue = []
      for (const call of waiting) call.reject(new ReadLimiterClosed())
      source.close()
    },
    read(parts) {
      if (closed) return Promise.reject(new ReadLimiterClosed())
      return new Promise((resolve, reject) => {
        queue.push({
          parts,
          resolve: (items) => resolve({ items }),
          reject,
        })
        if (!scheduled) {
          scheduled = true
          queueMicrotask(flush)
        }
      })
    },
  }
}
