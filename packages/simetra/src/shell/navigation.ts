import { useBlocker, type AnyRouter } from "@tanstack/react-router"
import type { NavigationAdapter } from "simetra/ui"

type RouteLike = {
  fullPath: string
  options: { staticData?: Record<string, unknown> }
}

// Маршрути знаходить застосунок-власник дерева, а шляху T6 не вигадує
// (спека П4-D §6): шукаємо в дереві роутера за `staticData`.
function findRoute(
  router: AnyRouter,
  field: "simetraCard" | "simetraList",
  object: string
): RouteLike | undefined {
  return (Object.values(router.routesById) as RouteLike[]).find((route) => {
    const data = route.options.staticData
    return data?.[field] !== undefined && data.simetraObject === object
  })
}

/**
 * The navigation adapter of T5 over TanStack Router (P4-D spec §6). The card
 * route is the one with `staticData.simetraCard` of the object, the list
 * route the one with `simetraList`; the path comes from the app's route tree.
 */
export function routerNavigation(router: AnyRouter): NavigationAdapter {
  return {
    openCard(object, key) {
      const route = findRoute(router, "simetraCard", object)
      if (route === undefined) {
        throw new Error(`routerNavigation: no card route for ${object}`)
      }
      void router.navigate({ to: route.fullPath, params: { id: key } })
    },
    openList(object) {
      const route = findRoute(router, "simetraList", object)
      if (route === undefined) {
        throw new Error(`routerNavigation: no list route for ${object}`)
      }
      void router.navigate({ to: route.fullPath })
    },
    useBlockWhile(dirty) {
      // Хук викликає хост на кожному кадрі: умова — у `shouldBlockFn`, а не в
      // наявності хука.
      useBlocker({
        shouldBlockFn: () => dirty,
        enableBeforeUnload: dirty,
        disabled: !dirty,
      })
    },
  }
}
