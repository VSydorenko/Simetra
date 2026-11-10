import type { CatalogIndex, DataRequest } from "simetra/model"
import type { CoreSession } from "../store/core"
import type { DataRuntime } from "./runtime"

/** One request of the runtime: the envelope without `subject`. */
export type RuntimeRequest = DataRequest["request"]

/** The internal handle of a runtime (not public API). */
export interface RuntimeHandle {
  /**
   * The transport wrapper: adds `subject`, refuses a body over
   * `PAYLOAD_MAX_BYTES` and any request after `dispose()` without calling the
   * transport, handles `session-changed`. Resolves with `value`; rejects with
   * a `CommandFailure` carrying the logical error. A transport exception
   * becomes `command.unavailable` without a reason (the original goes to the
   * runtime `log` as a `transport-failed` entry); after `dispose()` every
   * request rejects with `command.unavailable` `disposed`, after
   * `session-changed` — with that error.
   */
  send(request: RuntimeRequest): Promise<unknown>
  /**
   * The core session of the runtime (P4-B spec §6.1); closed by `dispose()`
   * (`disposed`) and by `session-changed`.
   */
  readonly core: CoreSession
  /** The catalog index of the runtime: wire errors of read parts map through it. */
  readonly index: CatalogIndex
}

// Хендл живе в окремому модулі, а не в `runtime.ts`: `runtime.ts` входить у
// публічний `.d.ts` `simetra/data`, а внутрішній хендл у ньому з'являтися не
// повинен (спека §3).
const handles = new WeakMap<DataRuntime, RuntimeHandle>()

/** Binds the handle to a runtime; called once by `createDataRuntime`. */
export function bindRuntimeHandle(
  runtime: DataRuntime,
  handle: RuntimeHandle
): void {
  handles.set(runtime, handle)
}

/** The handle of a runtime made by `createDataRuntime`. */
export function runtimeHandleOf(runtime: DataRuntime): RuntimeHandle {
  const handle = handles.get(runtime)
  if (handle === undefined) {
    throw new Error("not a data runtime made by createDataRuntime")
  }
  return handle
}
