import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@workspace/ui/components/tabs'
import { Badge } from '@workspace/ui/components/badge'
import { Input } from '@workspace/ui/components/input'
import { cn } from '@workspace/ui/lib/utils'
import { HugeiconsIcon } from '@hugeicons/react'
import { AttributeTable } from './attribute-table'
import { EnumValuesEditor } from './enum-values-editor'
import { TabularSectionsEditor } from './tabular-sections-editor'
import { SettingsForm } from './settings-form'
import { KIND_ICONS, KIND_COLORS, KIND_BADGE_CLASSES } from '@/lib/metadata-icons'
import { KIND_TO_KEY } from '@/lib/metadata-defaults'
import { useMetadataStore } from '@/stores/metadata-store'
import { useUiStore } from '@/stores/ui-store'
import type { MetadataKind, MetadataRef, MetadataObject, Attribute, TabularSection, StandardAttributeSettings } from '@simetra/core'

interface ObjectEditorProps {
  objectRef: MetadataRef
  activeSection: string
  onSectionChange: (section: string) => void
}

/** Визначає набір вкладок залежно від kind обʼєкта */
function getEditorTabs(kind: MetadataKind): string[] {
  switch (kind) {
    case 'Catalog':
    case 'Document':
      return ['attributes', 'tabularSections', 'settings']
    case 'CustomTable':
      return ['attributes', 'settings']
    case 'Enumeration':
      return ['values']
    case 'InformationRegister':
    case 'AccumulationRegister':
      return ['dimensions', 'resources', 'attributes', 'settings']
    case 'Constant':
      return ['settings']
  }
}

/** Витягує налаштування для стандартних реквізитів з обʼєкта */
function getStandardSettings(obj: MetadataObject): StandardAttributeSettings {
  const settings: StandardAttributeSettings = {}
  if ('hierarchyType' in obj) settings.hierarchyType = obj.hierarchyType as StandardAttributeSettings['hierarchyType']
  if ('owners' in obj) settings.owners = obj.owners as StandardAttributeSettings['owners']
  if ('periodicity' in obj) settings.periodicity = obj.periodicity as string
  if ('writeMode' in obj) settings.writeMode = obj.writeMode as string
  if ('registerType' in obj) settings.registerType = obj.registerType as StandardAttributeSettings['registerType']
  if ('autoAddPrimaryKey' in obj) settings.autoAddPrimaryKey = obj.autoAddPrimaryKey as boolean
  return settings
}

export function ObjectEditor({ objectRef, activeSection, onSectionChange }: ObjectEditorProps) {
  const { t } = useTranslation()
  const { updateTabObjectRef } = useUiStore()
  const model = useMetadataStore((s) => s.model)
  const renameObject = useMetadataStore((s) => s.renameObject)

  const object = useMemo(() => {
    const key = KIND_TO_KEY[objectRef.kind]
    const objects = model[key] as MetadataObject[]
    return objects.find((o) => o.name === objectRef.name) ?? null
  }, [model, objectRef])

  const tabs = useMemo(() => getEditorTabs(objectRef.kind), [objectRef.kind])

  // Якщо поточна секція не в списку для цього kind — вибрати першу
  const effectiveTab = tabs.includes(activeSection) ? activeSection : tabs[0]

  // commit-on-blur: локальний draft для імені обʼєкта
  const [nameDraft, setNameDraft] = useState(object?.name ?? '')
  const nameInputRef = useRef<HTMLInputElement>(null)


  if (!object) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('editor.noSelection')}
      </div>
    )
  }

  const stdSettings = getStandardSettings(object)
  const icon = KIND_ICONS[objectRef.kind]

  const commitName = () => {
    const trimmed = nameDraft.trim()
    if (trimmed && trimmed !== object.name) {
      const errors = renameObject(objectRef.kind, object.name, trimmed)
      if (!errors) {
        updateTabObjectRef(objectRef, { kind: objectRef.kind, name: trimmed })
      } else {
        setNameDraft(object.name)
      }
    } else {
      setNameDraft(object.name)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Заголовок обʼєкта */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <HugeiconsIcon icon={icon} size={16} className={cn('shrink-0', KIND_COLORS[objectRef.kind])} />
        <Badge variant="outline" className={cn('px-1.5 py-0 text-[10px]', KIND_BADGE_CLASSES[objectRef.kind])}>
          {t(`metadata.kind.${objectRef.kind}`)}
        </Badge>
        <Input
          ref={nameInputRef}
          className="h-7 max-w-64 border-none bg-transparent px-1 font-mono text-sm font-medium shadow-none focus-visible:ring-1"
          value={nameDraft}
          onChange={(e) => {
            setNameDraft(e.target.value)
          }}
          onBlur={() => {
            commitName()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitName()
              ;(e.target as HTMLInputElement).blur()
            } else if (e.key === 'Escape') {
              setNameDraft(object.name)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        {'displayName' in object && (
          <span className="truncate text-xs text-muted-foreground">
            {(object.displayName as { uk?: string })?.uk ?? ''}
          </span>
        )}
      </div>

      {/* Вкладки всередині картки */}
      <Tabs value={effectiveTab} onValueChange={onSectionChange} className="flex flex-1 flex-col overflow-hidden">
        <TabsList className="h-8 w-full justify-start rounded-none border-b border-border bg-transparent px-2">
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab}
              value={tab}
              className="h-7 rounded-sm px-3 text-xs data-[state=active]:bg-accent data-[state=active]:shadow-none"
            >
              {t(`metadata.section.${tab}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Контент вкладок */}
        {tabs.includes('attributes') && (
          <TabsContent value="attributes" className="mt-0 flex-1 overflow-hidden">
            <AttributeTable
              kind={objectRef.kind}
              objectName={objectRef.name}
              field="attributes"
              attributes={'attributes' in object ? (object.attributes as Attribute[]) : []}
              standardSettings={stdSettings}
              showStandard
            />
          </TabsContent>
        )}

        {tabs.includes('dimensions') && (
          <TabsContent value="dimensions" className="mt-0 flex-1 overflow-hidden">
            <AttributeTable
              kind={objectRef.kind}
              objectName={objectRef.name}
              field="dimensions"
              attributes={'dimensions' in object ? (object.dimensions as Attribute[]) : []}
              standardSettings={stdSettings}
              showStandard
            />
          </TabsContent>
        )}

        {tabs.includes('resources') && (
          <TabsContent value="resources" className="mt-0 flex-1 overflow-hidden">
            <AttributeTable
              kind={objectRef.kind}
              objectName={objectRef.name}
              field="resources"
              attributes={'resources' in object ? (object.resources as Attribute[]) : []}
            />
          </TabsContent>
        )}

        {tabs.includes('tabularSections') && (
          <TabsContent value="tabularSections" className="mt-0 flex-1 overflow-hidden">
            <TabularSectionsEditor
              kind={objectRef.kind}
              objectName={objectRef.name}
              tabularSections={
                'tabularSections' in object ? (object.tabularSections as TabularSection[]) : []
              }
            />
          </TabsContent>
        )}

        {tabs.includes('values') && (
          <TabsContent value="values" className="mt-0 flex-1 overflow-hidden">
            <EnumValuesEditor
              objectName={objectRef.name}
              values={
                'values' in object
                  ? (object.values as { name: string; displayName?: { uk?: string; en?: string }; order?: number }[])
                  : []
              }
            />
          </TabsContent>
        )}

        {tabs.includes('settings') && (
          <TabsContent value="settings" className="mt-0 flex-1 overflow-hidden">
            <SettingsForm
              kind={objectRef.kind}
              objectName={objectRef.name}
              object={object}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
