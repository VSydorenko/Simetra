import { useParams, useNavigate } from 'react-router'
import { resolveForm } from '@simetra/core'
import { useMetadata, ItemFormRenderer } from '@simetra/form-runtime'
import { resolveObjectFromSlug } from '../utils/resolve-object'

export function ItemPage() {
  const { kindSlug = '', objectSlug, id } = useParams<{ kindSlug: string; objectSlug: string; id: string }>()
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

  const { objectRef } = resolved
  const formModel = resolveForm(objectRef, 'ItemForm', model)

  return (
    <div className="p-6">
      <ItemFormRenderer
        objectRef={objectRef}
        formModel={formModel}
        recordId={id}
        onSave={() => navigate(`/${kindSlug}/${objectSlug}`)}
        onCancel={() => navigate(`/${kindSlug}/${objectSlug}`)}
      />
    </div>
  )
}
