import { useTranslation } from 'react-i18next'
import { useMetadataStore } from '@/stores/metadata-store'
import { useUiStore } from '@/stores/ui-store'
import { useIsDirty } from '@/hooks/use-is-dirty'

export function StatusBar() {
  const { t } = useTranslation()
  const isDirty = useIsDirty()

  const objectCount = useMetadataStore(
    (s) =>
      s.model.catalogs.length +
      s.model.documents.length +
      s.model.enumerations.length +
      s.model.informationRegisters.length +
      s.model.accumulationRegisters.length +
      s.model.constants.length +
      s.model.customTables.length,
  )

  const errorCount = useMetadataStore((s) =>
    Object.values(s.validationErrors).reduce(
      (sum, errors) => sum + errors.length,
      0,
    ),
  )

  const openTabsCount = useUiStore((s) => s.openTabs.length)
  const floatingWindowsCount = useUiStore((s) => s.floatingWindows.length)

  return (
    <footer className="z-panels flex h-6 shrink-0 items-center gap-3 border-t border-border bg-background px-3 text-[0.6875rem] text-muted-foreground">
      <span>{t('project.objectCount', { count: objectCount })}</span>
      <span className={errorCount > 0 ? 'text-destructive' : 'text-success'}>
        {errorCount > 0
          ? t('validation.errors', { count: errorCount })
          : t('validation.noErrors')}
      </span>
      {(openTabsCount > 0 || floatingWindowsCount > 0) && (
        <span>
          {t('statusBar.openTabs', { count: openTabsCount + floatingWindowsCount })}
        </span>
      )}
      {isDirty && (
        <span className="ml-auto text-warning">{t('project.unsavedChanges')}</span>
      )}
    </footer>
  )
}
