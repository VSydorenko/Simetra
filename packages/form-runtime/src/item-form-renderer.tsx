import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useForm, type FieldValues, type Control } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type {
  MetadataRef,
  FormSchema,
  FormLayoutElement,
  ToolbarItem,
  Attribute,
  TabularSection,
  StandardAttribute,
} from '@simetra/core'
import { getStandardAttributes } from '@simetra/core'
import { Label } from '@workspace/ui/components/label'
import { Separator } from '@workspace/ui/components/separator'
import { Button } from '@workspace/ui/components/button'
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@workspace/ui/components/tabs'
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@workspace/ui/components/accordion'
import { useDataProvider, useMetadata } from './context'
import { buildFormSchema } from './schema-builder'
import { FormFieldRenderer } from './components/form-field-renderer'
import { RuntimeDataTable } from './components/runtime-data-table'
import { SaveButton } from './components/save-button'
import { PostButton } from './components/post-button'
import { UnpostButton } from './components/unpost-button'
import { DeletionMarkButton } from './components/deletion-mark-button'

export interface ItemFormRendererProps {
  objectRef: MetadataRef
  formModel: FormSchema
  recordId?: string
  onSave?: (data: Record<string, unknown>) => void
  onCancel?: () => void
}

// Маппінг width → Tailwind max-w класи
const WIDTH_CLASS_MAP: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  full: 'max-w-full',
}

// MetadataKind → ключ колекції в ProjectModel
const KIND_TO_COLLECTION: Record<string, string> = {
  Catalog: 'catalogs',
  Document: 'documents',
  Enumeration: 'enumerations',
  InformationRegister: 'informationRegisters',
  AccumulationRegister: 'accumulationRegisters',
  Constant: 'constants',
  CustomTable: 'customTables',
}

/** Контекст для рекурсивного рендерингу layout дерева */
interface RenderContext {
  attributes: Attribute[]
  tabularSections: TabularSection[]
  control: Control<FieldValues>
  getValues: ReturnType<typeof useForm<FieldValues>>['getValues']
  setValue: ReturnType<typeof useForm<FieldValues>>['setValue']
}

/** Знайти metadata об'єкт з ProjectModel за ref */
function findMetadataObject(
  model: Record<string, unknown>,
  ref: MetadataRef,
): Record<string, unknown> | undefined {
  const collectionKey = KIND_TO_COLLECTION[ref.kind]
  if (!collectionKey) return undefined
  const collection = model[collectionKey] as { name: string }[] | undefined
  return collection?.find((obj) => obj.name === ref.name) as
    | Record<string, unknown>
    | undefined
}

/** Побудувати settings для getStandardAttributes з metadata об'єкта */
function buildSettings(
  kind: string,
  object: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case 'Catalog':
      return {
        hierarchyType: (object.hierarchyType as string) ?? 'None',
        owners: (object.owners as unknown[]) ?? [],
      }
    case 'CustomTable':
      return {
        autoAddPrimaryKey: (object.autoAddPrimaryKey as boolean) ?? true,
      }
    default:
      return {}
  }
}

export function ItemFormRenderer({
  objectRef,
  formModel,
  recordId,
  onSave,
  onCancel,
}: ItemFormRendererProps) {
  const dataProvider = useDataProvider()
  const model = useMetadata()

  const [loading, setLoading] = useState(!!recordId)
  const [saving, setSaving] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  // Знайти metadata об'єкт з моделі
  const metadataObject = useMemo(
    () => findMetadataObject(model as unknown as Record<string, unknown>, objectRef),
    [model, objectRef],
  )

  // Список стандартних реквізитів
  const standardAttrs = useMemo(() => {
    if (!metadataObject) return []
    const settings = buildSettings(objectRef.kind, metadataObject)
    return getStandardAttributes(
      objectRef.kind as Parameters<typeof getStandardAttributes>[0],
      settings,
    )
  }, [metadataObject, objectRef.kind])

  // User-defined attributes (без стандартних)
  const userAttributes = useMemo(() => {
    if (!metadataObject) return []
    const stdNames = new Set(standardAttrs.map((a) => a.name))
    const attrs = (metadataObject.attributes as Attribute[]) ?? []
    return attrs.filter((a) => !stdNames.has(a.name))
  }, [metadataObject, standardAttrs])

  // Усі атрибути для Zod schema (стандартні як Attribute + user-defined)
  const allAttributes = useMemo(() => {
    const stdAsAttrs: Attribute[] = standardAttrs.map((sa) => ({
      name: sa.name,
      type: sa.type as Attribute['type'],
      required: false,
      indexed: sa.indexed,
      unique: false,
      defaultValue: null,
      ...(sa.ref
        ? { ref: sa.ref as Attribute['ref'] }
        : {}),
      ...(sa.allowedTypes
        ? { allowedTypes: sa.allowedTypes as Attribute['allowedTypes'] }
        : {}),
    }))
    return [...stdAsAttrs, ...userAttributes]
  }, [standardAttrs, userAttributes])

  // Tabular sections
  const tabularSections = useMemo(
    () => (metadataObject?.tabularSections as TabularSection[]) ?? [],
    [metadataObject],
  )

  // Zod schema для react-hook-form
  const formSchema = useMemo(
    () => buildFormSchema(allAttributes),
    [allAttributes],
  )

  const {
    control,
    handleSubmit,
    reset,
    getValues,
    setValue,
  } = useForm<FieldValues>({
    // Zod v4 compat layer потребує cast для zodResolver
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(formSchema as any),
    defaultValues: {},
  })

  // Завантаження запису при edit
  useEffect(() => {
    if (!recordId) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setNotFound(false)

    dataProvider.get(objectRef, recordId).then((record) => {
      if (cancelled) return
      if (!record) {
        setNotFound(true)
      } else {
        reset(record)
      }
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [dataProvider, objectRef, recordId, reset])

  // Збереження
  const handleFormSubmit = useCallback(
    async (data: FieldValues) => {
      setSaving(true)
      try {
        if (recordId) {
          await dataProvider.update(objectRef, recordId, data)
        } else {
          await dataProvider.create(objectRef, data as Record<string, unknown>)
        }
        onSave?.(data as Record<string, unknown>)
      } finally {
        setSaving(false)
      }
    },
    [dataProvider, objectRef, recordId, onSave],
  )

  const widthClass = WIDTH_CLASS_MAP[formModel.width ?? 'lg'] ?? 'max-w-lg'

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        Завантаження...
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="flex items-center justify-center p-8 text-destructive">
        Запис не знайдено
      </div>
    )
  }

  const renderCtx: RenderContext = {
    attributes: allAttributes,
    tabularSections,
    control,
    getValues,
    setValue,
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit(handleFormSubmit)}
      className={`mx-auto space-y-6 p-4 ${widthClass}`}
    >
      {/* Toolbar */}
      {formModel.toolbar && formModel.toolbar.length > 0 && (
        <div className="flex items-center gap-2">
          {formModel.toolbar.map((item, idx) =>
            renderToolbarItem(item, idx, {
              objectRef,
              recordId,
              saving,
              onCancel,
              formRef,
            }),
          )}
        </div>
      )}

      {/* Standard attributes header */}
      {standardAttrs.length > 0 && (
        <StandardAttributesHeader
          standardAttrs={standardAttrs}
          control={control}
        />
      )}

      <Separator />

      {/* Layout body */}
      {formModel.layout ? (
        renderLayoutElement(formModel.layout, renderCtx)
      ) : (
        // Fallback: вертикальний список user-defined полів
        <div className="space-y-4">
          {userAttributes.map((attr) => (
            <FormFieldRenderer
              key={attr.name}
              attribute={attr}
              control={control}
            />
          ))}
          {tabularSections.map((ts) => (
            <TabularSectionField
              key={ts.name}
              tabularSection={ts}
              getValues={renderCtx.getValues}
              setValue={renderCtx.setValue}
            />
          ))}
        </div>
      )}
    </form>
  )
}

// ============================================================
// Standard Attributes Header
// ============================================================

function StandardAttributesHeader({
  standardAttrs,
  control,
}: {
  standardAttrs: StandardAttribute[]
  control: Control<FieldValues>
}) {
  // Фільтруємо системні поля (id, timestamps, deletion_mark)
  const visibleStdAttrs = standardAttrs.filter(
    (a) =>
      !['id', 'deletion_mark', 'created_at', 'updated_at', 'predefined_name'].includes(
        a.name,
      ),
  )

  if (visibleStdAttrs.length === 0) return null

  return (
    <div className="grid grid-cols-2 gap-4">
      {visibleStdAttrs.map((sa) => (
        <FormFieldRenderer
          key={sa.name}
          attribute={{
            name: sa.name,
            type: sa.type as Attribute['type'],
            required: false,
            indexed: sa.indexed,
            unique: false,
            defaultValue: null,
            ...(sa.ref
              ? { ref: sa.ref as Attribute['ref'] }
              : {}),
            ...(sa.allowedTypes
              ? { allowedTypes: sa.allowedTypes as Attribute['allowedTypes'] }
              : {}),
          }}
          control={control}
        />
      ))}
    </div>
  )
}

// ============================================================
// Layout Tree Renderer
// ============================================================

function renderLayoutElement(
  element: FormLayoutElement,
  ctx: RenderContext,
): React.ReactNode {
  switch (element.element) {
    case 'Field':
      return renderFieldElement(element, ctx)
    case 'Group':
      return renderGroupElement(element, ctx)
    case 'Columns':
      return renderColumnsElement(element, ctx)
    case 'Column':
      return renderColumnElement(element, ctx)
    case 'Tabs':
      return renderTabsElement(element, ctx)
    case 'Tab':
      // Tab поза Tabs — рендерити як Group
      return (
        <div className="space-y-4">
          {element.children.map((child, idx) => (
            <div key={idx}>{renderLayoutElement(child, ctx)}</div>
          ))}
        </div>
      )
    case 'TabularSection':
      return renderTabularSectionElement(element, ctx)
    case 'Separator':
      return <Separator />
    case 'Label':
      return (
        <Label className={element.className ?? undefined}>
          {element.text.uk ?? element.text.en}
        </Label>
      )
    case 'Accordion':
      return renderAccordionElement(element, ctx)
    default:
      return null
  }
}

function renderFieldElement(
  element: FormLayoutElement & { element: 'Field' },
  ctx: RenderContext,
) {
  const attr = ctx.attributes.find((a) => a.name === element.ref)
  if (!attr) return null
  if (element.hidden) return null

  return (
    <FormFieldRenderer
      attribute={attr}
      control={ctx.control}
      readOnly={element.readOnly}
    />
  )
}

function renderGroupElement(
  element: FormLayoutElement & { element: 'Group' },
  ctx: RenderContext,
) {
  const title = element.title?.uk ?? element.title?.en

  return (
    <div
      className={`space-y-4 rounded-md border p-4 ${element.className ?? ''}`}
    >
      {title && (
        <h3 className="text-sm font-semibold">{title}</h3>
      )}
      {element.children.map((child, idx) => (
        <div key={idx}>{renderLayoutElement(child, ctx)}</div>
      ))}
    </div>
  )
}

function renderColumnsElement(
  element: FormLayoutElement & { element: 'Columns' },
  ctx: RenderContext,
) {
  const colCount = element.columns.length

  return (
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: `repeat(${colCount}, 1fr)` }}
    >
      {element.columns.map((col, idx) => (
        <div key={idx}>{renderColumnElement(col, ctx)}</div>
      ))}
    </div>
  )
}

function renderColumnElement(
  element: FormLayoutElement & { element: 'Column' },
  ctx: RenderContext,
) {
  return (
    <div className="space-y-4">
      {element.children.map((child, idx) => (
        <div key={idx}>{renderLayoutElement(child, ctx)}</div>
      ))}
    </div>
  )
}

function renderTabsElement(
  element: FormLayoutElement & { element: 'Tabs' },
  ctx: RenderContext,
) {
  const firstTab = element.tabs[0]
  const defaultValue = firstTab
    ? (firstTab.title.uk ?? firstTab.title.en ?? 'tab-0')
    : 'tab-0'

  return (
    <Tabs defaultValue={defaultValue}>
      <TabsList>
        {element.tabs.map((tab, idx) => {
          const tabTitle = tab.title.uk ?? tab.title.en ?? `tab-${idx}`
          return (
            <TabsTrigger key={idx} value={tabTitle}>
              {tabTitle}
            </TabsTrigger>
          )
        })}
      </TabsList>
      {element.tabs.map((tab, idx) => {
        const tabTitle = tab.title.uk ?? tab.title.en ?? `tab-${idx}`
        return (
          <TabsContent key={idx} value={tabTitle} className="space-y-4">
            {tab.children.map((child, childIdx) => (
              <div key={childIdx}>
                {renderLayoutElement(child, ctx)}
              </div>
            ))}
          </TabsContent>
        )
      })}
    </Tabs>
  )
}

function renderTabularSectionElement(
  element: FormLayoutElement & { element: 'TabularSection' },
  ctx: RenderContext,
) {
  const ts = ctx.tabularSections.find((t) => t.name === element.ref)
  if (!ts) return null

  return (
    <TabularSectionField
      tabularSection={ts}
      columns={element.columns ?? undefined}
      allowAdd={element.allowAdd}
      allowDelete={element.allowDelete}
      allowReorder={element.allowReorder}
      getValues={ctx.getValues}
      setValue={ctx.setValue}
    />
  )
}

function renderAccordionElement(
  element: FormLayoutElement & { element: 'Accordion' },
  ctx: RenderContext,
) {
  const title = element.title.uk ?? element.title.en ?? ''

  return (
    <Accordion type="single" collapsible>
      <AccordionItem value={title}>
        <AccordionTrigger>{title}</AccordionTrigger>
        <AccordionContent className="space-y-4">
          {element.children.map((child, idx) => (
            <div key={idx}>{renderLayoutElement(child, ctx)}</div>
          ))}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

// ============================================================
// Tabular Section Field
// ============================================================

function TabularSectionField({
  tabularSection,
  columns: visibleColumns,
  allowAdd,
  allowDelete,
  allowReorder,
  getValues,
  setValue,
}: {
  tabularSection: TabularSection
  columns?: string[] | null
  allowAdd?: boolean
  allowDelete?: boolean
  allowReorder?: boolean
  getValues: ReturnType<typeof useForm<FieldValues>>['getValues']
  setValue: ReturnType<typeof useForm<FieldValues>>['setValue']
}) {
  const fieldName = tabularSection.name
  const rows =
    (getValues(fieldName) as Record<string, unknown>[] | undefined) ?? []

  // Фільтрувати стовпці якщо вказано
  const attrs = visibleColumns
    ? tabularSection.attributes.filter((a) => visibleColumns.includes(a.name))
    : tabularSection.attributes

  const tableColumns = attrs.map((a) => ({
    name: a.name,
    type: a.type,
    displayName: a.displayName as { uk?: string; en?: string } | undefined,
  }))

  const handleChange = useCallback(
    (newRows: Record<string, unknown>[]) => {
      setValue(fieldName, newRows, { shouldValidate: true })
    },
    [setValue, fieldName],
  )

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">
        {tabularSection.displayName?.uk ??
          tabularSection.displayName?.en ??
          tabularSection.name}
      </h4>
      <RuntimeDataTable
        columns={tableColumns}
        value={rows}
        onChange={handleChange}
        allowAdd={allowAdd}
        allowDelete={allowDelete}
        allowReorder={allowReorder}
      />
    </div>
  )
}

// ============================================================
// Toolbar Renderer
// ============================================================

function renderToolbarItem(
  item: ToolbarItem,
  index: number,
  ctx: {
    objectRef: MetadataRef
    recordId?: string
    saving: boolean
    onCancel?: () => void
    formRef: React.RefObject<HTMLFormElement | null>
  },
): React.ReactNode {
  switch (item.type) {
    case 'SaveButton':
      return (
        <SaveButton
          key={index}
          onClick={() => {
            ctx.formRef.current?.requestSubmit()
          }}
          loading={ctx.saving}
        />
      )

    case 'SaveAndCloseButton':
      return (
        <Button
          key={index}
          variant="default"
          disabled={ctx.saving}
          onClick={() => {
            // Submit форми, після чого onCancel закриє вікно
            ctx.formRef.current?.requestSubmit()
            // onCancel буде викликано через onSave callback ланцюг
          }}
        >
          {ctx.saving ? 'Збереження...' : 'Зберегти і закрити'}
        </Button>
      )

    case 'PostButton':
      if (!ctx.recordId) return null
      return (
        <PostButton
          key={index}
          objectRef={ctx.objectRef}
          recordId={ctx.recordId}
        />
      )

    case 'UnpostButton':
      if (!ctx.recordId) return null
      return (
        <UnpostButton
          key={index}
          objectRef={ctx.objectRef}
          recordId={ctx.recordId}
        />
      )

    case 'DeletionMarkButton':
      if (!ctx.recordId) return null
      return (
        <DeletionMarkButton
          key={index}
          objectRef={ctx.objectRef}
          recordId={ctx.recordId}
        />
      )

    case 'Separator':
      return <Separator key={index} orientation="vertical" className="h-6" />

    case 'CustomButton':
      return (
        <Button key={index} variant="outline">
          {item.label.uk ?? item.label.en}
        </Button>
      )

    default:
      return null
  }
}
