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
import { Badge } from '@workspace/ui/components/badge'
import { FieldTypeSelect } from '@/components/editor/field-type-select'
import { useMetadataStore } from '@/stores/metadata-store'
import { type FieldSelection } from '@/stores/ui-store'
import { KIND_TO_KEY } from '@/lib/metadata-defaults'
import type {
  Attribute,
  MetadataObject,
  MetadataRef,
  MetadataKind,
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

  const isRefType = ['CatalogRef', 'DocumentRef', 'EnumRef', 'AnyRef'].includes(attribute.type)
  const isStringType = attribute.type === 'String'
  const isNumericType = attribute.type === 'Numeric' || attribute.type === 'Integer'

  return (
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
              onChange={(v) => handleUpdate({ type: v })}
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
            <SettingRow label={t('properties.field.ref')}>
              <Input
                className="h-7 text-xs"
                value={attribute.ref ?? ''}
                onChange={(e) => handleUpdate({ ref: e.target.value || undefined })}
              />
            </SettingRow>
          )}
          {attribute.type === 'AnyRef' && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t('properties.field.allowedTypes')}</Label>
              <AllowedTypesSelect
                value={attribute.allowedTypes ?? []}
                onChange={(refs) => handleUpdate({ allowedTypes: refs })}
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
  )
}

/** Multi-select для allowedTypes (AnyRef) */
function AllowedTypesSelect({
  value,
  onChange,
}: {
  value: MetadataRef[]
  onChange: (refs: MetadataRef[]) => void
}) {
  const model = useMetadataStore((s) => s.model)

  const availableObjects = useMemo(() => {
    const kinds: MetadataKind[] = ['Catalog', 'Document', 'Enumeration']
    const result: MetadataRef[] = []
    for (const kind of kinds) {
      const key = KIND_TO_KEY[kind]
      const objects = model[key] as { name: string }[]
      for (const obj of objects) {
        result.push({ kind, name: obj.name })
      }
    }
    return result
  }, [model])

  const selectedSet = useMemo(
    () => new Set(value.map((r) => `${r.kind}/${r.name}`)),
    [value],
  )

  const toggleRef = useCallback(
    (ref: MetadataRef) => {
      const key = `${ref.kind}/${ref.name}`
      if (selectedSet.has(key)) {
        onChange(value.filter((r) => `${r.kind}/${r.name}` !== key))
      } else {
        onChange([...value, ref])
      }
    },
    [value, selectedSet, onChange],
  )

  if (availableObjects.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>
  }

  return (
    <div className="flex flex-wrap gap-1" role="group">
      {availableObjects.map((ref) => {
        const key = `${ref.kind}/${ref.name}`
        const isSelected = selectedSet.has(key)
        return (
          <button
            key={key}
            type="button"
            onClick={() => toggleRef(ref)}
            className="inline-flex"
            aria-pressed={isSelected}
          >
            <Badge
              variant={isSelected ? 'default' : 'outline'}
              className="cursor-pointer px-1.5 py-0 text-[10px]"
            >
              {ref.name}
            </Badge>
          </button>
        )
      })}
    </div>
  )
}
