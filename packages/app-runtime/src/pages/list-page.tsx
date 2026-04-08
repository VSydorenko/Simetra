import { useParams, useNavigate } from 'react-router'
import { resolveForm } from '@simetra/core'
import { useMetadata, ListRenderer } from '@simetra/form-runtime'
import { resolveObjectFromSlug } from '../utils/resolve-object'

export function ListPage() {
  const { kindSlug = '', objectSlug } = useParams<{ kindSlug: string; objectSlug: string }>()
  const navigate = useNavigate()
  const model = useMetadata()

  const resolved = objectSlug
    ? resolveObjectFromSlug(kindSlug, objectSlug, model)
    : null

  if (!resolved) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Об'єкт не знайдено</p>
      </div>
    )
  }

  const { objectRef, object } = resolved
  const displayName =
    (object as { displayName?: { uk?: string; en?: string } | null }).displayName?.uk ??
    (object as { displayName?: { uk?: string; en?: string } | null }).displayName?.en ??
    objectRef.name

  const formModel = resolveForm(objectRef, 'ListForm', model)

  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-bold">{displayName}</h1>
      <ListRenderer
        objectRef={objectRef}
        formModel={formModel}
        onRowClick={(id) => navigate(id)}
        onCreateClick={() => navigate('new')}
      />
    </div>
  )
}
