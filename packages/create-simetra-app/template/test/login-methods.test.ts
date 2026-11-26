import { afterEach, describe, expect, it, vi } from "vitest"
import { authSettings } from "../src/server/config"
import { loginMethodsOf } from "../src/server/login-methods"

afterEach(() => vi.unstubAllEnvs())

describe("loginMethodsOf", () => {
  it("carries exactly the three public keys and no provider secrets", () => {
    vi.stubEnv("SIMETRA_SIGN_IN_METHODS", "password,email-code,google")
    vi.stubEnv("SIMETRA_OAUTH_GOOGLE_CLIENT_ID", "client-id-value")
    vi.stubEnv("SIMETRA_OAUTH_GOOGLE_CLIENT_SECRET", "client-secret-value")

    const methods = loginMethodsOf(authSettings())

    expect(Object.keys(methods).sort()).toEqual([
      "emailCode",
      "password",
      "providers",
    ])
    expect(methods).toEqual({
      password: true,
      emailCode: true,
      providers: ["google"],
    })
    expect(JSON.stringify(methods)).not.toContain("client-")
  })

  it("defaults to password only", () => {
    vi.stubEnv("SIMETRA_SIGN_IN_METHODS", undefined)
    expect(loginMethodsOf(authSettings())).toEqual({
      password: true,
      emailCode: false,
      providers: [],
    })
  })
})
