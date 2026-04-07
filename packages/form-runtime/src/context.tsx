import { createContext, useContext } from 'react'
import type { DataProvider } from '@simetra/data-provider'
import type { ProjectModel } from '@simetra/core'

// Контекст DataProvider для runtime форм
const DataProviderContext = createContext<DataProvider | null>(null)

export function DataProviderProvider({
  provider,
  children,
}: {
  provider: DataProvider
  children: React.ReactNode
}) {
  return (
    <DataProviderContext value={provider}>{children}</DataProviderContext>
  )
}

export function useDataProvider(): DataProvider {
  const ctx = useContext(DataProviderContext)
  if (!ctx)
    throw new Error('useDataProvider must be used within DataProviderProvider')
  return ctx
}

// Контекст метаданих (ProjectModel)
const MetadataContext = createContext<ProjectModel | null>(null)

export function MetadataProvider({
  model,
  children,
}: {
  model: ProjectModel
  children: React.ReactNode
}) {
  return <MetadataContext value={model}>{children}</MetadataContext>
}

export function useMetadata(): ProjectModel {
  const ctx = useContext(MetadataContext)
  if (!ctx)
    throw new Error('useMetadata must be used within MetadataProvider')
  return ctx
}
