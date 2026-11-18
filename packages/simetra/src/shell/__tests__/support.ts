import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  createRoute,
  type AnyRoute,
} from "@tanstack/react-router"
import { createElement, type ReactElement } from "react"
import { DataRuntimeProvider } from "simetra/data/react"
import type { ClientCatalog } from "simetra/model"
import { NavigationProvider } from "simetra/ui"
import { SUBJECT, clientCatalog } from "../../data/__tests__/support"
import { runtimeHandleOf } from "../../data/runtime/handle"
import {
  createRuntimeHolder,
  type RuntimeHolder,
} from "../../data/runtime/holder"
import {
  OBJECTS,
  ORG,
  TASK,
  seed,
} from "../../data/store/__tests__/core-support"
import { createFakeSource } from "../../data/store/testing/fake-source"
import { simetraApp, type SimetraApp } from "../app"
import type { SimetraRouterContext } from "../context"
import { routerNavigation } from "../navigation"

export const catalog: ClientCatalog = {
  ...clientCatalog(),
  objects: [...OBJECTS],
}

/** An app and a runtime over the fake server. */
export function harness() {
  const app = simetraApp(catalog)
  const fake = createFakeSource({ objects: OBJECTS })
  seed(fake, 1, 3)
  const runtime = app.createRuntime({
    transport: () => Promise.reject(new Error("unused")),
    subject: SUBJECT,
    log: () => {},
    sources: {
      override: { [TASK]: () => fake.adapter, [ORG]: () => fake.adapter },
    },
  })
  return {
    app,
    fake,
    runtime,
    core: runtimeHandleOf(runtime).core,
    holder: createRuntimeHolder(runtime),
  }
}

/**
 * An in-memory router. `routes` builds the child routes of the root;
 * `data` is the router context (`null` — no runtime), `holder` what the
 * hosts read; `extra` renders beside the outlet.
 */
export function memoryRouter(options: {
  app: SimetraApp
  data: RuntimeHolder | null
  holder?: RuntimeHolder
  initial: string
  routes: (root: AnyRoute) => unknown[]
  extra?: () => ReactElement | null
}) {
  const hostsHolder = options.holder ?? options.data ?? createRuntimeHolder()
  const root = createRootRouteWithContext<SimetraRouterContext>()({
    component: () =>
      createElement(
        options.app.Provider,
        null,
        createElement(
          DataRuntimeProvider,
          { holder: hostsHolder },
          createElement(Outlet),
          options.extra?.() ?? null
        )
      ),
  })
  const router = createRouter({
    routeTree: root.addChildren(
      options.routes(root as unknown as AnyRoute) as never
    ) as unknown as AnyRoute,
    history: createMemoryHistory({ initialEntries: [options.initial] }),
    context: { data: options.data },
  })
  const navigation = routerNavigation(router)
  const element = createElement(
    NavigationProvider,
    { adapter: navigation },
    createElement(RouterProvider, { router })
  )
  return { router, navigation, element }
}

/**
 * A child of the root route. The generic route types of the library do not
 * line up between a test's route and `AnyRoute`, so the tests take it as
 * opaque and `memoryRouter` hands it to `addChildren`.
 */
export const route = (
  root: AnyRoute,
  path: string,
  options: Record<string, unknown> = {}
): unknown =>
  createRoute({ getParentRoute: () => root, path, ...options } as never)
