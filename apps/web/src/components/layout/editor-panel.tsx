import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { TabBar } from "../window-manager/tab-bar"
import { FloatingWindowContainer } from "../window-manager/floating-window-container"
import { Taskbar } from "../window-manager/taskbar"
import { ObjectEditor } from "../editor/object-editor"
import { WelcomeScreen } from "../editor/welcome-screen"
import { RecoveryBanner } from "../editor/recovery-banner"
import { SqlPreviewPanel } from "../sql-preview/sql-preview-panel"
import { isObjectTab, isSqlPreviewTab, useUiStore } from "@/stores/ui-store"
import { useProjectStore } from "@/stores/project-store"
import { useCallback } from "react"

/** Центральна панель: TabBar + вміст активної вкладки + floating windows */
export function EditorPanel() {
  const { t } = useTranslation()
  const { openTabs, activeTabId, setActiveSection } = useUiStore()
  const sessionRestoreStatus = useProjectStore((s) => s.sessionRestoreStatus)
  const isNewProject = useProjectStore((s) => s.isNewProject)
  const lastError = useProjectStore((s) => s.lastError)
  const lastErrorContext = useProjectStore((s) => s.lastErrorContext)
  const setError = useProjectStore((s) => s.setError)

  const activeTab = activeTabId
    ? openTabs.find((tab) => tab.id === activeTabId)
    : null

  const handleSectionChange = useCallback(
    (section: string) => setActiveSection(section),
    [setActiveSection]
  )

  // Показати Welcome Screen коли немає вкладок і:
  // — сесія ще не відновлена, або
  // — це новий порожній проєкт
  // recovery-available — проєкт вже завантажений, показуємо RecoveryBanner замість Welcome
  const showWelcome =
    !activeTab &&
    (sessionRestoreStatus === "idle" ||
      sessionRestoreStatus === "awaiting-permission" ||
      sessionRestoreStatus === "restoring" ||
      sessionRestoreStatus === "failed" ||
      sessionRestoreStatus === "draft-available" ||
      isNewProject)

  const showRecoveryBanner = sessionRestoreStatus === "recovery-available"

  const errorMessage = (() => {
    if (!lastError) return null
    switch (lastErrorContext) {
      case "save":
        return t("storage.errorSave", { error: lastError })
      case "open":
        return t("storage.errorOpen", { error: lastError })
      case "export":
        return t("storage.errorExport", { error: lastError })
      case "import":
        return t("storage.errorImport", { error: lastError })
      case "restore":
        return t("session.restoreError", { error: lastError })
      default:
        return lastError
    }
  })()

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Tab Bar */}
      <TabBar />

      {/* Recovery Banner — inline notification поверх editor */}
      {showRecoveryBanner && <RecoveryBanner />}

      {errorMessage && (
        <div className="flex items-start gap-3 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <div className="min-w-0 flex-1">{errorMessage}</div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setError(null)}
          >
            {t("action.close")}
          </Button>
        </div>
      )}

      {/* Контент активної вкладки */}
      <div className="flex-1 overflow-hidden">
        {activeTab ? (
          isObjectTab(activeTab) ? (
            <ObjectEditor
              key={activeTab.id}
              objectRef={activeTab.objectRef}
              activeSection={activeTab.activeSection}
              onSectionChange={handleSectionChange}
            />
          ) : isSqlPreviewTab(activeTab) ? (
            <SqlPreviewPanel key={activeTab.id} />
          ) : null
        ) : showWelcome ? (
          <WelcomeScreen />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("editor.noOpenTabs")}
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
