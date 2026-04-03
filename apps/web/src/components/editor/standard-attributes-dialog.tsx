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
import { Input } from '@workspace/ui/components/input'
import { ScrollArea } from '@workspace/ui/components/scroll-area'
import type { MetadataKind, MetadataObject, LocalizedString } from '@simetra/core'
import {
  getStandardAttributes,
  getTabularSectionStandardAttributes,
  type StandardAttributeSettings,
} from '@simetra/core'

interface StandardAttributesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: MetadataKind
  objectName: string
  object: MetadataObject
  onUpdateObject: (updates: Partial<MetadataObject>) => void
  /** Якщо задано — показати стандартні реквізити табличної частини */
  tabularSectionName?: string
}

type Overrides = Record<string, { description?: LocalizedString }>

/** Витягує settings з обʼєкта для передачі в getStandardAttributes */
function extractSettings(kind: MetadataKind, object: MetadataObject): StandardAttributeSettings {
  switch (kind) {
    case 'Catalog': {
      const o = object as { hierarchyType?: string; owners?: { kind: string; name: string }[] }
      return {
        hierarchyType: (o.hierarchyType as StandardAttributeSettings['hierarchyType']) ?? 'None',
        owners: o.owners,
      }
    }
    case 'InformationRegister': {
      const o = object as { periodicity?: string; writeMode?: string }
      return {
        periodicity: o.periodicity,
        writeMode: o.writeMode,
      }
    }
    case 'AccumulationRegister': {
      const o = object as { registerType?: string }
      return {
        registerType: o.registerType as StandardAttributeSettings['registerType'],
      }
    }
    case 'CustomTable': {
      const o = object as { autoAddPrimaryKey?: boolean }
      return {
        autoAddPrimaryKey: o.autoAddPrimaryKey,
      }
    }
    default:
      return {}
  }
}

export function StandardAttributesDialog({
  open,
  onOpenChange,
  kind,
  objectName,
  object,
  onUpdateObject,
  tabularSectionName,
}: StandardAttributesDialogProps) {
  const { t } = useTranslation()

  const handleCancel = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  // key змінюється при кожному відкритті — скидає внутрішній draft
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
          <StandardAttributesDialogBody
            key={revisionKey}
            kind={kind}
            objectName={objectName}
            object={object}
            onUpdateObject={onUpdateObject}
            onCancel={handleCancel}
            tabularSectionName={tabularSectionName}
            t={t}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function StandardAttributesDialogBody({
  kind,
  objectName,
  object,
  onUpdateObject,
  onCancel,
  tabularSectionName,
  t,
}: {
  kind: MetadataKind
  objectName: string
  object: MetadataObject
  onUpdateObject: (updates: Partial<MetadataObject>) => void
  onCancel: () => void
  tabularSectionName?: string
  t: (key: string) => string
}) {
  const { i18n } = useTranslation()
  const lang = i18n.language as 'uk' | 'en'

  const attributes = useMemo(() => {
    if (tabularSectionName) {
      return getTabularSectionStandardAttributes()
    }
    const settings = extractSettings(kind, object)
    return getStandardAttributes(kind, settings)
  }, [kind, object, tabularSectionName])

  const savedOverrides = useMemo(() => {
    return ('standardAttributeOverrides' in object
      ? (object.standardAttributeOverrides as Overrides)
      : {}) ?? {}
  }, [object])

  // Ініціалізується один раз при mount (key-reset при відкритті)
  const [draftOverrides, setDraftOverrides] = useState<Overrides>(() =>
    structuredClone(savedOverrides),
  )

  const isDirty = useMemo(() => {
    return JSON.stringify(draftOverrides) !== JSON.stringify(savedOverrides)
  }, [draftOverrides, savedOverrides])

  const handleDescriptionChange = useCallback(
    (attrName: string, locale: 'uk' | 'en', value: string) => {
      setDraftOverrides((prev) => {
        const current = prev[attrName]?.description ?? {}
        return {
          ...prev,
          [attrName]: {
            ...prev[attrName],
            description: { ...current, [locale]: value || undefined },
          },
        }
      })
    },
    [],
  )

  const handleSave = useCallback(() => {
    onUpdateObject({ standardAttributeOverrides: draftOverrides } as Partial<MetadataObject>)
    onCancel()
  }, [draftOverrides, onUpdateObject, onCancel])

  const kindLabel = t(`metadata.kind.${kind}`)
  const title = tabularSectionName
    ? `${kindLabel} ${objectName} / ${tabularSectionName}: ${t('properties.standardAttributes')}`
    : `${kindLabel} ${objectName}: ${t('properties.standardAttributes')}`

  const isReadonly = !!tabularSectionName

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">{title}</DialogTitle>
        <DialogDescription className="text-xs">
          {t('dialog.standardAttributesDescription')}
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
              <TableHead className="h-8 px-2 text-xs font-medium whitespace-normal">
                {t('metadata.field.description')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {attributes.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="h-16 text-center text-xs text-muted-foreground whitespace-normal"
                >
                  {t('dialog.noStandardAttributes')}
                </TableCell>
              </TableRow>
            ) : (
              attributes.map((attr) => (
                <StandardAttributeRow
                  key={attr.name}
                  attr={attr}
                  lang={lang}
                  override={draftOverrides[attr.name]}
                  isReadonly={isReadonly}
                  onDescriptionChange={handleDescriptionChange}
                />
              ))
            )}
          </TableBody>
        </Table>
      </ScrollArea>
      {!isReadonly && (
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('action.cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!isDirty}>
            {t('action.save')}
          </Button>
        </DialogFooter>
      )}
    </>
  )
}

/** Рядок стандартного реквізиту з редагованим описом */
function StandardAttributeRow({
  attr,
  lang,
  override,
  isReadonly,
  onDescriptionChange,
}: {
  attr: { name: string; type: string; description: { uk: string; en: string } }
  lang: 'uk' | 'en'
  override?: { description?: LocalizedString }
  isReadonly: boolean
  onDescriptionChange: (attrName: string, locale: 'uk' | 'en', value: string) => void
}) {
  const systemDescription = attr.description[lang] ?? attr.description.uk ?? ''
  const value = override?.description?.[lang] ?? ''

  return (
    <TableRow className="h-8">
      <TableCell className="px-2 py-1">
        <span className="font-mono text-xs">{attr.name}</span>
      </TableCell>
      <TableCell className="px-2 py-1">
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {attr.type}
        </Badge>
      </TableCell>
      <TableCell className="px-2 py-1 whitespace-normal">
        {isReadonly ? (
          <span className="text-xs text-muted-foreground">{systemDescription}</span>
        ) : (
          <Input
            className="h-6 text-xs"
            placeholder={systemDescription}
            value={value}
            onChange={(e) => onDescriptionChange(attr.name, lang, e.target.value)}
          />
        )}
      </TableCell>
    </TableRow>
  )
}
