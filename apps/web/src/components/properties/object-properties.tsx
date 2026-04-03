import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@workspace/ui/components/accordion'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select'
import { Switch } from '@workspace/ui/components/switch'
import { Badge } from '@workspace/ui/components/badge'
import { FieldTypeSelect } from '@/components/editor/field-type-select'
import { MetadataRefMultiPicker } from '@/components/properties/metadata-ref-picker'
import { useMetadataStore, type ValidationError } from '@/stores/metadata-store'
import { useUiStore } from '@/stores/ui-store'
import { KIND_TO_KEY } from '@/lib/metadata-defaults'
import type {
  MetadataKind,
  MetadataObject,
  MetadataRef,
  FieldType,
} from '@simetra/core'

interface ObjectPropertiesProps {
  objectRef: MetadataRef
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[1fr_1fr] items-center gap-2">
      <Label className="truncate text-xs text-muted-foreground">{label}</Label>
      <div>{children}</div>
    </div>
  )
}

/** Commit-on-blur редагування імені обʼєкта */
function NameEditor({
  kind,
  currentName,
  renameObject,
  updateTabObjectRef,
}: {
  kind: MetadataKind
  currentName: string
  renameObject: (kind: MetadataKind, oldName: string, newName: string) => ValidationError[] | null
  updateTabObjectRef: (oldRef: MetadataRef, newRef: MetadataRef) => void
}) {
  const [draft, setDraft] = useState(currentName)

  // Синхронізація draft при зміні objectRef ззовні
  useEffect(() => {
    setDraft(currentName)
  }, [currentName])

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== currentName) {
      const errors = renameObject(kind, currentName, trimmed)
      if (!errors) {
        updateTabObjectRef({ kind, name: currentName }, { kind, name: trimmed })
      } else {
        setDraft(currentName)
      }
    } else {
      setDraft(currentName)
    }
  }

  return (
    <Input
      className="h-7 font-mono text-xs"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          ;(e.target as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          setDraft(currentName)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

export function ObjectProperties({ objectRef }: ObjectPropertiesProps) {
  const { t } = useTranslation()
  const model = useMetadataStore((s) => s.model)
  const updateObject = useMetadataStore((s) => s.updateObject)
  const renameObject = useMetadataStore((s) => s.renameObject)
  const { updateTabObjectRef } = useUiStore()

  const object = useMemo(() => {
    const key = KIND_TO_KEY[objectRef.kind]
    const objects = model[key] as MetadataObject[]
    return objects.find((o) => o.name === objectRef.name) ?? null
  }, [model, objectRef])

  const handleUpdate = useCallback(
    (updates: Partial<MetadataObject>) => {
      updateObject(objectRef.kind, objectRef.name, updates)
    },
    [objectRef.kind, objectRef.name, updateObject],
  )

  if (!object) return null

  const displayName = 'displayName' in object
    ? (object.displayName as { uk?: string; en?: string } | undefined)
    : undefined

  const hasStandardAttributes = !['Enumeration', 'Constant'].includes(objectRef.kind)

  return (
    <>
    <Accordion type="multiple" defaultValue={['general', 'typeSettings']} className="w-full">
      {/* Група: Основні */}
      <AccordionItem value="general">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t('properties.group.general')}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <SettingRow label={t('metadata.field.name')}>
            <NameEditor
              kind={objectRef.kind}
              currentName={object.name}
              renameObject={renameObject}
              updateTabObjectRef={updateTabObjectRef}
            />
          </SettingRow>
          <SettingRow label={t('metadata.field.type')}>
            <Badge variant="outline" className="text-[10px]">
              {t(`metadata.kind.${objectRef.kind}`)}
            </Badge>
          </SettingRow>
          <SettingRow label={t('editor.displayNameUk')}>
            <Input
              className="h-7 text-xs"
              value={displayName?.uk ?? ''}
              onChange={(e) =>
                handleUpdate({
                  displayName: { ...displayName, uk: e.target.value || undefined },
                } as Partial<MetadataObject>)
              }
            />
          </SettingRow>
          <SettingRow label={t('editor.displayNameEn')}>
            <Input
              className="h-7 text-xs"
              value={displayName?.en ?? ''}
              onChange={(e) =>
                handleUpdate({
                  displayName: { ...displayName, en: e.target.value || undefined },
                } as Partial<MetadataObject>)
              }
            />
          </SettingRow>
        </AccordionContent>
      </AccordionItem>

      {/* Група: Налаштування типу */}
      <AccordionItem value="typeSettings">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t('metadata.section.settings')}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <TypeSettings kind={objectRef.kind} object={object} onUpdate={handleUpdate} />
        </AccordionContent>
      </AccordionItem>
    </Accordion>

    {/* Посилання на діалоги (Модулі G, H) */}
    {hasStandardAttributes && (
      <div className="space-y-1 border-t border-border px-3 py-2">
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          disabled
        >
          {t('properties.standardAttributes')}
        </Button>
        <br />
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          disabled
        >
          {t('properties.additionalIndexes')}
        </Button>
      </div>
    )}
    </>
  )
}

// --- Kind-specific settings ---

function TypeSettings({
  kind,
  object,
  onUpdate,
}: {
  kind: MetadataKind
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  switch (kind) {
    case 'Catalog':
      return <CatalogTypeSettings object={object} onUpdate={onUpdate} />
    case 'Document':
      return <DocumentTypeSettings object={object} onUpdate={onUpdate} />
    case 'InformationRegister':
      return <InfoRegisterTypeSettings object={object} onUpdate={onUpdate} />
    case 'AccumulationRegister':
      return <AccumRegisterTypeSettings object={object} onUpdate={onUpdate} />
    case 'Constant':
      return <ConstantTypeSettings object={object} onUpdate={onUpdate} />
    case 'CustomTable':
      return <CustomTableTypeSettings object={object} onUpdate={onUpdate} />
    case 'Enumeration':
      return <EmptySettings />
    default:
      return null
  }
}

function EmptySettings() {
  return <span className="text-xs text-muted-foreground">—</span>
}

function CatalogTypeSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: 'Catalog' }>

  return (
    <>
      <SettingRow label={t('metadata.setting.codeLength')}>
        <Input
          type="number"
          className="h-7 text-xs"
          value={o.codeLength}
          min={1}
          onChange={(e) => onUpdate({ codeLength: parseInt(e.target.value, 10) || 9 } as Partial<MetadataObject>)}
        />
      </SettingRow>
      <SettingRow label={t('metadata.setting.codeType')}>
        <Select value={o.codeType} onValueChange={(v) => onUpdate({ codeType: v } as Partial<MetadataObject>)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="String" className="text-xs">String</SelectItem>
            <SelectItem value="Number" className="text-xs">Number</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t('metadata.setting.descriptionLength')}>
        <Input
          type="number"
          className="h-7 text-xs"
          value={o.descriptionLength}
          min={1}
          onChange={(e) => onUpdate({ descriptionLength: parseInt(e.target.value, 10) || 150 } as Partial<MetadataObject>)}
        />
      </SettingRow>
      <SettingRow label={t('metadata.setting.hierarchyType')}>
        <Select value={o.hierarchyType} onValueChange={(v) => onUpdate({ hierarchyType: v } as Partial<MetadataObject>)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="None" className="text-xs">None</SelectItem>
            <SelectItem value="FoldersAndItems" className="text-xs">Folders & Items</SelectItem>
            <SelectItem value="ItemsOnly" className="text-xs">Items Only</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t('metadata.setting.autonumber')}>
        <Switch checked={o.autonumber} onCheckedChange={(v) => onUpdate({ autonumber: v } as Partial<MetadataObject>)} />
      </SettingRow>
      <SettingRow label={t('metadata.setting.codeUnique')}>
        <Switch checked={o.codeUnique} onCheckedChange={(v) => onUpdate({ codeUnique: v } as Partial<MetadataObject>)} />
      </SettingRow>
      <SettingRow label={t('metadata.setting.mainPresentation')}>
        <Select value={o.mainPresentation} onValueChange={(v) => onUpdate({ mainPresentation: v } as Partial<MetadataObject>)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="Code" className="text-xs">Code</SelectItem>
            <SelectItem value="Description" className="text-xs">Description</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{t('properties.owners')}</Label>
        <MetadataRefMultiPicker
          value={o.owners}
          allowedKinds={['Catalog']}
          onChange={(refs) => onUpdate({ owners: refs } as Partial<MetadataObject>)}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{t('metadata.setting.predefinedItems')}</Label>
        <div className="space-y-1">
          {(o.predefinedItems ?? []).map((item, idx) => (
            <div key={idx} className="flex items-center gap-1">
              <Input
                className="h-7 flex-1 font-mono text-xs"
                value={item.name}
                onChange={(e) => {
                  const updated = [...(o.predefinedItems ?? [])]
                  updated[idx] = { ...updated[idx], name: e.target.value }
                  onUpdate({ predefinedItems: updated } as Partial<MetadataObject>)
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => {
                  const updated = (o.predefinedItems ?? []).filter((_, i) => i !== idx)
                  onUpdate({ predefinedItems: updated } as Partial<MetadataObject>)
                }}
              >
                <span className="text-xs">✕</span>
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-full text-xs"
            onClick={() => {
              const items = o.predefinedItems ?? []
              onUpdate({ predefinedItems: [...items, { name: `Item${items.length + 1}` }] } as Partial<MetadataObject>)
            }}
          >
            + {t('metadata.setting.predefinedItems')}
          </Button>
        </div>
      </div>
    </>
  )
}

function DocumentTypeSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: 'Document' }>

  return (
    <>
      <SettingRow label={t('metadata.setting.numberLength')}>
        <Input
          type="number"
          className="h-7 text-xs"
          value={o.numberLength}
          min={1}
          onChange={(e) => onUpdate({ numberLength: parseInt(e.target.value, 10) || 11 } as Partial<MetadataObject>)}
        />
      </SettingRow>
      <SettingRow label={t('metadata.setting.numberType')}>
        <Select value={o.numberType} onValueChange={(v) => onUpdate({ numberType: v } as Partial<MetadataObject>)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="String" className="text-xs">String</SelectItem>
            <SelectItem value="Number" className="text-xs">Number</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t('metadata.setting.autonumber')}>
        <Switch checked={o.autonumber} onCheckedChange={(v) => onUpdate({ autonumber: v } as Partial<MetadataObject>)} />
      </SettingRow>
      <SettingRow label={t('metadata.setting.numberPeriodicity')}>
        <Select value={o.numberPeriodicity} onValueChange={(v) => onUpdate({ numberPeriodicity: v } as Partial<MetadataObject>)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="None" className="text-xs">None</SelectItem>
            <SelectItem value="Year" className="text-xs">Year</SelectItem>
            <SelectItem value="Quarter" className="text-xs">Quarter</SelectItem>
            <SelectItem value="Month" className="text-xs">Month</SelectItem>
            <SelectItem value="Day" className="text-xs">Day</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t('metadata.setting.posting')}>
        <Switch checked={o.posting} onCheckedChange={(v) => onUpdate({ posting: v } as Partial<MetadataObject>)} />
      </SettingRow>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{t('properties.registerMovements')}</Label>
        <MetadataRefMultiPicker
          value={o.registerMovements}
          allowedKinds={['AccumulationRegister', 'InformationRegister']}
          onChange={(refs) => onUpdate({ registerMovements: refs } as Partial<MetadataObject>)}
        />
      </div>
    </>
  )
}

function InfoRegisterTypeSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: 'InformationRegister' }>

  return (
    <>
      <SettingRow label={t('metadata.setting.periodicity')}>
        <Select value={o.periodicity} onValueChange={(v) => onUpdate({ periodicity: v } as Partial<MetadataObject>)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="NonPeriodic" className="text-xs">Non-periodic</SelectItem>
            <SelectItem value="Day" className="text-xs">Day</SelectItem>
            <SelectItem value="Month" className="text-xs">Month</SelectItem>
            <SelectItem value="Quarter" className="text-xs">Quarter</SelectItem>
            <SelectItem value="Year" className="text-xs">Year</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t('metadata.setting.writeMode')}>
        <Select value={o.writeMode} onValueChange={(v) => onUpdate({ writeMode: v } as Partial<MetadataObject>)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="Independent" className="text-xs">Independent</SelectItem>
            <SelectItem value="RecorderSubordinate" className="text-xs">Recorder Subordinate</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{t('properties.recorderTypes')}</Label>
        <MetadataRefMultiPicker
          value={o.recorderTypes}
          allowedKinds={['Document']}
          onChange={(refs) => onUpdate({ recorderTypes: refs } as Partial<MetadataObject>)}
        />
      </div>
    </>
  )
}

function AccumRegisterTypeSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: 'AccumulationRegister' }>

  return (
    <>
      <SettingRow label={t('metadata.setting.registerType')}>
        <Select value={o.registerType} onValueChange={(v) => onUpdate({ registerType: v } as Partial<MetadataObject>)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="Balance" className="text-xs">Balance</SelectItem>
            <SelectItem value="Turnover" className="text-xs">Turnover</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{t('properties.recorderTypes')}</Label>
        <MetadataRefMultiPicker
          value={o.recorderTypes}
          allowedKinds={['Document']}
          onChange={(refs) => onUpdate({ recorderTypes: refs } as Partial<MetadataObject>)}
        />
      </div>
    </>
  )
}

function ConstantTypeSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: 'Constant' }>

  return (
    <>
      <SettingRow label={t('metadata.setting.valueType')}>
        <FieldTypeSelect
          value={o.valueType as FieldType}
          onChange={(v) => onUpdate({ valueType: v } as Partial<MetadataObject>)}
        />
      </SettingRow>
      <SettingRow label={t('metadata.setting.defaultValue')}>
        <Input
          className="h-7 text-xs"
          value={typeof o.defaultValue === 'string' || typeof o.defaultValue === 'number' ? String(o.defaultValue) : ''}
          onChange={(e) => onUpdate({ defaultValue: e.target.value || null } as Partial<MetadataObject>)}
        />
      </SettingRow>
    </>
  )
}

function CustomTableTypeSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: 'CustomTable' }>

  return (
    <SettingRow label={t('metadata.setting.autoAddPrimaryKey')}>
      <Switch
        checked={o.autoAddPrimaryKey}
        onCheckedChange={(v) => onUpdate({ autoAddPrimaryKey: v } as Partial<MetadataObject>)}
      />
    </SettingRow>
  )
}
