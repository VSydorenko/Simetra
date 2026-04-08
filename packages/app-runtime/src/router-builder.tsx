import type { ProjectModel } from '@simetra/core'
import type { RouteObject } from 'react-router'
import { HomePage } from './pages/home-page'
import { ListPage } from './pages/list-page'
import { ItemPage } from './pages/item-page'
import { ConstantsPage } from './pages/constants-page'
import { NotFoundPage } from './pages/not-found-page'

/** Kind slugs що підтримують list/item маршрути */
export const SUPPORTED_KIND_SLUGS = ['catalogs', 'documents', 'custom-tables'] as const
export type KindSlug = (typeof SUPPORTED_KIND_SLUGS)[number]

/**
 * Будує масив RouteObject для children root layout route.
 * Phase 3: маршрути з :kindSlug параметром, без subsystem filtering.
 * Phase 4: model буде використовуватись для subsystem-based routing.
 */
export function buildRoutes(_model: ProjectModel): RouteObject[] {
  return [
    { index: true, element: <HomePage /> },
    { path: ':kindSlug/:objectSlug', element: <ListPage /> },
    { path: ':kindSlug/:objectSlug/new', element: <ItemPage /> },
    { path: ':kindSlug/:objectSlug/:id', element: <ItemPage /> },
    { path: 'constants', element: <ConstantsPage /> },
    { path: '*', element: <NotFoundPage /> },
  ]
}
