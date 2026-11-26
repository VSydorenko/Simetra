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
  "command.privileged-login",
  "command.unavailable",
  "command.timeout",
  "command.busy",
  "command.stale-client",
  "command.internal",
] as const

export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number]

/**
 * `reason` values a `CommandError` carries for envelope and size limits
 * (P4-B spec §4.5), session changes and refused origins. Most come from a
 * schema issue's `params.reason`, which T3 moves into `CommandError`;
 * `sessionChanged` and `origin` are set by the handler directly. `disposed`
 * is client-only: the data runtime sets it locally and it is never on the
 * wire (P4-B spec §7.3).
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
 * `reason` values a `command.invalid` carries for a value its attribute's
 * type refuses beyond the type itself (multilingual data spec §5.7). The place
 * inside the value stays out of the error: the client gets it from the T0
 * check itself (`checkRichText`).
 */
export const VALUE_REASONS = {
  /** A `RichText` value outside `RICH_TEXT_PROFILE`, or nested too deep. */
  richTextProfile: "rich-text-profile",
} as const

/**
 * `reason` values of `command.privileged-login`: the fact through which the
 * login role of the runtime (`session_user`, itself or through any
 * membership) reaches a power the runtime must not hold (postgres profile
 * spec §4.2, "trust boundary"). When several facts hold, the reason is the
 * first in this order.
 */
export const PRIVILEGED_LOGIN_REASONS = {
  /** The owner of the platform schema or the owner role of the profile. */
  owner: "owner",
  /** A role with `SUPERUSER`. */
  superuser: "superuser",
  /** A role with `BYPASSRLS`. */
  bypassRls: "bypassrls",
  /** A role with `CREATEROLE`. */
  createRole: "createrole",
  /** `pg_execute_server_program`, `pg_read_server_files` or `pg_write_server_files`. */
  serverFiles: "server-files",
  /** `pg_read_all_data`: reads every table, past grants and RLS. */
  readAllData: "read-all-data",
  /** `pg_write_all_data`: writes every table, past grants and RLS. */
  writeAllData: "write-all-data",
  /** `pg_database_owner`: the login owns the current database. */
  databaseOwner: "database-owner",
  /** A login role of the provider (`PROVIDER_LOGIN_ROLES`). */
  providerLogin: "provider-login",
  /** The service role of the profile (`PROVIDER_API_ROLES[provider].service`). */
  service: "service",
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
 * причин.
 */
export class CommandFailure extends Error {
  readonly error: CommandError

  constructor(error: CommandError) {
    super(error.code)
    this.name = "CommandFailure"
    this.error = error
  }
}
