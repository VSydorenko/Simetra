import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
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
import { ScrollArea } from '@workspace/ui/components/scroll-area'
import { FieldTypeSelect } from './field-type-select'
import type { MetadataKind, MetadataObject, FieldType } from '@simetra/core'
import { useMetadataStore } from '@/stores/metadata-store'

interface SettingsFormProps {
  kind: MetadataKind
  objectName: string
  object: MetadataObject
}

export function SettingsForm({ kind, objectName, object }: SettingsFormProps) {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        <SettingsFormContent kind={kind} objectName={objectName} object={object} />
      </div>
    </ScrollArea>
  )
}

/** Вміст налаштувань без зовнішнього ScrollArea — для вбудовування в інші секції */
export function SettingsFormContent({ kind, objectName, object }: SettingsFormProps) {
  const updateObject = useMetadataStore((s) => s.updateObject)

  const handleUpdate = useCallback(
    (updates: Partial<MetadataObject>) => {
      updateObject(kind, objectName, updates)
    },
    [kind, objectName, updateObject],
  )

  return (
    <>
      {kind === 'Catalog' && 'codeLength' in object && (
        <CatalogSettings object={object} onUpdate={handleUpdate} />
      )}
      {kind === 'Document' && 'numberLength' in object && (
        <DocumentSettings object={object} onUpdate={handleUpdate} />
      )}
      {kind === 'InformationRegister' && 'periodicity' in object && (
        <InformationRegisterSettings object={object} onUpdate={handleUpdate} />
      )}
      {kind === 'AccumulationRegister' && 'registerType' in object && (
        <AccumulationRegisterSettings object={object} onUpdate={handleUpdate} />
      )}
      {kind === 'Constant' && 'valueType' in object && (
        <ConstantSettings object={object} onUpdate={handleUpdate} />
      )}
      {kind === 'CustomTable' && 'autoAddPrimaryKey' in object && (
        <CustomTableSettings object={object} onUpdate={handleUpdate} />
      )}
    </>
  )
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="w-48 shrink-0">{children}</div>
    </div>
  )
}

function CatalogSettings({
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
    </>
  )
}

function DocumentSettings({
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
    </>
  )
}

function InformationRegisterSettings({
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
    </>
  )
}

function AccumulationRegisterSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: 'AccumulationRegister' }>

  return (
    <SettingRow label={t('metadata.setting.registerType')}>
      <Select value={o.registerType} onValueChange={(v) => onUpdate({ registerType: v } as Partial<MetadataObject>)}>
        <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="Balance" className="text-xs">Balance</SelectItem>
          <SelectItem value="Turnover" className="text-xs">Turnover</SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>
  )
}

function ConstantSettings({
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
          value={typeof o.defaultValue === 'string' || typeof o.defaultValue === 'number' ? o.defaultValue : ''}
          onChange={(e) => onUpdate({ defaultValue: e.target.value || null } as Partial<MetadataObject>)}
        />
      </SettingRow>
    </>
  )
}

function CustomTableSettings({
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
