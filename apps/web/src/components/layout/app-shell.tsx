import { useHotkeys } from 'react-hotkeys-hook'
import {
  Group,
  Panel,
  Separator as PanelSeparator,
} from 'react-resizable-panels'
import { TopBar } from './top-bar'
import { StatusBar } from './status-bar'
import { TreePanel } from './tree-panel'
import { EditorPanel } from './editor-panel'
import { PropertiesPanel } from './properties-panel'
import { CommandPalette } from '../command-palette'
import { useUiStore } from '@/stores/ui-store'
import { useMetadataStore } from '@/stores/metadata-store'
import { useProjectStore } from '@/stores/project-store'
import { createDefaultObject, generateUniqueName, getObjectNames } from '@/lib/metadata-defaults'

export function AppShell() {
  const toggleCommandPalette = useUiStore((s) => s.toggleCommandPalette)
  const togglePropertiesPanel = useUiStore((s) => s.togglePropertiesPanel)

  // --- Глобальні hotkeys ---

  // Command Palette
  useHotkeys('mod+k', (e) => {
    e.preventDefault()
    toggleCommandPalette()
  })

  // Save
  useHotkeys('mod+s', (e) => {
    e.preventDefault()
    void useProjectStore.getState().saveProject()
  })

  // Undo / Redo
  useHotkeys('mod+z', (e) => {
    e.preventDefault()
    useMetadataStore.temporal.getState().undo()
  })

  useHotkeys('mod+shift+z', (e) => {
    e.preventDefault()
    useMetadataStore.temporal.getState().redo()
  })

  // Alt+Enter — відкрити/закрити панель властивостей
  useHotkeys('alt+enter', (e) => {
    e.preventDefault()
    togglePropertiesPanel()
  })

  // Ctrl+N — створити обʼєкт (контекст-залежне створення)
  useHotkeys('mod+n', (e) => {
    e.preventDefault()
    const { selectedObject } = useUiStore.getState()
    const kind = selectedObject?.kind ?? 'Catalog'
    const model = useMetadataStore.getState().model
    const existingNames = getObjectNames(model, kind)
    const name = generateUniqueName(kind, existingNames)
    const obj = createDefaultObject(kind, name)
    const errors = useMetadataStore.getState().createObject(obj)
    if (!errors) {
      useUiStore.getState().selectObject({ kind, name })
    }
  })

  // Ctrl+W — закрити активну вкладку
  useHotkeys('mod+w', (e) => {
    e.preventDefault()
    const { activeTabId, closeTab } = useUiStore.getState()
    if (activeTabId) closeTab(activeTabId)
  })

  // Ctrl+Tab / Ctrl+Shift+Tab — переключення між вкладками
  useHotkeys('ctrl+tab', (e) => {
    e.preventDefault()
    const { openTabs, activeTabId, setActiveTab } = useUiStore.getState()
    if (openTabs.length === 0) return
    const idx = openTabs.findIndex((t) => t.id === activeTabId)
    const next = (idx + 1) % openTabs.length
    setActiveTab(openTabs[next].id)
  })

  useHotkeys('ctrl+shift+tab', (e) => {
    e.preventDefault()
    const { openTabs, activeTabId, setActiveTab } = useUiStore.getState()
    if (openTabs.length === 0) return
    const idx = openTabs.findIndex((t) => t.id === activeTabId)
    const prev = (idx - 1 + openTabs.length) % openTabs.length
    setActiveTab(openTabs[prev].id)
  })

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TopBar />

      <Group
        orientation="horizontal"
        className="flex-1"
        id="simetra-panels"
      >
        <Panel id="tree" defaultSize={20} minSize={12}>
          <div className="h-full border-r border-border">
            <TreePanel />
          </div>
        </Panel>

        <PanelSeparator className="w-px bg-border transition-colors hover:bg-primary/50 active:bg-primary/70" />

        <Panel id="editor" minSize={30}>
          <EditorPanel />
        </Panel>

        <PanelSeparator className="w-px bg-border transition-colors hover:bg-primary/50 active:bg-primary/70" />

        <Panel
          id="properties"
          defaultSize={25}
          minSize={12}
          collapsible
        >
          <div className="h-full border-l border-border">
            <PropertiesPanel />
          </div>
        </Panel>
      </Group>

      <StatusBar />
      <CommandPalette />
    </div>
  )
}
