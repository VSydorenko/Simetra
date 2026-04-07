import { useState, useCallback } from 'react'
import type { MetadataRef } from '@simetra/core'
import { Button } from '@workspace/ui/components/button'
import { useDataProvider } from '../context'

export interface PostButtonProps {
  objectRef: MetadataRef
  recordId: string
  onSuccess?: () => void
}

export function PostButton({ objectRef, recordId, onSuccess }: PostButtonProps) {
  const dataProvider = useDataProvider()
  const [loading, setLoading] = useState(false)

  const handlePost = useCallback(async () => {
    setLoading(true)
    try {
      await dataProvider.postDocument(objectRef, recordId)
      onSuccess?.()
    } finally {
      setLoading(false)
    }
  }, [dataProvider, objectRef, recordId, onSuccess])

  return (
    <Button onClick={handlePost} disabled={loading}>
      {loading ? 'Проведення...' : 'Провести'}
    </Button>
  )
}
