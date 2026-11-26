import { afterEach, describe, expect, it, vi } from "vitest"
import { mailTransport } from "../src/server/mail-dev"
import { appMailTransport } from "../src/server/mail"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("mail port (Р-D5-5)", () => {
  it("the template app has no transport", () => {
    expect(appMailTransport()).toBeUndefined()
  })

  it("outside production the letter goes to the process log", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const transport = mailTransport()
    expect(transport).toBeDefined()
    await transport?.send({ to: "a@b.test", subject: "Code", text: "123456" })
    const logged = String(info.mock.calls[0]?.[0])
    expect(logged).toContain("a@b.test")
    expect(logged).toContain("123456")
  })

  it("in production there is no fallback transport", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(mailTransport()).toBeUndefined()
  })
})
