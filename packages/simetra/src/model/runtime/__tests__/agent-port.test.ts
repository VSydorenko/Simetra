import { describe, expect, it } from "vitest"
import { agentTokenInfoSchema } from "../agent-port"

const valid = {
  sub: "user-1",
  isAnonymous: false,
  clientId: "client-1",
  aud: ["https://app.example/mcp"],
}

describe("agentTokenInfoSchema", () => {
  it("accepts a valid info with and without pin", () => {
    expect(agentTokenInfoSchema.safeParse(valid).success).toBe(true)
    const pin = "0197f3a0-0000-4000-8000-000000000001"
    expect(agentTokenInfoSchema.parse({ ...valid, pin }).pin).toBe(pin)
  })

  it("rejects an empty sub", () => {
    expect(agentTokenInfoSchema.safeParse({ ...valid, sub: "" }).success).toBe(
      false
    )
  })

  it("rejects aud that is not an array", () => {
    expect(
      agentTokenInfoSchema.safeParse({
        ...valid,
        aud: "https://app.example/mcp",
      }).success
    ).toBe(false)
  })

  it("rejects a pin that is not a UUID", () => {
    expect(
      agentTokenInfoSchema.safeParse({ ...valid, pin: "not-a-uuid" }).success
    ).toBe(false)
  })

  it("drops extra fields so the port cannot carry claims through", () => {
    const parsed = agentTokenInfoSchema.parse({ ...valid, scope: "x", act: {} })
    expect(parsed).toEqual(valid)
  })
})
