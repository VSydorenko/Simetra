import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@workspace/ui/components/button'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  FileAddIcon,
  FolderOpenIcon,
  Upload04Icon,
  ArrowTurnBackwardIcon,
  Loading03Icon,
  DataRecoveryIcon,
} from '@hugeicons/core-free-icons'
import { useProjectStore } from '@/stores/project-store'
import { loadSession, loadDraft } from '@/storage/session-db'

interface SessionMeta {
  name: string | null
  savedAt: number | null
  hasHandle: boolean
}

export function WelcomeScreen() {
  const { t } = useTranslation()
  const sessionRestoreStatus = useProjectStore((s) => s.sessionRestoreStatus)
  const hasDraftFallback = useProjectStore((s) => s.hasDraftFallback)
  const newProject = useProjectStore((s) => s.newProject)
  const openProject = useProjectStore((s) => s.openProject)
  const importProject = useProjectStore((s) => s.importProject)
  const requestDirectoryPermission = useProjectStore((s) => s.requestDirectoryPermission)
  const restoreDraft = useProjectStore((s) => s.restoreDraft)

  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null)

  // Перечитувати sessionMeta при зміні sessionRestoreStatus
  useEffect(() => {
    void (async () => {
      const session = await loadSession()
      if (session) {
        setSessionMeta({
          name: session.projectHandle?.name ?? session.projectModel.project.name,
          savedAt: session.savedAt,
          hasHandle: !!session.projectHandle,
        })
        return
      }
      // Якщо session немає — спробувати draft
      const draft = await loadDraft()
      if (draft) {
        setSessionMeta({
          name: draft.model.project.name,
          savedAt: draft.savedAt,
          hasHandle: false,
        })
        return
      }
      setSessionMeta(null)
    })()
  }, [sessionRestoreStatus])

  const handleNewProject = useCallback(() => {
    newProject(t('welcome.defaultProjectName', { defaultValue: 'NewProject' }))
  }, [newProject, t])

  const handleOpenProject = useCallback(() => {
    void openProject()
  }, [openProject])

  const handleImportProject = useCallback(() => {
    void importProject()
  }, [importProject])

  const handleRestoreSession = useCallback(() => {
    if (sessionMeta?.hasHandle) {
      void requestDirectoryPermission()
    } else {
      void restoreDraft()
    }
  }, [sessionMeta, requestDirectoryPermission, restoreDraft])

  const handleRestoreFromBackup = useCallback(() => {
    void restoreDraft()
  }, [restoreDraft])

  if (sessionRestoreStatus === 'restoring') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
        <HugeiconsIcon icon={Loading03Icon} size={32} className="animate-spin" />
        <p className="text-sm">{t('welcome.restoring')}</p>
      </div>
    )
  }

  const formattedDate = sessionMeta?.savedAt
    ? new Date(sessionMeta.savedAt).toLocaleString()
    : null

  const showRestoreAction = sessionMeta && sessionRestoreStatus !== 'restored'
  const showDualCta = hasDraftFallback && sessionRestoreStatus === 'awaiting-permission'

  return (
    <div className="flex h-full flex-col items-center justify-center gap-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-foreground">{t('welcome.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('welcome.subtitle')}</p>
      </div>

      <div className="flex flex-col gap-3 w-72">
        <WelcomeAction
          icon={FileAddIcon}
          label={t('welcome.newProject')}
          description={t('welcome.newProjectDescription')}
          onClick={handleNewProject}
        />

        <WelcomeAction
          icon={FolderOpenIcon}
          label={t('welcome.openProject')}
          description={t('welcome.openProjectDescription')}
          onClick={handleOpenProject}
        />

        <WelcomeAction
          icon={Upload04Icon}
          label={t('welcome.importZip')}
          description={t('welcome.importZipDescription')}
          onClick={handleImportProject}
        />

        {showRestoreAction && (
          <WelcomeAction
            icon={ArrowTurnBackwardIcon}
            label={
              sessionMeta.hasHandle && sessionRestoreStatus === 'awaiting-permission'
                ? t('welcome.reopenProject')
                : t('welcome.restoreSession')
            }
            description={
              sessionMeta.hasHandle && sessionRestoreStatus === 'awaiting-permission'
                ? t('welcome.reopenProjectDescription')
                : t('welcome.restoreSessionDescription', {
                    name: sessionMeta.name ?? t('welcome.defaultProjectName', { defaultValue: 'Project' }),
                    date: formattedDate ?? '',
                  })
            }
            onClick={handleRestoreSession}
            autoFocus
          />
        )}

        {showDualCta && (
          <WelcomeAction
            icon={DataRecoveryIcon}
            label={t('welcome.restoreFromBackup')}
            description={t('welcome.restoreFromBackupDescription')}
            onClick={handleRestoreFromBackup}
          />
        )}
      </div>
    </div>
  )
}

interface WelcomeActionProps {
  icon: typeof FileAddIcon
  label: string
  description: string
  onClick: () => void
  autoFocus?: boolean
}

function WelcomeAction({ icon, label, description, onClick, autoFocus }: WelcomeActionProps) {
  return (
    <Button
      variant="ghost"
      className="flex h-auto items-start gap-3 px-4 py-3 text-left"
      onClick={onClick}
      autoFocus={autoFocus}
    >
      <HugeiconsIcon icon={icon} size={20} className="mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
    </Button>
  )
}
