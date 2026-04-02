import { create } from 'zustand'
import type { MetadataKind, MetadataRef } from '@simetra/core'

// Контекст вибору — або обʼєкт, або поле всередині обʼєкта
export interface FieldSelection {
  objectRef: MetadataRef
  // Ім'я поля (атрибута, dimension, resource тощо)
  fieldName: string
  // Для поля всередині табличної частини
  tabularSectionName?: string
}

export type PanelId = 'tree' | 'editor' | 'properties'

export interface UiState {
  // Вибраний обʼєкт у дереві
  selectedObject: MetadataRef | null
  // Вибране поле в таблиці атрибутів
  selectedField: FieldSelection | null
  // Розгорнуті вузли дерева (kind як кореневий розділ)
  expandedTreeNodes: string[]
  // Пошуковий запит у дереві
  searchQuery: string
  // Активна вкладка в редакторі
  activeEditorTab: string
  // Чи відкрита панель властивостей
  propertiesPanelOpen: boolean
  // Чи відкрита Command Palette
  commandPaletteOpen: boolean
  // Останній активний фокус (для scoped hotkeys)
  focusedPanel: PanelId | null
}

export interface UiActions {
  selectObject: (ref: MetadataRef | null) => void
  selectField: (field: FieldSelection | null) => void
  setExpandedTreeNodes: (nodes: string[]) => void
  toggleTreeNode: (nodeId: string) => void
  setSearchQuery: (query: string) => void
  setActiveEditorTab: (tab: string) => void
  setPropertiesPanelOpen: (open: boolean) => void
  togglePropertiesPanel: () => void
  setCommandPaletteOpen: (open: boolean) => void
  toggleCommandPalette: () => void
  setFocusedPanel: (panel: PanelId | null) => void
}

// Кореневі розділи розгорнуті за замовчуванням
const DEFAULT_EXPANDED: string[] = [
  'Catalog',
  'Document',
  'Enumeration',
  'InformationRegister',
  'AccumulationRegister',
  'Constant',
  'CustomTable',
] satisfies MetadataKind[]

export type UiStore = UiState & UiActions

export const useUiStore = create<UiStore>()((set) => ({
  selectedObject: null,
  selectedField: null,
  expandedTreeNodes: DEFAULT_EXPANDED,
  searchQuery: '',
  activeEditorTab: 'attributes',
  propertiesPanelOpen: true,
  commandPaletteOpen: false,
  focusedPanel: null,

  selectObject: (ref) =>
    set({
      selectedObject: ref,
      // Скинути вибір поля при зміні обʼєкта
      selectedField: null,
      activeEditorTab: 'attributes',
    }),

  selectField: (field) =>
    set({ selectedField: field }),

  setExpandedTreeNodes: (nodes) =>
    set({ expandedTreeNodes: nodes }),

  toggleTreeNode: (nodeId) =>
    set((state) => {
      const nodes = state.expandedTreeNodes
      const isExpanded = nodes.includes(nodeId)
      return {
        expandedTreeNodes: isExpanded
          ? nodes.filter((n) => n !== nodeId)
          : [...nodes, nodeId],
      }
    }),

  setSearchQuery: (query) =>
    set({ searchQuery: query }),

  setActiveEditorTab: (tab) =>
    set({ activeEditorTab: tab }),

  setPropertiesPanelOpen: (open) =>
    set({ propertiesPanelOpen: open }),

  togglePropertiesPanel: () =>
    set((state) => ({ propertiesPanelOpen: !state.propertiesPanelOpen })),

  setCommandPaletteOpen: (open) =>
    set({ commandPaletteOpen: open }),

  toggleCommandPalette: () =>
    set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),

  setFocusedPanel: (panel) =>
    set({ focusedPanel: panel }),
}))
