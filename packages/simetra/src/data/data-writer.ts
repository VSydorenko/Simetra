import { runtimeHandleOf } from "./runtime/handle"
import type { DataRuntime } from "./runtime/runtime"
import { closedMutation, type UpdateOptions } from "./store/overlay"
import type {
  CloseReason,
  Key,
  Mutation,
  ObjectName,
  Values,
} from "./store/types"

/**
 * The write API of the data runtime (P4-B spec §7.1). Each call is one
 * mutation in the journal and one `run`; the thin M3 slice has `update`
 * with the `await` policy only.
 */
export interface DataWriter {
  /**
   * Sends the changed attributes of one row with `expectedVersion`, the
   * confirmed version the edit is based on. The shown row keeps its values
   * until the answer and has the state `pending`; `settled` resolves when
   * the attempt settles and never rejects. Throws synchronously, before the
   * transport: `TypeError` for a name outside the catalog, `DataError`
   * `data.version-required`, `data.mutation-pending` (the key has a
   * `pending` mutation), `data.journal-full`. An update of a key with a
   * `failed`, `conflict` or `unknown` mutation replaces it.
   */
  update(
    object: ObjectName,
    id: Key,
    values: Values,
    options: UpdateOptions
  ): Mutation
}

// Один writer на рантайм: хук і host отримують той самий об'єкт.
const writers = new WeakMap<DataRuntime, DataWriter>()

/** The writer of a runtime made by `createDataRuntime`. */
export function writerOf(runtime: DataRuntime): DataWriter {
  let writer = writers.get(runtime)
  if (writer === undefined) {
    const { core } = runtimeHandleOf(runtime)
    writer = Object.freeze({
      update: (object, id, values, options) =>
        core.update(object, id, values, options),
    } satisfies DataWriter)
    writers.set(runtime, writer)
  }
  return writer
}

const closedWriters = new Map<CloseReason, DataWriter>()

/**
 * The writer of a holder without a runtime: every mutation settles with the
 * close reason and is never sent.
 */
export function closedWriter(reason: CloseReason): DataWriter {
  let writer = closedWriters.get(reason)
  if (writer === undefined) {
    writer = Object.freeze({ update: () => closedMutation(reason) })
    closedWriters.set(reason, writer)
  }
  return writer
}
