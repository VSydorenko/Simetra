import { describe, expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"
import { createElement } from "react"
import { codedError, errorCode, sanitizeMatchErrors } from "../src/host-errors"
import { RootError } from "../src/root-view"

const SECRET = 'connection to "db.internal.example" role simetra_runtime failed'

describe("errorCode", () => {
  it("takes a code from `code` or from a message that is a code", () => {
    expect(errorCode({ code: "data.full-too-large", message: SECRET })).toBe(
      "data.full-too-large"
    )
    expect(errorCode(new Error("command.unavailable"))).toBe(
      "command.unavailable"
    )
  })

  it("everything else is the generic code, never the text", () => {
    for (const error of [
      new Error(SECRET),
      SECRET,
      { code: SECRET },
      { code: "ECONNREFUSED" },
      null,
      undefined,
    ]) {
      expect(errorCode(error)).toBe("command.internal")
    }
  })
})

describe("sanitizeMatchErrors", () => {
  it("replaces the error with a code-only one and logs the original", () => {
    const original = new Error(SECRET)
    const match: { error?: unknown } = { error: original }
    const log = vi.fn()
    sanitizeMatchErrors([match, {}], log)
    expect(log).toHaveBeenCalledExactlyOnceWith(original)
    expect(match.error).toBeInstanceOf(Error)
    expect((match.error as Error).message).toBe("command.internal")
    expect(JSON.stringify(match.error)).not.toContain("db.internal")
  })

  it("keeps the code of a coded error and a non-Error value gets a code too", () => {
    const coded: { error?: unknown } = { error: { code: "command.forbidden" } }
    const thrownString: { error?: unknown } = { error: SECRET }
    sanitizeMatchErrors([coded, thrownString], () => undefined)
    expect((coded.error as Error).message).toBe("command.forbidden")
    expect((thrownString.error as Error).message).toBe("command.internal")
  })

  it("a second pass over an already coded error logs nothing", () => {
    const match: { error?: unknown } = { error: codedError("command.internal") }
    const log = vi.fn()
    sanitizeMatchErrors([match], log)
    expect(log).not.toHaveBeenCalled()
  })
})

describe("RootError", () => {
  it("shows the code and never the message", () => {
    const html = renderToString(
      createElement(RootError, {
        error: new Error(SECRET),
        reset: () => undefined,
      })
    )
    expect(html).toContain("command.internal")
    expect(html).not.toContain("db.internal")
    expect(html).not.toContain("simetra_runtime")
  })
})
