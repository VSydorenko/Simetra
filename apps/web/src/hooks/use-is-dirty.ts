import { useMemo } from 'react'
import { useMetadataStore } from '../stores/metadata-store'
import { useProjectStore } from '../stores/project-store'
import type { MetadataRef } from '@simetra/core'

/** Реактивний хук для відстеження незбережених змін (глобальний) */
export function useIsDirty(): boolean {
  const version = useMetadataStore((s) => s.version)
  const lastSavedVersion = useProjectStore((s) => s.lastSavedVersion)
  return useMemo(
    () => lastSavedVersion === null || version !== lastSavedVersion,
    [version, lastSavedVersion],
  )
}

/** Реактивний хук для dirty-стану конкретного обʼєкта */
export function useIsObjectDirty(ref: MetadataRef): boolean {
  const key = `${ref.kind}/${ref.name}`
  const objectVersion = useMetadataStore((s) => s.objectVersions[key])
  const lastSavedObjectVersion = useProjectStore(
    (s) => s.lastSavedObjectVersions[key],
  )
  return useMemo(
    () => objectVersion !== lastSavedObjectVersion,
    [objectVersion, lastSavedObjectVersion],
  )
}
