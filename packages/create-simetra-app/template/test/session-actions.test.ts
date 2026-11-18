import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/server/data-fn", () => ({ dataFn: vi.fn() }))

import { app } from "../src/app"
import { createHostScope } from "../src/host-scope"
import { signIn, signOut } from "../src/session-actions"

afterEach(() => vi.unstubAllGlobals())

function newScope() {
  return createHostScope({
    toLogin: vi.fn(),
    onResponseEnd: vi.fn(),
    markHydrated: vi.fn(),
    establish: () => Promise.resolve(),
  })
}

function runtimeOf(subject: string) {
  return app.createRuntime({
    subject,
    transport: () => Promise.reject(new Error("no network in this test")),
    visible: true,
  })
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn(() => Promise.resolve(response))
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("document", { hidden: false })
  return fetchMock
}

describe("signIn", () => {
  it("replaces the runtime of a live session with the runtime of the new subject, lower-cased", async () => {
    const scope = newScope()
    const before = runtimeOf("user-a")
    scope.holder.replace(before)
    stubFetch(Response.json({ user: { id: "USER-B" } }))

    expect(await signIn(scope, "b@e2e.test", "pw")).toEqual({ ok: true })

    expect(before.disposed).toBe(true)
    expect(scope.holder.current()?.subject).toBe("user-b")
    scope.holder.current()?.dispose()
  })

  it("leaves the holder alone on a refusal and returns the code only", async () => {
    const scope = newScope()
    const before = runtimeOf("user-a")
    scope.holder.replace(before)
    stubFetch(Response.json({ message: "secret text" }, { status: 401 }))

    expect(await signIn(scope, "b@e2e.test", "bad")).toEqual({
      ok: false,
      code: "command.forbidden",
    })
    expect(scope.holder.current()).toBe(before)
    before.dispose()
  })
})

describe("signIn with a malformed success body", () => {
  it("a non-JSON 2xx gives command.internal and leaves the holder alone", async () => {
    const scope = newScope()
    const before = runtimeOf("user-a")
    scope.holder.replace(before)
    stubFetch(new Response("<html>proxy</html>", { status: 200 }))

    expect(await signIn(scope, "b@e2e.test", "pw")).toEqual({
      ok: false,
      code: "command.internal",
    })
    expect(scope.holder.current()).toBe(before)
    before.dispose()
  })
})

describe("signIn refusal codes", () => {
  it.each([
    [500, "command.internal"],
    [503, "command.internal"],
    [429, "command.rate-limited"],
    [401, "command.forbidden"],
  ])("status %i gives %s", async (status, code) => {
    const scope = newScope()
    stubFetch(new Response("x", { status }))
    expect(await signIn(scope, "b@e2e.test", "pw")).toEqual({ ok: false, code })
  })
})

describe("signOut", () => {
  it("closes the holder with signed-out only after the server accepted", async () => {
    const scope = newScope()
    scope.holder.replace(runtimeOf("user-a"))
    stubFetch(Response.json({ success: true }))

    expect(await signOut(scope)).toEqual({ ok: true })
    expect(scope.holder.current()).toBeUndefined()
    expect(scope.holder.closed()).toBe("signed-out")
  })

  it("keeps the runtime when the server refused the sign-out", async () => {
    const scope = newScope()
    const runtime = runtimeOf("user-a")
    scope.holder.replace(runtime)
    stubFetch(new Response("no", { status: 500 }))

    expect(await signOut(scope)).toEqual({
      ok: false,
      code: "command.internal",
    })
    expect(scope.holder.current()).toBe(runtime)
    runtime.dispose()
  })
})
