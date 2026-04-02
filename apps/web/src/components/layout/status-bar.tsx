import { useTranslation } from 'react-i18next'
import { useMetadataStore } from '@/stores/metadata-store'
import { useUiStore } from '@/stores/ui-store'
import { useProjectStore } from '@/stores/project-store'
import { useIsDirty } from '@/hooks/use-is-dirty'
import { Folder02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

function ProjectDirectoryIndicator() {
  const { t } = useTranslation()
  const projectDirectoryName = useProjectStore((s) => s.projectDirectoryName)
  const projectHandle = useProjectStore((s) => s.projectHandle)
  const isNewProject = useProjectStore((s) => s.isNewProject)

  let label: string
  if (projectDirectoryName) {
    label = t('statusBar.projectDirectory', { name: projectDirectoryName })
  } else if (!isNewProject && !projectHandle) {
    label = t('statusBar.importedFromZip')
  } else {
    label = t('statusBar.notSaved')
  }

  return (
    <span className="flex items-center gap-1">
      <HugeiconsIcon icon={Folder02Icon} size={12} />
      {label}
    </span>
  )
}

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

  const warningCount = useProjectStore((s) => s.openWarnings.length)

  const openTabsCount = useUiStore((s) => s.openTabs.length)
  const floatingWindowsCount = useUiStore((s) => s.floatingWindows.length)

  return (
    <footer className="z-panels flex h-6 shrink-0 items-center gap-3 border-t border-border bg-background px-3 text-[0.6875rem] text-muted-foreground">
      <ProjectDirectoryIndicator />
      <span>{t('project.objectCount', { count: objectCount })}</span>
      <span className={errorCount > 0 ? 'text-destructive' : 'text-success'}>
        {errorCount > 0
          ? t('validation.errors', { count: errorCount })
          : t('validation.noErrors')}
      </span>
      {warningCount > 0 && (
        <span className="text-amber-500">
          {t('validation.warnings', { count: warningCount })}
        </span>
      )}
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
