import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { Button } from "@workspace/ui/components/button"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  Delete02Icon,
  ArrowUp01Icon,
  ArrowDown01Icon,
} from "@hugeicons/core-free-icons"
import type { Attribute, MetadataKind } from "@simetra/core"
import { useMetadataStore } from "@/stores/metadata-store"
import { useUiStore } from "@/stores/ui-store"
import { useFieldUpdate, type FieldRole } from "@/hooks/use-field-update"
import { formatTypeLabel } from "@/lib/format-type-label"
import { DataTypeEditorDialog } from "@/components/editor/data-type-editor-dialog"

const columnHelper = createColumnHelper<Attribute>()

interface AttributeTableProps {
  kind: MetadataKind
  objectName: string
  /** Поле обʼєкта, де лежать атрибути: 'attributes' | 'dimensions' | 'resources' */
  field: "attributes" | "dimensions" | "resources"
  attributes: Attribute[]
  /** Якщо задано — CRUD делегується до tabular section actions */
  tabularSectionName?: string
}

export function AttributeTable({
  kind,
  objectName,
  field,
  attributes,
  tabularSectionName,
}: AttributeTableProps) {
  const { t, i18n } = useTranslation()
  const [selectedRow, setSelectedRow] = useState<string | null>(null)
  const [editingTypeAttr, setEditingTypeAttr] = useState<string | null>(null)

  const model = useMetadataStore((s) => s.model)
  const {
    addAttribute,
    removeAttribute,
    reorderAttributes,
    addDimension,
    removeDimension,
    reorderDimensions,
    addResource,
    removeResource,
    reorderResources,
    addTabularSectionAttribute,
    removeTabularSectionAttribute,
    reorderTabularSectionAttributes,
  } = useMetadataStore()
  const { selectField } = useUiStore()
  const dispatchFieldUpdate = useFieldUpdate()

  const handleAdd = useCallback(() => {
    let i = 1
    const existing = new Set(attributes.map((a) => a.name))
    while (existing.has(`new_field_${i}`)) i++
    const attr: Attribute = {
      name: `new_field_${i}`,
      type: field === "resources" ? "Numeric" : "String",
      required: false,
      indexed: false,
      unique: false,
      defaultValue: null,
    }

    if (tabularSectionName) {
      addTabularSectionAttribute(kind, objectName, tabularSectionName, attr)
    } else if (field === "dimensions") {
      addDimension(kind, objectName, attr)
    } else if (field === "resources") {
      addResource(kind, objectName, attr)
    } else {
      addAttribute(kind, objectName, attr)
    }
  }, [
    kind,
    objectName,
    field,
    attributes,
    tabularSectionName,
    addAttribute,
    addDimension,
    addResource,
    addTabularSectionAttribute,
  ])

  const handleRemove = useCallback(() => {
    if (!selectedRow) return
    if (tabularSectionName) {
      removeTabularSectionAttribute(
        kind,
        objectName,
        tabularSectionName,
        selectedRow
      )
    } else if (field === "dimensions") {
      removeDimension(kind, objectName, selectedRow)
    } else if (field === "resources") {
      removeResource(kind, objectName, selectedRow)
    } else {
      removeAttribute(kind, objectName, selectedRow)
    }
    setSelectedRow(null)
    selectField(null)
  }, [
    kind,
    objectName,
    field,
    selectedRow,
    tabularSectionName,
    removeAttribute,
    removeDimension,
    removeResource,
    removeTabularSectionAttribute,
    selectField,
  ])

  const handleMove = useCallback(
    (direction: "up" | "down") => {
      if (!selectedRow) return
      const idx = attributes.findIndex((a) => a.name === selectedRow)
      if (idx === -1) return
      const newIdx = direction === "up" ? idx - 1 : idx + 1
      if (newIdx < 0 || newIdx >= attributes.length) return
      if (tabularSectionName) {
        reorderTabularSectionAttributes(
          kind,
          objectName,
          tabularSectionName,
          idx,
          newIdx
        )
      } else if (field === "dimensions") {
        reorderDimensions(kind, objectName, idx, newIdx)
      } else if (field === "resources") {
        reorderResources(kind, objectName, idx, newIdx)
      } else {
        reorderAttributes(kind, objectName, idx, newIdx)
      }
    },
    [
      kind,
      objectName,
      selectedRow,
      attributes,
      field,
      tabularSectionName,
      reorderAttributes,
      reorderDimensions,
      reorderResources,
      reorderTabularSectionAttributes,
    ]
  )

  /** Атрибут, для якого зараз відкрито діалог редагування типу */
  const editingAttribute = useMemo(
    () => (editingTypeAttr ? attributes.find((a) => a.name === editingTypeAttr) ?? null : null),
    [editingTypeAttr, attributes],
  )

  /** Зберігає зміни типу через відповідний store action */
  const handleTypeUpdate = useCallback(
    (updates: Partial<Attribute>) => {
      if (!editingTypeAttr) return
      const role: FieldRole = tabularSectionName
        ? "tabularSection"
        : field
      dispatchFieldUpdate(
        { kind, objectName, fieldName: editingTypeAttr, role, tabularSectionName },
        updates,
      )
    },
    [kind, objectName, field, editingTypeAttr, tabularSectionName, dispatchFieldUpdate],
  )

  const columns = useMemo(
    () => [
      columnHelper.accessor("name", {
        header: () => t("metadata.field.name"),
        cell: (info) => (
          <span className="font-mono text-xs">{info.getValue()}</span>
        ),
        size: 160,
      }),
      columnHelper.accessor("type", {
        header: () => t("metadata.field.type"),
        cell: (info) => (
          <button
            type="button"
            className="inline-flex cursor-pointer items-center rounded-md border bg-transparent px-1.5 py-0 text-[10px] font-semibold text-foreground shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={(e) => {
              e.stopPropagation()
              setEditingTypeAttr(info.row.original.name)
            }}
          >
            {formatTypeLabel(info.row.original, t)}
          </button>
        ),
        size: 130,
      }),
      columnHelper.accessor("required", {
        header: () => t("metadata.field.required"),
        cell: (info) =>
          info.getValue() ? (
            <span className="mx-auto block w-fit text-xs text-foreground">
              ✓
            </span>
          ) : null,
        size: 80,
      }),
      columnHelper.accessor("indexed", {
        header: () => t("metadata.field.indexed"),
        cell: (info) =>
          info.getValue() ? (
            <span className="mx-auto block w-fit text-xs text-foreground">
              ✓
            </span>
          ) : null,
        size: 80,
      }),
      columnHelper.display({
        id: "description",
        header: () => t("metadata.field.description"),
        cell: (info) => {
          const desc = info.row.original.description
          if (!desc) return null
          const lang = i18n.language as "uk" | "en"
          return (
            <span className="truncate text-xs text-muted-foreground">
              {desc[lang] ?? desc.uk ?? desc.en ?? ""}
            </span>
          )
        },
        size: 200,
      }),
    ],
    [t, i18n.language]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- відомий false positive для TanStack Table
  const table = useReactTable({
    data: attributes,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.name,
  })

  const addLabel =
    field === "dimensions"
      ? t("editor.addDimension")
      : field === "resources"
        ? t("editor.addResource")
        : t("editor.addAttribute")

  const emptyLabel =
    field === "dimensions"
      ? t("editor.emptyDimensions")
      : field === "resources"
        ? t("editor.emptyResources")
        : t("editor.emptyAttributes")

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border-b border-border px-1.5 py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-green-600 hover:text-green-600"
              aria-label={addLabel}
              onClick={handleAdd}
            >
              <HugeiconsIcon
                icon={Add01Icon}
                strokeWidth={2}
                className="size-3.5"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{addLabel}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-destructive hover:text-destructive"
              aria-label={t("editor.deleteSelected")}
              disabled={!selectedRow}
              onClick={handleRemove}
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                strokeWidth={2}
                className="size-3.5"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("editor.deleteSelected")}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-blue-500 hover:text-blue-500"
              aria-label={t("editor.moveUp")}
              disabled={!selectedRow}
              onClick={() => handleMove("up")}
            >
              <HugeiconsIcon
                icon={ArrowUp01Icon}
                strokeWidth={2}
                className="size-3.5"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("editor.moveUp")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-blue-500 hover:text-blue-500"
              aria-label={t("editor.moveDown")}
              disabled={!selectedRow}
              onClick={() => handleMove("down")}
            >
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                strokeWidth={2}
                className="size-3.5"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("editor.moveDown")}</TooltipContent>
        </Tooltip>
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
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
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
                    "h-8 cursor-pointer",
                    selectedRow === row.id && "bg-accent"
                  )}
                  onClick={() => {
                    setSelectedRow(row.id)
                    selectField({
                      objectRef: { kind, name: objectName },
                      fieldName: row.id,
                      tabularSectionName,
                    })
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="px-2 py-0.5">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </ScrollArea>

      {editingAttribute && (
        <DataTypeEditorDialog
          open={!!editingTypeAttr}
          onOpenChange={(open) => {
            if (!open) setEditingTypeAttr(null)
          }}
          attribute={editingAttribute}
          model={model}
          onSave={handleTypeUpdate}
        />
      )}
    </div>
  )
}
