import {
  COMMAND_ERROR_CODES,
  type CommandError,
  type CommandFailure,
} from "simetra/model"

/** The catalog's own error codes, next to the `CommandError` codes of T0. */
export const CATALOG_ERROR_CODES = [
  "catalog.invalid-input",
  "catalog.unknown-tool",
  "catalog.unknown-object",
  "catalog.rights-write-refused",
  "catalog.result-too-large",
] as const

/** The closed set of codes an agent tool result may carry. */
export const AGENT_ERROR_CODES = [
  ...COMMAND_ERROR_CODES,
  ...CATALOG_ERROR_CODES,
] as const

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number]

/**
 * The next step for an agent: `retry` — the same call may work later;
 * `ask_user` — a human has to decide or fix something; `fix_input` — change
 * the call and send it again.
 */
export type AgentOutcome = "retry" | "ask_user" | "fix_input"

// Повне відображення за кодом: новий код не компілюється без рядка, тож
// агент ніколи не отримає помилку без наступного кроку.
/** The outcome of every error code. */
export const AGENT_OUTCOMES: Readonly<Record<AgentErrorCode, AgentOutcome>> = {
  "command.forbidden": "ask_user",
  "command.conflict": "fix_input",
  "command.invalid": "fix_input",
  "command.constraint": "fix_input",
  "command.context": "fix_input",
  "command.unauthenticated": "ask_user",
  "command.rejected": "fix_input",
  "command.nested": "fix_input",
  "command.depth": "fix_input",
  "command.retry-exhausted": "retry",
  "command.model-mismatch": "ask_user",
  "command.read-role-missing": "ask_user",
  "command.privileged-login": "ask_user",
  "command.unavailable": "retry",
  "command.timeout": "retry",
  "command.busy": "retry",
  "command.stale-client": "retry",
  "command.internal": "ask_user",
  "catalog.invalid-input": "fix_input",
  "catalog.unknown-tool": "fix_input",
  "catalog.unknown-object": "fix_input",
  "catalog.rights-write-refused": "ask_user",
  "catalog.result-too-large": "fix_input",
}

const HINTS: Readonly<Record<AgentErrorCode, string>> = {
  "command.forbidden":
    "The current user may not do this. Ask the user to get the permission or to choose another action.",
  "command.conflict":
    "The row changed since it was read. Read it again and resend with its current version.",
  "command.invalid":
    "The input is invalid. Check the field named in the error against describe and resend.",
  "command.constraint":
    "A database constraint refused the change. Change the value named in the error and resend.",
  "command.context":
    "The command is not allowed in this context. Check the object and the scope in the input.",
  "command.unauthenticated":
    "There is no signed-in user. Ask the user to sign in again.",
  "command.rejected":
    "A rule of the application refused the change. Read the error detail and change the input.",
  "command.nested":
    "A nested command was refused. Simplify the batch and resend.",
  "command.depth":
    "The command nests too deeply. Split the work into smaller batches.",
  "command.retry-exhausted":
    "The change kept conflicting with concurrent work. Retry the call later.",
  "command.model-mismatch":
    "The database does not match the application model. Ask the user to update the database.",
  "command.read-role-missing":
    "The database role for reading is missing. Ask the user to set up the database roles.",
  "command.privileged-login":
    "The server connects with a role that is too privileged. Ask the user to fix the connection.",
  "command.unavailable": "The service is not available now. Retry later.",
  "command.timeout": "The call took too long. Retry, or narrow the request.",
  "command.busy": "The service is busy. Retry in a moment.",
  "command.stale-client":
    "The catalog is out of date. Call describe again, then retry.",
  "command.internal":
    "An internal error occurred. Ask the user to check the server log.",
  "catalog.invalid-input":
    "The input does not match the tool schema. Fix the field named in path and resend.",
  "catalog.unknown-tool": "There is no such tool. Use one of the listed tools.",
  "catalog.unknown-object":
    "There is no such object. Call describe without arguments to list the objects.",
  "catalog.rights-write-refused":
    "This tool may not change rights. Ask the user to change them in the application.",
  "catalog.result-too-large":
    "The result is too large for one answer. Narrow the request: fewer fields, tabular sections or a smaller limit.",
}

/** An error result of a tool: always with `hint` and `outcome`. */
export interface AgentToolError {
  code: AgentErrorCode
  message: string
  hint: string
  outcome: AgentOutcome
  /** Logical path of the offending input (`catalog.invalid-input`). */
  path?: string
  /** The runtime's error, intact (`command.*` codes). */
  error?: CommandError
}

/** An error result with the `hint` and `outcome` of its code. */
export function agentError(
  code: AgentErrorCode,
  message: string,
  extra: { path?: string; error?: CommandError } = {}
): AgentToolError {
  return {
    code,
    message,
    hint: HINTS[code],
    outcome: AGENT_OUTCOMES[code],
    ...(extra.path === undefined ? {} : { path: extra.path }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
  }
}

/** The error result of a runtime failure; its `CommandError` is carried intact. */
export function failureError(failure: CommandFailure): AgentToolError {
  const e = failure.error
  const where = [
    e.object === undefined ? undefined : `${e.object.kind}.${e.object.name}`,
    e.path,
  ].filter((part) => part !== undefined)
  const message = [
    e.code,
    e.reason === undefined ? undefined : `(${e.reason})`,
    where.length === 0 ? undefined : `at ${where.join(" ")}`,
    e.detail === undefined ? undefined : `: ${e.detail}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ")
  return agentError(e.code, message, { error: e })
}
