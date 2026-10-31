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
  "command.internal",
] as const

export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number]

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
