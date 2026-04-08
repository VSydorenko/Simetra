import type { MetadataRef, ProjectModel } from '@simetra/core'
import { toKebabCase } from '@simetra/core'

// Маппінг URL kind slug → MetadataKind + collection key
const SLUG_MAP: Record<string, { kind: string; collectionKey: keyof ProjectModel }> = {
  catalogs: { kind: 'Catalog', collectionKey: 'catalogs' },
  documents: { kind: 'Document', collectionKey: 'documents' },
  'custom-tables': { kind: 'CustomTable', collectionKey: 'customTables' },
}

export interface ResolvedObject {
  objectRef: MetadataRef
  object: Record<string, unknown>
}

export function resolveObjectFromSlug(
  kindSlug: string,
  objectSlug: string,
  model: ProjectModel,
): ResolvedObject | null {
  const config = SLUG_MAP[kindSlug]
  if (!config) return null

  const collection = model[config.collectionKey] as { name: string }[]
  const obj = collection?.find((o) => toKebabCase(o.name) === objectSlug)
  if (!obj) return null

  return {
    objectRef: { kind: config.kind, name: obj.name } as MetadataRef,
    object: obj as Record<string, unknown>,
  }
}
