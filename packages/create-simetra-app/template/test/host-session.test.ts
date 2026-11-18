import { afterEach, describe, expect, it, vi } from "vitest"
import type { DataRuntimeOptions } from "simetra/data"

vi.mock("../src/server/data-fn", () => ({ dataFn: vi.fn() }))

import { app } from "../src/app"
import { createHostScope, type AppRouterContext } from "../src/host-scope"
import {
  createClientRuntime,
  establishServerSession,
  clientContext,
} from "../src/host-session"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function newScope() {
  const toLogin = vi.fn()
  const endActions: Array<() => void> = []
  const scope = createHostScope({
    toLogin,
    onResponseEnd: (action) => void endActions.push(action),
    markHydrated: vi.fn(),
    establish: () => Promise.resolve(),
  })
  const context: AppRouterContext = { data: null, host: scope }
  return { scope, context, toLogin, endActions }
}

const NO_NETWORK = () => Promise.reject(new Error("no network in this test"))

/** Опції, з якими host створив рантайм: перехоплено, а не вгадано. */
function captureOptions() {
  const captured: Array<Omit<DataRuntimeOptions, "catalog">> = []
  const create = app.createRuntime.bind(app)
  vi.spyOn(app, "createRuntime").mockImplementation((options) => {
    captured.push(options)
    return create(options)
  })
  return captured
}

describe("establishServerSession", () => {
  it("makes a runtime of the session subject, invisible, with the options of §4.6", () => {
    const options = captureOptions()
    const { scope, context } = newScope()
    const transport = vi.fn()
    establishServerSession(scope, context, { sub: "user-a" }, (claims) => {
      transport(claims)
      return NO_NETWORK
    })
    expect(transport).toHaveBeenCalledWith({ sub: "user-a" })
    const runtime = scope.holder.current()
    expect(runtime?.subject).toBe("user-a")
    expect(runtime?.visible).toBe(false)
    expect(context.data).toBe(scope.holder)
    expect(options[0]?.residency).toEqual({
      "Catalog.Country": "full",
      "Catalog.Client": "window",
    })
    expect(options[0]?.strict).toBe(true)
    // Серверний рантайм не клієнтський: ні банера, ні входу
    expect(options[0]?.onStaleClient).toBeUndefined()
    expect(options[0]?.onSessionChanged).toBeUndefined()
    runtime?.dispose()
  })

  it("without a session there is no runtime and context.data is null", () => {
    const { scope, context } = newScope()
    context.data = scope.holder
    const transportFor = vi.fn()
    establishServerSession(scope, context, null, transportFor)
    expect(context.data).toBeNull()
    expect(scope.holder.current()).toBeUndefined()
    expect(transportFor).not.toHaveBeenCalled()
  })

  it("disposes the runtime when the response ends, not before", () => {
    const { scope, context, endActions } = newScope()
    establishServerSession(scope, context, { sub: "u" }, () => NO_NETWORK)
    const runtime = scope.holder.current()
    expect(runtime?.disposed).toBe(false)
    expect(endActions).toHaveLength(1)
    endActions[0]?.()
    expect(runtime?.disposed).toBe(true)
    expect(scope.holder.current()).toBeUndefined()
  })

  it("two requests never share a holder or a runtime", () => {
    const a = newScope()
    const b = newScope()
    establishServerSession(a.scope, a.context, { sub: "a" }, () => NO_NETWORK)
    establishServerSession(b.scope, b.context, { sub: "b" }, () => NO_NETWORK)
    expect(a.scope.holder).not.toBe(b.scope.holder)
    expect(a.scope.holder.current()?.subject).toBe("a")
    expect(b.scope.holder.current()?.subject).toBe("b")
    a.scope.holder.current()?.dispose()
    b.scope.holder.current()?.dispose()
  })
})

describe("createClientRuntime", () => {
  it("starts hidden in a tab opened hidden and visible otherwise", () => {
    const { scope } = newScope()
    vi.stubGlobal("document", { hidden: true })
    expect(createClientRuntime(scope, "u").visible).toBe(false)
    vi.stubGlobal("document", { hidden: false })
    expect(createClientRuntime(scope, "u").visible).toBe(true)
  })

  it("session-changed closes the holder and goes to login; a stale runtime does not", () => {
    vi.stubGlobal("document", { hidden: false })
    const options = captureOptions()
    const { scope, toLogin } = newScope()
    const first = createClientRuntime(scope, "a")
    scope.holder.replace(first)
    const second = createClientRuntime(scope, "b")
    scope.holder.replace(second)
    // Пізній виклик замінюваного рантайму не чіпає живий
    options[0]?.onSessionChanged?.()
    expect(scope.holder.current()).toBe(second)
    expect(toLogin).not.toHaveBeenCalled()
    options[1]?.onSessionChanged?.()
    expect(scope.holder.current()).toBeUndefined()
    expect(scope.holder.closed()).toBe("session-changed")
    expect(toLogin).toHaveBeenCalledOnce()
  })

  it("onStaleClient shows the banner", () => {
    vi.stubGlobal("document", { hidden: false })
    const options = captureOptions()
    const { scope } = newScope()
    createClientRuntime(scope, "u")
    const seen = vi.fn()
    scope.stale.subscribe(seen)
    options[0]?.onStaleClient?.("Catalog.Client")
    expect(scope.stale.isStale()).toBe(true)
    expect(seen).toHaveBeenCalledOnce()
  })
})

describe("clientContext", () => {
  it("gives routes the holder while it holds a runtime and null otherwise; never asks for a session", () => {
    vi.stubGlobal("document", { hidden: false })
    const { scope, context } = newScope()
    clientContext(scope, context)
    expect(context.data).toBeNull()
    scope.holder.replace(createClientRuntime(scope, "a"))
    clientContext(scope, context)
    expect(context.data).toBe(scope.holder)
    // Вихід чи вхід кличуть `holder.replace` самі: контекст іде за тримачем
    scope.holder.replace(undefined, "signed-out")
    clientContext(scope, context)
    expect(context.data).toBeNull()
  })
})
