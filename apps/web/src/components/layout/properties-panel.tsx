import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@workspace/ui/components/scroll-area'
import { ObjectProperties } from '@/components/properties/object-properties'
import { FieldProperties } from '@/components/properties/field-properties'
import { ProjectSettings } from '@/components/properties/project-settings'
import { useUiStore } from '@/stores/ui-store'

/**
 * Контекстно-залежна панель властивостей.
 * Пріоритет контексту: selectedField → selectedObject → activeWindow → activeTab → ProjectSettings
 */
export function PropertiesPanel() {
  const { t } = useTranslation()
  const selectedField = useUiStore((s) => s.selectedField)
  const selectedObject = useUiStore((s) => s.selectedObject)
  const activeTabId = useUiStore((s) => s.activeTabId)
  const activeWindowId = useUiStore((s) => s.activeWindowId)
  const openTabs = useUiStore((s) => s.openTabs)
  const floatingWindows = useUiStore((s) => s.floatingWindows)

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
              {t('properties.title')} — {selectedField.fieldName}
            </span>
          </div>
          <FieldProperties selection={selectedField} />
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
              {t('properties.title')} — {activeObjectRef.name}
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
            {t('properties.projectSettings')}
          </span>
        </div>
        <ProjectSettings />
      </div>
    </ScrollArea>
  )
}
