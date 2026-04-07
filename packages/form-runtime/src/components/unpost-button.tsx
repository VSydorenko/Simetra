import { useState, useCallback } from 'react'
import type { MetadataRef } from '@simetra/core'
import { Button } from '@workspace/ui/components/button'
import { useDataProvider } from '../context'

export interface UnpostButtonProps {
  objectRef: MetadataRef
  recordId: string
  onSuccess?: () => void
}

export function UnpostButton({ objectRef, recordId, onSuccess }: UnpostButtonProps) {
  const dataProvider = useDataProvider()
  const [loading, setLoading] = useState(false)

  const handleUnpost = useCallback(async () => {
    setLoading(true)
    try {
      await dataProvider.unpostDocument(objectRef, recordId)
      onSuccess?.()
    } finally {
      setLoading(false)
    }
  }, [dataProvider, objectRef, recordId, onSuccess])

  return (
    <Button variant="outline" onClick={handleUnpost} disabled={loading}>
      {loading ? 'Скасування...' : 'Скасувати проведення'}
    </Button>
  )
}
