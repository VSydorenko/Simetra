import type { MetadataRef } from "../schemas/metadata-ref"
import type { ObjectOperation } from "./operation"

/** One row changed by a command. */
export interface Change {
  object: MetadataRef
  /** Id of the scope kind label from the runtime catalog. */
  scopeKind?: string
  /** Present only for a scoped object. */
  scope?: string
  id: string
  version: number
  operation: ObjectOperation
}

/** The outcome of a command. */
export interface CommandResult {
  /** One row per input operation, in input order. */
  rows: Record<string, unknown>[]
  /** Every phase, `ctx.run` included, in the order the core was called. */
  changes: Change[]
}
