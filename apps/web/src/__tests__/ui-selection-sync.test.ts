import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { projectModelSchema, type ProjectModel } from "@simetra/core"
import { useMetadataStore } from "../stores/metadata-store"
import { startUiSelectionSync } from "../stores/ui-selection-sync"
import {
  DEFAULT_PANEL_LAYOUT,
  useUiStore,
  type TabularSectionSelection,
} from "../stores/ui-store"

const DEFAULT_EXPANDED = [
  "Catalog",
  "Document",
  "Enumeration",
  "InformationRegister",
  "AccumulationRegister",
  "Constant",
  "CustomTable",
]

const objectRef = { kind: "Catalog", name: "Products" } as const

function createModel(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: "TestProject" },
    catalogs: [
      {
        kind: "Catalog",
        name: "Products",
        codeLength: 9,
        codeType: "String",
        descriptionLength: 100,
        hierarchyType: "None",
        attributes: [],
        tabularSections: [
          {
            name: "items",
            displayName: { uk: "Рядки" },
            attributes: [
              {
                name: "quantity",
                type: "Numeric",
                required: false,
                indexed: false,
                unique: false,
                defaultValue: null,
              },
            ],
          },
          {
            name: "services",
            attributes: [],
          },
        ],
      },
    ],
  })
}

function resetUiStore(): void {
  useUiStore.setState({
    openTabs: [],
    activeTabId: null,
    floatingWindows: [],
    activeWindowId: null,
    nextWindowZIndex: 30,
    selectedObject: null,
    selectedTabularSection: null,
    selectedField: null,
    expandedTreeNodes: DEFAULT_EXPANDED,
    propertiesPanelOpen: true,
    panelLayout: DEFAULT_PANEL_LAYOUT,
    searchQuery: "",
    commandPaletteOpen: false,
    focusedPanel: null,
  })
}

describe("ui selection sync", () => {
  let stopSync: (() => void) | null = null

  beforeEach(() => {
    localStorage.clear()
    useMetadataStore.getState().loadModel(createModel())
    useMetadataStore.temporal.getState().clear()
    resetUiStore()
    stopSync = startUiSelectionSync()
  })

  afterEach(() => {
    stopSync?.()
    stopSync = null
  })

  it("оновлює selectedTabularSection після rename і history undo/redo", () => {
    const selection: TabularSectionSelection = {
      objectRef,
      tabularSectionName: "items",
    }

    useUiStore.getState().selectTabularSection(selection)

    useMetadataStore
      .getState()
      .renameTabularSection("Catalog", "Products", "items", "lines")

    expect(useUiStore.getState().selectedTabularSection).toEqual({
      objectRef,
      tabularSectionName: "lines",
    })

    useMetadataStore.temporal.getState().undo()

    expect(useUiStore.getState().selectedTabularSection).toEqual(selection)

    useMetadataStore.temporal.getState().redo()

    expect(useUiStore.getState().selectedTabularSection).toEqual({
      objectRef,
      tabularSectionName: "lines",
    })
  })

  it("оновлює selectedField.tabularSectionName після rename і history undo/redo", () => {
    useUiStore.getState().selectField({
      objectRef,
      fieldName: "quantity",
      tabularSectionName: "items",
    })

    useMetadataStore
      .getState()
      .renameTabularSection("Catalog", "Products", "items", "lines")

    expect(useUiStore.getState().selectedField).toEqual({
      objectRef,
      fieldName: "quantity",
      tabularSectionName: "lines",
    })
    expect(useUiStore.getState().selectedObject).toEqual(objectRef)

    useMetadataStore.temporal.getState().undo()

    expect(useUiStore.getState().selectedField).toEqual({
      objectRef,
      fieldName: "quantity",
      tabularSectionName: "items",
    })

    useMetadataStore.temporal.getState().redo()

    expect(useUiStore.getState().selectedField).toEqual({
      objectRef,
      fieldName: "quantity",
      tabularSectionName: "lines",
    })
  })

  it("скидає stale tabular-section selection до object-level після remove", () => {
    useUiStore.getState().selectTabularSection({
      objectRef,
      tabularSectionName: "items",
    })

    useMetadataStore.getState().removeTabularSection("Catalog", "Products", "items")

    expect(useUiStore.getState().selectedTabularSection).toBeNull()
    expect(useUiStore.getState().selectedObject).toEqual(objectRef)
  })

  it("скидає stale top-level field selection до object-level після remove", () => {
    useUiStore.getState().selectField({
      objectRef,
      fieldName: "sku",
    })

    useMetadataStore.getState().updateObject("Catalog", "Products", {
      attributes: [],
    })

    expect(useUiStore.getState().selectedField).toBeNull()
    expect(useUiStore.getState().selectedObject).toEqual(objectRef)
  })

  it("скидає selectedTabularSection після видалення обʼєкта", () => {
    useUiStore.getState().selectTabularSection({
      objectRef,
      tabularSectionName: "items",
    })

    useMetadataStore.getState().deleteObject("Catalog", "Products")

    expect(useUiStore.getState().selectedTabularSection).toBeNull()
    expect(useUiStore.getState().selectedObject).toBeNull()
  })
})