import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({}) }))

import { LoginView } from "../src/login-view"
import type { HostScope } from "../src/host-scope"

const scope = {} as HostScope

function html(methods: Parameters<typeof LoginView>[0]["methods"]) {
  return renderToString(createElement(LoginView, { scope, methods }))
}

describe("LoginView", () => {
  it("shows only the password form for password only", () => {
    const out = html({ password: true, emailCode: false, providers: [] })
    expect(out).toContain('data-method="password"')
    expect(out).not.toContain('data-method="email-code"')
    expect(out).not.toContain("data-provider")
  })

  it("shows the first step of the code (address, no code field) and provider buttons", () => {
    const out = html({
      password: false,
      emailCode: true,
      providers: ["google", "github"],
    })
    expect(out).not.toContain('data-method="password"')
    expect(out).toContain('data-method="email-code"')
    expect(out).toContain('name="email"')
    expect(out).not.toContain('name="code"')
    expect(out).toContain('data-provider="google"')
    expect(out).toContain('data-provider="github"')
  })
})
