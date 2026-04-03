import { createContext } from 'react'
import type { MetadataKind } from '@simetra/core'

// --- Типи вузлів глибокого дерева ---

export type TreeNodeType = 'kind' | 'object' | 'group' | 'field' | 'tabularSection'

export interface TreeNodeData {
  id: string
  name: string
  kind: MetadataKind
  nodeType: TreeNodeType
  objectCount?: number
  /** Імʼя обʼєкта (для group/field/tabularSection) */
  objectName?: string
  /** Ключ групи: attributes | dimensions | resources | tabularSections | values */
  groupKey?: string
  /** Імʼя табличної частини (для полів всередині ТЧ) */
  tabularSectionName?: string
  /** Тип поля метаданих (для field вузлів) */
  fieldType?: string
  /** Відображуваний тип поля (derived, наприклад CatalogRef.Products) */
  fieldTypeDisplay?: string
  children?: TreeNodeData[]
}

// Порядок розділів у дереві
export const SECTION_ORDER: MetadataKind[] = [
  'Catalog',
  'Document',
  'Enumeration',
  'InformationRegister',
  'AccumulationRegister',
  'Constant',
  'CustomTable',
]

/** Маппінг groupKey → i18n ключ для додавання */
export const GROUP_ADD_KEYS: Record<string, string> = {
  attributes: 'tree.addAttribute',
  dimensions: 'tree.addDimension',
  resources: 'tree.addResource',
  tabularSections: 'tree.addTabularSection',
  values: 'tree.addValue',
}

// --- Контекст для діалогу видалення (один на все дерево) ---

export interface DeleteDialogState {
  requestDelete: (kind: MetadataKind, name: string) => void
}

export const DeleteDialogContext = createContext<DeleteDialogState>({
  requestDelete: () => {},
})
