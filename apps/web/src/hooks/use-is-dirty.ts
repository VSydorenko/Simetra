import { useMemo } from 'react'
import { useMetadataStore } from '../stores/metadata-store'
import { useProjectStore } from '../stores/project-store'

/** Реактивний хук для відстеження незбережених змін */
export function useIsDirty(): boolean {
  const version = useMetadataStore((s) => s.version)
  const lastSavedVersion = useProjectStore((s) => s.lastSavedVersion)
  return useMemo(
    () => lastSavedVersion === null || version !== lastSavedVersion,
    [version, lastSavedVersion],
  )
}
