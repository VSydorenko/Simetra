import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Tree, type NodeApi, type TreeApi } from "react-arborist"
import { Input } from "@workspace/ui/components/input"
import { HugeiconsIcon } from "@hugeicons/react"
import { Search01Icon } from "@hugeicons/core-free-icons"
import type { FieldType, MetadataKind, MetadataRef, ProjectModel } from "@simetra/core"
import {
  buildTypeEditorTree,
  REFERENCEABLE_KINDS,
} from "@/components/layout/tree/tree-builder"
import type { TreeNodeData } from "@/components/layout/tree/tree-types"
import {
  RefKindGroupPresentation,
  RefTargetPresentation,
  PrimitiveTypePresentation,
} from "@/components/layout/tree/tree-node-presentation"

export interface MetadataObjectTreeSelectorProps {
  model: ProjectModel
  /** Які kinds показувати (дефолт: REFERENCEABLE_KINDS) */
  allowedKinds?: readonly MetadataKind[]
  /** Поточний пошуковий запит (controlled) */
  searchQuery: string
  /** Callback зміни пошуку */
  onSearchChange: (query: string) => void
  /** Набір обраних id вузлів (ref/{kind}/{name}) */
  selectedIds: Set<string>
  /** Режим вибору: radio (single) або checkbox (multi) */
  mode: "radio" | "checkbox"
  /** Чи показувати примітивні типи (дефолт: true) */
  includePrimitives?: boolean
  /** Callback при виборі ref target */
  onSelectTarget: (ref: MetadataRef) => void
  /** Callback при виборі примітивного типу (тільки якщо includePrimitives=true) */
  onSelectPrimitive?: (fieldType: FieldType) => void
  /** Callback при toggle kind group (тільки для checkbox mode) */
  onToggleKindGroup?: (kind: MetadataKind) => void
  /** Стан чекбоксів kind groups у checkbox mode */
  kindCheckedStates?: Record<string, boolean | "indeterminate">
  /** Висота контейнера дерева */
  height?: number
}

export function MetadataObjectTreeSelector({
  model,
  allowedKinds = REFERENCEABLE_KINDS,
  searchQuery,
  onSearchChange,
  selectedIds,
  mode,
  includePrimitives = true,
  onSelectTarget,
  onSelectPrimitive,
  onToggleKindGroup,
  kindCheckedStates,
  height = 280,
}: MetadataObjectTreeSelectorProps) {
  const { t } = useTranslation()

  const treeData = useMemo(
    () =>
      buildTypeEditorTree(model, searchQuery, (key) => t(key), {
        allowedKinds,
        includePrimitives,
      }),
    [model, searchQuery, t, allowedKinds, includePrimitives],
  )

  const treeContainerRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<TreeApi<TreeNodeData>>(null)
  const [treeDimensions, setTreeDimensions] = useState({ width: 380, height })

  useEffect(() => {
    if (!treeContainerRef.current) return
    const observer = new ResizeObserver((entries) => {
      const { width, height: h } = entries[0].contentRect
      setTreeDimensions({ width, height: h })
    })
    observer.observe(treeContainerRef.current)
    return () => observer.disconnect()
  }, [])

  const isCheckboxMode = mode === "checkbox"

  const handleActivate = useCallback(
    (node: NodeApi<TreeNodeData>) => {
      const data = node.data
      if (data.nodeType === "refTarget" && data.refTarget) {
        onSelectTarget(data.refTarget)
      } else if (data.nodeType === "primitiveType") {
        if (data.fieldTypeValue && onSelectPrimitive) {
          onSelectPrimitive(data.fieldTypeValue)
        }
      } else if (data.nodeType === "refKindGroup") {
        if (isCheckboxMode && data.kind && onToggleKindGroup) {
          onToggleKindGroup(data.kind)
        }
        node.toggle()
      }
    },
    [isCheckboxMode, onSelectTarget, onSelectPrimitive, onToggleKindGroup],
  )

  const renderNode = useCallback(
    ({
      node,
      style,
    }: {
      node: NodeApi<TreeNodeData>
      style: React.CSSProperties
    }) => {
      const data = node.data

      if (data.nodeType === "primitiveType") {
        if (!includePrimitives) return null
        const isSelected = selectedIds.has(data.id)
        return (
          <div
            onClick={() => {
              if (data.fieldTypeValue && onSelectPrimitive) {
                onSelectPrimitive(data.fieldTypeValue)
              }
            }}
          >
            <PrimitiveTypePresentation
              data={data}
              isSelected={isSelected}
              isFocused={node.isFocused}
              mode={mode}
              label={t(`fieldType.${data.fieldTypeValue}`)}
              style={style}
            />
          </div>
        )
      }

      if (data.nodeType === "refKindGroup") {
        return (
          <div
            onClick={(e) => {
              e.stopPropagation()
              if (isCheckboxMode && data.kind && onToggleKindGroup) {
                onToggleKindGroup(data.kind)
              }
              node.toggle()
            }}
          >
            <RefKindGroupPresentation
              data={data}
              isOpen={node.isOpen}
              isFocused={node.isFocused}
              onToggle={() => {}}
              label={t(`metadata.kind.${data.kind}`)}
              childCount={data.children?.length ?? 0}
              checkedState={
                isCheckboxMode && data.kind
                  ? kindCheckedStates?.[data.kind]
                  : undefined
              }
              style={style}
            />
          </div>
        )
      }

      if (data.nodeType === "refTarget") {
        const isSelected = selectedIds.has(data.id)
        return (
          <div
            onClick={() => {
              if (data.refTarget) {
                onSelectTarget(data.refTarget)
              }
            }}
          >
            <RefTargetPresentation
              data={data}
              isSelected={isSelected}
              isFocused={node.isFocused}
              mode={mode}
              style={style}
            />
          </div>
        )
      }

      return null
    },
    [
      selectedIds,
      isCheckboxMode,
      includePrimitives,
      kindCheckedStates,
      onSelectTarget,
      onSelectPrimitive,
      onToggleKindGroup,
      mode,
      t,
    ],
  )

  return (
    <div className="space-y-2">
      {/* Пошук */}
      <div className="relative">
        <HugeiconsIcon
          icon={Search01Icon}
          size={14}
          className="absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          className="h-7 pl-7 text-xs"
          placeholder={t("dataTypeEditor.search")}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      {/* Дерево */}
      <div
        ref={treeContainerRef}
        className="overflow-hidden rounded-md border"
        style={{ height }}
      >
        <Tree<TreeNodeData>
          ref={treeRef}
          data={treeData}
          width={treeDimensions.width}
          height={treeDimensions.height}
          openByDefault
          indent={16}
          rowHeight={28}
          overscanCount={5}
          disableDrag
          disableDrop
          disableMultiSelection
          disableEdit
          padding={4}
          onActivate={handleActivate}
        >
          {renderNode}
        </Tree>
      </div>
    </div>
  )
}
