import { runtimeHandleOf } from "./runtime/handle"
import type { DataRuntime } from "./runtime/runtime"
import type { CoreSession } from "./store/core"
import type { UpdateOptions } from "./store/overlay"
import type { Key, Mutation, ObjectName, Values } from "./store/types"

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

/**
 * Builds the writer of a core; `createDataRuntime` calls it once and keeps
 * the writer in the runtime handle.
 */
export function createWriter(core: CoreSession): DataWriter {
  return Object.freeze({
    update: (object, id, values, options) =>
      core.update(object, id, values, options),
  } satisfies DataWriter)
}

/** The writer of a runtime made by `createDataRuntime`. */
export function writerOf(runtime: DataRuntime): DataWriter {
  // Writer живе в хендлі, а не в мапі цього модуля: хук `simetra/data/react`
  // бере той самий об'єкт через хендл, не тягнучи журнал у спільний чанк.
  return runtimeHandleOf(runtime).writer
}
