import { describe, expect, it, vi } from "vitest"

vi.mock("../src/server/data-fn", () => ({ dataFn: vi.fn() }))

import { withStartRefusal } from "../src/data-transport"

const REQUEST = { subject: "u", request: { type: "read", items: [] } } as never
const OK = { ok: true, value: 1, serverHash: "h" }

describe("withStartRefusal", () => {
  it("passes a response through", async () => {
    const transport = withStartRefusal(async () => OK as never, "h")
    expect(await transport(REQUEST)).toEqual(OK)
  })

  it("maps the bare 403 of Start to a coded origin refusal", async () => {
    const transport = withStartRefusal(async () => {
      throw new Error("Forbidden")
    }, "hash")
    expect(await transport(REQUEST)).toEqual({
      ok: false,
      error: { code: "command.forbidden", reason: "origin" },
      serverHash: "hash",
    })
  })

  it("does not swallow other failures", async () => {
    const transport = withStartRefusal(async () => {
      throw new Error("boom")
    }, "h")
    await expect(transport(REQUEST)).rejects.toThrow("boom")
  })
})
