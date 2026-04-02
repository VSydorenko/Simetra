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
} from '@hugeicons/core-free-icons'
import { useProjectStore } from '@/stores/project-store'
import { loadSession } from '@/storage/session-db'

interface SessionMeta {
  name: string | null
  savedAt: number | null
  hasHandle: boolean
}

export function WelcomeScreen() {
  const { t } = useTranslation()
  const sessionRestoreStatus = useProjectStore((s) => s.sessionRestoreStatus)
  const newProject = useProjectStore((s) => s.newProject)
  const openProject = useProjectStore((s) => s.openProject)
  const importProject = useProjectStore((s) => s.importProject)
  const requestDirectoryPermission = useProjectStore((s) => s.requestDirectoryPermission)
  const restoreDraft = useProjectStore((s) => s.restoreDraft)

  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null)

  useEffect(() => {
    void loadSession().then((session) => {
      if (session) {
        setSessionMeta({
          name: session.projectHandle?.name ?? session.projectModel.project.name,
          savedAt: session.savedAt,
          hasHandle: !!session.projectHandle,
        })
      }
    })
  }, [])

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

  // Обробка Enter на кнопці відновлення
  useEffect(() => {
    if (!sessionMeta) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement
        // Не перехоплювати якщо фокус на кнопці
        if (target.tagName === 'BUTTON') return
        handleRestoreSession()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [sessionMeta, handleRestoreSession])

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

        {sessionMeta && sessionRestoreStatus !== 'restored' && (
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
