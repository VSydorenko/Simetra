import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@workspace/ui/components/accordion'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Checkbox } from '@workspace/ui/components/checkbox'
import { FieldTypeSelect } from '@/components/editor/field-type-select'
import { MetadataRefPicker } from '@/components/properties/metadata-ref-picker'
import { useMetadataStore, type ValidationError } from '@/stores/metadata-store'
import { type FieldSelection } from '@/stores/ui-store'
import { KIND_TO_KEY } from '@/lib/metadata-defaults'
import type {
  Attribute,
  MetadataObject,
} from '@simetra/core'

interface FieldPropertiesProps {
  selection: FieldSelection
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[1fr_1fr] items-center gap-2">
      <Label className="truncate text-xs text-muted-foreground">{label}</Label>
      <div>{children}</div>
    </div>
  )
}

/** Стабільне пусте посилання — уникаємо нових [] при відсутності помилок */
const EMPTY_ERRORS: ValidationError[] = []

/** Форматує повідомлення про помилку для відображення */
function formatErrorMessage(message: string, t: (key: string, opts?: Record<string, string>) => string): string {
  if (message.startsWith('ref:')) {
    const refPart = message.slice(4)
    const slashIdx = refPart.indexOf('/')
    if (slashIdx !== -1) {
      const kind = refPart.slice(0, slashIdx)
      const name = refPart.slice(slashIdx + 1)
      return t('validation.refNotFound', { kind, name })
    }
  }
  return message
}

/** Панель відображення помилок валідації для поля */
function FieldValidationErrors({
  errors,
  fieldName,
  tabularSectionName,
}: {
  errors: ValidationError[]
  fieldName: string
  tabularSectionName?: string
}) {
  const { t } = useTranslation()
  // Точне зіставлення за path з урахуванням ролі поля та секції
  const fieldErrors = errors.filter((e) => {
    if (!e.path) return false
    // Поле табличної частини: tabularSections.{sectionName}.{fieldName}[.*]
    if (tabularSectionName) {
      const prefix = `tabularSections.${tabularSectionName}.${fieldName}`
      return e.path === prefix || e.path.startsWith(`${prefix}.`)
    }
    // Звичайне поле (attributes, dimensions, resources) — точний збіг або sub-path
    return (
      e.path === `attributes.${fieldName}` || e.path.startsWith(`attributes.${fieldName}.`) ||
      e.path === `dimensions.${fieldName}` || e.path.startsWith(`dimensions.${fieldName}.`) ||
      e.path === `resources.${fieldName}` || e.path.startsWith(`resources.${fieldName}.`)
    )
  })
  if (fieldErrors.length === 0) return null

  return (
    <div className="mb-2 rounded border border-destructive/20 bg-destructive/5 px-3 py-2">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-destructive">
        {t('validation.objectErrors')}
      </p>
      <ul className="space-y-0.5">
        {fieldErrors.map((err, i) => (
          <li key={i} className="text-[11px] text-destructive">
            {formatErrorMessage(err.message, t)}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Знаходить атрибут за selection у відповідній колекції обʼєкта */
function findAttribute(
  object: MetadataObject,
  selection: FieldSelection,
): Attribute | null {
  // Поле табличної частини
  if (selection.tabularSectionName && 'tabularSections' in object) {
    const sections = object.tabularSections as { name: string; attributes: Attribute[] }[]
    const section = sections.find((s) => s.name === selection.tabularSectionName)
    return section?.attributes.find((a) => a.name === selection.fieldName) ?? null
  }

  // Атрибути
  if ('attributes' in object) {
    const attrs = object.attributes as Attribute[]
    const found = attrs.find((a) => a.name === selection.fieldName)
    if (found) return found
  }

  // Dimensions
  if ('dimensions' in object) {
    const dims = object.dimensions as Attribute[]
    const found = dims.find((a) => a.name === selection.fieldName)
    if (found) return found
  }

  // Resources
  if ('resources' in object) {
    const res = object.resources as Attribute[]
    const found = res.find((a) => a.name === selection.fieldName)
    if (found) return found
  }

  return null
}

/** Визначає field role для правильного dispatch */
function getFieldRole(
  object: MetadataObject,
  selection: FieldSelection,
): 'attributes' | 'dimensions' | 'resources' | 'tabularSection' {
  if (selection.tabularSectionName) return 'tabularSection'

  if ('dimensions' in object) {
    const dims = object.dimensions as Attribute[]
    if (dims.some((a) => a.name === selection.fieldName)) return 'dimensions'
  }

  if ('resources' in object) {
    const res = object.resources as Attribute[]
    if (res.some((a) => a.name === selection.fieldName)) return 'resources'
  }

  return 'attributes'
}

export function FieldProperties({ selection }: FieldPropertiesProps) {
  const { t } = useTranslation()
  const model = useMetadataStore((s) => s.model)
  const {
    updateAttribute,
    updateDimension,
    updateResource,
    updateTabularSectionAttribute,
  } = useMetadataStore()

  const { kind, name: objectName } = selection.objectRef

  // Помилки валідації: два окремих примітивних селектори + useMemo
  // (уникаємо infinite loop через нові посилання на масив у single selector)
  const key = `${kind}/${objectName}`
  const mutErrors = useMetadataStore((s) => s.validationErrors[key] ?? EMPTY_ERRORS)
  const mdlErrors = useMetadataStore((s) => s.modelErrors[key] ?? EMPTY_ERRORS)
  const objectErrors = useMemo(() => {
    if (mutErrors.length === 0 && mdlErrors.length === 0) return EMPTY_ERRORS
    const seen = new Set<string>()
    const combined: ValidationError[] = []
    for (const err of [...mutErrors, ...mdlErrors]) {
      const dedupeKey = `${err.path}:${err.message}`
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey)
        combined.push(err)
      }
    }
    return combined
  }, [mutErrors, mdlErrors])

  const object = useMemo(() => {
    const key = KIND_TO_KEY[kind]
    const objects = model[key] as MetadataObject[]
    return objects.find((o) => o.name === objectName) ?? null
  }, [model, kind, objectName])

  const attribute = useMemo(
    () => (object ? findAttribute(object, selection) : null),
    [object, selection],
  )

  const fieldRole = useMemo(
    () => (object ? getFieldRole(object, selection) : 'attributes'),
    [object, selection],
  )

  const handleUpdate = useCallback(
    (updates: Partial<Attribute>) => {
      switch (fieldRole) {
        case 'dimensions':
          updateDimension(kind, objectName, selection.fieldName, updates)
          break
        case 'resources':
          updateResource(kind, objectName, selection.fieldName, updates)
          break
        case 'tabularSection':
          if (selection.tabularSectionName) {
            updateTabularSectionAttribute(
              kind,
              objectName,
              selection.tabularSectionName,
              selection.fieldName,
              updates,
            )
          }
          break
        default:
          updateAttribute(kind, objectName, selection.fieldName, updates)
      }
    },
    [
      kind,
      objectName,
      selection.fieldName,
      selection.tabularSectionName,
      fieldRole,
      updateAttribute,
      updateDimension,
      updateResource,
      updateTabularSectionAttribute,
    ],
  )

  if (!object || !attribute) return null

  const isRefType = attribute.type === 'Ref'
  const isStringType = attribute.type === 'String'
  const isNumericType = attribute.type === 'Numeric'

  return (
    <>
      <FieldValidationErrors
        errors={objectErrors}
        fieldName={selection.fieldName}
        tabularSectionName={selection.tabularSectionName}
      />
      <Accordion type="multiple" defaultValue={['general', 'dataType', 'constraints', 'additional']} className="w-full">
      {/* Основні */}
      <AccordionItem value="general">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t('properties.group.general')}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <SettingRow label={t('metadata.field.name')}>
            <Input
              className="h-7 font-mono text-xs"
              value={attribute.name}
              readOnly
              disabled
            />
          </SettingRow>
          <SettingRow label={t('editor.displayNameUk')}>
            <Input
              className="h-7 text-xs"
              value={attribute.displayName?.uk ?? ''}
              onChange={(e) =>
                handleUpdate({
                  displayName: { ...attribute.displayName, uk: e.target.value || undefined },
                })
              }
            />
          </SettingRow>
          <SettingRow label={t('editor.displayNameEn')}>
            <Input
              className="h-7 text-xs"
              value={attribute.displayName?.en ?? ''}
              onChange={(e) =>
                handleUpdate({
                  displayName: { ...attribute.displayName, en: e.target.value || undefined },
                })
              }
            />
          </SettingRow>
        </AccordionContent>
      </AccordionItem>

      {/* Тип даних */}
      <AccordionItem value="dataType">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t('properties.group.dataType')}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <SettingRow label={t('metadata.field.type')}>
            <FieldTypeSelect
              value={attribute.type}
              onChange={(v) => {
                const updates: Partial<Attribute> = { type: v }
                // Очищення type-specific полів при зміні типу
                if (v !== 'Ref') {
                  updates.ref = undefined
                  updates.allowedTypes = undefined
                }
                if (v !== 'String') {
                  updates.length = undefined
                }
                if (v !== 'Numeric') {
                  updates.precision = undefined
                  updates.scale = undefined
                }
                handleUpdate(updates)
              }}
            />
          </SettingRow>
          {isStringType && (
            <SettingRow label={t('properties.field.length')}>
              <Input
                type="number"
                className="h-7 text-xs"
                value={attribute.length ?? ''}
                min={1}
                onChange={(e) => handleUpdate({ length: parseInt(e.target.value, 10) || undefined })}
              />
            </SettingRow>
          )}
          {isNumericType && (
            <>
              <SettingRow label={t('properties.field.precision')}>
                <Input
                  type="number"
                  className="h-7 text-xs"
                  value={attribute.precision ?? ''}
                  min={1}
                  onChange={(e) => handleUpdate({ precision: parseInt(e.target.value, 10) || undefined })}
                />
              </SettingRow>
              <SettingRow label={t('properties.field.scale')}>
                <Input
                  type="number"
                  className="h-7 text-xs"
                  value={attribute.scale ?? ''}
                  min={0}
                  onChange={(e) => {
                    const val = e.target.value
                    handleUpdate({ scale: val === '' ? undefined : parseInt(val, 10) })
                  }}
                />
              </SettingRow>
            </>
          )}
          {isRefType && (
            <div className="space-y-1">
              <MetadataRefPicker
                refValue={attribute.ref}
                allowedTypes={attribute.allowedTypes}
                onChange={handleUpdate}
              />
            </div>
          )}
        </AccordionContent>
      </AccordionItem>

      {/* Обмеження */}
      <AccordionItem value="constraints">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t('properties.group.constraints')}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="field-required"
              checked={attribute.required}
              onCheckedChange={(v) => handleUpdate({ required: v === true })}
            />
            <Label htmlFor="field-required" className="text-xs">
              {t('metadata.field.required')}
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="field-indexed"
              checked={attribute.indexed}
              onCheckedChange={(v) => handleUpdate({ indexed: v === true })}
            />
            <Label htmlFor="field-indexed" className="text-xs">
              {t('metadata.field.indexed')}
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="field-unique"
              checked={attribute.unique}
              onCheckedChange={(v) => handleUpdate({ unique: v === true })}
            />
            <Label htmlFor="field-unique" className="text-xs">
              {t('metadata.field.unique')}
            </Label>
          </div>
          <SettingRow label={t('metadata.field.defaultValue')}>
            <Input
              className="h-7 text-xs"
              value={attribute.defaultValue ?? ''}
              onChange={(e) => handleUpdate({ defaultValue: e.target.value || null })}
            />
          </SettingRow>
        </AccordionContent>
      </AccordionItem>

      {/* Додатково */}
      <AccordionItem value="additional">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t('properties.group.additional')}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <SettingRow label={t('metadata.field.description') + ' (uk)'}>
            <Input
              className="h-7 text-xs"
              value={attribute.description?.uk ?? ''}
              onChange={(e) =>
                handleUpdate({
                  description: { ...attribute.description, uk: e.target.value || undefined },
                })
              }
            />
          </SettingRow>
          <SettingRow label={t('metadata.field.description') + ' (en)'}>
            <Input
              className="h-7 text-xs"
              value={attribute.description?.en ?? ''}
              onChange={(e) =>
                handleUpdate({
                  description: { ...attribute.description, en: e.target.value || undefined },
                })
              }
            />
          </SettingRow>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
    </>
  )
}
