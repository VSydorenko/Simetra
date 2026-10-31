import type { CommandError } from "simetra/model"

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
