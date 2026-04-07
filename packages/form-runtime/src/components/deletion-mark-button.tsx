import { useState, useCallback } from 'react'
import type { MetadataRef } from '@simetra/core'
import { Button } from '@workspace/ui/components/button'
import { useDataProvider } from '../context'

export interface DeletionMarkButtonProps {
  objectRef: MetadataRef
  recordId: string
  isDeletionMarked?: boolean
  onSuccess?: () => void
}

export function DeletionMarkButton({
  objectRef,
  recordId,
  isDeletionMarked = false,
  onSuccess,
}: DeletionMarkButtonProps) {
  const dataProvider = useDataProvider()
  const [loading, setLoading] = useState(false)

  const handleToggle = useCallback(async () => {
    setLoading(true)
    try {
      await dataProvider.update(objectRef, recordId, {
        deletion_mark: !isDeletionMarked,
      })
      onSuccess?.()
    } finally {
      setLoading(false)
    }
  }, [dataProvider, objectRef, recordId, isDeletionMarked, onSuccess])

  return (
    <Button
      variant={isDeletionMarked ? 'outline' : 'destructive'}
      onClick={handleToggle}
      disabled={loading}
    >
      {loading
        ? 'Обробка...'
        : isDeletionMarked
          ? 'Зняти позначку видалення'
          : 'Позначити на видалення'}
    </Button>
  )
}
