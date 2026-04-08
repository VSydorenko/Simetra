import type { ProjectModel } from '@simetra/core'
import type { DataProvider } from '@simetra/data-provider'
import { DataProviderProvider, MetadataProvider } from '@simetra/form-runtime'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { useMemo } from 'react'
import { buildFlatNavigation } from './navigation-builder'
import { buildRoutes } from './router-builder'
import { SidebarLayout } from './shell/sidebar-layout'

export interface SimetraAppProps {
  model: ProjectModel
  dataProvider: DataProvider
  // Phase 4: applicationConfig?: ApplicationConfig
}

export function SimetraApp({ model, dataProvider }: SimetraAppProps) {
  const navigation = useMemo(() => buildFlatNavigation(model), [model])

  const router = useMemo(() => {
    // Root layout обгортає все у providers
    const RootLayout = () => (
      <DataProviderProvider provider={dataProvider}>
        <MetadataProvider model={model}>
          <SidebarLayout
            navigation={navigation}
            projectName={model.project.displayName}
          />
        </MetadataProvider>
      </DataProviderProvider>
    )

    return createBrowserRouter([
      {
        element: <RootLayout />,
        children: buildRoutes(model),
      },
    ])
  }, [model, dataProvider, navigation])

  return <RouterProvider router={router} />
}
