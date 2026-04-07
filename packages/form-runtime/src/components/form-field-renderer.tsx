import { Controller, type Control, type FieldValues } from 'react-hook-form'
import type { Attribute } from '@simetra/core'
import { Input } from '@workspace/ui/components/input'
import { Textarea } from '@workspace/ui/components/textarea'
import { Switch } from '@workspace/ui/components/switch'
import { Label } from '@workspace/ui/components/label'
import { resolveFieldComponent } from '../field-mapping'
import { EnumSelect } from './enum-select'
import { CatalogCombobox } from './catalog-combobox'
import { PolymorphicRefPlaceholder } from './polymorphic-ref-placeholder'

export interface FormFieldRendererProps {
  attribute: Attribute
  control: Control<FieldValues>
  readOnly?: boolean
}

/** Рендерить одне поле форми з інтеграцією react-hook-form */
export function FormFieldRenderer({
  attribute,
  control,
  readOnly,
}: FormFieldRendererProps) {
  const { component, props } = resolveFieldComponent(attribute)
  const label =
    attribute.displayName?.uk ?? attribute.displayName?.en ?? attribute.name

  return (
    <div className="space-y-1.5">
      <Label htmlFor={attribute.name}>{label}</Label>
      <Controller
        name={attribute.name}
        control={control}
        render={({ field, fieldState }) => (
          <>
            {renderFieldControl(component, {
              ...props,
              ...field,
              id: attribute.name,
              readOnly,
              attribute,
              fieldState,
            })}
            {fieldState.error && (
              <p className="text-xs text-destructive">
                {fieldState.error.message}
              </p>
            )}
          </>
        )}
      />
    </div>
  )
}

/** Маппінг FieldComponentType → конкретний UI-компонент */
function renderFieldControl(
  component: string,
  fieldProps: Record<string, unknown>,
) {
  const {
    attribute,
    readOnly,
    id,
    value,
    onChange,
    onBlur,
    name,
    ...restProps
  } = fieldProps as {
    attribute: Attribute
    fieldState: unknown
    readOnly?: boolean
    id: string
    value: unknown
    onChange: (v: unknown) => void
    onBlur: () => void
    name: string
    [key: string]: unknown
  }

  switch (component) {
    case 'input':
      return (
        <Input
          id={id}
          name={name}
          type={(restProps.type as string) ?? 'text'}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          readOnly={readOnly}
        />
      )

    case 'textarea':
      return (
        <Textarea
          id={id}
          name={name}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          readOnly={readOnly}
        />
      )

    case 'number-input':
      return (
        <Input
          id={id}
          name={name}
          type="number"
          step={restProps.step as number}
          value={value != null ? String(value) : ''}
          onChange={(e) =>
            onChange(e.target.value === '' ? null : Number(e.target.value))
          }
          onBlur={onBlur}
          readOnly={readOnly}
        />
      )

    case 'switch':
      return (
        <Switch
          id={id}
          checked={!!value}
          onCheckedChange={onChange}
          disabled={readOnly}
        />
      )

    case 'date-picker':
      return (
        <Input
          id={id}
          name={name}
          type="date"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          readOnly={readOnly}
        />
      )

    case 'datetime-picker':
      return (
        <Input
          id={id}
          name={name}
          type="datetime-local"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          readOnly={readOnly}
        />
      )

    case 'enum-select':
      return (
        <EnumSelect
          enumRef={attribute.ref!}
          value={value as string | null}
          onChange={onChange as (v: string | null) => void}
          disabled={readOnly}
        />
      )

    case 'catalog-combobox':
    case 'document-combobox':
      return (
        <CatalogCombobox
          targetRef={attribute.ref!}
          value={value as string | null}
          onChange={onChange as (v: string | null) => void}
          disabled={readOnly}
        />
      )

    case 'polymorphic-ref-placeholder':
      return <PolymorphicRefPlaceholder />

    case 'uuid-input':
      return (
        <Input
          id={id}
          name={name}
          value={(value as string) ?? ''}
          readOnly
        />
      )

    case 'binary-placeholder':
      return (
        <div className="rounded-md border border-dashed border-muted-foreground/30 px-3 py-2 text-xs text-muted-foreground">
          Binary — не підтримується в MVP
        </div>
      )

    default:
      return (
        <Input
          id={id}
          name={name}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          readOnly={readOnly}
        />
      )
  }
}
