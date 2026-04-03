import { useTranslation } from 'react-i18next'
import { TabBar } from '../window-manager/tab-bar'
import { FloatingWindowContainer } from '../window-manager/floating-window-container'
import { Taskbar } from '../window-manager/taskbar'
import { ObjectEditor } from '../editor/object-editor'
import { WelcomeScreen } from '../editor/welcome-screen'
import { RecoveryBanner } from '../editor/recovery-banner'
import { useUiStore } from '@/stores/ui-store'
import { useProjectStore } from '@/stores/project-store'

/** Центральна панель: TabBar + вміст активної вкладки + floating windows */
export function EditorPanel() {
  const { t } = useTranslation()
  const { openTabs, activeTabId } = useUiStore()
  const sessionRestoreStatus = useProjectStore((s) => s.sessionRestoreStatus)
  const isNewProject = useProjectStore((s) => s.isNewProject)

  const activeTab = activeTabId ? openTabs.find((tab) => tab.id === activeTabId) : null

  // Показати Welcome Screen коли немає вкладок і:
  // — сесія ще не відновлена, або
  // — це новий порожній проєкт
  // recovery-available — проєкт вже завантажений, показуємо RecoveryBanner замість Welcome
  const showWelcome = !activeTab && (
    sessionRestoreStatus === 'idle' ||
    sessionRestoreStatus === 'awaiting-permission' ||
    sessionRestoreStatus === 'restoring' ||
    sessionRestoreStatus === 'failed' ||
    isNewProject
  )

  const showRecoveryBanner = sessionRestoreStatus === 'recovery-available'

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Tab Bar */}
      <TabBar />

      {/* Recovery Banner — inline notification поверх editor */}
      {showRecoveryBanner && <RecoveryBanner />}

      {/* Контент активної вкладки */}
      <div className="flex-1 overflow-hidden">
        {activeTab ? (
          <ObjectEditor key={activeTab.id} objectRef={activeTab.objectRef} />
        ) : showWelcome ? (
          <WelcomeScreen />
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
