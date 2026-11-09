/**
 * Codes of a developer error in T4 (P4-B spec §6, §7): a misuse of the data
 * runtime, not a refusal of the server — those come as `CommandFailure`.
 */
export type DataErrorCode =
  | "data.unsupported-predicate"
  | "data.version-required"
  | "data.tabular-incomplete"
  | "data.full-too-large"
  | "data.views-limit"

/** A developer error of the data runtime; `message` defaults to the code. */
export class DataError extends Error {
  readonly code: DataErrorCode

  constructor(code: DataErrorCode, message: string = code) {
    super(message)
    this.name = "DataError"
    this.code = code
  }
}
