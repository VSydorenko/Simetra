import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@workspace/ui/components/button'
import { HugeiconsIcon } from '@hugeicons/react'
import { Alert02Icon } from '@hugeicons/core-free-icons'
import { useProjectStore } from '@/stores/project-store'
import { stopAndClearDraft } from '@/storage/draft-sync'

export function RecoveryBanner() {
  const { t } = useTranslation()
  const pendingRecovery = useProjectStore((s) => s.pendingRecovery)
  const restoreDraft = useProjectStore((s) => s.restoreDraft)

  const formattedDate = pendingRecovery?.savedAt
    ? new Date(pendingRecovery.savedAt).toLocaleString()
    : null

  const handleAccept = useCallback(() => {
    void restoreDraft()
  }, [restoreDraft])

  const handleDismiss = useCallback(() => {
    stopAndClearDraft()
    useProjectStore.setState({
      sessionRestoreStatus: 'restored',
      pendingRecovery: null,
    })
  }, [])

  return (
    <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm">
      <HugeiconsIcon icon={Alert02Icon} size={16} className="shrink-0 text-amber-500" />
      <span className="flex-1 text-foreground">
        {t('recovery.bannerMessage', { date: formattedDate ?? '' })}
      </span>
      <Button variant="outline" size="sm" onClick={handleAccept}>
        {t('recovery.accept')}
      </Button>
      <Button variant="ghost" size="sm" onClick={handleDismiss}>
        {t('recovery.dismiss')}
      </Button>
    </div>
  )
}
