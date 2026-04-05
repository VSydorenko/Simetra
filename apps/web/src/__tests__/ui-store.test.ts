import { describe, it, expect, beforeEach } from "vitest"
import {
  DEFAULT_PANEL_LAYOUT,
  UI_STORE_STORAGE_KEY,
  useUiStore,
  refToTabId,
} from "../stores/ui-store"
import type { MetadataRef } from "@simetra/core"

// Хелпери для створення MetadataRef
const catalogRef = (name: string): MetadataRef => ({ kind: "Catalog", name })
const documentRef = (name: string): MetadataRef => ({ kind: "Document", name })

// Скидання стану store перед кожним тестом
beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({
    openTabs: [],
    activeTabId: null,
    floatingWindows: [],
    activeWindowId: null,
    nextWindowZIndex: 30,
    selectedObject: null,
    selectedTabularSection: null,
    selectedField: null,
    expandedTreeNodes: [
      "Catalog",
      "Document",
      "Enumeration",
      "InformationRegister",
      "AccumulationRegister",
      "Constant",
      "CustomTable",
    ],
    propertiesPanelOpen: true,
    panelLayout: DEFAULT_PANEL_LAYOUT,
    searchQuery: "",
    commandPaletteOpen: false,
    focusedPanel: null,
  })
})

// --- refToTabId ---

describe("refToTabId", () => {
  it("генерує id у форматі kind/name", () => {
    expect(refToTabId({ kind: "Catalog", name: "Products" })).toBe(
      "Catalog/Products"
    )
  })
})

describe("persisted UI preferences", () => {
  it("зберігає тільки стабільні UI налаштування", () => {
    useUiStore.setState({
      propertiesPanelOpen: false,
      panelLayout: { tree: 18, editor: 64, properties: 18 },
      expandedTreeNodes: ["Catalog", "Document"],
      openTabs: [
        {
          id: "Catalog/Products",
          objectRef: catalogRef("Products"),
          isPinned: false,
          activeSection: "main",
        },
      ],
      selectedObject: catalogRef("Products"),
    })

    const raw = localStorage.getItem(UI_STORE_STORAGE_KEY)
    expect(raw).not.toBeNull()

    const persisted = JSON.parse(raw ?? "{}") as {
      state?: Record<string, unknown>
    }

    expect(persisted.state).toMatchObject({
      propertiesPanelOpen: false,
      panelLayout: { tree: 18, editor: 64, properties: 18 },
      expandedTreeNodes: ["Catalog", "Document"],
    })
    expect(persisted.state).not.toHaveProperty("activeEditorTab")
    expect(persisted.state).not.toHaveProperty("openTabs")
    expect(persisted.state).not.toHaveProperty("selectedObject")
  })
})

describe("selection actions", () => {
  it("selectTabularSection очищає selectedField і встановлює selectedTabularSection", () => {
    useUiStore.setState({
      selectedField: {
        objectRef: catalogRef("Products"),
        fieldName: "quantity",
        tabularSectionName: "items",
      },
    })

    useUiStore.getState().selectTabularSection({
      objectRef: catalogRef("Products"),
      tabularSectionName: "items",
    })

    const state = useUiStore.getState()
    expect(state.selectedField).toBeNull()
    expect(state.selectedTabularSection).toEqual({
      objectRef: catalogRef("Products"),
      tabularSectionName: "items",
    })
  })

  it("selectObject очищає selectedTabularSection", () => {
    useUiStore.setState({
      selectedTabularSection: {
        objectRef: catalogRef("Products"),
        tabularSectionName: "items",
      },
      selectedField: {
        objectRef: catalogRef("Products"),
        fieldName: "quantity",
      },
    })

    useUiStore.getState().selectObject(documentRef("SalesOrder"))

    const state = useUiStore.getState()
    expect(state.selectedObject).toEqual(documentRef("SalesOrder"))
    expect(state.selectedTabularSection).toBeNull()
    expect(state.selectedField).toBeNull()
  })

  it("selectField очищає selectedTabularSection", () => {
    useUiStore.setState({
      selectedTabularSection: {
        objectRef: catalogRef("Products"),
        tabularSectionName: "items",
      },
    })

    useUiStore.getState().selectField({
      objectRef: catalogRef("Products"),
      fieldName: "quantity",
    })

    const state = useUiStore.getState()
    expect(state.selectedTabularSection).toBeNull()
    expect(state.selectedField).toEqual({
      objectRef: catalogRef("Products"),
      fieldName: "quantity",
    })
  })
})

// --- Tab lifecycle ---

describe("openTab", () => {
  it("відкриває нову вкладку і робить її активною", () => {
    const ref = catalogRef("Products")
    useUiStore.getState().openTab(ref)

    const state = useUiStore.getState()
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0].id).toBe("Catalog/Products")
    expect(state.openTabs[0].objectRef).toEqual(ref)
    expect(state.openTabs[0].isPinned).toBe(false)
    expect(state.activeTabId).toBe("Catalog/Products")
    expect(state.selectedObject).toEqual(ref)
  })

  it("активує існуючу вкладку замість дублювання", () => {
    const ref = catalogRef("Products")
    useUiStore.getState().openTab(ref)
    useUiStore.getState().openTab(documentRef("SalesOrder"))
    useUiStore.getState().openTab(ref)

    const state = useUiStore.getState()
    expect(state.openTabs).toHaveLength(2)
    expect(state.activeTabId).toBe("Catalog/Products")
  })

  it("відкриває кілька вкладок послідовно", () => {
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().openTab(documentRef("SalesOrder"))

    const state = useUiStore.getState()
    expect(state.openTabs).toHaveLength(2)
    expect(state.activeTabId).toBe("Document/SalesOrder")
  })
})

describe("closeTab", () => {
  it("закриває вкладку", () => {
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().closeTab("Catalog/Products")

    const state = useUiStore.getState()
    expect(state.openTabs).toHaveLength(0)
    expect(state.activeTabId).toBeNull()
  })

  it("при закритті активної вкладки — вибирає сусідню праворуч", () => {
    useUiStore.getState().openTab(catalogRef("A"))
    useUiStore.getState().openTab(catalogRef("B"))
    useUiStore.getState().openTab(catalogRef("C"))
    useUiStore.getState().setActiveTab("Catalog/B")

    useUiStore.getState().closeTab("Catalog/B")

    const state = useUiStore.getState()
    expect(state.openTabs).toHaveLength(2)
    expect(state.activeTabId).toBe("Catalog/C")
  })

  it("при закритті останньої вкладки — вибирає попередню", () => {
    useUiStore.getState().openTab(catalogRef("A"))
    useUiStore.getState().openTab(catalogRef("B"))
    // activeTabId = Catalog/B (остання)

    useUiStore.getState().closeTab("Catalog/B")

    expect(useUiStore.getState().activeTabId).toBe("Catalog/A")
  })

  it("ігнорує неіснуючий tabId", () => {
    useUiStore.getState().openTab(catalogRef("A"))
    useUiStore.getState().closeTab("nonexistent")

    expect(useUiStore.getState().openTabs).toHaveLength(1)
  })

  it("скидає selectedTabularSection для закритого обʼєкта", () => {
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().openTab(documentRef("SalesOrder"))
    useUiStore.setState({
      activeTabId: "Catalog/Products",
      selectedObject: catalogRef("Products"),
      selectedTabularSection: {
        objectRef: catalogRef("Products"),
        tabularSectionName: "items",
      },
    })

    useUiStore.getState().closeTab("Catalog/Products")

    const state = useUiStore.getState()
    expect(state.selectedTabularSection).toBeNull()
    expect(state.selectedObject).toEqual(documentRef("SalesOrder"))
  })
})

describe("closeOtherTabs", () => {
  it("закриває всі крім зазначеної", () => {
    useUiStore.getState().openTab(catalogRef("A"))
    useUiStore.getState().openTab(catalogRef("B"))
    useUiStore.getState().openTab(catalogRef("C"))

    useUiStore.getState().closeOtherTabs("Catalog/B")

    const state = useUiStore.getState()
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0].id).toBe("Catalog/B")
    expect(state.activeTabId).toBe("Catalog/B")
  })

  it("зберігає pinned вкладки", () => {
    useUiStore.getState().openTab(catalogRef("A"))
    useUiStore.getState().openTab(catalogRef("B"))
    useUiStore.getState().openTab(catalogRef("C"))
    useUiStore.getState().pinTab("Catalog/A")

    useUiStore.getState().closeOtherTabs("Catalog/C")

    const state = useUiStore.getState()
    expect(state.openTabs).toHaveLength(2)
    expect(state.openTabs.map((t) => t.id)).toContain("Catalog/A")
    expect(state.openTabs.map((t) => t.id)).toContain("Catalog/C")
  })
})

describe("closeAllTabs", () => {
  it("закриває всі крім pinned", () => {
    useUiStore.getState().openTab(catalogRef("A"))
    useUiStore.getState().openTab(catalogRef("B"))
    useUiStore.getState().openTab(catalogRef("C"))
    useUiStore.getState().pinTab("Catalog/B")

    useUiStore.getState().closeAllTabs()

    const state = useUiStore.getState()
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0].id).toBe("Catalog/B")
    expect(state.activeTabId).toBe("Catalog/B")
  })

  it("закриває всі якщо немає pinned", () => {
    useUiStore.getState().openTab(catalogRef("A"))
    useUiStore.getState().openTab(catalogRef("B"))

    useUiStore.getState().closeAllTabs()

    expect(useUiStore.getState().openTabs).toHaveLength(0)
    expect(useUiStore.getState().activeTabId).toBeNull()
  })
})

describe("closeTabsToRight", () => {
  it("закриває вкладки праворуч від зазначеної", () => {
    useUiStore.getState().openTab(catalogRef("A"))
    useUiStore.getState().openTab(catalogRef("B"))
    useUiStore.getState().openTab(catalogRef("C"))

    useUiStore.getState().closeTabsToRight("Catalog/A")

    const state = useUiStore.getState()
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0].id).toBe("Catalog/A")
  })
})

describe("pinTab / unpinTab", () => {
  it("закріплює та відкріплює вкладку", () => {
    useUiStore.getState().openTab(catalogRef("A"))

    useUiStore.getState().pinTab("Catalog/A")
    expect(useUiStore.getState().openTabs[0].isPinned).toBe(true)

    useUiStore.getState().unpinTab("Catalog/A")
    expect(useUiStore.getState().openTabs[0].isPinned).toBe(false)
  })
})

describe("reorderTabs", () => {
  it("змінює порядок вкладок", () => {
    useUiStore.getState().openTab(catalogRef("A"))
    useUiStore.getState().openTab(catalogRef("B"))
    useUiStore.getState().openTab(catalogRef("C"))

    useUiStore.getState().reorderTabs(0, 2)

    const ids = useUiStore.getState().openTabs.map((t) => t.id)
    expect(ids).toEqual(["Catalog/B", "Catalog/C", "Catalog/A"])
  })

  it("ігнорує невалідні індекси", () => {
    useUiStore.getState().openTab(catalogRef("A"))

    useUiStore.getState().reorderTabs(-1, 5)

    expect(useUiStore.getState().openTabs).toHaveLength(1)
  })
})

// --- Floating window lifecycle ---

describe("detachTab", () => {
  it("переміщує вкладку у floating window", () => {
    useUiStore.getState().openTab(catalogRef("Products"))

    useUiStore.getState().detachTab("Catalog/Products")

    const state = useUiStore.getState()
    expect(state.openTabs).toHaveLength(0)
    expect(state.floatingWindows).toHaveLength(1)
    expect(state.floatingWindows[0].id).toBe("window-Catalog/Products")
    expect(state.floatingWindows[0].objectRef).toEqual(catalogRef("Products"))
    expect(state.floatingWindows[0].isMinimized).toBe(false)
    expect(state.floatingWindows[0].isMaximized).toBe(false)
  })

  it("не дублює якщо вікно вже існує", () => {
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().detachTab("Catalog/Products")

    // Знову відкрити і спробувати detach
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().detachTab("Catalog/Products")

    expect(useUiStore.getState().floatingWindows).toHaveLength(1)
  })

  it("при detach активної вкладки — вибирає сусідню", () => {
    useUiStore.getState().openTab(catalogRef("A"))
    useUiStore.getState().openTab(catalogRef("B"))
    useUiStore.getState().setActiveTab("Catalog/A")

    useUiStore.getState().detachTab("Catalog/A")

    expect(useUiStore.getState().activeTabId).toBe("Catalog/B")
  })
})

describe("attachWindow", () => {
  it("повертає floating window у Tab Bar", () => {
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().detachTab("Catalog/Products")

    useUiStore.getState().attachWindow("window-Catalog/Products")

    const state = useUiStore.getState()
    expect(state.floatingWindows).toHaveLength(0)
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0].id).toBe("Catalog/Products")
    expect(state.activeTabId).toBe("Catalog/Products")
  })

  it("при існуючій вкладці — просто закриває вікно", () => {
    useUiStore.getState().openTab(catalogRef("Products"))
    // Вручну додати floating window для того ж обʼєкта
    useUiStore.setState((s) => ({
      floatingWindows: [
        ...s.floatingWindows,
        {
          id: "window-Catalog/Products",
          objectRef: catalogRef("Products"),
          position: { x: 50, y: 50 },
          size: { width: 600, height: 400 },
          zIndex: 30,
          isMinimized: false,
          isMaximized: false,
          activeSection: "main",
        },
      ],
    }))

    useUiStore.getState().attachWindow("window-Catalog/Products")

    const state = useUiStore.getState()
    expect(state.floatingWindows).toHaveLength(0)
    expect(state.openTabs).toHaveLength(1)
    expect(state.activeTabId).toBe("Catalog/Products")
  })
})

describe("closeWindow", () => {
  it("закриває floating window", () => {
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().detachTab("Catalog/Products")

    useUiStore.getState().closeWindow("window-Catalog/Products")

    expect(useUiStore.getState().floatingWindows).toHaveLength(0)
  })
})

describe("minimizeWindow / maximizeWindow / restoreWindow", () => {
  beforeEach(() => {
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().detachTab("Catalog/Products")
  })

  it("мінімізує вікно", () => {
    useUiStore.getState().minimizeWindow("window-Catalog/Products")

    const win = useUiStore.getState().floatingWindows[0]
    expect(win.isMinimized).toBe(true)
    expect(win.isMaximized).toBe(false)
  })

  it("максимізує вікно", () => {
    useUiStore.getState().maximizeWindow("window-Catalog/Products")

    const win = useUiStore.getState().floatingWindows[0]
    expect(win.isMaximized).toBe(true)
    expect(win.isMinimized).toBe(false)
  })

  it("відновлює вікно з мінімізованого стану", () => {
    useUiStore.getState().minimizeWindow("window-Catalog/Products")
    useUiStore.getState().restoreWindow("window-Catalog/Products")

    const win = useUiStore.getState().floatingWindows[0]
    expect(win.isMinimized).toBe(false)
    expect(win.isMaximized).toBe(false)
  })

  it("відновлює вікно з максимізованого стану", () => {
    useUiStore.getState().maximizeWindow("window-Catalog/Products")
    useUiStore.getState().restoreWindow("window-Catalog/Products")

    const win = useUiStore.getState().floatingWindows[0]
    expect(win.isMinimized).toBe(false)
    expect(win.isMaximized).toBe(false)
  })
})

describe("focusWindow", () => {
  it("піднімає z-index вікна", () => {
    useUiStore.getState().openTab(catalogRef("A"))
    useUiStore.getState().openTab(catalogRef("B"))
    useUiStore.getState().detachTab("Catalog/A")
    useUiStore.getState().detachTab("Catalog/B")

    const zBefore = useUiStore
      .getState()
      .floatingWindows.find((w) => w.id === "window-Catalog/A")!.zIndex

    useUiStore.getState().focusWindow("window-Catalog/A")

    const zAfter = useUiStore
      .getState()
      .floatingWindows.find((w) => w.id === "window-Catalog/A")!.zIndex

    expect(zAfter).toBeGreaterThan(zBefore)
    expect(useUiStore.getState().activeWindowId).toBe("window-Catalog/A")
  })
})

describe("moveWindow / resizeWindow", () => {
  beforeEach(() => {
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().detachTab("Catalog/Products")
  })

  it("переміщує вікно", () => {
    useUiStore
      .getState()
      .moveWindow("window-Catalog/Products", { x: 100, y: 200 })

    const win = useUiStore.getState().floatingWindows[0]
    expect(win.position).toEqual({ x: 100, y: 200 })
  })

  it("змінює розмір вікна", () => {
    useUiStore
      .getState()
      .resizeWindow("window-Catalog/Products", { width: 800, height: 600 })

    const win = useUiStore.getState().floatingWindows[0]
    expect(win.size).toEqual({ width: 800, height: 600 })
  })
})

// --- Unified ---

describe("focusEntity", () => {
  it("активує існуючу вкладку", () => {
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().openTab(documentRef("SalesOrder"))

    useUiStore.getState().focusEntity(catalogRef("Products"))

    expect(useUiStore.getState().activeTabId).toBe("Catalog/Products")
  })

  it("відновлює та фокусує мінімізоване вікно", () => {
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().detachTab("Catalog/Products")
    useUiStore.getState().minimizeWindow("window-Catalog/Products")

    useUiStore.getState().focusEntity(catalogRef("Products"))

    const win = useUiStore.getState().floatingWindows[0]
    expect(win.isMinimized).toBe(false)
    expect(useUiStore.getState().activeWindowId).toBe("window-Catalog/Products")
  })

  it("відкриває нову вкладку якщо обʼєкт не знайдено", () => {
    useUiStore.getState().focusEntity(catalogRef("Products"))

    expect(useUiStore.getState().openTabs).toHaveLength(1)
    expect(useUiStore.getState().activeTabId).toBe("Catalog/Products")
  })
})

describe("closeAllForObject", () => {
  it("закриває вкладку та floating window для обʼєкта", () => {
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().openTab(documentRef("SalesOrder"))
    useUiStore.getState().detachTab("Document/SalesOrder")

    useUiStore.getState().closeAllForObject(catalogRef("Products"))
    useUiStore.getState().closeAllForObject(documentRef("SalesOrder"))

    const state = useUiStore.getState()
    expect(state.openTabs).toHaveLength(0)
    expect(state.floatingWindows).toHaveLength(0)
  })

  it("при видаленні активної вкладки — вибирає сусідню", () => {
    useUiStore.getState().openTab(catalogRef("A"))
    useUiStore.getState().openTab(catalogRef("B"))
    useUiStore.getState().openTab(catalogRef("C"))
    useUiStore.getState().setActiveTab("Catalog/B")

    useUiStore.getState().closeAllForObject(catalogRef("B"))

    expect(useUiStore.getState().activeTabId).toBe("Catalog/C")
  })

  it("скидає selectedTabularSection для обʼєкта, який закривається", () => {
    useUiStore.getState().openTab(catalogRef("Products"))
    useUiStore.getState().openTab(documentRef("SalesOrder"))
    useUiStore.setState({
      selectedObject: catalogRef("Products"),
      selectedTabularSection: {
        objectRef: catalogRef("Products"),
        tabularSectionName: "items",
      },
    })

    useUiStore.getState().closeAllForObject(catalogRef("Products"))

    const state = useUiStore.getState()
    expect(state.selectedTabularSection).toBeNull()
    expect(state.selectedObject).toEqual(documentRef("SalesOrder"))
  })
})

// --- Window manager invariants ---

describe("Window manager invariants", () => {
  it("after attachWindow: activeWindowId !== attached window", () => {
    const { openTab } = useUiStore.getState()
    openTab(catalogRef("Test1"))
    openTab(catalogRef("Test2"))
    const tabId = useUiStore.getState().openTabs[0].id
    useUiStore.getState().detachTab(tabId)
    const windowId = useUiStore.getState().floatingWindows[0]?.id
    expect(windowId).toBeDefined()
    useUiStore.getState().attachWindow(windowId!)
    expect(useUiStore.getState().activeWindowId).not.toBe(windowId)
  })

  it("after closing last window: activeWindowId === null", () => {
    const { openTab } = useUiStore.getState()
    openTab(catalogRef("Test1"))
    const tabId = useUiStore.getState().openTabs[0].id
    useUiStore.getState().detachTab(tabId)
    const windowId = useUiStore.getState().floatingWindows[0]?.id
    expect(windowId).toBeDefined()
    useUiStore.getState().closeWindow(windowId!)
    expect(useUiStore.getState().activeWindowId).toBeNull()
  })

  it("after minimizeWindow active: activeWindowId changes or null", () => {
    const { openTab } = useUiStore.getState()
    openTab(catalogRef("Test1"))
    const tabId = useUiStore.getState().openTabs[0].id
    useUiStore.getState().detachTab(tabId)
    const windowId = useUiStore.getState().floatingWindows[0]?.id
    expect(windowId).toBeDefined()
    useUiStore.getState().minimizeWindow(windowId!)
    const { activeWindowId } = useUiStore.getState()
    expect(activeWindowId === null || activeWindowId !== windowId).toBe(true)
  })

  it("after detachTab: activeWindowId === new floating window id", () => {
    const { openTab } = useUiStore.getState()
    openTab(catalogRef("Test1"))
    const tabId = useUiStore.getState().openTabs[0].id
    useUiStore.getState().detachTab(tabId)
    const newWindow = useUiStore.getState().floatingWindows[0]
    expect(newWindow).toBeDefined()
    expect(useUiStore.getState().activeWindowId).toBe(newWindow?.id)
  })

  it("invariant: activeWindowId is always null or existing non-minimized window", () => {
    const { openTab } = useUiStore.getState()
    openTab(catalogRef("Test1"))
    openTab(catalogRef("Test2"))

    // Detach two tabs
    const tabs = useUiStore.getState().openTabs
    useUiStore.getState().detachTab(tabs[0].id)
    useUiStore.getState().detachTab(tabs[1].id)

    // Minimize first
    const windows = useUiStore.getState().floatingWindows
    useUiStore.getState().minimizeWindow(windows[0].id)

    const { activeWindowId, floatingWindows } = useUiStore.getState()
    if (activeWindowId !== null) {
      const win = floatingWindows.find((w) => w.id === activeWindowId)
      expect(win).toBeDefined()
      expect(win?.isMinimized).toBe(false)
    }
  })
})
