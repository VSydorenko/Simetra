import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import type {
  MetadataKind,
  MetadataObject,
  MetadataRef,
  ProjectModel,
  TabularSection,
} from "@simetra/core"
import type { Layout } from "react-resizable-panels"
import { KIND_TO_KEY } from "@/lib/metadata-defaults"

// Контекст вибору — або обʼєкт, або поле всередині обʼєкта
export interface FieldSelection {
  objectRef: MetadataRef
  // Ім'я поля (атрибута, dimension, resource тощо)
  fieldName: string
  // Для поля всередині табличної частини
  tabularSectionName?: string
}

export interface TabularSectionSelection {
  objectRef: MetadataRef
  tabularSectionName: string
}

export type PanelId = "tree" | "editor" | "properties"

// --- Tab / Floating Window типи ---

/** Унікальний ідентифікатор вкладки/вікна = `${kind}/${name}` */
export function refToTabId(ref: MetadataRef): string {
  return `${ref.kind}/${ref.name}`
}

/** Перша доступна секція залежно від kind обʼєкта */
export const DEFAULT_SECTION: Record<MetadataKind, string> = {
  Catalog: "main",
  Document: "main",
  Enumeration: "main",
  InformationRegister: "main",
  AccumulationRegister: "main",
  Constant: "main",
  CustomTable: "main",
}

// Базові поля для всіх типів вкладок
interface BaseTab {
  id: string
  isPinned: boolean
}

// Вкладка об'єкта метаданих (поточна поведінка)
export interface ObjectTab extends BaseTab {
  type: "object"
  objectRef: MetadataRef
  activeSection: string
}

// Вкладка SQL Preview
export interface SqlPreviewTab extends BaseTab {
  type: "sql-preview"
}

export type TabItem = ObjectTab | SqlPreviewTab

// Type guard для TypeScript narrowing
export function isObjectTab(tab: TabItem): tab is ObjectTab {
  return tab.type === "object"
}

export function isSqlPreviewTab(tab: TabItem): tab is SqlPreviewTab {
  return tab.type === "sql-preview"
}

export interface FloatingWindowPosition {
  x: number
  y: number
}

export interface FloatingWindowSize {
  width: number
  height: number
}

export interface FloatingWindow {
  id: string
  objectRef: MetadataRef
  position: FloatingWindowPosition
  size: FloatingWindowSize
  zIndex: number
  isMinimized: boolean
  isMaximized: boolean
  // Активна секція редактора per-window
  activeSection: string
}

// Z-index для floating windows починається з 30 (відповідно до z-index системи Модуля 5)
const FLOATING_WINDOW_BASE_Z = 30

const DEFAULT_WINDOW_SIZE: FloatingWindowSize = { width: 600, height: 400 }
const DEFAULT_WINDOW_POSITION: FloatingWindowPosition = { x: 50, y: 50 }
// Зміщення для каскадного розміщення нових вікон
const WINDOW_CASCADE_OFFSET = 30

/** Знайти наступне non-minimized вікно з найвищим zIndex */
function findNextActiveWindow(
  windows: FloatingWindow[],
  excludeId?: string
): string | null {
  const candidates = windows
    .filter((w) => !w.isMinimized && w.id !== excludeId)
    .sort((a, b) => b.zIndex - a.zIndex)
  return candidates[0]?.id ?? null
}

function findActiveTab(
  tabs: TabItem[],
  activeTabId: string | null
): TabItem | null {
  if (!activeTabId) {
    return null
  }

  return tabs.find((tab) => tab.id === activeTabId) ?? null
}

function findActiveWindow(
  windows: FloatingWindow[],
  activeWindowId: string | null
): FloatingWindow | null {
  if (!activeWindowId) {
    return null
  }

  return windows.find((window) => window.id === activeWindowId) ?? null
}

function resolveSelectionAfterClosedRef(
  state: Pick<
    UiState,
    "selectedObject" | "selectedTabularSection" | "selectedField"
  >,
  closedRef: MetadataRef,
  openTabs: TabItem[],
  activeTabId: string | null,
  floatingWindows: FloatingWindow[],
  activeWindowId: string | null
): Pick<
  UiState,
  "selectedObject" | "selectedTabularSection" | "selectedField"
> {
  const selectedTabularSection =
    state.selectedTabularSection &&
    isSameRef(state.selectedTabularSection.objectRef, closedRef)
      ? null
      : state.selectedTabularSection

  const selectedField =
    state.selectedField && isSameRef(state.selectedField.objectRef, closedRef)
      ? null
      : state.selectedField

  const activeWindow = findActiveWindow(floatingWindows, activeWindowId)
  const activeTab = findActiveTab(openTabs, activeTabId)
  const selectedObject =
    selectedField?.objectRef ??
    selectedTabularSection?.objectRef ??
    (state.selectedObject && !isSameRef(state.selectedObject, closedRef)
      ? state.selectedObject
      : null) ??
    activeWindow?.objectRef ??
    (activeTab && isObjectTab(activeTab) ? activeTab.objectRef : null) ??
    null

  return {
    selectedObject,
    selectedTabularSection,
    selectedField,
  }
}

function isSameRef(
  left: MetadataRef | null | undefined,
  right: MetadataRef | null | undefined
): boolean {
  return left?.kind === right?.kind && left?.name === right?.name
}

export function findMetadataObject(
  model: ProjectModel,
  ref: MetadataRef | null | undefined
): MetadataObject | null {
  if (!ref) {
    return null
  }

  const key = KIND_TO_KEY[ref.kind]
  const objects = model[key] as MetadataObject[]
  return objects.find((candidate) => candidate.name === ref.name) ?? null
}

export function findTabularSection(
  model: ProjectModel,
  selection: TabularSectionSelection | null | undefined
): TabularSection | null {
  if (!selection) {
    return null
  }

  const object = findMetadataObject(model, selection.objectRef)
  if (!object || !("tabularSections" in object)) {
    return null
  }

  return (
    (object.tabularSections as TabularSection[]).find(
      (candidate) => candidate.name === selection.tabularSectionName
    ) ?? null
  )
}

function areTabularSectionsEquivalentExceptName(
  left: TabularSection,
  right: TabularSection
): boolean {
  const leftRest = { ...left }
  const rightRest = { ...right }
  delete leftRest.name
  delete rightRest.name
  return JSON.stringify(leftRest) === JSON.stringify(rightRest)
}

function resolveRenamedTabularSectionName(
  previousModel: ProjectModel | undefined,
  nextModel: ProjectModel,
  objectRef: MetadataRef,
  previousSectionName: string
): string | null {
  if (!previousModel) {
    return null
  }

  const previousObject = findMetadataObject(previousModel, objectRef)
  const nextObject = findMetadataObject(nextModel, objectRef)
  if (
    !previousObject ||
    !nextObject ||
    !("tabularSections" in previousObject) ||
    !("tabularSections" in nextObject)
  ) {
    return null
  }

  const previousSections = previousObject.tabularSections as TabularSection[]
  const nextSections = nextObject.tabularSections as TabularSection[]
  const previousIndex = previousSections.findIndex(
    (section) => section.name === previousSectionName
  )

  if (previousIndex === -1 || previousSections.length !== nextSections.length) {
    return null
  }

  const previousSection = previousSections[previousIndex]
  const nextSection = nextSections[previousIndex]

  if (!nextSection || nextSection.name === previousSectionName) {
    return null
  }

  if (!areTabularSectionsEquivalentExceptName(previousSection, nextSection)) {
    return null
  }

  return nextSection.name
}

function findTopLevelField(
  model: ProjectModel,
  objectRef: MetadataRef,
  fieldName: string
): { name: string } | null {
  const object = findMetadataObject(model, objectRef)

  if (!object) {
    return null
  }

  if ("attributes" in object) {
    const attribute = object.attributes.find(
      (candidate) => candidate.name === fieldName
    )
    if (attribute) {
      return attribute
    }
  }

  if ("dimensions" in object) {
    const dimension = object.dimensions.find(
      (candidate) => candidate.name === fieldName
    )
    if (dimension) {
      return dimension
    }
  }

  if ("resources" in object) {
    const resource = object.resources.find(
      (candidate) => candidate.name === fieldName
    )
    if (resource) {
      return resource
    }
  }

  return null
}

export interface UiState {
  // Вибраний обʼєкт у дереві
  selectedObject: MetadataRef | null
  // Вибрана таблична частина у межах обʼєкта
  selectedTabularSection: TabularSectionSelection | null
  // Вибране поле в таблиці атрибутів
  selectedField: FieldSelection | null
  // Розгорнуті вузли дерева (kind як кореневий розділ)
  expandedTreeNodes: string[]
  // Пошуковий запит у дереві
  searchQuery: string
  // Чи відкрита панель властивостей
  propertiesPanelOpen: boolean
  // Розкладка 3-panel layout у відсотках від ширини контейнера
  panelLayout: Layout
  // Чи відкрита Command Palette
  commandPaletteOpen: boolean
  // Останній активний фокус (для scoped hotkeys)
  focusedPanel: PanelId | null

  // --- Window management ---
  openTabs: TabItem[]
  activeTabId: string | null
  floatingWindows: FloatingWindow[]
  /** Id активного floating window (або null якщо активна tab) */
  activeWindowId: string | null
  /** Лічильник z-index для коректного z-order floating windows */
  nextWindowZIndex: number
}

export interface UiActions {
  selectObject: (ref: MetadataRef | null) => void
  selectTabularSection: (selection: TabularSectionSelection | null) => void
  selectField: (field: FieldSelection | null) => void
  reconcileSelectionWithModel: (
    model: ProjectModel,
    previousModel?: ProjectModel
  ) => void
  setExpandedTreeNodes: (nodes: string[]) => void
  toggleTreeNode: (nodeId: string) => void
  setSearchQuery: (query: string) => void
  /** Встановити активну секцію для поточного tab/window */
  setActiveSection: (section: string) => void
  setPropertiesPanelOpen: (open: boolean) => void
  setPanelLayout: (layout: Layout) => void
  togglePropertiesPanel: () => void
  setCommandPaletteOpen: (open: boolean) => void
  toggleCommandPalette: () => void
  setFocusedPanel: (panel: PanelId | null) => void

  // --- Tab lifecycle ---
  /** Відкрити вкладку або активувати існуючу */
  openTab: (ref: MetadataRef) => void
  /** Відкрити SQL Preview вкладку */
  openSqlPreview: () => void
  /** Закрити вкладку */
  closeTab: (tabId: string) => void
  /** Закрити всі вкладки крім зазначеної */
  closeOtherTabs: (tabId: string) => void
  /** Закрити всі вкладки (крім pinned) */
  closeAllTabs: () => void
  /** Закрити вкладки праворуч від зазначеної */
  closeTabsToRight: (tabId: string) => void
  /** Встановити активну вкладку */
  setActiveTab: (tabId: string | null) => void
  /** Закріпити вкладку */
  pinTab: (tabId: string) => void
  /** Відкріпити вкладку */
  unpinTab: (tabId: string) => void
  /** Змінити порядок вкладок */
  reorderTabs: (fromIndex: number, toIndex: number) => void
  /** Оновити objectRef вкладки (при перейменуванні обʼєкта) */
  updateTabObjectRef: (oldRef: MetadataRef, newRef: MetadataRef) => void

  // --- Floating window lifecycle ---
  /** Відʼєднати вкладку у floating window */
  detachTab: (tabId: string) => void
  /** Прикріпити floating window як вкладку */
  attachWindow: (windowId: string) => void
  /** Закрити floating window */
  closeWindow: (windowId: string) => void
  /** Мінімізувати floating window */
  minimizeWindow: (windowId: string) => void
  /** Максимізувати floating window */
  maximizeWindow: (windowId: string) => void
  /** Відновити floating window з мінімізованого/максимізованого стану */
  restoreWindow: (windowId: string) => void
  /** Підняти floating window на передній план */
  focusWindow: (windowId: string) => void
  /** Перемістити floating window */
  moveWindow: (windowId: string, position: FloatingWindowPosition) => void
  /** Змінити розмір floating window */
  resizeWindow: (windowId: string, size: FloatingWindowSize) => void

  // --- Unified ---
  /** Знайти обʼєкт серед tabs/windows і активувати; якщо немає — відкрити вкладку */
  focusEntity: (ref: MetadataRef) => void
  /** Закрити всі вкладки та вікна для обʼєкта (при видаленні) */
  closeAllForObject: (ref: MetadataRef) => void
}

// Кореневі розділи розгорнуті за замовчуванням
const DEFAULT_EXPANDED: string[] = [
  "Catalog",
  "Document",
  "Enumeration",
  "InformationRegister",
  "AccumulationRegister",
  "Constant",
  "CustomTable",
] satisfies MetadataKind[]

export const DEFAULT_PANEL_LAYOUT: Layout = {
  tree: 20,
  editor: 50,
  properties: 30,
}

export const UI_STORE_STORAGE_KEY = "simetra-ui"

export type UiStore = UiState & UiActions

export const useUiStore = create<UiStore>()(
  persist(
    (set, get) => ({
      selectedObject: null,
      selectedTabularSection: null,
      selectedField: null,
      expandedTreeNodes: DEFAULT_EXPANDED,
      searchQuery: "",
      propertiesPanelOpen: true,
      panelLayout: DEFAULT_PANEL_LAYOUT,
      commandPaletteOpen: false,
      focusedPanel: null,

      // Window management defaults
      openTabs: [],
      activeTabId: null,
      floatingWindows: [],
      activeWindowId: null,
      nextWindowZIndex: FLOATING_WINDOW_BASE_Z,

      selectObject: (ref) =>
        set({
          selectedObject: ref,
          // Скинути вибір поля при зміні обʼєкта (але НЕ скидати activeSection)
          selectedTabularSection: null,
          selectedField: null,
        }),

      selectTabularSection: (selection) =>
        set((state) => ({
          selectedObject: selection?.objectRef ?? state.selectedObject,
          selectedTabularSection: selection,
          selectedField: null,
        })),

      selectField: (field) =>
        set((state) => ({
          selectedObject: field?.objectRef ?? state.selectedObject,
          selectedTabularSection: null,
          selectedField: field,
        })),

      reconcileSelectionWithModel: (model, previousModel) =>
        set((state) => {
          let selectedObject = state.selectedObject
          let selectedTabularSection = state.selectedTabularSection
          let selectedField = state.selectedField
          let fallbackObjectRef: MetadataRef | null = null
          let hasChanges = false

          if (selectedTabularSection) {
            const renamedSectionName =
              findTabularSection(model, selectedTabularSection) === null
                ? resolveRenamedTabularSectionName(
                    previousModel,
                    model,
                    selectedTabularSection.objectRef,
                    selectedTabularSection.tabularSectionName
                  )
                : null

            if (renamedSectionName) {
              selectedTabularSection = {
                ...selectedTabularSection,
                tabularSectionName: renamedSectionName,
              }
              hasChanges = true
            } else if (!findTabularSection(model, selectedTabularSection)) {
              fallbackObjectRef = selectedTabularSection.objectRef
              selectedTabularSection = null
              hasChanges = true
            }
          }

          if (selectedField?.tabularSectionName) {
            const previousField = selectedField
            let resolvedSectionName = selectedField.tabularSectionName
            let resolvedSection = findTabularSection(model, {
              objectRef: selectedField.objectRef,
              tabularSectionName: selectedField.tabularSectionName,
            })

            if (!resolvedSection) {
              const renamedSectionName = resolveRenamedTabularSectionName(
                previousModel,
                model,
                selectedField.objectRef,
                selectedField.tabularSectionName
              )

              if (renamedSectionName) {
                resolvedSectionName = renamedSectionName
                resolvedSection = findTabularSection(model, {
                  objectRef: selectedField.objectRef,
                  tabularSectionName: renamedSectionName,
                })
              }
            }

            const fieldStillExists =
              resolvedSection?.attributes.some(
                (attribute) => attribute.name === previousField.fieldName
              ) ?? false

            if (resolvedSection && fieldStillExists) {
              if (resolvedSectionName !== previousField.tabularSectionName) {
                selectedField = {
                  ...previousField,
                  tabularSectionName: resolvedSectionName,
                }
                hasChanges = true
              }
            } else {
              fallbackObjectRef = previousField.objectRef
              selectedField = null
              hasChanges = true
            }
          } else if (selectedField) {
            const fieldStillExists = findTopLevelField(
              model,
              selectedField.objectRef,
              selectedField.fieldName
            )

            if (!fieldStillExists) {
              fallbackObjectRef = selectedField.objectRef
              selectedField = null
              hasChanges = true
            }
          }

          const nextSelectedObject =
            (selectedField && findMetadataObject(model, selectedField.objectRef)
              ? selectedField.objectRef
              : null) ??
            (selectedTabularSection &&
            findMetadataObject(model, selectedTabularSection.objectRef)
              ? selectedTabularSection.objectRef
              : null) ??
            (selectedObject && findMetadataObject(model, selectedObject)
              ? selectedObject
              : null) ??
            (fallbackObjectRef && findMetadataObject(model, fallbackObjectRef)
              ? fallbackObjectRef
              : null)

          if (!isSameRef(selectedObject, nextSelectedObject)) {
            selectedObject = nextSelectedObject
            hasChanges = true
          }

          if (!hasChanges) {
            return state
          }

          return {
            selectedObject,
            selectedTabularSection,
            selectedField,
          }
        }),

      setExpandedTreeNodes: (nodes) => set({ expandedTreeNodes: nodes }),

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

      setSearchQuery: (query) => set({ searchQuery: query }),

      setActiveSection: (section) =>
        set((state) => {
          // Встановити activeSection для поточного активного tab або window
          if (state.activeWindowId) {
            return {
              floatingWindows: state.floatingWindows.map((w) =>
                w.id === state.activeWindowId
                  ? { ...w, activeSection: section }
                  : w
              ),
            }
          }
          if (state.activeTabId) {
            return {
              openTabs: state.openTabs.map((t) =>
                t.id === state.activeTabId && isObjectTab(t)
                  ? { ...t, activeSection: section }
                  : t
              ),
            }
          }
          return state
        }),

      setPropertiesPanelOpen: (open) => set({ propertiesPanelOpen: open }),

      setPanelLayout: (layout) => set({ panelLayout: layout }),

      togglePropertiesPanel: () =>
        set((state) => ({ propertiesPanelOpen: !state.propertiesPanelOpen })),

      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

      toggleCommandPalette: () =>
        set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),

      setFocusedPanel: (panel) => set({ focusedPanel: panel }),

      // --- Tab lifecycle ---

      openTab: (ref) => {
        const tabId = refToTabId(ref)
        const { openTabs } = get()
        const existing = openTabs.find((t) => t.id === tabId)
        if (existing) {
          // Вкладка вже відкрита — просто активувати
          set({
            activeTabId: tabId,
            activeWindowId: null,
            selectedObject: ref,
            selectedTabularSection: null,
            selectedField: null,
          })
          return
        }
        const tab: TabItem = {
          id: tabId,
          type: "object",
          objectRef: ref,
          isPinned: false,
          activeSection: DEFAULT_SECTION[ref.kind],
        }
        set({
          openTabs: [...openTabs, tab],
          activeTabId: tabId,
          activeWindowId: null,
          selectedObject: ref,
          selectedTabularSection: null,
          selectedField: null,
        })
      },

      openSqlPreview: () => {
        const sqlTabId = "__sql-preview__"
        const { openTabs } = get()
        const existing = openTabs.find((t) => t.id === sqlTabId)
        if (existing) {
          set({ activeTabId: sqlTabId, activeWindowId: null })
          return
        }
        const tab: SqlPreviewTab = {
          id: sqlTabId,
          type: "sql-preview",
          isPinned: false,
        }
        set({
          openTabs: [...openTabs, tab],
          activeTabId: sqlTabId,
          activeWindowId: null,
        })
      },

      closeTab: (tabId) =>
        set((state) => {
          const idx = state.openTabs.findIndex((t) => t.id === tabId)
          if (idx === -1) return state

          const closedTab = state.openTabs[idx]

          const newTabs = state.openTabs.filter((t) => t.id !== tabId)
          let newActiveTabId = state.activeTabId

          // Якщо закриваємо активну вкладку — вибрати сусідню
          if (state.activeTabId === tabId) {
            if (newTabs.length === 0) {
              newActiveTabId = null
            } else if (idx >= newTabs.length) {
              newActiveTabId = newTabs[newTabs.length - 1].id
            } else {
              newActiveTabId = newTabs[idx].id
            }
          }

          // Тільки для object tabs потрібен selection reconciliation
          const selectionState = isObjectTab(closedTab)
            ? resolveSelectionAfterClosedRef(
                state,
                closedTab.objectRef,
                newTabs,
                newActiveTabId,
                state.floatingWindows,
                state.activeWindowId
              )
            : {}

          return {
            openTabs: newTabs,
            activeTabId: newActiveTabId,
            ...selectionState,
          }
        }),

      closeOtherTabs: (tabId) =>
        set((state) => {
          const kept = state.openTabs.filter(
            (t) => t.id === tabId || t.isPinned
          )
          const activeTab = kept.find((t) => t.id === tabId) ?? kept[0]
          return {
            openTabs: kept,
            activeTabId: activeTab?.id ?? null,
            selectedObject:
              activeTab && isObjectTab(activeTab) ? activeTab.objectRef : null,
            selectedTabularSection: null,
            selectedField: null,
          }
        }),

      closeAllTabs: () =>
        set((state) => {
          const pinned = state.openTabs.filter((t) => t.isPinned)
          const activeTab = pinned[0]
          return {
            openTabs: pinned,
            activeTabId: activeTab?.id ?? null,
            selectedObject:
              activeTab && isObjectTab(activeTab) ? activeTab.objectRef : null,
            selectedTabularSection: null,
            selectedField: null,
          }
        }),

      closeTabsToRight: (tabId) =>
        set((state) => {
          const idx = state.openTabs.findIndex((t) => t.id === tabId)
          if (idx === -1) return state

          const kept = state.openTabs.filter((t, i) => i <= idx || t.isPinned)
          const hasActive = kept.some((t) => t.id === state.activeTabId)
          const newActiveTabId = hasActive ? state.activeTabId : tabId

          const activeTab = kept.find((t) => t.id === newActiveTabId)
          return {
            openTabs: kept,
            activeTabId: newActiveTabId,
            selectedObject:
              activeTab && isObjectTab(activeTab) ? activeTab.objectRef : null,
            selectedTabularSection: null,
            selectedField: null,
          }
        }),

      setActiveTab: (tabId) =>
        set((state) => {
          if (tabId === null) {
            return {
              activeTabId: null,
              activeWindowId: null,
              selectedObject: null,
              selectedTabularSection: null,
              selectedField: null,
            }
          }
          const tab = state.openTabs.find((t) => t.id === tabId)
          if (!tab) return state
          return {
            activeTabId: tabId,
            activeWindowId: null,
            selectedObject: isObjectTab(tab) ? tab.objectRef : null,
            selectedTabularSection: null,
            selectedField: null,
          }
        }),

      pinTab: (tabId) =>
        set((state) => ({
          openTabs: state.openTabs.map((t) =>
            t.id === tabId ? { ...t, isPinned: true } : t
          ),
        })),

      unpinTab: (tabId) =>
        set((state) => ({
          openTabs: state.openTabs.map((t) =>
            t.id === tabId ? { ...t, isPinned: false } : t
          ),
        })),

      reorderTabs: (fromIndex, toIndex) =>
        set((state) => {
          if (
            fromIndex < 0 ||
            fromIndex >= state.openTabs.length ||
            toIndex < 0 ||
            toIndex >= state.openTabs.length
          ) {
            return state
          }
          const tabs = [...state.openTabs]
          const [moved] = tabs.splice(fromIndex, 1)
          tabs.splice(toIndex, 0, moved)
          return { openTabs: tabs }
        }),

      updateTabObjectRef: (oldRef, newRef) =>
        set((state) => {
          const oldTabId = refToTabId(oldRef)
          const newTabId = refToTabId(newRef)

          const hasTab =
            state.openTabs.findIndex((t) => t.id === oldTabId) !== -1
          const oldWindowId = `window-${oldTabId}`
          const newWindowId = `window-${newTabId}`

          const newTabs = hasTab
            ? state.openTabs.map((t) =>
                t.id === oldTabId && isObjectTab(t)
                  ? { ...t, id: newTabId, objectRef: newRef }
                  : t
              )
            : state.openTabs
          const newActiveTabId =
            hasTab && state.activeTabId === oldTabId
              ? newTabId
              : state.activeTabId

          // Оновити floating windows незалежно від наявності вкладки
          const newWindows = state.floatingWindows.map((w) =>
            w.id === oldWindowId
              ? { ...w, id: newWindowId, objectRef: newRef }
              : w
          )
          const newActiveWindowId =
            state.activeWindowId === oldWindowId
              ? newWindowId
              : state.activeWindowId

          return {
            openTabs: newTabs,
            activeTabId: newActiveTabId,
            floatingWindows: newWindows,
            activeWindowId: newActiveWindowId,
            selectedObject: isSameRef(state.selectedObject, oldRef)
              ? newRef
              : state.selectedObject,
            selectedTabularSection:
              state.selectedTabularSection &&
              isSameRef(state.selectedTabularSection.objectRef, oldRef)
                ? {
                    ...state.selectedTabularSection,
                    objectRef: newRef,
                  }
                : state.selectedTabularSection,
            selectedField:
              state.selectedField &&
              isSameRef(state.selectedField.objectRef, oldRef)
                ? {
                    ...state.selectedField,
                    objectRef: newRef,
                  }
                : state.selectedField,
          }
        }),

      // --- Floating window lifecycle ---

      detachTab: (tabId) =>
        set((state) => {
          const tab = state.openTabs.find((t) => t.id === tabId)
          // SQL Preview та інші non-object tabs не detach-аються
          if (!tab || !isObjectTab(tab)) return state

          const windowId = `window-${tab.id}`
          // Обʼєкт вже у floating window — не дублювати
          if (state.floatingWindows.some((w) => w.id === windowId)) return state

          // Каскадне зміщення позиції для нових вікон
          const offset = state.floatingWindows.length * WINDOW_CASCADE_OFFSET
          const newZIndex = state.nextWindowZIndex

          const win: FloatingWindow = {
            id: windowId,
            objectRef: tab.objectRef,
            position: {
              x: DEFAULT_WINDOW_POSITION.x + offset,
              y: DEFAULT_WINDOW_POSITION.y + offset,
            },
            size: { ...DEFAULT_WINDOW_SIZE },
            zIndex: newZIndex,
            isMinimized: false,
            isMaximized: false,
            activeSection: tab.activeSection,
          }

          // Видалити вкладку з tabs
          const newTabs = state.openTabs.filter((t) => t.id !== tabId)
          const idx = state.openTabs.findIndex((t) => t.id === tabId)
          let newActiveTabId = state.activeTabId

          if (state.activeTabId === tabId) {
            if (newTabs.length === 0) {
              newActiveTabId = null
            } else if (idx >= newTabs.length) {
              newActiveTabId = newTabs[newTabs.length - 1].id
            } else {
              newActiveTabId = newTabs[idx].id
            }
          }

          return {
            openTabs: newTabs,
            activeTabId: newActiveTabId,
            activeWindowId: windowId,
            floatingWindows: [...state.floatingWindows, win],
            nextWindowZIndex: newZIndex + 1,
            selectedObject: win.objectRef,
            selectedTabularSection: null,
            selectedField: null,
          }
        }),

      attachWindow: (windowId) =>
        set((state) => {
          const win = state.floatingWindows.find((w) => w.id === windowId)
          if (!win) return state

          const tabId = refToTabId(win.objectRef)
          const remainingWindows = state.floatingWindows.filter(
            (w) => w.id !== windowId
          )
          const newActiveWindowId =
            state.activeWindowId === windowId ? null : state.activeWindowId

          // Вже є вкладка з таким id — просто закрити вікно
          if (state.openTabs.some((t) => t.id === tabId)) {
            return {
              floatingWindows: remainingWindows,
              activeTabId: tabId,
              activeWindowId: newActiveWindowId,
              selectedObject: win.objectRef,
              selectedTabularSection: null,
              selectedField: null,
            }
          }

          const tab: TabItem = {
            id: tabId,
            type: "object",
            objectRef: win.objectRef,
            isPinned: false,
            activeSection: win.activeSection,
          }

          return {
            openTabs: [...state.openTabs, tab],
            activeTabId: tabId,
            floatingWindows: remainingWindows,
            activeWindowId: newActiveWindowId,
            selectedObject: win.objectRef,
            selectedTabularSection: null,
            selectedField: null,
          }
        }),

      closeWindow: (windowId) =>
        set((state) => {
          const closedWindow = state.floatingWindows.find(
            (w) => w.id === windowId
          )
          if (!closedWindow) {
            return state
          }

          const remainingWindows = state.floatingWindows.filter(
            (w) => w.id !== windowId
          )

          if (state.activeWindowId !== windowId) {
            return { floatingWindows: remainingWindows }
          }

          const nextWindowId = findNextActiveWindow(remainingWindows)
          const selectionState = resolveSelectionAfterClosedRef(
            state,
            closedWindow.objectRef,
            state.openTabs,
            state.activeTabId,
            remainingWindows,
            nextWindowId
          )

          return {
            floatingWindows: remainingWindows,
            activeWindowId: nextWindowId,
            ...selectionState,
          }
        }),

      minimizeWindow: (windowId) =>
        set((state) => {
          const newWindows = state.floatingWindows.map((w) =>
            w.id === windowId
              ? { ...w, isMinimized: true, isMaximized: false }
              : w
          )

          if (state.activeWindowId !== windowId) {
            return { floatingWindows: newWindows }
          }

          const nextWindowId = findNextActiveWindow(newWindows)
          const nextWindow = nextWindowId
            ? newWindows.find((w) => w.id === nextWindowId)
            : null

          const activeTab =
            !nextWindow && state.activeTabId
              ? state.openTabs.find((t) => t.id === state.activeTabId)
              : null

          return {
            floatingWindows: newWindows,
            activeWindowId: nextWindowId,
            selectedObject:
              nextWindow?.objectRef ??
              (activeTab && isObjectTab(activeTab)
                ? activeTab.objectRef
                : null) ??
              null,
            selectedTabularSection: null,
            selectedField: null,
          }
        }),

      maximizeWindow: (windowId) =>
        set((state) => ({
          floatingWindows: state.floatingWindows.map((w) =>
            w.id === windowId
              ? { ...w, isMaximized: true, isMinimized: false }
              : w
          ),
        })),

      restoreWindow: (windowId) =>
        set((state) => ({
          floatingWindows: state.floatingWindows.map((w) =>
            w.id === windowId
              ? { ...w, isMinimized: false, isMaximized: false }
              : w
          ),
        })),

      focusWindow: (windowId) =>
        set((state) => {
          const win = state.floatingWindows.find((w) => w.id === windowId)
          const newZIndex = state.nextWindowZIndex
          return {
            floatingWindows: state.floatingWindows.map((w) =>
              w.id === windowId ? { ...w, zIndex: newZIndex } : w
            ),
            nextWindowZIndex: newZIndex + 1,
            activeWindowId: windowId,
            selectedObject: win?.objectRef ?? state.selectedObject,
            selectedTabularSection: null,
            selectedField: null,
          }
        }),

      moveWindow: (windowId, position) =>
        set((state) => ({
          floatingWindows: state.floatingWindows.map((w) =>
            w.id === windowId ? { ...w, position } : w
          ),
        })),

      resizeWindow: (windowId, size) =>
        set((state) => ({
          floatingWindows: state.floatingWindows.map((w) =>
            w.id === windowId ? { ...w, size } : w
          ),
        })),

      // --- Unified ---

      focusEntity: (ref) => {
        const tabId = refToTabId(ref)
        const { openTabs, floatingWindows } = get()

        // Спочатку шукати серед вкладок
        if (openTabs.some((t) => t.id === tabId)) {
          set({
            activeTabId: tabId,
            activeWindowId: null,
            selectedObject: ref,
            selectedTabularSection: null,
            selectedField: null,
          })
          return
        }

        // Потім серед floating windows — делегуємо до існуючих actions
        const windowId = `window-${tabId}`
        const win = floatingWindows.find((w) => w.id === windowId)
        if (win) {
          if (win.isMinimized) get().restoreWindow(windowId)
          get().focusWindow(windowId)
          return
        }

        // Не знайдено — відкрити нову вкладку
        get().openTab(ref)
      },

      closeAllForObject: (ref) =>
        set((state) => {
          const tabId = refToTabId(ref)
          const windowId = `window-${tabId}`

          const hasTab = state.openTabs.some((t) => t.id === tabId)
          const hasWindow = state.floatingWindows.some((w) => w.id === windowId)

          if (!hasTab && !hasWindow) return state

          const newTabs = hasTab
            ? state.openTabs.filter((t) => t.id !== tabId)
            : state.openTabs
          const newWindows = hasWindow
            ? state.floatingWindows.filter((w) => w.id !== windowId)
            : state.floatingWindows

          // Перерахувати активну вкладку, якщо закрили активну
          let newActiveTabId = state.activeTabId
          if (hasTab && state.activeTabId === tabId) {
            const idx = state.openTabs.findIndex((t) => t.id === tabId)
            if (newTabs.length === 0) {
              newActiveTabId = null
            } else if (idx >= newTabs.length) {
              newActiveTabId = newTabs[newTabs.length - 1].id
            } else {
              newActiveTabId = newTabs[idx].id
            }
          }

          // Скинути activeWindowId, якщо закрили активне вікно
          const newActiveWindowId =
            hasWindow && state.activeWindowId === windowId
              ? findNextActiveWindow(newWindows)
              : state.activeWindowId

          const selectionState = resolveSelectionAfterClosedRef(
            state,
            ref,
            newTabs,
            newActiveTabId,
            newWindows,
            newActiveWindowId
          )

          return {
            openTabs: newTabs,
            floatingWindows: newWindows,
            activeTabId: newActiveTabId,
            activeWindowId: newActiveWindowId,
            ...selectionState,
          }
        }),
    }),
    {
      name: UI_STORE_STORAGE_KEY,
      version: 3,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>
        if (version < 2) {
          // v1 → v2: оновити layout defaults з 20/55/25 на 20/50/30
          const layout = state.panelLayout as Layout | undefined
          if (
            layout &&
            layout.tree === 20 &&
            layout.editor === 55 &&
            layout.properties === 25
          ) {
            state.panelLayout = { ...DEFAULT_PANEL_LAYOUT }
          }
        }
        if (version < 3) {
          // v2 → v3: activeEditorTab перенесено у per-tab activeSection
          delete state.activeEditorTab
        }
        return state
      },
      partialize: (state) => ({
        expandedTreeNodes: state.expandedTreeNodes,
        propertiesPanelOpen: state.propertiesPanelOpen,
        panelLayout: state.panelLayout,
      }),
    }
  )
)
