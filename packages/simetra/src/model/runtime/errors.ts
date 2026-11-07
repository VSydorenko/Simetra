import type { MetadataRef } from "../schemas/metadata-ref"
import type { ObjectOperation } from "./operation"

/** Error codes a command or the runtime factory reports (P4 spec §6.10). */
export const COMMAND_ERROR_CODES = [
  "command.forbidden",
  "command.conflict",
  "command.invalid",
  "command.constraint",
  "command.context",
  "command.unauthenticated",
  "command.rejected",
  "command.nested",
  "command.depth",
  "command.retry-exhausted",
  "command.model-mismatch",
  "command.read-role-missing",
  "command.unavailable",
  "command.timeout",
  "command.busy",
  "command.stale-client",
  "command.internal",
] as const

export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number]

/**
 * `reason` values of the envelope and size limits (P4-B spec §4.5): a schema
 * issue carries one in `params.reason`, and T3 moves it into `CommandError`.
 */
export const LIMIT_REASONS = {
  /** A batch longer than `BATCH_MAX`. */
  batchTooLarge: "batch-too-large",
  /** A tabular section array longer than `TABULAR_LINES_MAX`. */
  tabularTooLarge: "tabular-too-large",
  /** A value over its attribute's `maxBytes`. */
  tooLarge: "too-large",
  /** A request body over `PAYLOAD_MAX_BYTES`. */
  payloadTooLarge: "payload-too-large",
  /** A response over `RESPONSE_BUDGET_BYTES` that cannot be cut. */
  responseTooLarge: "response-too-large",
  /** The session changed between the client's request and the server. */
  sessionChanged: "session-changed",
  /** A request from an origin the handler does not accept. */
  origin: "origin",
  /** A client request after its data runtime was disposed (`command.unavailable`). */
  disposed: "disposed",
} as const

/**
 * An error as the outside sees it: a code and fields, never Postgres text.
 */
export interface CommandError {
  code: CommandErrorCode
  reason?: string
  object?: MetadataRef
  operation?: ObjectOperation
  /** Logical path of the offending input. */
  path?: string
  detail?: string
  currentVersion?: number
  kind?: "notNull" | "unique" | "check"
  /** Logical attributes of the violated constraint. */
  attributes?: string[]
  hashes?: { catalog: string; applied: string | null }
  role?: string
}

/**
 * The rejection of `run` and `read`: `message` is the error code, no
 * `cause` — текст Postgres не має виходити назовні навіть через ланцюжок
 * причин (Р-A3-8).
 */
export class CommandFailure extends Error {
  readonly error: CommandError

  constructor(error: CommandError) {
    super(error.code)
    this.name = "CommandFailure"
    this.error = error
  }
}
