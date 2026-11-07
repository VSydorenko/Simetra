import type { QueryClient } from "@tanstack/query-core"
import type { DataRequest } from "simetra/model"
import type { DataRuntime } from "./runtime"

/** One request of the runtime: the envelope without `subject`. */
export type RuntimeRequest = DataRequest["request"]

/** The internal handle of a runtime for the facade (not public API). */
export interface Facade {
  readonly queryClient: QueryClient
  /** `["simetra", subject, nonce]`: every query key of the runtime starts with it. */
  readonly keyPrefix: readonly ["simetra", string, string]
  /**
   * The transport wrapper: adds `subject`, refuses a body over
   * `PAYLOAD_MAX_BYTES` and any request after `dispose()` without calling the
   * transport, handles `session-changed`. Resolves with `value`; rejects with
   * a `CommandFailure` carrying the logical error.
   */
  send(request: RuntimeRequest): Promise<unknown>
}

// Хендл живе в окремому модулі, а не в `runtime.ts`: збирач `.d.ts` лишає
// імпорт `@tanstack/query-core` модуля, що згадує `QueryClient` у типах,
// навіть коли сам тип відкинуто, — а `runtime.ts` входить у публічний
// `.d.ts` `simetra/data`, який `@tanstack/*` не згадує (спека §3).
const facades = new WeakMap<DataRuntime, Facade>()

/** Binds the facade handle to a runtime; called once by `createDataRuntime`. */
export function bindFacade(runtime: DataRuntime, facade: Facade): void {
  facades.set(runtime, facade)
}

/** The facade handle of a runtime made by `createDataRuntime`. */
export function facadeOf(runtime: DataRuntime): Facade {
  const facade = facades.get(runtime)
  if (facade === undefined) {
    throw new Error("not a data runtime made by createDataRuntime")
  }
  return facade
}
