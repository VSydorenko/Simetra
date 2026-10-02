import { beforeEach, describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { projectModelSchema, type ProjectModel } from "@simetra/core"
import "../i18n"
import { PropertiesPanel } from "../components/layout/properties-panel"
import { TabularSectionProperties } from "../components/properties/tabular-section-properties"
import { useMetadataStore } from "../stores/metadata-store"
import { DEFAULT_PANEL_LAYOUT, useUiStore } from "../stores/ui-store"

const DEFAULT_EXPANDED = [
  "Catalog",
  "Document",
  "Enumeration",
  "InformationRegister",
  "AccumulationRegister",
  "Constant",
  "CustomTable",
]

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
            displayName: { uk: "Рядки", en: "Rows" },
            attributes: [],
          },
        ],
      },
    ],
  })
}

beforeEach(() => {
  localStorage.clear()
  useMetadataStore.getState().loadModel(createModel())
  useUiStore.setState({
    openTabs: [],
    activeTabId: null,
    floatingWindows: [],
    activeWindowId: null,
    nextWindowZIndex: 30,
    selectedObject: { kind: "Catalog", name: "Products" },
    selectedTabularSection: {
      objectRef: { kind: "Catalog", name: "Products" },
      tabularSectionName: "GhostSection",
    },
    selectedField: null,
    expandedTreeNodes: DEFAULT_EXPANDED,
    propertiesPanelOpen: true,
    panelLayout: DEFAULT_PANEL_LAYOUT,
    searchQuery: "",
    commandPaletteOpen: false,
    focusedPanel: null,
  })
})

describe("PropertiesPanel", () => {
  it("TabularSectionProperties рендерить technical name, displayName і кнопку Standard Attributes", () => {
    render(
      <TabularSectionProperties
        selection={{
          objectRef: { kind: "Catalog", name: "Products" },
          tabularSectionName: "items",
        }}
      />
    )

    expect(screen.getByDisplayValue("items")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Рядки")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Rows")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Стандартні реквізити" })
    ).toBeInTheDocument()
  })

  it("рендерить TabularSectionProperties коли selectedTabularSection задано", () => {
    useUiStore.setState({
      selectedObject: { kind: "Catalog", name: "Products" },
      selectedTabularSection: {
        objectRef: { kind: "Catalog", name: "Products" },
        tabularSectionName: "items",
      },
      selectedField: null,
    })

    render(<PropertiesPanel />)

    expect(screen.getByDisplayValue("items")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Рядки")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Стандартні реквізити" })
    ).toBeInTheDocument()
  })

  it("не лишається порожньою при stale selectedTabularSection", () => {
    render(<PropertiesPanel />)

    expect(screen.queryByText("GhostSection")).not.toBeInTheDocument()
    expect(screen.getByDisplayValue("Products")).toBeInTheDocument()
  })
})
