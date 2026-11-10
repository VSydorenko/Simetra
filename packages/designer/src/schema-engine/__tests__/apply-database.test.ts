import {
  ApplyConnectionLost,
  ApplyDbError,
  ENGINE_SESSION_TIMEOUTS,
} from "simetra/schema"
import { describe, expect, it } from "vitest"
import { normalize, STATEMENT_PRELUDE } from "../apply-database"

/** Помилка сервера в формі, яку кидає `pg`: SQLSTATE в `code` і поля діагностики. */
function serverError(code: string, fields: Record<string, unknown> = {}) {
  return Object.assign(new Error("server refused"), { code, ...fields })
}

describe("apply database error normalization", () => {
  it("normalize keeps detail, column, constraint and table", () => {
    const error = normalize(
      serverError("23502", {
        detail: "Failing row contains (1).",
        column: "title",
        constraint: "items_title_not_null",
        table: "items",
      })
    )
    expect(error).toBeInstanceOf(ApplyDbError)
    expect(error).toMatchObject({
      sqlstate: "23502",
      detail: "Failing row contains (1).",
      column: "title",
      constraint: "items_title_not_null",
      table: "items",
    })
  })

  it("leaves fields the server did not send undefined", () => {
    // `pg` кладе в поле null, коли сервер його не надіслав
    const error = normalize(
      serverError("42501", { detail: "escalation", column: null })
    ) as ApplyDbError
    expect(error.detail).toBe("escalation")
    expect(error.column).toBeUndefined()
    expect(error.constraint).toBeUndefined()
    expect(error.table).toBeUndefined()
  })

  it("keeps a connection loss free of the server fields", () => {
    expect(normalize(serverError("08006", { detail: "x" }))).toBeInstanceOf(
      ApplyConnectionLost
    )
  })
})

describe("statement prelude", () => {
  it("resets every engine session timeout on the session", () => {
    for (const guc of ENGINE_SESSION_TIMEOUTS)
      expect(STATEMENT_PRELUDE).toContain(`SET ${guc} = 0`)
  })
})
