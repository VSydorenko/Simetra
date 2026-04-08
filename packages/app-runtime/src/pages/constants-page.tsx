import { useMetadata, ConstantsForm } from '@simetra/form-runtime'

export function ConstantsPage() {
  const model = useMetadata()

  return (
    <div className="p-6">
      <h1 className="mb-4 text-xl font-bold">Налаштування</h1>
      <ConstantsForm constants={model.constants} />
    </div>
  )
}
