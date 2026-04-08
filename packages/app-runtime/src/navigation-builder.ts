import type { ProjectModel } from '@simetra/core'
import { toKebabCase } from '@simetra/core'

export interface NavigationItem {
  kind: string
  objectName: string
  displayName: string
  path: string
}

export interface NavigationGroup {
  kind: string
  label: string
  items: NavigationItem[]
}

// Конфігурація навігаційних груп для Phase 3 (flat mode)
const GROUP_CONFIG: { kind: string; label: string; pathPrefix: string; collectionKey: keyof ProjectModel }[] = [
  { kind: 'Catalog', label: 'Довідники', pathPrefix: '/catalogs', collectionKey: 'catalogs' },
  { kind: 'Document', label: 'Документи', pathPrefix: '/documents', collectionKey: 'documents' },
  { kind: 'CustomTable', label: 'Таблиці', pathPrefix: '/custom-tables', collectionKey: 'customTables' },
]

function resolveDisplayName(obj: { name: string; displayName?: { uk?: string; en?: string } | null }): string {
  return obj.displayName?.uk ?? obj.displayName?.en ?? obj.name
}

/**
 * Будує flat-навігацію з ProjectModel.
 * Phase 3: без subsystems, просто групування по kind.
 */
export function buildFlatNavigation(model: ProjectModel): NavigationGroup[] {
  const groups: NavigationGroup[] = []

  for (const cfg of GROUP_CONFIG) {
    const collection = model[cfg.collectionKey] as { name: string; displayName?: { uk?: string; en?: string } | null }[]
    if (!collection || collection.length === 0) continue

    const items: NavigationItem[] = collection.map((obj) => ({
      kind: cfg.kind,
      objectName: obj.name,
      displayName: resolveDisplayName(obj),
      path: `${cfg.pathPrefix}/${toKebabCase(obj.name)}`,
    }))

    groups.push({ kind: cfg.kind, label: cfg.label, items })
  }

  // Constants — окрема група з єдиним пунктом
  if (model.constants.length > 0) {
    groups.push({
      kind: 'Constant',
      label: 'Налаштування',
      items: [
        {
          kind: 'Constant',
          objectName: '',
          displayName: 'Налаштування',
          path: '/constants',
        },
      ],
    })
  }

  return groups
}
