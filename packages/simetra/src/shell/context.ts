import type { RuntimeHolder } from "simetra/data"

/**
 * The router context the simetra routes read (P4-D spec §6). The router
 * factory of the app puts the holder of the request's runtime here; `null`
 * means there is no runtime (an anonymous request), so a loader loads nothing.
 */
export interface SimetraRouterContext {
  data: RuntimeHolder | null
}
