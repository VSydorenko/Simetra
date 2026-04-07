import type { MetadataRef } from '@simetra/core'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select'
import { useMetadata } from '../context'

export interface EnumSelectProps {
  enumRef: MetadataRef
  value?: string | null
  onChange?: (value: string | null) => void
  disabled?: boolean
}

/** Отримати display label для значення енумерації */
function getDisplayLabel(item: {
  name: string
  displayName?: { uk?: string; en?: string }
}): string {
  return item.displayName?.uk ?? item.displayName?.en ?? item.name
}

export function EnumSelect({
  enumRef,
  value,
  onChange,
  disabled,
}: EnumSelectProps) {
  const model = useMetadata()

  // Знайти enum за іменем з model.enumerations
  const enumDef = model.enumerations.find((e) => e.name === enumRef.name)

  if (!enumDef) {
    return (
      <div className="text-xs text-destructive">
        Enumeration &quot;{enumRef.name}&quot; не знайдено
      </div>
    )
  }

  const handleChange = (val: string) => {
    // Radix Select не дозволяє пустий value — використовуємо спеціальний маркер
    onChange?.(val === '__clear__' ? null : val)
  }

  return (
    <Select
      value={value ?? undefined}
      onValueChange={handleChange}
      disabled={disabled}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Оберіть..." />
      </SelectTrigger>
      <SelectContent>
        {enumDef.values.map((item) => (
          <SelectItem key={item.name} value={item.name}>
            {getDisplayLabel(item)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
