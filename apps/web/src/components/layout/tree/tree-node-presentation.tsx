import type { IconSvgElement } from "@hugeicons/react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"
import type { TreeNodeData } from "./tree-types"
import {
  KIND_ICONS,
  KIND_COLORS,
  GROUP_ICONS,
  FIELD_TYPE_ICONS,
  DEFAULT_FIELD_ICON,
} from "@/lib/metadata-icons"

// --- Presentation-only компоненти для вузлів дерева ---
// Без CRUD, без ContextMenu, без store access. Чистий візуал.

// --- Базовий row wrapper ---

export interface NodeRowProps {
  style?: React.CSSProperties
  className?: string
  onClick?: (e: React.MouseEvent) => void
  children: React.ReactNode
  dragHandle?: (el: HTMLDivElement | null) => void
}

export function NodeRow({
  style,
  className,
  onClick,
  children,
  dragHandle,
}: NodeRowProps) {
  return (
    <div
      ref={dragHandle}
      style={style}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs",
        "hover:bg-accent/50",
        className
      )}
      onClick={onClick}
    >
      {children}
    </div>
  )
}

// --- Стрілка розгортання ---

export function ExpandArrow({
  isOpen,
  onClick,
}: {
  isOpen: boolean
  onClick?: (e: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      className="shrink-0 text-[10px] text-muted-foreground"
      onClick={onClick}
    >
      {isOpen ? "▼" : "▶"}
    </button>
  )
}

// --- Іконка вузла ---

export function NodeIcon({
  icon,
  className,
}: {
  icon: IconSvgElement
  className?: string
}) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={14}
      className={cn("shrink-0", className)}
    />
  )
}

// --- Badge з лічильником ---

export function NodeBadge({ count }: { count: number | undefined }) {
  if (!count || count <= 0) return null
  return (
    <Badge
      variant="secondary"
      className="ml-auto h-4 min-w-5 justify-center px-1 text-[0.6rem]"
    >
      {count}
    </Badge>
  )
}

// --- Presentation для Kind Section (кореневий розділ) ---

export interface KindSectionPresentationProps {
  data: TreeNodeData
  isOpen: boolean
  isFocused: boolean
  onToggle: () => void
  label: string
  style?: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
}

export function KindSectionPresentation({
  data,
  isOpen,
  isFocused,
  onToggle,
  label,
  style,
  dragHandle,
}: KindSectionPresentationProps) {
  const kind = data.kind!
  const icon = KIND_ICONS[kind]

  return (
    <NodeRow
      style={style}
      className={cn("group", isFocused && "bg-accent")}
      onClick={onToggle}
      dragHandle={dragHandle}
    >
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {isOpen ? "▼" : "▶"}
      </span>
      <NodeIcon icon={icon} className={KIND_COLORS[kind]} />
      <span className="truncate font-medium">{label}</span>
      <NodeBadge count={data.objectCount} />
    </NodeRow>
  )
}

// --- Presentation для Object ---

export interface ObjectPresentationProps {
  data: TreeNodeData
  isOpen: boolean
  isSelected: boolean
  isFocused: boolean
  hasChildren: boolean
  isEditing: boolean
  onToggle: () => void
  editingNode?: React.ReactNode
  style?: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
}

export function ObjectPresentation({
  data,
  isOpen,
  isSelected,
  isFocused,
  hasChildren,
  isEditing,
  onToggle,
  editingNode,
  style,
  dragHandle,
}: ObjectPresentationProps) {
  const kind = data.kind!
  const icon = KIND_ICONS[kind]

  return (
    <NodeRow
      style={style}
      className={cn(
        isSelected &&
          "border-l-2 border-primary bg-accent text-accent-foreground",
        isFocused && !isSelected && "ring-1 ring-ring"
      )}
      dragHandle={dragHandle}
    >
      {hasChildren ? (
        <ExpandArrow
          isOpen={isOpen}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
        />
      ) : (
        <span className="w-[10px] shrink-0" />
      )}
      <NodeIcon icon={icon} className={KIND_COLORS[kind]} />
      {isEditing ? (
        editingNode
      ) : (
        <span className="truncate font-mono text-[0.75rem]">{data.name}</span>
      )}
    </NodeRow>
  )
}

// --- Presentation для Group ---

export interface GroupPresentationProps {
  data: TreeNodeData
  isOpen: boolean
  isFocused: boolean
  childCount: number
  onToggle: () => void
  label: string
  style?: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
}

export function GroupPresentation({
  data,
  isOpen,
  isFocused,
  childCount,
  onToggle,
  label,
  style,
  dragHandle,
}: GroupPresentationProps) {
  const groupIcon = GROUP_ICONS[data.groupKey ?? ""]

  return (
    <NodeRow
      style={style}
      className={cn("group", isFocused && "bg-accent")}
      onClick={onToggle}
      dragHandle={dragHandle}
    >
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {isOpen ? "▼" : "▶"}
      </span>
      {groupIcon && (
        <HugeiconsIcon
          icon={groupIcon}
          size={13}
          className="shrink-0 text-muted-foreground"
        />
      )}
      <span className="truncate text-muted-foreground">{label}</span>
      <NodeBadge count={childCount} />
    </NodeRow>
  )
}

// --- Presentation для Field ---

export interface FieldPresentationProps {
  data: TreeNodeData
  isSelected: boolean
  isFocused: boolean
  style?: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
}

export function FieldPresentation({
  data,
  isSelected,
  isFocused,
  style,
  dragHandle,
}: FieldPresentationProps) {
  const fieldIcon = FIELD_TYPE_ICONS[data.fieldType ?? ""] ?? DEFAULT_FIELD_ICON

  return (
    <NodeRow
      style={style}
      className={cn(
        isSelected &&
          "border-l-2 border-primary bg-accent text-accent-foreground",
        isFocused && !isSelected && "ring-1 ring-ring"
      )}
      dragHandle={dragHandle}
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
    </NodeRow>
  )
}

// --- Presentation для TabularSection ---

export interface TabularSectionPresentationProps {
  data: TreeNodeData
  isOpen: boolean
  isSelected: boolean
  isFocused: boolean
  hasChildren: boolean
  childCount: number
  onToggle: () => void
  style?: React.CSSProperties
  dragHandle?: (el: HTMLDivElement | null) => void
}

export function TabularSectionPresentation({
  data,
  isOpen,
  isSelected,
  isFocused,
  hasChildren,
  childCount,
  onToggle,
  style,
  dragHandle,
}: TabularSectionPresentationProps) {
  const groupIcon = GROUP_ICONS.tabularSections

  return (
    <NodeRow
      style={style}
      className={cn(
        isSelected &&
          "border-l-2 border-primary bg-accent text-accent-foreground",
        isFocused && !isSelected && "ring-1 ring-ring"
      )}
      onClick={onToggle}
      dragHandle={dragHandle}
    >
      {hasChildren && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {isOpen ? "▼" : "▶"}
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
      <NodeBadge count={childCount} />
    </NodeRow>
  )
}

// --- Нові presentation nodes для Data Type Editor ---

export interface PrimitiveTypeNodeProps {
  data: TreeNodeData
  isSelected: boolean
  mode: "radio" | "checkbox"
  disabled?: boolean
  label: string
  style?: React.CSSProperties
}

export function PrimitiveTypePresentation({
  data,
  isSelected,
  mode,
  disabled,
  label,
  style,
}: PrimitiveTypeNodeProps) {
  const icon = FIELD_TYPE_ICONS[data.fieldTypeValue ?? ""] ?? DEFAULT_FIELD_ICON

  return (
    <div
      style={style}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs",
        "hover:bg-accent/50",
        isSelected && "bg-accent text-accent-foreground",
        disabled && "cursor-not-allowed opacity-50"
      )}
    >
      <input
        type={mode}
        checked={isSelected}
        disabled={disabled}
        readOnly
        className="pointer-events-none h-3 w-3 shrink-0 accent-primary"
      />
      <HugeiconsIcon
        icon={icon}
        size={13}
        className="shrink-0 text-muted-foreground"
      />
      <span className="truncate">{label}</span>
    </div>
  )
}

export interface RefKindGroupPresentationProps {
  data: TreeNodeData
  isOpen: boolean
  onToggle: () => void
  label: string
  childCount: number
  /** Стан чекбоксу групи у compound mode: true/false/'indeterminate'/undefined (не показувати) */
  checkedState?: boolean | "indeterminate"
  style?: React.CSSProperties
}

export function RefKindGroupPresentation({
  data,
  isOpen,
  onToggle,
  label,
  childCount,
  checkedState,
  style,
}: RefKindGroupPresentationProps) {
  const kind = data.kind!
  const icon = KIND_ICONS[kind]

  return (
    <div
      style={style}
      className={cn(
        "group flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs",
        "hover:bg-accent/50"
      )}
      onClick={onToggle}
    >
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {isOpen ? "▼" : "▶"}
      </span>
      {checkedState !== undefined && (
        <input
          type="checkbox"
          checked={checkedState === true}
          ref={(el) => {
            if (el) el.indeterminate = checkedState === "indeterminate"
          }}
          readOnly
          className="pointer-events-none h-3 w-3 shrink-0 accent-primary"
        />
      )}
      <NodeIcon icon={icon} className={KIND_COLORS[kind]} />
      <span className="truncate font-medium">{label}</span>
      <NodeBadge count={childCount} />
    </div>
  )
}

export interface RefTargetPresentationProps {
  data: TreeNodeData
  isSelected: boolean
  mode: "radio" | "checkbox"
  style?: React.CSSProperties
}

export function RefTargetPresentation({
  data,
  isSelected,
  mode,
  style,
}: RefTargetPresentationProps) {
  const kind = data.kind!
  const icon = KIND_ICONS[kind]

  return (
    <div
      style={style}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs",
        "hover:bg-accent/50",
        isSelected && "bg-accent text-accent-foreground"
      )}
    >
      <input
        type={mode}
        checked={isSelected}
        readOnly
        className="pointer-events-none h-3 w-3 shrink-0 accent-primary"
      />
      <NodeIcon icon={icon} className={KIND_COLORS[kind]} />
      <span className="truncate font-mono text-[0.75rem]">{data.name}</span>
    </div>
  )
}
