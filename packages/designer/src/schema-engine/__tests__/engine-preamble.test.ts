import { describe, expect, it } from "vitest"
import { checkPreamble } from "../pg-delta/adapter"

/**
 * Преамбула двигуна проти дозволеного переліку порту: виконавець виставляє
 * лише відоме, тож невідоме має стати діагностикою, а не тихим виконанням.
 */
describe("checkPreamble", () => {
  it("accepts the allowed settings", () => {
    expect(
      checkPreamble([
        { name: "search_path", value: "pg_catalog" },
        { name: "check_function_bodies", value: "off" },
      ])
    ).toEqual([])
  })

  it("reports an unknown setting name", () => {
    const [d, ...rest] = checkPreamble([{ name: "role", value: "postgres" }])
    expect(rest).toEqual([])
    expect(d).toMatchObject({
      code: "engine.preamble-unknown",
      severity: "error",
      params: { name: "role", value: "postgres" },
    })
  })

  it("reports a known name with an unexpected value", () => {
    const [d] = checkPreamble([{ name: "search_path", value: "app, public" }])
    expect(d).toMatchObject({
      code: "engine.preamble-unknown",
      params: { name: "search_path", value: "app, public" },
    })
  })
})
