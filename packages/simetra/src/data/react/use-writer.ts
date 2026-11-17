import { useSyncExternalStore } from "react"
import { closedWriter, writerOf, type DataWriter } from "../data-writer"
import { useHolder } from "./provider"

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
  return runtime === undefined
    ? closedWriter(reason ?? "disposed")
    : writerOf(runtime)
}
