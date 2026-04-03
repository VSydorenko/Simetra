import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslation } from "react-i18next"
import { Tree, type NodeApi, type TreeApi } from "react-arborist"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Separator } from "@workspace/ui/components/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { HugeiconsIcon } from "@hugeicons/react"
import { Search01Icon } from "@hugeicons/core-free-icons"
import type {
  Attribute,
  FieldType,
  ProjectModel,
  ReferenceableKind,
} from "@simetra/core"
import { KIND_TO_KEY } from "@/lib/metadata-defaults"
import { buildTypeEditorTree } from "@/components/layout/tree/tree-builder"
import type { TreeNodeData } from "@/components/layout/tree/tree-types"
import {
  PrimitiveTypePresentation,
  RefKindGroupPresentation,
  RefTargetPresentation,
} from "@/components/layout/tree/tree-node-presentation"

const REFERENCEABLE_KINDS = ["Catalog", "Document", "Enumeration"] as const

type AttributeRefTarget = NonNullable<Attribute["ref"]>

// --- Типи ---

/** Type-related поля атрибута, що редагуються в діалозі */
interface TypeDraft {
  type: FieldType
  ref: Attribute["ref"]
  allowedTypes: Attribute["allowedTypes"]
  length: number | undefined
  precision: number | undefined
  scale: number | undefined
}

function isReferenceableKind(kind: string): kind is ReferenceableKind {
  return (REFERENCEABLE_KINDS as readonly string[]).includes(kind)
}

function isAttributeRefTarget(
  refTarget: TreeNodeData["refTarget"],
): refTarget is AttributeRefTarget {
  return !!refTarget && isReferenceableKind(refTarget.kind)
}

interface DataTypeEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  attribute: Attribute
  model: ProjectModel
  onSave: (updates: Partial<Attribute>) => void
}

// --- Утиліти ---

/** Витягує type-related поля з атрибута */
function extractTypeDraft(attr: Attribute): TypeDraft {
  return {
    type: attr.type,
    ref: attr.ref,
    allowedTypes: attr.allowedTypes,
    length: attr.length,
    precision: attr.precision,
    scale: attr.scale,
  }
}

/** Очищення type-specific полів при зміні типу */
function cleanupDraftForType(draft: TypeDraft): TypeDraft {
  const cleaned: TypeDraft = { ...draft }

  if (cleaned.type === "String") {
    cleaned.precision = undefined
    cleaned.scale = undefined
    cleaned.ref = undefined
    cleaned.allowedTypes = undefined
  } else if (cleaned.type === "Numeric") {
    cleaned.length = undefined
    cleaned.ref = undefined
    cleaned.allowedTypes = undefined
  } else if (cleaned.type === "Ref") {
    cleaned.length = undefined
    cleaned.precision = undefined
    cleaned.scale = undefined
  } else {
    // UUID, Boolean, Text, Date, DateTime, Binary, Integer
    cleaned.length = undefined
    cleaned.precision = undefined
    cleaned.scale = undefined
    cleaned.ref = undefined
    cleaned.allowedTypes = undefined
  }

  return cleaned
}

// --- Wrapper ---

export function DataTypeEditorDialog({
  open,
  onOpenChange,
  attribute,
  model,
  onSave,
}: DataTypeEditorDialogProps) {
  const handleCancel = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  // revisionKey змінюється при кожному відкритті — скидає внутрішній draft
  const [revisionKey, setRevisionKey] = useState(0)
  const handleOpen = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        handleCancel()
      } else {
        setRevisionKey((k) => k + 1)
      }
    },
    [handleCancel],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="sm:max-w-md">
        {open && (
          <DataTypeEditorBody
            key={revisionKey}
            attribute={attribute}
            model={model}
            onSave={onSave}
            onCancel={handleCancel}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// --- Body ---

function DataTypeEditorBody({
  attribute,
  model,
  onSave,
  onCancel,
}: {
  attribute: Attribute
  model: ProjectModel
  onSave: (updates: Partial<Attribute>) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()

  // Snapshot при mount — для isDirty
  const [snapshot] = useState(() => extractTypeDraft(attribute))
  const [draft, setDraft] = useState<TypeDraft>(() =>
    structuredClone(snapshot),
  )

  // Compound mode: allowedTypes з кількома ref targets
  const isCompound = useMemo(
    () =>
      draft.type === "Ref" &&
      Array.isArray(draft.allowedTypes) &&
      draft.allowedTypes.length > 0,
    [draft.type, draft.allowedTypes],
  )

  const [compoundEnabled, setCompoundEnabled] = useState(() => isCompound)

  // Пошук
  const [searchQuery, setSearchQuery] = useState("")

  // isDirty — порівняння draft зі snapshot
  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(snapshot),
    [draft, snapshot],
  )

  // --- Дерево ---

  const treeData = useMemo(
    () => buildTypeEditorTree(model, searchQuery),
    [model, searchQuery],
  )

  const treeContainerRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<TreeApi<TreeNodeData>>(null)
  const [treeDimensions, setTreeDimensions] = useState({
    width: 380,
    height: 280,
  })

  useEffect(() => {
    if (!treeContainerRef.current) return
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setTreeDimensions({ width, height })
    })
    observer.observe(treeContainerRef.current)
    return () => observer.disconnect()
  }, [])

  // --- Обрані вузли: визначаються з draft ---

  const selectedIds = useMemo(() => {
    const ids = new Set<string>()

    if (draft.type !== "Ref") {
      // Примітивний тип
      ids.add(`type/${draft.type}`)
    } else if (draft.allowedTypes && draft.allowedTypes.length > 0) {
      // Compound — кілька ref targets
      for (const at of draft.allowedTypes) {
        ids.add(`ref/${at.kind}/${at.name}`)
      }
    } else if (draft.ref) {
      // Single ref
      ids.add(`ref/${draft.ref.kind}/${draft.ref.name}`)
    }

    return ids
  }, [draft])

  // --- Обробники вибору ---

  /** Клік на примітивний тип (single mode) */
  const handleSelectPrimitive = useCallback(
    (fieldType: FieldType) => {
      if (compoundEnabled) return
      setDraft((prev) =>
        cleanupDraftForType({
          ...prev,
          type: fieldType,
          ref: undefined,
          allowedTypes: undefined,
        }),
      )
    },
    [compoundEnabled],
  )

  /** Клік на ref target */
  const handleSelectRefTarget = useCallback(
    (refTarget: AttributeRefTarget) => {
      if (compoundEnabled) {
        // Compound: toggle target в allowedTypes
        setDraft((prev) => {
          const current = prev.allowedTypes ?? []
          const exists = current.some(
            (at) => at.kind === refTarget.kind && at.name === refTarget.name,
          )
          const updated = exists
            ? current.filter(
                (at) =>
                  !(at.kind === refTarget.kind && at.name === refTarget.name),
              )
            : [...current, refTarget]

          return cleanupDraftForType({
            ...prev,
            type: "Ref",
            ref: undefined,
            allowedTypes: updated.length > 0 ? updated : undefined,
          })
        })
      } else {
        // Single: обрати один ref target
        setDraft((prev) =>
          cleanupDraftForType({
            ...prev,
            type: "Ref",
            ref: refTarget,
            allowedTypes: undefined,
          }),
        )
      }
    },
    [compoundEnabled],
  )

  /** Клік на kind group header — у compound mode toggle всі targets цього kind */
  const handleToggleKindGroup = useCallback(
    (kind: ReferenceableKind) => {
      if (!compoundEnabled) return

      // Беремо всі targets цього kind з повної model (не з відфільтрованого treeData)
      const modelKey = KIND_TO_KEY[kind]
      const objects = (model[modelKey] as { name: string }[]) ?? []
      const kindTargets: AttributeRefTarget[] = objects.map((obj) => ({
        kind,
        name: obj.name,
      }))

      setDraft((prev) => {
        const current = prev.allowedTypes ?? []
        // Якщо всі targets цього kind вже обрані — зняти всі
        const allSelected = kindTargets.every((kt) =>
          current.some((at) => at.kind === kt.kind && at.name === kt.name),
        )

        let updated: AttributeRefTarget[]
        if (allSelected) {
          updated = current.filter(
            (at) => !kindTargets.some((kt) => kt.kind === at.kind && kt.name === at.name),
          )
        } else {
          const toAdd = kindTargets.filter(
            (kt) =>
              !current.some((at) => at.kind === kt.kind && at.name === kt.name),
          )
          updated = [...current, ...toAdd]
        }

        return cleanupDraftForType({
          ...prev,
          type: "Ref",
          ref: undefined,
          allowedTypes: updated.length > 0 ? updated : undefined,
        })
      })
    },
    [compoundEnabled, model],
  )

  // --- Compound toggle ---

  const handleCompoundToggle = useCallback(
    (checked: boolean) => {
      setCompoundEnabled(checked)

      if (checked) {
        // single → compound: якщо обрано single ref — перенести в allowedTypes
        setDraft((prev) => {
          if (prev.type === "Ref" && prev.ref) {
            return cleanupDraftForType({
              ...prev,
              allowedTypes: [prev.ref],
              ref: undefined,
            })
          }
          // Якщо обрано примітивний тип — скинути
          if (prev.type !== "Ref") {
            return cleanupDraftForType({
              ...prev,
              type: "Ref",
              ref: undefined,
              allowedTypes: undefined,
              length: undefined,
              precision: undefined,
              scale: undefined,
            })
          }
          return prev
        })
      } else {
        // compound → single: зберегти перший target
        setDraft((prev) => {
          if (prev.allowedTypes && prev.allowedTypes.length > 0) {
            return cleanupDraftForType({
              ...prev,
              ref: prev.allowedTypes[0],
              allowedTypes: undefined,
            })
          }
          return prev
        })
      }
    },
    [],
  )

  // --- Save ---

  const handleSave = useCallback(() => {
    onSave({
      type: draft.type,
      ref: draft.ref,
      allowedTypes: draft.allowedTypes,
      length: draft.length,
      precision: draft.precision,
      scale: draft.scale,
    })
    onCancel()
  }, [draft, onSave, onCancel])

  // --- Tree node renderer ---

  const renderNode = useCallback(
    ({ node, style }: { node: NodeApi<TreeNodeData>; style: React.CSSProperties }) => {
      const data = node.data

      if (data.nodeType === "primitiveType") {
        const isSelected = selectedIds.has(data.id)
        return (
          <div
            onClick={() => {
              if (data.fieldTypeValue) {
                handleSelectPrimitive(data.fieldTypeValue)
              }
            }}
          >
            <PrimitiveTypePresentation
              data={data}
              isSelected={isSelected}
              mode={compoundEnabled ? "checkbox" : "radio"}
              disabled={compoundEnabled}
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
              if (compoundEnabled && data.kind && isReferenceableKind(data.kind)) {
                handleToggleKindGroup(data.kind)
              }
              node.toggle()
            }}
          >
            <RefKindGroupPresentation
              data={data}
              isOpen={node.isOpen}
              onToggle={() => {}}
              label={t(`dataTypeEditor.refGroup.${data.kind}`)}
              childCount={data.children?.length ?? 0}
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
              const refTarget = data.refTarget
              if (isAttributeRefTarget(refTarget)) {
                handleSelectRefTarget(refTarget)
              }
            }}
          >
            <RefTargetPresentation
              data={data}
              isSelected={isSelected}
              mode={compoundEnabled ? "checkbox" : "radio"}
              style={style}
            />
          </div>
        )
      }

      return null
    },
    [
      selectedIds,
      compoundEnabled,
      handleSelectPrimitive,
      handleSelectRefTarget,
      handleToggleKindGroup,
      t,
    ],
  )

  // --- Type params display ---

  const typeParamsSection = useMemo(() => {
    if (draft.type === "String") {
      return (
        <div className="grid grid-cols-[1fr_1fr] items-center gap-2">
          <Label className="text-xs text-muted-foreground">
            {t("properties.field.length")}
          </Label>
          <Input
            type="number"
            className="h-7 text-xs"
            value={draft.length ?? ""}
            min={1}
            onChange={(e) =>
              setDraft((prev) => ({
                ...prev,
                length: parseInt(e.target.value, 10) || undefined,
              }))
            }
          />
        </div>
      )
    }

    if (draft.type === "Numeric") {
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_1fr] items-center gap-2">
            <Label className="text-xs text-muted-foreground">
              {t("properties.field.precision")}
            </Label>
            <Input
              type="number"
              className="h-7 text-xs"
              value={draft.precision ?? ""}
              min={1}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  precision: parseInt(e.target.value, 10) || undefined,
                }))
              }
            />
          </div>
          <div className="grid grid-cols-[1fr_1fr] items-center gap-2">
            <Label className="text-xs text-muted-foreground">
              {t("properties.field.scale")}
            </Label>
            <Input
              type="number"
              className="h-7 text-xs"
              value={draft.scale ?? ""}
              min={0}
              onChange={(e) => {
                const val = e.target.value
                setDraft((prev) => ({
                  ...prev,
                  scale: val === "" ? undefined : parseInt(val, 10),
                }))
              }}
            />
          </div>
        </div>
      )
    }

    if (draft.type === "Ref") {
      if (draft.allowedTypes && draft.allowedTypes.length > 0) {
        return (
          <p className="text-xs text-muted-foreground">
            {t("dataTypeEditor.selectedCount", {
              count: draft.allowedTypes.length,
            })}
          </p>
        )
      }
      if (draft.ref) {
        return (
          <p className="text-xs text-muted-foreground">
            {t(`metadata.kind.${draft.ref.kind}`)}: {draft.ref.name}
          </p>
        )
      }
      return (
        <p className="text-xs text-muted-foreground">
          {t("fieldType.Ref")}
        </p>
      )
    }

    // UUID, Boolean, Text, Date, DateTime, Binary, Integer
    return (
      <p className="text-xs text-muted-foreground">
        {t("dataTypeEditor.noParams")}
      </p>
    )
  }, [draft, t])

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">
          {t("dataTypeEditor.title")}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t("dataTypeEditor.title")}
        </DialogDescription>
      </DialogHeader>

      {/* Чекбокс "Складений тип" */}
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2">
              <Checkbox
                id="compound-type"
                checked={compoundEnabled}
                onCheckedChange={(v) => handleCompoundToggle(v === true)}
              />
              <Label htmlFor="compound-type" className="text-xs">
                {t("dataTypeEditor.compoundType")}
              </Label>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            {t("dataTypeEditor.compoundTooltip")}
          </TooltipContent>
        </Tooltip>
      </div>

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
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Дерево вибору типу */}
      <div
        ref={treeContainerRef}
        className="h-[280px] overflow-hidden rounded-md border"
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
        >
          {renderNode}
        </Tree>
      </div>

      {/* Параметри типу */}
      <div className="space-y-2">
        <Separator />
        <p className="text-xs font-medium">{t("dataTypeEditor.typeParams")}</p>
        {typeParamsSection}
      </div>

      {/* Footer */}
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t("action.cancel")}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!isDirty}>
          {t("action.save")}
        </Button>
      </DialogFooter>
    </>
  )
}
