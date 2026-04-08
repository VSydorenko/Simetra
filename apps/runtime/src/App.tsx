import { useEffect, useState } from 'react'
import type { ProjectModel } from '@simetra/core'
import { parseMetadataFiles, buildProjectModelFromParsed } from '@simetra/core'
import type { DataProvider } from '@simetra/data-provider'
import { InMemoryDataProvider } from '@simetra/data-provider'
import { PostgRestDataProvider } from '@simetra/data-provider-postgrest'
import { SimetraApp } from '@simetra/app-runtime'
import {
  SIMETRA_API_URL,
  SIMETRA_ANON_KEY,
  SIMETRA_METADATA_PATH,
  SIMETRA_DATA_PROVIDER,
} from './config'

function getRuntimeConfigError(): string | null {
  if (!SIMETRA_METADATA_PATH) {
    return 'Не задано env-параметр VITE_SIMETRA_METADATA_PATH для browser runtime'
  }

  if (SIMETRA_DATA_PROVIDER === 'postgrest' && !SIMETRA_API_URL) {
    return 'Не задано env-параметр VITE_SIMETRA_API_URL для PostgREST provider'
  }

  return null
}

/** Завантажити metadata files через HTTP */
async function loadMetadata(basePath: string): Promise<ProjectModel> {
  // Завантажуємо index.json з переліком файлів
  const indexRes = await fetch(`${basePath}/index.json`)
  if (!indexRes.ok) throw new Error(`Failed to fetch metadata index: ${indexRes.status}`)
  const fileList: string[] = await indexRes.json()

  // Завантажуємо кожен файл (fail-fast: будь-який невдалий fetch зупиняє bootstrap)
  const files = new Map<string, string>()
  const results = await Promise.all(
    fileList.map(async (filePath) => {
      const res = await fetch(`${basePath}/${filePath}`)
      if (!res.ok) {
        throw new Error(`Failed to fetch metadata file "${filePath}": ${res.status}`)
      }
      return { filePath, content: await res.text() }
    }),
  )
  for (const { filePath, content } of results) {
    files.set(filePath, content)
  }

  const { parsed } = parseMetadataFiles(files)
  const { model } = buildProjectModelFromParsed(parsed)
  return model
}

/** Створити data provider залежно від конфігурації */
function createDataProvider(): DataProvider {
  if (SIMETRA_DATA_PROVIDER === 'postgrest' && SIMETRA_API_URL) {
    return new PostgRestDataProvider({
      url: SIMETRA_API_URL,
      anonKey: SIMETRA_ANON_KEY,
    })
  }
  return new InMemoryDataProvider()
}

export function App() {
  const [model, setModel] = useState<ProjectModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dataProvider] = useState<DataProvider>(() => createDataProvider())
  const configError = getRuntimeConfigError()

  useEffect(() => {
    if (configError) {
      return
    }

    const metadataBasePath = SIMETRA_METADATA_PATH
    if (!metadataBasePath) {
      return
    }

    loadMetadata(metadataBasePath)
      .then(setModel)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [configError])

  if (configError || error) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-bold text-destructive">Помилка завантаження</h1>
          <p className="mt-2 text-muted-foreground">{configError ?? error}</p>
        </div>
      </div>
    )
  }

  if (!model) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Завантаження метаданих...</p>
      </div>
    )
  }

  return <SimetraApp model={model} dataProvider={dataProvider} />
}
