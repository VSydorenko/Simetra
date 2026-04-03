import { useTranslation } from 'react-i18next'
import { HugeiconsIcon } from '@hugeicons/react'
import { Link04Icon } from '@hugeicons/core-free-icons'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select'
import type { FieldType } from '@simetra/core'

const PRIMITIVE_TYPES: FieldType[] = [
  'UUID',
  'String',
  'Text',
  'Integer',
  'Numeric',
  'Boolean',
  'Date',
  'DateTime',
  'Binary',
]

const REFERENCE_TYPES: FieldType[] = ['Ref']

interface FieldTypeSelectProps {
  value: FieldType
  onChange: (value: FieldType) => void
  disabled?: boolean
}

export function FieldTypeSelect({ value, onChange, disabled }: FieldTypeSelectProps) {
  const { t } = useTranslation()

  return (
    <Select value={value} onValueChange={(v) => onChange(v as FieldType)} disabled={disabled}>
      <SelectTrigger className="h-7 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel className="text-xs">{t('properties.group.dataType')}</SelectLabel>
          {PRIMITIVE_TYPES.map((type) => (
            <SelectItem key={type} value={type} className="text-xs">
              {type}
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel className="text-xs">{t('properties.group.reference')}</SelectLabel>
          {REFERENCE_TYPES.map((type) => (
            <SelectItem key={type} value={type} className="text-xs">
              <span className="inline-flex items-center gap-1.5">
                <HugeiconsIcon icon={Link04Icon} className="h-3.5 w-3.5" />
                {t('properties.group.reference')}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
