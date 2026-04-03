import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@workspace/ui/components/table'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Checkbox } from '@workspace/ui/components/checkbox'
import { Badge } from '@workspace/ui/components/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@workspace/ui/components/tooltip'
import { ScrollArea } from '@workspace/ui/components/scroll-area'
import { cn } from '@workspace/ui/lib/utils'
import { FieldTypeSelect } from './field-type-select'
import type { Attribute, FieldType, MetadataKind } from '@simetra/core'
import { getStandardAttributes, type StandardAttribute, type StandardAttributeSettings } from '@simetra/core'
import { useMetadataStore } from '@/stores/metadata-store'
import { useUiStore } from '@/stores/ui-store'

const columnHelper = createColumnHelper<Attribute>()

interface AttributeTableProps {
  kind: MetadataKind
  objectName: string
  /** Поле обʼєкта, де лежать атрибути: 'attributes' | 'dimensions' | 'resources' */
  field: 'attributes' | 'dimensions' | 'resources'
  attributes: Attribute[]
  /** Налаштування для стандартних реквізитів */
  standardSettings?: StandardAttributeSettings
  /** Показувати стандартні реквізити */
  showStandard?: boolean
  /** Якщо задано — CRUD делегується до tabular section actions */
  tabularSectionName?: string
}

export function AttributeTable({
  kind,
  objectName,
  field,
  attributes,
  standardSettings,
  showStandard = false,
  tabularSectionName,
}: AttributeTableProps) {
  const { t, i18n } = useTranslation()
  const [selectedRow, setSelectedRow] = useState<string | null>(null)

  const {
    addAttribute,
    removeAttribute,
    updateAttribute,
    reorderAttributes,
    addDimension,
    removeDimension,
    updateDimension,
    reorderDimensions,
    addResource,
    removeResource,
    updateResource,
    reorderResources,
    addTabularSectionAttribute,
    removeTabularSectionAttribute,
    updateTabularSectionAttribute,
    reorderTabularSectionAttributes,
  } = useMetadataStore()
  const { selectField } = useUiStore()

  const standardAttrs = useMemo(
    () => (showStandard ? getStandardAttributes(kind, standardSettings) : []),
    [kind, standardSettings, showStandard],
  )

  const handleAdd = useCallback(() => {
    let i = 1
    const existing = new Set(attributes.map((a) => a.name))
    while (existing.has(`new_field_${i}`)) i++
    const attr: Attribute = {
      name: `new_field_${i}`,
      type: field === 'resources' ? 'Numeric' : 'String',
      required: false,
      indexed: false,
      unique: false,
      defaultValue: null,
    }

    if (tabularSectionName) {
      addTabularSectionAttribute(kind, objectName, tabularSectionName, attr)
    } else if (field === 'dimensions') {
      addDimension(kind, objectName, attr)
    } else if (field === 'resources') {
      addResource(kind, objectName, attr)
    } else {
      addAttribute(kind, objectName, attr)
    }
  }, [kind, objectName, field, attributes, tabularSectionName, addAttribute, addDimension, addResource, addTabularSectionAttribute])

  const handleRemove = useCallback(() => {
    if (!selectedRow) return
    if (tabularSectionName) {
      removeTabularSectionAttribute(kind, objectName, tabularSectionName, selectedRow)
    } else if (field === 'dimensions') {
      removeDimension(kind, objectName, selectedRow)
    } else if (field === 'resources') {
      removeResource(kind, objectName, selectedRow)
    } else {
      removeAttribute(kind, objectName, selectedRow)
    }
    setSelectedRow(null)
    selectField(null)
  }, [kind, objectName, field, selectedRow, tabularSectionName, removeAttribute, removeDimension, removeResource, removeTabularSectionAttribute, selectField])

  const handleUpdateField = useCallback(
    (attrName: string, updates: Partial<Attribute>) => {
      if (tabularSectionName) {
        updateTabularSectionAttribute(kind, objectName, tabularSectionName, attrName, updates)
      } else if (field === 'dimensions') {
        updateDimension(kind, objectName, attrName, updates)
      } else if (field === 'resources') {
        updateResource(kind, objectName, attrName, updates)
      } else {
        updateAttribute(kind, objectName, attrName, updates)
      }
    },
    [kind, objectName, field, tabularSectionName, updateAttribute, updateDimension, updateResource, updateTabularSectionAttribute],
  )

  const handleMove = useCallback(
    (direction: 'up' | 'down') => {
      if (!selectedRow) return
      const idx = attributes.findIndex((a) => a.name === selectedRow)
      if (idx === -1) return
      const newIdx = direction === 'up' ? idx - 1 : idx + 1
      if (newIdx < 0 || newIdx >= attributes.length) return
      if (tabularSectionName) {
        reorderTabularSectionAttributes(kind, objectName, tabularSectionName, idx, newIdx)
      } else if (field === 'dimensions') {
        reorderDimensions(kind, objectName, idx, newIdx)
      } else if (field === 'resources') {
        reorderResources(kind, objectName, idx, newIdx)
      } else {
        reorderAttributes(kind, objectName, idx, newIdx)
      }
    },
    [kind, objectName, selectedRow, attributes, field, tabularSectionName, reorderAttributes, reorderDimensions, reorderResources, reorderTabularSectionAttributes],
  )

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: () => t('metadata.field.name'),
        cell: (info) => (
          <EditableNameCell
            value={info.getValue()}
            onCommit={(newName) => handleUpdateField(info.row.original.name, { name: newName })}
          />
        ),
        size: 160,
      }),
      columnHelper.accessor('type', {
        header: () => t('metadata.field.type'),
        cell: (info) => (
          <FieldTypeSelect
            value={info.getValue()}
            onChange={(type: FieldType) =>
              handleUpdateField(info.row.original.name, { type })
            }
          />
        ),
        size: 130,
      }),
      columnHelper.accessor('required', {
        header: () => t('metadata.field.required'),
        cell: (info) => (
          <Checkbox
            checked={info.getValue()}
            onCheckedChange={(checked) =>
              handleUpdateField(info.row.original.name, { required: !!checked })
            }
            className="mx-auto"
          />
        ),
        size: 80,
      }),
      columnHelper.accessor('indexed', {
        header: () => t('metadata.field.indexed'),
        cell: (info) => (
          <Checkbox
            checked={info.getValue()}
            onCheckedChange={(checked) =>
              handleUpdateField(info.row.original.name, { indexed: !!checked })
            }
            className="mx-auto"
          />
        ),
        size: 80,
      }),
      columnHelper.display({
        id: 'description',
        header: () => t('metadata.field.description'),
        cell: (info) => {
          const desc = info.row.original.description
          if (!desc) return null
          const lang = i18n.language as 'uk' | 'en'
          return (
            <span className="truncate text-xs text-muted-foreground">
              {desc[lang] ?? desc.uk ?? desc.en ?? ''}
            </span>
          )
        },
        size: 200,
      }),
    ],
    [t, i18n.language, handleUpdateField],
  )

  const table = useReactTable({
    data: attributes,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.name,
  })

  const addLabel =
    field === 'dimensions'
      ? t('editor.addDimension')
      : field === 'resources'
        ? t('editor.addResource')
        : t('editor.addAttribute')

  const emptyLabel =
    field === 'dimensions'
      ? t('editor.emptyDimensions')
      : field === 'resources'
        ? t('editor.emptyResources')
        : t('editor.emptyAttributes')

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={handleAdd}>
          {addLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          disabled={!selectedRow}
          onClick={handleRemove}
        >
          {t('editor.deleteSelected')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          disabled={!selectedRow}
          onClick={() => handleMove('up')}
        >
          {t('editor.moveUp')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          disabled={!selectedRow}
          onClick={() => handleMove('down')}
        >
          {t('editor.moveDown')}
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="h-7">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="h-7 px-2 text-xs font-medium"
                    style={{ width: header.getSize() }}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {/* Стандартні реквізити — readonly */}
            {standardAttrs.map((attr) => (
              <StandardAttributeRow key={attr.name} attr={attr} />
            ))}

            {/* Користувацькі атрибути */}
            {table.getRowModel().rows.length === 0 && standardAttrs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-20 text-center text-xs text-muted-foreground"
                >
                  {emptyLabel}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn(
                    'h-8 cursor-pointer',
                    selectedRow === row.id && 'bg-accent',
                  )}
                  onClick={() => {
                    setSelectedRow(row.id)
                    selectField({
                      objectRef: { kind, name: objectName },
                      fieldName: row.id,
                    })
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="px-2 py-0.5">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  )
}

/** Inline-редагування імені з commit-on-blur патерном */
function EditableNameCell({ value, onCommit }: { value: string; onCommit: (newName: string) => void }) {
  const [draft, setDraft] = useState(value)

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) {
      onCommit(trimmed)
    } else {
      setDraft(value)
    }
  }

  return (
    <Input
      className="h-6 border-none bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-1"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
      }}
      onBlur={() => {
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          ;(e.target as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          setDraft(value)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

/** Рядок стандартного реквізита — readonly */
function StandardAttributeRow({ attr }: { attr: StandardAttribute }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'uk' | 'en'

  return (
    <TableRow className="h-8 bg-muted/30">
      <TableCell className="px-2 py-0.5">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs text-muted-foreground">{attr.name}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="px-1 py-0 text-[9px] leading-tight">
                {t('metadata.standardAttribute')}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">{attr.description[lang] ?? attr.description.uk}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </TableCell>
      <TableCell className="px-2 py-0.5">
        <span className="text-xs text-muted-foreground">{attr.type}</span>
      </TableCell>
      <TableCell className="px-2 py-0.5" />
      <TableCell className="px-2 py-0.5" />
      <TableCell className="px-2 py-0.5">
        <span className="truncate text-xs text-muted-foreground">
          {attr.description[lang] ?? attr.description.uk}
        </span>
      </TableCell>
    </TableRow>
  )
}
