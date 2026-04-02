import { useTranslation } from 'react-i18next'
import { TabBar } from '../window-manager/tab-bar'
import { FloatingWindowContainer } from '../window-manager/floating-window-container'
import { Taskbar } from '../window-manager/taskbar'
import { ObjectEditor } from '../editor/object-editor'
import { useUiStore } from '@/stores/ui-store'

/** Центральна панель: TabBar + вміст активної вкладки + floating windows */
export function EditorPanel() {
  const { t } = useTranslation()
  const { openTabs, activeTabId } = useUiStore()

  const activeTab = activeTabId ? openTabs.find((tab) => tab.id === activeTabId) : null

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Tab Bar */}
      <TabBar />

      {/* Контент активної вкладки */}
      <div className="flex-1 overflow-hidden">
        {activeTab ? (
          <ObjectEditor key={activeTab.id} objectRef={activeTab.objectRef} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('editor.noOpenTabs')}
          </div>
        )}
      </div>

      {/* Floating windows поверх контенту */}
      <FloatingWindowContainer />

      {/* Taskbar для мінімізованих вікон */}
      <Taskbar />
    </div>
  )
}
