import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/server/data-fn", () => ({ dataFn: vi.fn() }))

import { app } from "../src/app"
import { createHostScope } from "../src/host-scope"
import {
  requestEmailCode,
  signIn,
  signInWithEmailCode,
  signInWithProvider,
  signOut,
} from "../src/session-actions"

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

  it("tells the other tabs which subject signed out, after the holder is closed", async () => {
    const posted: unknown[] = []
    const scope = createHostScope({
      toLogin: vi.fn(),
      onResponseEnd: vi.fn(),
      markHydrated: vi.fn(),
      establish: () => Promise.resolve(),
      createChannel: () => ({
        onmessage: null,
        postMessage: (message) => {
          // Вкладка вже без рантайму, коли шина повідомляє решту
          expect(scope.holder.current()).toBeUndefined()
          posted.push(message)
        },
        close: vi.fn(),
      }),
    })
    scope.holder.replace(runtimeOf("user-a"))
    stubFetch(Response.json({ success: true }))
    await signOut(scope)
    expect(posted).toEqual([{ type: "signed-out", subject: "user-a" }])
  })

  it("publishes nothing when the server refused the sign-out", async () => {
    const createChannel = vi.fn()
    const scope = createHostScope({
      toLogin: vi.fn(),
      onResponseEnd: vi.fn(),
      markHydrated: vi.fn(),
      establish: () => Promise.resolve(),
      createChannel,
    })
    const runtime = runtimeOf("user-a")
    scope.holder.replace(runtime)
    stubFetch(new Response("no", { status: 500 }))
    await signOut(scope)
    expect(createChannel).not.toHaveBeenCalled()
    runtime.dispose()
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

describe("requestEmailCode", () => {
  it("posts the address with type sign-in", async () => {
    const fetchMock = stubFetch(Response.json({ success: true }))
    expect(await requestEmailCode("a@e2e.test")).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/email-otp/send-verification-otp",
      expect.objectContaining({
        body: JSON.stringify({ email: "a@e2e.test", type: "sign-in" }),
      })
    )
  })

  it.each([
    [429, "command.rate-limited"],
    [400, "command.forbidden"],
    [500, "command.internal"],
  ])("status %i gives %s", async (status, code) => {
    stubFetch(new Response("x", { status }))
    expect(await requestEmailCode("a@e2e.test")).toEqual({ ok: false, code })
  })
})

describe("signInWithEmailCode", () => {
  it("replaces the runtime like the password sign-in", async () => {
    const scope = newScope()
    const fetchMock = stubFetch(Response.json({ user: { id: "USER-C" } }))
    expect(await signInWithEmailCode(scope, "c@e2e.test", "123456")).toEqual({
      ok: true,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/sign-in/email-otp",
      expect.objectContaining({
        body: JSON.stringify({ email: "c@e2e.test", otp: "123456" }),
      })
    )
    expect(scope.holder.current()?.subject).toBe("user-c")
    scope.holder.current()?.dispose()
  })

  it("429 gives command.rate-limited and leaves the holder alone", async () => {
    const scope = newScope()
    stubFetch(new Response("x", { status: 429 }))
    expect(await signInWithEmailCode(scope, "c@e2e.test", "1")).toEqual({
      ok: false,
      code: "command.rate-limited",
    })
    expect(scope.holder.current()).toBeUndefined()
  })
})

describe("signInWithProvider", () => {
  it("navigates to the url the server returned", async () => {
    const navigate = vi.fn()
    stubFetch(Response.json({ url: "https://idp.test/auth", redirect: true }))
    expect(await signInWithProvider("google", navigate)).toEqual({ ok: true })
    expect(navigate).toHaveBeenCalledWith("https://idp.test/auth")
  })

  it("a refusal does not navigate", async () => {
    const navigate = vi.fn()
    stubFetch(new Response("x", { status: 429 }))
    expect(await signInWithProvider("google", navigate)).toEqual({
      ok: false,
      code: "command.rate-limited",
    })
    expect(navigate).not.toHaveBeenCalled()
  })
})
