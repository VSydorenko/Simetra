import { Button } from '@workspace/ui/components/button'

export interface SaveButtonProps {
  onClick: () => void
  disabled?: boolean
  loading?: boolean
}

export function SaveButton({ onClick, disabled, loading }: SaveButtonProps) {
  return (
    <Button onClick={onClick} disabled={disabled || loading}>
      {loading ? 'Збереження...' : 'Зберегти'}
    </Button>
  )
}
