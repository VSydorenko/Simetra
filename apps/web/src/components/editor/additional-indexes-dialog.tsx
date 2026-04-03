import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@workspace/ui/components/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@workspace/ui/components/table'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Checkbox } from '@workspace/ui/components/checkbox'
import { ScrollArea } from '@workspace/ui/components/scroll-area'
import type { MetadataKind, MetadataObject, Attribute } from '@simetra/core'
import { getStandardAttributes } from '@simetra/core'
import { useMetadataStore } from '@/stores/metadata-store'
import { KIND_TO_KEY } from '@/lib/metadata-defaults'
import { extractStandardAttributeSettings } from '@/lib/extract-settings'

interface AdditionalIndexesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: MetadataKind
  objectName: string
}

interface IndexableField {
  name: string
  type: string
  indexed: boolean
  /** Стандартний реквізит — лише для відображення, не редагується */
  isStandard: boolean
  /** Роль поля для dispatch */
  role: 'attributes' | 'dimensions' | 'resources'
  /** Група для відображення в UI */
  group: string
}

/** Збирає всі індексовані поля обʼєкта (стандартні + custom) */
function collectIndexableFields(
  kind: MetadataKind,
  object: MetadataObject,
  t: (key: string) => string,
): IndexableField[] {
  const fields: IndexableField[] = []

  // Стандартні реквізити — indexed визначається в core
  const settings = extractStandardAttributeSettings(kind, object)
  const standardAttrs = getStandardAttributes(kind, settings)
  for (const attr of standardAttrs) {
    fields.push({
      name: attr.name,
      type: attr.type,
      indexed: attr.indexed,
      isStandard: true,
      role: 'attributes',
      group: t('metadata.standardAttribute'),
    })
  }

  // Custom реквізити
  if ('attributes' in object && Array.isArray(object.attributes)) {
    for (const attr of object.attributes as Attribute[]) {
      fields.push({
        name: attr.name,
        type: attr.type,
        indexed: attr.indexed ?? false,
        isStandard: false,
        role: 'attributes',
        group: t('metadata.section.attributes'),
      })
    }
  }

  // Виміри (dimensions)
  if ('dimensions' in object && Array.isArray(object.dimensions)) {
    for (const attr of object.dimensions as Attribute[]) {
      fields.push({
        name: attr.name,
        type: attr.type,
        indexed: attr.indexed ?? false,
        isStandard: false,
        role: 'dimensions',
        group: t('metadata.section.dimensions'),
      })
    }
  }

  // Ресурси (resources)
  if ('resources' in object && Array.isArray(object.resources)) {
    for (const attr of object.resources as Attribute[]) {
      fields.push({
        name: attr.name,
        type: attr.type,
        indexed: attr.indexed ?? false,
        isStandard: false,
        role: 'resources',
        group: t('metadata.section.resources'),
      })
    }
  }

  return fields
}

export function AdditionalIndexesDialog({
  open,
  onOpenChange,
  kind,
  objectName,
}: AdditionalIndexesDialogProps) {
  const { t } = useTranslation()

  const handleCancel = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  // key змінюється при кожному відкритті — скидає draft
  const [revisionKey, setRevisionKey] = useState(0)
  const handleOpen = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        handleCancel()
      } else {
        setRevisionKey((k) => k + 1)
      }
    },
    [handleCancel],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="sm:max-w-2xl">
        {open && (
          <AdditionalIndexesDialogBody
            key={revisionKey}
            kind={kind}
            objectName={objectName}
            onCancel={handleCancel}
            t={t}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Draft-стан indexed для custom полів, ключ = `${role}:${name}` */
type IndexedDraft = Record<string, boolean>

/** Збирає початковий draft indexed стану custom полів */
function buildInitialDraft(object: MetadataObject): IndexedDraft {
  const draft: IndexedDraft = {}

  if ('attributes' in object && Array.isArray(object.attributes)) {
    for (const attr of object.attributes as Attribute[]) {
      draft[`attributes:${attr.name}`] = attr.indexed ?? false
    }
  }
  if ('dimensions' in object && Array.isArray(object.dimensions)) {
    for (const attr of object.dimensions as Attribute[]) {
      draft[`dimensions:${attr.name}`] = attr.indexed ?? false
    }
  }
  if ('resources' in object && Array.isArray(object.resources)) {
    for (const attr of object.resources as Attribute[]) {
      draft[`resources:${attr.name}`] = attr.indexed ?? false
    }
  }

  return draft
}

function AdditionalIndexesDialogBody({
  kind,
  objectName,
  onCancel,
  t,
}: {
  kind: MetadataKind
  objectName: string
  onCancel: () => void
  t: (key: string) => string
}) {
  const model = useMetadataStore((s) => s.model)
  const updateAttribute = useMetadataStore((s) => s.updateAttribute)
  const updateDimension = useMetadataStore((s) => s.updateDimension)
  const updateResource = useMetadataStore((s) => s.updateResource)

  const object = useMemo(() => {
    const key = KIND_TO_KEY[kind]
    const objects = model[key] as MetadataObject[]
    return objects.find((o) => o.name === objectName) ?? null
  }, [model, kind, objectName])

  const fields = useMemo(
    () => (object ? collectIndexableFields(kind, object, t) : []),
    [kind, object, t],
  )

  const savedDraft = useMemo(
    () => (object ? buildInitialDraft(object) : {}),
    [object],
  )

  const [draft, setDraft] = useState<IndexedDraft>(() => structuredClone(savedDraft))

  const isDirty = useMemo(() => {
    return JSON.stringify(draft) !== JSON.stringify(savedDraft)
  }, [draft, savedDraft])

  const handleToggle = useCallback(
    (field: IndexableField, checked: boolean) => {
      if (field.isStandard) return
      setDraft((prev) => ({
        ...prev,
        [`${field.role}:${field.name}`]: checked,
      }))
    },
    [],
  )

  const handleSave = useCallback(() => {
    // Dispatch тільки змінені поля
    for (const [key, indexed] of Object.entries(draft)) {
      if (savedDraft[key] === indexed) continue

      const [role, fieldName] = key.split(':') as [string, string]
      switch (role) {
        case 'dimensions':
          updateDimension(kind, objectName, fieldName, { indexed })
          break
        case 'resources':
          updateResource(kind, objectName, fieldName, { indexed })
          break
        default:
          updateAttribute(kind, objectName, fieldName, { indexed })
      }
    }
    onCancel()
  }, [draft, savedDraft, kind, objectName, updateAttribute, updateDimension, updateResource, onCancel])

  const kindLabel = t(`metadata.kind.${kind}`)
  const title = `${kindLabel} ${objectName}: ${t('properties.additionalIndexes')}`

  /** Отримати draft-значення indexed для custom поля */
  const getDraftIndexed = (field: IndexableField): boolean => {
    if (field.isStandard) return field.indexed
    return draft[`${field.role}:${field.name}`] ?? field.indexed
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">{title}</DialogTitle>
        <DialogDescription className="text-xs">
          {t('dialog.additionalIndexesDescription')}
        </DialogDescription>
      </DialogHeader>
      <ScrollArea className="max-h-[60vh]">
        <Table>
          <TableHeader>
            <TableRow className="h-8">
              <TableHead className="h-8 w-[140px] px-2 text-xs font-medium">
                {t('metadata.field.name')}
              </TableHead>
              <TableHead className="h-8 w-[100px] px-2 text-xs font-medium">
                {t('metadata.field.type')}
              </TableHead>
              <TableHead className="h-8 w-[120px] px-2 text-xs font-medium">
                {t('dialog.fieldGroup')}
              </TableHead>
              <TableHead className="h-8 w-[80px] px-2 text-center text-xs font-medium">
                {t('metadata.field.indexed')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-16 text-center text-xs text-muted-foreground"
                >
                  {t('dialog.noIndexableFields')}
                </TableCell>
              </TableRow>
            ) : (
              fields.map((field) => (
                <IndexableFieldRow
                  key={`${field.role}:${field.name}`}
                  field={field}
                  indexed={getDraftIndexed(field)}
                  onToggle={handleToggle}
                />
              ))
            )}
          </TableBody>
        </Table>
      </ScrollArea>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!isDirty}>
          {t('action.save')}
        </Button>
      </DialogFooter>
    </>
  )
}

function IndexableFieldRow({
  field,
  indexed,
  onToggle,
}: {
  field: IndexableField
  indexed: boolean
  onToggle: (field: IndexableField, checked: boolean) => void
}) {
  return (
    <TableRow className="h-8">
      <TableCell className="px-2 py-1">
        <span className="font-mono text-xs">{field.name}</span>
      </TableCell>
      <TableCell className="px-2 py-1">
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {field.type}
        </Badge>
      </TableCell>
      <TableCell className="px-2 py-1">
        <span className="text-xs text-muted-foreground">{field.group}</span>
      </TableCell>
      <TableCell className="px-2 py-1 text-center">
        <Checkbox
          checked={indexed}
          disabled={field.isStandard}
          onCheckedChange={(v) => onToggle(field, v === true)}
        />
      </TableCell>
    </TableRow>
  )
}
