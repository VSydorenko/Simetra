import { useCallback, useRef, useEffect, useContext, useState } from "react"
import { useTranslation } from "react-i18next"
import type { NodeRendererProps, NodeApi } from "react-arborist"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  Copy01Icon,
  Delete02Icon,
  PencilEdit02Icon,
  LinkSquare02Icon,
  ArrowUp01Icon,
  ArrowDown01Icon,
} from "@hugeicons/core-free-icons"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@workspace/ui/components/context-menu"
import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"
import {
  NUMERIC_PRECISION,
  NUMERIC_SCALE,
  STRING_LENGTH,
  type MetadataObject,
  type Attribute,
  type TabularSection,
} from "@simetra/core"
import { useMetadataStore } from "@/stores/metadata-store"
import { useUiStore } from "@/stores/ui-store"
import {
  KIND_ICONS,
  KIND_COLORS,
  GROUP_ICONS,
  FIELD_TYPE_ICONS,
  DEFAULT_FIELD_ICON,
} from "@/lib/metadata-icons"
import {
  createDefaultObject,
  generateUniqueName,
  getObjectNames,
  KIND_TO_KEY,
} from "@/lib/metadata-defaults"
import { validateTechnicalName } from "@/lib/validate-technical-name"
import {
  DeleteDialogContext,
  WhereUsedDialogContext,
  GROUP_ADD_KEYS,
  type TreeNodeData,
} from "./tree-types"

// --- Рендерер вузлів ---

export function TreeNode({
  node,
  style,
  dragHandle,
}: NodeRendererProps<TreeNodeData>) {
  const data = node.data

  switch (data.nodeType) {
    case "kind":
      return (
        <KindSectionNode node={node} style={style} dragHandle={dragHandle} />
      )
    case "object":
      return <ObjectNode node={node} style={style} dragHandle={dragHandle} />
    case "group":
      return <GroupNode node={node} style={style} dragHandle={dragHandle} />
    case "field":
      return <FieldNode node={node} style={style} dragHandle={dragHandle} />
    case "form":
      return <FormNode node={node} style={style} dragHandle={dragHandle} />
    case "tabularSection":
      return (
        <TabularSectionNode node={node} style={style} dragHandle={dragHandle} />
      )
    default:
      return null
  }
}

// --- Вузол кореневого розділу (kind) ---

function KindSectionNode({
  node,
  style,
  dragHandle,
}: {
  node: NodeApi<TreeNodeData>
  style: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
}) {
  const { t } = useTranslation()
  const data = node.data
  const kind = data.kind!
  const icon = KIND_ICONS[kind]

  const handleAddObject = useCallback(() => {
    const model = useMetadataStore.getState().model
    const existingNames = getObjectNames(model, kind)
    const name = generateUniqueName(kind, existingNames)
    const obj = createDefaultObject(kind, name)
    const errors = useMetadataStore.getState().createObject(obj)
    if (!errors) {
      useUiStore.getState().selectObject({ kind, name })
      node.open()
    }
  }, [kind, node])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={dragHandle}
          style={style}
          className={cn(
            "group flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs",
            "hover:bg-accent/50",
            node.isFocused && "bg-accent"
          )}
          onClick={() => node.toggle()}
        >
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {node.isOpen ? "▼" : "▶"}
          </span>
          <HugeiconsIcon
            icon={icon}
            size={14}
            className={cn("shrink-0", KIND_COLORS[kind])}
          />
          <span className="truncate font-medium">
            {t(`metadata.kindPlural.${kind}`)}
          </span>
          {(data.objectCount ?? 0) > 0 && (
            <Badge
              variant="secondary"
              className="ml-auto h-4 min-w-5 justify-center px-1 text-[0.6rem]"
            >
              {data.objectCount}
            </Badge>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={handleAddObject}>
          <HugeiconsIcon icon={Add01Icon} size={14} className="mr-2" />
          {t("tree.addObject", { kind: t(`metadata.kind.${kind}`) })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// --- Вузол обʼєкта ---

function ObjectNode({
  node,
  style,
  dragHandle,
}: {
  node: NodeApi<TreeNodeData>
  style: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
}) {
  const { t } = useTranslation()
  const data = node.data
  const kind = data.kind!
  const icon = KIND_ICONS[kind]
  const { requestDelete } = useContext(DeleteDialogContext)
  const { requestWhereUsed } = useContext(WhereUsedDialogContext)

  const handleAdd = useCallback(() => {
    const model = useMetadataStore.getState().model
    const existingNames = getObjectNames(model, kind)
    const name = generateUniqueName(kind, existingNames)
    const obj = createDefaultObject(kind, name)
    const errors = useMetadataStore.getState().createObject(obj)
    if (!errors) {
      useUiStore.getState().selectObject({ kind, name })
    }
  }, [kind])

  const handleRename = useCallback(() => {
    node.edit()
  }, [node])

  const handleDuplicate = useCallback(() => {
    const model = useMetadataStore.getState().model
    const existingNames = getObjectNames(model, kind)
    const newName = generateUniqueName(kind, existingNames)
    useMetadataStore.getState().duplicateObject(kind, data.name, newName)
    useUiStore.getState().selectObject({ kind, name: newName })
  }, [kind, data.name])

  const handleDelete = useCallback(() => {
    requestDelete(kind, data.name)
  }, [kind, data.name, requestDelete])

  const handleWhereUsed = useCallback(() => {
    requestWhereUsed(kind, data.name)
  }, [kind, data.name, requestWhereUsed])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={dragHandle}
          style={style}
          className={cn(
            "flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs",
            "hover:bg-accent/50",
            node.isSelected &&
              "border-l-2 border-primary bg-accent text-accent-foreground",
            node.isFocused && !node.isSelected && "ring-1 ring-ring"
          )}
        >
          {/* Стрілка розгортання — тільки якщо є дочірні вузли */}
          {node.children && node.children.length > 0 ? (
            <button
              type="button"
              className="shrink-0 text-[10px] text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation()
                node.toggle()
              }}
            >
              {node.isOpen ? "▼" : "▶"}
            </button>
          ) : (
            <span className="w-[10px] shrink-0" />
          )}
          <HugeiconsIcon
            icon={icon}
            size={14}
            className={cn("shrink-0", KIND_COLORS[kind])}
          />
          {node.isEditing ? (
            <RenameInput node={node} />
          ) : (
            <span className="truncate font-mono text-[0.75rem]">
              {data.name}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={handleAdd}>
          <HugeiconsIcon icon={Add01Icon} size={14} className="mr-2" />
          {t("tree.addObject", { kind: t(`metadata.kind.${kind}`) })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleRename}>
          <HugeiconsIcon icon={PencilEdit02Icon} size={14} className="mr-2" />
          {t("tree.renameObject")}
        </ContextMenuItem>
        <ContextMenuItem onClick={handleDuplicate}>
          <HugeiconsIcon icon={Copy01Icon} size={14} className="mr-2" />
          {t("tree.duplicateObject")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleWhereUsed}>
          <HugeiconsIcon icon={LinkSquare02Icon} size={14} className="mr-2" />
          {t("tree.whereUsed")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={handleDelete}
          className="text-destructive focus:text-destructive"
        >
          <HugeiconsIcon icon={Delete02Icon} size={14} className="mr-2" />
          {t("tree.deleteObject")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// --- Вузол структурної групи (📂 Реквізити, 📂 Табличні частини тощо) ---

function GroupNode({
  node,
  style,
  dragHandle,
}: {
  node: NodeApi<TreeNodeData>
  style: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
}) {
  const { t } = useTranslation()
  const data = node.data
  const kind = data.kind!
  const groupIcon = GROUP_ICONS[data.groupKey ?? ""]

  const handleAdd = useCallback(() => {
    if (!data.objectName || !data.groupKey) return
    const store = useMetadataStore.getState()
    const uiStore = useUiStore.getState()
    const objectRef = { kind, name: data.objectName }

    if (
      data.groupKey === "attributes" ||
      data.groupKey === "dimensions" ||
      data.groupKey === "resources"
    ) {
      const key = KIND_TO_KEY[kind]
      const objects = store.model[key] as MetadataObject[]
      const obj = objects.find((o) => o.name === data.objectName)
      if (!obj) return

      const existingAttrs: Attribute[] =
        data.groupKey === "dimensions" && "dimensions" in obj
          ? (obj.dimensions as Attribute[])
          : data.groupKey === "resources" && "resources" in obj
            ? (obj.resources as Attribute[])
            : "attributes" in obj
              ? (obj.attributes as Attribute[])
              : []

      let i = 1
      const existing = new Set(existingAttrs.map((a) => a.name))
      while (existing.has(`new_field_${i}`)) i++
      const attr: Attribute = {
        name: `new_field_${i}`,
        type: data.groupKey === "resources" ? "Numeric" : "String",
        required: false,
        indexed: false,
        unique: false,
        defaultValue: null,
        ...(data.groupKey === "resources"
          ? { precision: NUMERIC_PRECISION, scale: NUMERIC_SCALE }
          : { length: STRING_LENGTH }),
      }

      if (data.groupKey === "dimensions") {
        store.addDimension(kind, data.objectName, attr)
      } else if (data.groupKey === "resources") {
        store.addResource(kind, data.objectName, attr)
      } else {
        store.addAttribute(kind, data.objectName, attr)
      }

      node.open()
      uiStore.selectObject(objectRef)
      uiStore.selectField({
        objectRef,
        fieldName: attr.name,
      })
      uiStore.setFocusedPanel("properties")
    } else if (data.groupKey === "tabularSections") {
      const key = KIND_TO_KEY[kind]
      const objects = store.model[key] as MetadataObject[]
      const obj = objects.find((o) => o.name === data.objectName)
      if (!obj || !("tabularSections" in obj)) return

      const sections = obj.tabularSections as TabularSection[]
      let i = 1
      const existing = new Set(sections.map((s) => s.name))
      while (existing.has(`section_${i}`)) i++
      const section: TabularSection = {
        name: `section_${i}`,
        standardAttributeOverrides: {},
        attributes: [],
      }
      store.addTabularSection(kind, data.objectName, section)

      node.open()
      uiStore.selectObject(objectRef)
    } else if (data.groupKey === "values") {
      const key = KIND_TO_KEY[kind]
      const objects = store.model[key] as MetadataObject[]
      const obj = objects.find((o) => o.name === data.objectName)
      if (!obj || !("values" in obj)) return

      const values = obj.values as { name: string }[]
      let i = 1
      const existing = new Set(values.map((v) => v.name))
      while (existing.has(`Value${i}`)) i++
      store.addEnumValue(data.objectName, {
        name: `Value${i}`,
        order: values.length,
      })

      node.open()
      uiStore.selectObject(objectRef)
    } else if (data.groupKey === "forms") {
      // Додати форму: спочатку ItemForm, якщо вже є — ListForm
      const existingForms = store.model.forms?.filter(
        (f) =>
          f.objectRef.kind === kind && f.objectRef.name === data.objectName,
      ) ?? []
      const hasItem = existingForms.some((f) => f.kind === "ItemForm")
      const hasList = existingForms.some((f) => f.kind === "ListForm")
      const formKind = !hasItem ? "ItemForm" : !hasList ? "ListForm" : null
      if (!formKind) return // обидві форми вже існують
      store.addForm(kind, data.objectName, formKind)
      node.open()
      uiStore.selectObject(objectRef)
    }
  }, [data, kind, node])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={dragHandle}
          style={style}
          className={cn(
            "group flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs",
            "hover:bg-accent/50",
            node.isFocused && "bg-accent"
          )}
          onClick={() => node.toggle()}
        >
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {node.isOpen ? "▼" : "▶"}
          </span>
          {groupIcon && (
            <HugeiconsIcon
              icon={groupIcon}
              size={13}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="truncate text-muted-foreground">
            {t(`metadata.section.${data.groupKey}`)}
          </span>
          {(node.children?.length ?? 0) > 0 && (
            <Badge
              variant="secondary"
              className="ml-auto h-4 min-w-5 justify-center px-1 text-[0.6rem]"
            >
              {node.children?.length}
            </Badge>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={handleAdd}>
          <HugeiconsIcon icon={Add01Icon} size={14} className="mr-2" />
          {t(GROUP_ADD_KEYS[data.groupKey ?? ""] ?? "action.add")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// --- Вузол поля (реквізит, вимір, ресурс, значення перелічення) ---

function FieldNode({
  node,
  style,
  dragHandle,
}: {
  node: NodeApi<TreeNodeData>
  style: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
}) {
  const { t } = useTranslation()
  const data = node.data
  const kind = data.kind!
  const fieldIcon = FIELD_TYPE_ICONS[data.fieldType ?? ""] ?? DEFAULT_FIELD_ICON

  const handleDelete = useCallback(() => {
    if (!data.objectName || !data.groupKey) return
    const store = useMetadataStore.getState()

    if (data.groupKey === "values") {
      store.removeEnumValue(data.objectName, data.name)
    } else if (data.tabularSectionName) {
      store.removeTabularSectionAttribute(
        kind,
        data.objectName,
        data.tabularSectionName,
        data.name
      )
    } else if (data.groupKey === "dimensions") {
      store.removeDimension(kind, data.objectName, data.name)
    } else if (data.groupKey === "resources") {
      store.removeResource(kind, data.objectName, data.name)
    } else {
      store.removeAttribute(kind, data.objectName, data.name)
    }
    useUiStore.getState().selectField(null)
  }, [data, kind])

  const handleMove = useCallback(
    (direction: "up" | "down") => {
      if (!data.objectName || !data.groupKey) return
      const store = useMetadataStore.getState()
      const key = KIND_TO_KEY[kind]
      const objects = store.model[key] as MetadataObject[]
      const obj = objects.find((o) => o.name === data.objectName)
      if (!obj) return

      let attrs: Attribute[] | { name: string }[] = []
      if (data.groupKey === "values" && "values" in obj) {
        attrs = obj.values as { name: string }[]
      } else if (data.tabularSectionName && "tabularSections" in obj) {
        const ts = (obj.tabularSections as TabularSection[]).find(
          (s) => s.name === data.tabularSectionName
        )
        if (ts) attrs = ts.attributes
      } else if (data.groupKey === "dimensions" && "dimensions" in obj) {
        attrs = obj.dimensions as Attribute[]
      } else if (data.groupKey === "resources" && "resources" in obj) {
        attrs = obj.resources as Attribute[]
      } else if ("attributes" in obj) {
        attrs = obj.attributes as Attribute[]
      }

      const idx = attrs.findIndex((a) => a.name === data.name)
      if (idx === -1) return
      const newIdx = direction === "up" ? idx - 1 : idx + 1
      if (newIdx < 0 || newIdx >= attrs.length) return

      if (data.groupKey === "values") {
        store.reorderEnumValues(data.objectName, idx, newIdx)
      } else if (data.tabularSectionName) {
        store.reorderTabularSectionAttributes(
          kind,
          data.objectName,
          data.tabularSectionName,
          idx,
          newIdx
        )
      } else if (data.groupKey === "dimensions") {
        store.reorderDimensions(kind, data.objectName, idx, newIdx)
      } else if (data.groupKey === "resources") {
        store.reorderResources(kind, data.objectName, idx, newIdx)
      } else {
        store.reorderAttributes(kind, data.objectName, idx, newIdx)
      }
    },
    [data, kind]
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={dragHandle}
          style={style}
          className={cn(
            "flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs",
            "hover:bg-accent/50",
            node.isSelected &&
              "border-l-2 border-primary bg-accent text-accent-foreground",
            node.isFocused && !node.isSelected && "ring-1 ring-ring"
          )}
        >
          <HugeiconsIcon
            icon={fieldIcon}
            size={13}
            className="shrink-0 text-muted-foreground"
          />
          <span className="truncate font-mono text-[0.75rem]">{data.name}</span>
          {data.fieldTypeDisplay && (
            <span className="ml-auto truncate text-[10px] text-muted-foreground">
              {data.fieldTypeDisplay}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => handleMove("up")}>
          <HugeiconsIcon icon={ArrowUp01Icon} size={14} className="mr-2" />
          {t("tree.moveUp")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleMove("down")}>
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} className="mr-2" />
          {t("tree.moveDown")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={handleDelete}
          className="text-destructive focus:text-destructive"
        >
          <HugeiconsIcon icon={Delete02Icon} size={14} className="mr-2" />
          {t("tree.deleteField")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// --- Вузол форми ---

function FormNode({
  node,
  style,
  dragHandle,
}: {
  node: NodeApi<TreeNodeData>
  style: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
}) {
  const { t } = useTranslation()
  const data = node.data
  const kind = data.kind!
  const formIcon = GROUP_ICONS.forms

  const handleDelete = useCallback(() => {
    if (!data.objectName) return
    const formKind = data.name as "ItemForm" | "ListForm"
    useMetadataStore.getState().deleteForm(kind, data.objectName, formKind)
  }, [data, kind])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={dragHandle}
          style={style}
          className={cn(
            "flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs",
            "hover:bg-accent/50",
            node.isSelected &&
              "border-l-2 border-primary bg-accent text-accent-foreground",
            node.isFocused && !node.isSelected && "ring-1 ring-ring",
          )}
        >
          {formIcon && (
            <HugeiconsIcon
              icon={formIcon}
              size={13}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="truncate text-[0.75rem]">{data.name}</span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={handleDelete}
          className="text-destructive focus:text-destructive"
        >
          <HugeiconsIcon icon={Delete02Icon} size={14} className="mr-2" />
          {t("action.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// --- Вузол табличної частини ---

function TabularSectionNode({
  node,
  style,
  dragHandle,
}: {
  node: NodeApi<TreeNodeData>
  style: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
}) {
  const { t } = useTranslation()
  const data = node.data
  const kind = data.kind!
  const groupIcon = GROUP_ICONS.tabularSections

  const handleAddAttribute = useCallback(() => {
    if (!data.objectName) return
    const store = useMetadataStore.getState()
    const key = KIND_TO_KEY[kind]
    const objects = store.model[key] as MetadataObject[]
    const obj = objects.find((o) => o.name === data.objectName)
    if (!obj || !("tabularSections" in obj)) return

    const ts = (obj.tabularSections as TabularSection[]).find(
      (s) => s.name === data.name
    )
    if (!ts) return

    let i = 1
    const existing = new Set(ts.attributes.map((a) => a.name))
    while (existing.has(`new_field_${i}`)) i++
    const attr: Attribute = {
      name: `new_field_${i}`,
      type: "String",
      required: false,
      indexed: false,
      unique: false,
      defaultValue: null,
      length: STRING_LENGTH,
    }
    store.addTabularSectionAttribute(kind, data.objectName, data.name, attr)

    node.open()
    const uiStore = useUiStore.getState()
    const objectRef = { kind, name: data.objectName }
    uiStore.selectObject(objectRef)
    uiStore.selectField({
      objectRef,
      fieldName: attr.name,
      tabularSectionName: data.name,
    })
    uiStore.setFocusedPanel("properties")
  }, [data, kind, node])

  const handleDelete = useCallback(() => {
    if (!data.objectName) return
    useMetadataStore
      .getState()
      .removeTabularSection(kind, data.objectName, data.name)
  }, [data, kind])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={dragHandle}
          style={style}
          className={cn(
            "flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs",
            "hover:bg-accent/50",
            node.isSelected &&
              "border-l-2 border-primary bg-accent text-accent-foreground",
            node.isFocused && !node.isSelected && "ring-1 ring-ring"
          )}
          onClick={() => node.toggle()}
        >
          {node.children && node.children.length > 0 && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {node.isOpen ? "▼" : "▶"}
            </span>
          )}
          {groupIcon && (
            <HugeiconsIcon
              icon={groupIcon}
              size={13}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="truncate font-mono text-[0.75rem]">{data.name}</span>
          {(node.children?.length ?? 0) > 0 && (
            <Badge
              variant="secondary"
              className="ml-auto h-4 min-w-5 justify-center px-1 text-[0.6rem]"
            >
              {node.children?.length}
            </Badge>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={handleAddAttribute}>
          <HugeiconsIcon icon={Add01Icon} size={14} className="mr-2" />
          {t("tree.addAttribute")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={handleDelete}
          className="text-destructive focus:text-destructive"
        >
          <HugeiconsIcon icon={Delete02Icon} size={14} className="mr-2" />
          {t("tree.deleteTabularSection")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// --- Inline rename input ---

function RenameInput({ node }: { node: NodeApi<TreeNodeData> }) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(node.data.name)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = useCallback(() => {
    const trimmed = draft.trim()
    const validationError = validateTechnicalName(trimmed, "PascalCase")

    if (validationError) {
      setError(validationError)
      setTimeout(() => inputRef.current?.focus(), 0)
      return false
    }

    if (trimmed === node.data.name) {
      setError(null)
      node.reset()
      return true
    }

    const kind = node.data.kind
    if (!kind) {
      setError(t("validation.resolveObjectTypeFailed"))
      return false
    }

    const errors = useMetadataStore
      .getState()
      .renameObject(kind, node.data.name, trimmed)
    if (errors) {
      setError(
        errors.find((issue) => issue.path === "name")?.message ??
          errors[0]?.message ??
          t("validation.renameFailed")
      )
      setTimeout(() => inputRef.current?.focus(), 0)
      return false
    }

    useUiStore
      .getState()
      .updateTabObjectRef(
        { kind, name: node.data.name },
        { kind, name: trimmed }
      )
    setError(null)
    node.reset()
    return true
  }, [draft, node, t])

  return (
    <div className="relative flex-1 overflow-visible">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        className="h-5 w-full rounded-sm border border-ring bg-background px-1 font-mono text-[0.75rem] outline-none"
        aria-invalid={error ? "true" : "false"}
        onChange={(e) => {
          setDraft(e.currentTarget.value)
          if (error) setError(null)
        }}
        onBlur={() => {
          commit()
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (!commit()) {
              e.preventDefault()
            }
          }
          if (e.key === "Escape") {
            setDraft(node.data.name)
            setError(null)
            node.reset()
          }
        }}
      />
      {error ? (
        <div className="absolute top-full left-0 z-10 mt-1 max-w-56 rounded border border-destructive/20 bg-background px-2 py-1 text-[11px] text-destructive shadow-sm">
          {error}
        </div>
      ) : null}
    </div>
  )
}
