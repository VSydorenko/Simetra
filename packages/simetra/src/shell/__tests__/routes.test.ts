// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRuntimeHolder } from "../../data/runtime/holder"
import { ORG, TASK, key, settle } from "../../data/store/__tests__/core-support"
import { entityCardRoute, entityListRoute } from "../routes"
import { harness, memoryRouter, route } from "./support"

const flush = () => act(async () => void (await settle()))
const task = { kind: "Catalog", name: "Task" } as const

afterEach(cleanup)

describe("entityListRoute", () => {
  it("preloads the very view the host subscribes to", async () => {
    const { app, runtime, core, holder } = harness()
    const preload = vi.spyOn(runtime, "preload")
    const view = vi.spyOn(core, "view")
    const entity = app.object(task)
    const { router, element } = memoryRouter({
      app,
      data: holder,
      initial: "/tasks",
      routes: (root) => [route(root, "/tasks", entityListRoute(entity))],
    })
    await router.load()
    render(element)
    await flush()

    expect(preload).toHaveBeenCalledTimes(1)
    const preloaded = preload.mock.calls[0]![0]
    expect(preloaded).toMatchObject({ kind: "window", object: TASK })
    // Один `spec`: хост просить те саме, що loader уже втримав.
    expect(view.mock.calls.map((call) => call[0])).toContainEqual(preloaded)
  })

  it("passes the options to the loader and to the host alike", async () => {
    const { app, runtime, core, holder } = harness()
    const preload = vi.spyOn(runtime, "preload")
    const view = vi.spyOn(core, "view")
    const options = {
      orderBy: [{ attribute: "title", direction: "desc" as const }],
      include: [],
    }
    const { router, element } = memoryRouter({
      app,
      data: holder,
      initial: "/tasks",
      routes: (root) => [
        route(root, "/tasks", entityListRoute(app.object(task), options)),
      ],
    })
    await router.load()
    render(element)
    await flush()
    const preloaded = preload.mock.calls[0]![0]
    expect(preloaded).toMatchObject({ orderBy: options.orderBy })
    expect(view.mock.calls.map((call) => call[0])).toContainEqual(preloaded)
  })

  it("does not preload without a runtime in the context", async () => {
    const { app, runtime, holder } = harness()
    const preload = vi.spyOn(runtime, "preload")
    const { router } = memoryRouter({
      app,
      data: null,
      holder,
      initial: "/tasks",
      routes: (root) => [
        route(root, "/tasks", entityListRoute(app.object(task))),
      ],
    })
    await router.load()
    expect(preload).not.toHaveBeenCalled()
    expect(router.state.location.pathname).toBe("/tasks")
    // Loader не падає без тримача: збій лишився б у стані збігу.
    expect(router.state.matches.map((match) => match.status)).not.toContain(
      "error"
    )

    // Тримач без рантайму (вихід) — так само.
    const closed = createRuntimeHolder()
    const second = memoryRouter({
      app,
      data: closed,
      initial: "/tasks",
      routes: (root) => [
        route(root, "/tasks", entityListRoute(app.object(task))),
      ],
    })
    await second.router.load()
    expect(preload).not.toHaveBeenCalled()
  })

  it("carries the staticData the adapter looks up", () => {
    const { app } = harness()
    const entity = app.object(task)
    expect(entityListRoute(entity)).toMatchObject({
      ssr: true,
      staticData: { simetraList: entity.id, simetraObject: TASK },
    })
  })
})

describe("entityCardRoute", () => {
  it("preloads the very card and section views the host subscribes to", async () => {
    const { app, runtime, core, holder } = harness()
    const preload = vi.spyOn(runtime, "preload")
    const view = vi.spyOn(core, "view")
    const { router, element } = memoryRouter({
      app,
      data: holder,
      initial: `/tasks/${key(2)}`,
      routes: (root) => [
        route(root, "/tasks/$id", entityCardRoute(app.object(task))),
      ],
    })
    await router.load()
    const { container } = render(element)
    await flush()

    const preloaded = preload.mock.calls.map((call) => call[0])
    expect(preloaded).toEqual([
      { kind: "card", object: TASK, key: key(2) },
      { kind: "section", object: TASK, owner: key(2), section: "lines" },
    ])
    const viewed = view.mock.calls.map((call) => call[0])
    for (const spec of preloaded) expect(viewed).toContainEqual(spec)
    // Хост узяв `id` з параметрів шляху.
    const card = container.querySelector('[data-region="card"]')
    expect(card?.getAttribute("data-key")).toBe(key(2))
    expect(
      container.querySelector<HTMLInputElement>('input[data-field="title"]')
        ?.value
    ).toBe("t2")
  })

  it("does not preload without a runtime in the context", async () => {
    const { app, runtime, holder } = harness()
    const preload = vi.spyOn(runtime, "preload")
    const { router } = memoryRouter({
      app,
      data: null,
      holder,
      initial: `/tasks/${key(1)}`,
      routes: (root) => [
        route(root, "/tasks/$id", entityCardRoute(app.object(task))),
      ],
    })
    await router.load()
    expect(preload).not.toHaveBeenCalled()
    expect(router.state.matches.map((match) => match.status)).not.toContain(
      "error"
    )
  })

  it("carries the staticData the adapter looks up; openCard finds it", async () => {
    const { app, holder } = harness()
    const entity = app.object(task)
    expect(entityCardRoute(entity)).toMatchObject({
      ssr: true,
      staticData: { simetraCard: entity.id, simetraObject: TASK },
    })
    const { router, navigation } = memoryRouter({
      app,
      data: holder,
      initial: "/",
      routes: (root) => [
        route(root, "/", { component: () => null }),
        route(root, "/tasks/$id", {
          ...entityCardRoute(entity),
          component: () => null,
        }),
      ],
    })
    await router.load()
    navigation.openCard(TASK, key(3))
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/tasks/${key(3)}`)
    )
  })
})

describe("routerNavigation", () => {
  const listRoute = (
    app: ReturnType<typeof harness>["app"],
    root: Parameters<typeof route>[0]
  ) =>
    route(root, "/tasks", {
      ...entityListRoute(app.object(task)),
      component: () => null,
    })

  it("openCard without a card route throws Error", async () => {
    const { app, holder } = harness()
    const { router, navigation } = memoryRouter({
      app,
      data: holder,
      initial: "/tasks",
      routes: (root) => [listRoute(app, root)],
    })
    await router.load()
    expect(() => navigation.openCard(TASK, key(1))).toThrow(Error)
  })

  it("openCard goes to the route with the staticData of the object", async () => {
    const { app, holder } = harness()
    const entity = app.object(task)
    const { router, navigation } = memoryRouter({
      app,
      data: holder,
      initial: "/tasks",
      routes: (root) => [
        listRoute(app, root),
        route(root, "/tasks/$id", {
          component: () => null,
          staticData: { simetraCard: entity.id, simetraObject: TASK },
        }),
        // Картка іншого об'єкта: шукаємо за об'єктом, а не за першою карткою.
        route(root, "/orgs/$id", {
          component: () => null,
          staticData: {
            simetraCard: app.object({ kind: "Catalog", name: "Organization" })
              .id,
            simetraObject: ORG,
          },
        }),
      ],
    })
    await router.load()
    navigation.openCard(TASK, key(2))
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/tasks/${key(2)}`)
    )
    navigation.openCard(ORG, key(3))
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/orgs/${key(3)}`)
    )
    navigation.openList(TASK)
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/tasks")
    )
  })

  it("useBlockWhile(true) blocks a transition, (false) lets it pass", async () => {
    const { app, holder } = harness()
    let setDirty: (dirty: boolean) => void = () => {}
    const { router, navigation, element } = memoryRouter({
      app,
      data: holder,
      initial: "/tasks",
      routes: (root) => [
        listRoute(app, root),
        route(root, "/other", { component: () => null }),
      ],
      extra: () => {
        const [dirty, set] = useState(true)
        setDirty = set
        navigation.useBlockWhile(dirty)
        return null
      },
    })
    render(element)
    await flush()

    // Заблокований перехід не завершується, тож його проміс не чекаємо.
    await act(async () => {
      void router.navigate({ to: "/other" })
      await settle()
    })
    expect(router.state.location.pathname).toBe("/tasks")

    await act(async () => {
      setDirty(false)
      await settle()
    })
    await act(async () => {
      await router.navigate({ to: "/other" })
    })
    expect(router.state.location.pathname).toBe("/other")
  })
})
