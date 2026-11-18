import { useSyncExternalStore } from "react"
import type { DataWriter } from "../data-writer"
import { runtimeHandleOf } from "../runtime/handle"
import { closedMutation } from "../store/closed-mutation"
import { useHolder } from "./provider"
import type { CloseReason } from "../store/types"

const closedWriters = new Map<CloseReason, DataWriter>()

/**
 * The writer of a holder without a runtime: every mutation settles with the
 * close reason and is never sent.
 */
function closedWriter(reason: CloseReason): DataWriter {
  let writer = closedWriters.get(reason)
  if (writer === undefined) {
    writer = Object.freeze({ update: () => closedMutation(reason) })
    closedWriters.set(reason, writer)
  }
  return writer
}

/**
 * The {@link DataWriter} of the runtime the provider's holder holds (P4-B
 * spec §7.1). After `replace` the hook returns the writer of the new
 * runtime; while the holder has none, every mutation settles with the close
 * reason (`disposed` before the first runtime) and is never sent.
 */
export function useWriter(): DataWriter {
  const holder = useHolder()
  const runtime = useSyncExternalStore(
    holder.subscribe,
    holder.current,
    holder.current
  )
  const reason = useSyncExternalStore(
    holder.subscribe,
    holder.closed,
    holder.closed
  )
  // Хендл, а не `writerOf`: модуль writer-а з журналом лишається лише в
  // `simetra/data`, а спільним для обох входів є тільки чанк хендла.
  return runtime === undefined
    ? closedWriter(reason ?? "disposed")
    : runtimeHandleOf(runtime).writer
}
