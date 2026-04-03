import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@workspace/ui/components/badge'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { ScrollArea } from '@workspace/ui/components/scroll-area'
import { cn } from '@workspace/ui/lib/utils'
import { HugeiconsIcon } from '@hugeicons/react'
import { AttributeTable } from './attribute-table'
import { EnumValuesEditor } from './enum-values-editor'
import { TabularSectionsEditor } from './tabular-sections-editor'
import { SettingsFormContent } from './settings-form'
import { VerticalNav } from './vertical-nav'
import { SECTION_CONFIG } from './section-config'
import { KIND_ICONS, KIND_COLORS, KIND_BADGE_CLASSES } from '@/lib/metadata-icons'
import { KIND_TO_KEY } from '@/lib/metadata-defaults'
import { useMetadataStore } from '@/stores/metadata-store'
import { useUiStore } from '@/stores/ui-store'
import type { MetadataRef, MetadataObject, Attribute, TabularSection, StandardAttributeSettings } from '@simetra/core'

interface ObjectEditorProps {
  objectRef: MetadataRef
  activeSection: string
  onSectionChange: (section: string) => void
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

  const sections = useMemo(() => SECTION_CONFIG[objectRef.kind], [objectRef.kind])
  const sectionIds = useMemo(() => sections.map((s) => s.id), [sections])

  // Якщо поточна секція не в списку для цього kind — вибрати першу
  const effectiveSection = sectionIds.includes(activeSection) ? activeSection : sectionIds[0]

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

      {/* Вертикальна навігація + контент секції */}
      <div className="flex flex-1 overflow-hidden">
        <VerticalNav
          sections={sections}
          activeSection={effectiveSection}
          onSectionChange={onSectionChange}
        />
        <div className="flex-1 overflow-hidden">
          <SectionContent
            kind={objectRef.kind}
            objectName={objectRef.name}
            object={object}
            section={effectiveSection}
            standardSettings={stdSettings}
          />
        </div>
      </div>
    </div>
  )
}

/** Рендер контенту активної секції */
function SectionContent({
  kind,
  objectName,
  object,
  section,
  standardSettings,
}: {
  kind: MetadataRef['kind']
  objectName: string
  object: MetadataObject
  section: string
  standardSettings: StandardAttributeSettings
}) {
  const { t } = useTranslation()

  switch (section) {
    case 'main':
      return (
        <MainSectionContent
          kind={kind}
          objectName={objectName}
          object={object}
        />
      )

    case 'data':
      return (
        <DataSectionContent
          kind={kind}
          objectName={objectName}
          object={object}
          standardSettings={standardSettings}
        />
      )

    case 'values':
      return (
        <EnumValuesEditor
          objectName={objectName}
          values={
            'values' in object
              ? (object.values as { name: string; displayName?: { uk?: string; en?: string }; order?: number }[])
              : []
          }
        />
      )

    case 'numbering':
    case 'movements':
    case 'settings':
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {t(`metadata.section.${section}`)} — {t('editor.comingSoon')}
        </div>
      )

    default:
      return null
  }
}

/** Комбінований вигляд даних: реквізити + табличні частини або виміри + ресурси + реквізити */
function DataSectionContent({
  kind,
  objectName,
  object,
  standardSettings,
}: {
  kind: MetadataRef['kind']
  objectName: string
  object: MetadataObject
  standardSettings: StandardAttributeSettings
}) {
  const isRegister = kind === 'InformationRegister' || kind === 'AccumulationRegister'

  if (isRegister) {
    return (
      <div className="flex h-full flex-col overflow-auto">
        <AttributeTable
          kind={kind}
          objectName={objectName}
          field="dimensions"
          attributes={'dimensions' in object ? (object.dimensions as Attribute[]) : []}
          standardSettings={standardSettings}
          showStandard
        />
        <AttributeTable
          kind={kind}
          objectName={objectName}
          field="resources"
          attributes={'resources' in object ? (object.resources as Attribute[]) : []}
        />
        <AttributeTable
          kind={kind}
          objectName={objectName}
          field="attributes"
          attributes={'attributes' in object ? (object.attributes as Attribute[]) : []}
        />
      </div>
    )
  }

  const hasTabularSections = kind === 'Catalog' || kind === 'Document'

  return (
    <div className="flex h-full flex-col overflow-auto">
      <AttributeTable
        kind={kind}
        objectName={objectName}
        field="attributes"
        attributes={'attributes' in object ? (object.attributes as Attribute[]) : []}
        standardSettings={standardSettings}
        showStandard
      />
      {hasTabularSections && (
        <TabularSectionsEditor
          kind={kind}
          objectName={objectName}
          tabularSections={
            'tabularSections' in object ? (object.tabularSections as TabularSection[]) : []
          }
        />
      )}
    </div>
  )
}

/** Секція "Основні": displayName + ключові налаштування типу */
function MainSectionContent({
  kind,
  objectName,
  object,
}: {
  kind: MetadataRef['kind']
  objectName: string
  object: MetadataObject
}) {
  const { t } = useTranslation()
  const updateObject = useMetadataStore((s) => s.updateObject)

  const displayName = 'displayName' in object
    ? (object.displayName as { uk?: string; en?: string })
    : undefined
  const description = 'description' in object ? (object.description as string) : undefined

  const handleDisplayNameChange = useCallback(
    (lang: 'uk' | 'en', value: string) => {
      updateObject(kind, objectName, {
        displayName: { ...displayName, [lang]: value },
      } as Partial<MetadataObject>)
    },
    [kind, objectName, displayName, updateObject],
  )

  const handleDescriptionChange = useCallback(
    (value: string) => {
      updateObject(kind, objectName, { description: value } as Partial<MetadataObject>)
    },
    [kind, objectName, updateObject],
  )

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        {displayName !== undefined && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('editor.displayNameUk')}</Label>
              <Input
                className="h-8 text-sm"
                value={displayName?.uk ?? ''}
                onChange={(e) => handleDisplayNameChange('uk', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('editor.displayNameEn')}</Label>
              <Input
                className="h-8 text-sm"
                value={displayName?.en ?? ''}
                onChange={(e) => handleDisplayNameChange('en', e.target.value)}
              />
            </div>
          </>
        )}

        {description !== undefined && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t('metadata.field.description')}</Label>
            <Input
              className="h-8 text-sm"
              value={description ?? ''}
              onChange={(e) => handleDescriptionChange(e.target.value)}
            />
          </div>
        )}

        {/* Налаштування типу — рендеримо вміст SettingsForm без окремого ScrollArea */}
        <SettingsFormContent kind={kind} objectName={objectName} object={object} />
      </div>
    </ScrollArea>
  )
}
