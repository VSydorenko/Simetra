import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import { ObjectProperties } from "@/components/properties/object-properties"
import { FieldProperties } from "@/components/properties/field-properties"
import { ProjectSettings } from "@/components/properties/project-settings"
import { TabularSectionProperties } from "@/components/properties/tabular-section-properties"
import { useMetadataStore } from "@/stores/metadata-store"
import { findTabularSection, useUiStore } from "@/stores/ui-store"

/**
 * Контекстно-залежна панель властивостей.
 * Пріоритет контексту: selectedField → selectedTabularSection → selectedObject → activeWindow → activeTab → ProjectSettings
 */
export function PropertiesPanel() {
  const { t } = useTranslation()
  const model = useMetadataStore((s) => s.model)
  const selectedField = useUiStore((s) => s.selectedField)
  const selectedTabularSection = useUiStore((s) => s.selectedTabularSection)
  const selectedObject = useUiStore((s) => s.selectedObject)
  const activeTabId = useUiStore((s) => s.activeTabId)
  const activeWindowId = useUiStore((s) => s.activeWindowId)
  const openTabs = useUiStore((s) => s.openTabs)
  const floatingWindows = useUiStore((s) => s.floatingWindows)
  const resolvedTabularSectionSelection = useMemo(() => {
    if (!selectedTabularSection) {
      return null
    }

    return findTabularSection(model, selectedTabularSection)
      ? selectedTabularSection
      : null
  }, [model, selectedTabularSection])

  // Визначити активний обʼєкт — selectedObject > floating window > tab
  const activeObjectRef = useMemo(() => {
    if (selectedObject) return selectedObject
    if (activeWindowId) {
      const win = floatingWindows.find((w) => w.id === activeWindowId)
      if (win) return win.objectRef
    }
    if (activeTabId) {
      const tab = openTabs.find((t) => t.id === activeTabId)
      if (tab) return tab.objectRef
    }
    return null
  }, [selectedObject, activeTabId, activeWindowId, openTabs, floatingWindows])

  // Вибрано поле — показати властивості поля
  if (selectedField) {
    return (
      <ScrollArea className="h-full">
        <div className="py-1">
          <div className="border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t("properties.title")} — {selectedField.fieldName}
            </span>
          </div>
          <FieldProperties selection={selectedField} />
        </div>
      </ScrollArea>
    )
  }

  if (resolvedTabularSectionSelection) {
    return (
      <ScrollArea className="h-full">
        <div className="py-1">
          <div className="border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t("properties.title")} —
              {" "}
              {resolvedTabularSectionSelection.tabularSectionName}
            </span>
          </div>
          <TabularSectionProperties selection={resolvedTabularSectionSelection} />
        </div>
      </ScrollArea>
    )
  }

  // Є активний обʼєкт — показати властивості обʼєкта
  if (activeObjectRef) {
    return (
      <ScrollArea className="h-full">
        <div className="py-1">
          <div className="border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t("properties.title")} — {activeObjectRef.name}
            </span>
          </div>
          <ObjectProperties objectRef={activeObjectRef} />
        </div>
      </ScrollArea>
    )
  }

  // Нічого не вибрано — показати налаштування проєкту
  return (
    <ScrollArea className="h-full">
      <div className="py-1">
        <div className="border-b border-border px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            {t("properties.projectSettings")}
          </span>
        </div>
        <ProjectSettings />
      </div>
    </ScrollArea>
  )
}
