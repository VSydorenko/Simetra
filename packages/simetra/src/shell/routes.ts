import { createElement, type ReactElement } from "react"
import type { OrderBy } from "simetra/model"
import { ListHost, listQuery } from "simetra/ui"
import { entryOf, type EntityDescriptor } from "./app"
import type { SimetraRouterContext } from "./context"

declare module "@tanstack/react-router" {
  // Поля `staticData`, за якими адаптер знаходить маршрути (спека П4-D §6).
  interface StaticDataRouteOption {
    /** Set on the list route of an object: its UUID. */
    simetraList?: string
    /**
     * Set on the card route of an object: its UUID. `entityCardRoute` also
     * sets {@link simetraObject}.
     */
    simetraCard?: string
    /** The logical name of the object of a simetra route. */
    simetraObject?: string
  }
}

export interface EntityListRouteOptions {
  orderBy?: OrderBy
  include?: readonly string[]
}

/**
 * The route options of the standard list of an object: a loader that
 * preloads the list view, the `ListHost` component, `ssr: true` and the
 * `staticData` the navigation adapter looks up (P4-D spec §6). Use it as
 * `createFileRoute("/clients/")(entityListRoute(Client))`.
 */
export function entityListRoute(
  entity: EntityDescriptor,
  options: EntityListRouteOptions = {}
) {
  // Запис і запит — один раз, на рівні модуля: той самий `listQuery`, що в
  // `ListHost`, тож loader гріє саме той вигляд, на який підпишеться хост.
  const query = listQuery(entryOf(entity), options)
  return {
    loader: async ({
      context,
    }: {
      context: SimetraRouterContext
    }): Promise<void> => {
      // Без тримача чи рантайму (анонімний запит, вихід) даних не вантажимо:
      // хост покаже причину закриття сам.
      const runtime = context.data?.current()
      if (runtime === undefined) return
      await runtime.preload({
        kind: runtime.residencyOf(entity.ref),
        object: entity.ref,
        ...query,
      })
    },
    component: (): ReactElement =>
      createElement(ListHost, { object: entity.ref, ...options }),
    ssr: true as const,
    staticData: { simetraList: entity.id, simetraObject: entity.ref },
  }
}

// Шов для `entityCardRoute(entity)`: той самий вигляд опцій, а в `staticData`
// — `simetraCard: entity.id` і ОБОВ'ЯЗКОВО `simetraObject: entity.ref` (без нього
// `openCard` маршрут не знайде); `openCard`
// (navigation.ts) вже шукає маршрут саме за ними. Додасть задача 4 разом із
// `CardHost`.
