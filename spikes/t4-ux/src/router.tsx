// Фабрика роутера викликається на кожен SSR-запит і один раз на клієнті:
// тримач рантайму (і ядро) живе в ній, а не на рівні модуля — знімок одного
// користувача не може потрапити іншому через спільний модуль.
import { createRouter } from '@tanstack/react-router'
import type { CoreSnapshot } from './core/types'
import { routeTree } from './routeTree.gen'
import { RuntimeProvider } from './t4/hooks'
import { RuntimeHolder } from './t4/runtime'
import { acceptSnapshot, type SnapshotMeta } from './t4/ssr'

export interface RouterContext {
  holder: RuntimeHolder
}

export function getRouter() {
  const holder = new RuntimeHolder()
  const router = createRouter({
    routeTree,
    context: { holder },
    scrollRestoration: false,
    // Дані зі сховища показуються одразу; pending-кадр роутера не потрібен.
    defaultPendingMs: 60_000,
    defaultPendingMinMs: 0,
    defaultPreload: false,
    dehydrate: () => {
      const core = holder.core
      return { t4: core ? { meta: snapshotMeta(core.subject), snap: core.dehydrate() } : null }
    },
    hydrate: (d: { t4: { meta: SnapshotMeta; snap: CoreSnapshot } | null }) => {
      // Ядро гідрується до першого клієнтського рендера (router-core
      // load-client чекає options.hydrate перед matchRoutes).
      if (d.t4 && acceptSnapshot(d.t4.meta)) holder.ensure(d.t4.snap.subject)?.hydrate(d.t4.snap)
    },
    Wrap: ({ children }) => <RuntimeProvider holder={holder}>{children}</RuntimeProvider>,
  })
  return router
}

function snapshotMeta(subject: string): SnapshotMeta {
  return { subject, catalogHash: CATALOG_HASH, issuedAt: Date.now(), ttlMs: SNAPSHOT_TTL_MS }
}

export const CATALOG_HASH = 'catalog-v1'
export const SNAPSHOT_TTL_MS = 60_000

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
