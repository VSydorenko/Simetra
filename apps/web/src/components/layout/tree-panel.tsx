import { useCallback, useMemo, useRef, useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Tree, type NodeApi, type TreeApi } from "react-arborist"
import { useHotkeys } from "react-hotkeys-hook"
import { HugeiconsIcon } from "@hugeicons/react"
import { Search01Icon, Cancel01Icon } from "@hugeicons/core-free-icons"
import { Input } from "@workspace/ui/components/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Button } from "@workspace/ui/components/button"
import type { MetadataKind } from "@simetra/core"
import { useMetadataStore } from "@/stores/metadata-store"
import { useUiStore } from "@/stores/ui-store"
import {
  findReferences,
  formatReference,
  type Reference,
} from "@/lib/find-references"
import {
  DeleteDialogContext,
  WhereUsedDialogContext,
  type TreeNodeData,
} from "./tree/tree-types"
import { buildTreeData } from "./tree/tree-builder"
import { TreeNode } from "./tree/tree-nodes"
import { WhereUsedDialog } from "@/components/editor/where-used-dialog"

// --- Головний компонент ---

export function TreePanel() {
  const { t } = useTranslation()
  const treeRef = useRef<TreeApi<TreeNodeData>>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [dimensions, setDimensions] = useState({ width: 240, height: 600 })
  const [searchVisible, setSearchVisible] = useState(false)

  // --- Delete dialog state (один на все дерево) ---
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: MetadataKind
    name: string
  } | null>(null)
  const [deleteRefs, setDeleteRefs] = useState<Reference[]>([])

  const requestDelete = useCallback((kind: MetadataKind, name: string) => {
    const model = useMetadataStore.getState().model
    const refs = findReferences(model, kind, name)
    setDeleteRefs(refs)
    setDeleteTarget({ kind, name })
  }, [])

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return
    useUiStore.getState().closeAllForObject(deleteTarget)
    useMetadataStore
      .getState()
      .deleteObject(deleteTarget.kind, deleteTarget.name)
    setDeleteTarget(null)
  }, [deleteTarget])

  const deleteDialogCtx = useMemo(() => ({ requestDelete }), [requestDelete])

  // --- Where Used dialog state ---
  const [whereUsedTarget, setWhereUsedTarget] = useState<{
    name: string
    refs: Reference[]
  } | null>(null)

  const requestWhereUsed = useCallback((kind: MetadataKind, name: string) => {
    const mdl = useMetadataStore.getState().model
    const refs = findReferences(mdl, kind, name)
    setWhereUsedTarget({ name, refs })
  }, [])

  const whereUsedDialogCtx = useMemo(
    () => ({ requestWhereUsed }),
    [requestWhereUsed]
  )

  // --- Store state ---
  const model = useMetadataStore((s) => s.model)
  const version = useMetadataStore((s) => s.version)

  const searchQuery = useUiStore((s) => s.searchQuery)
  const setSearchQuery = useUiStore((s) => s.setSearchQuery)
  const selectedObject = useUiStore((s) => s.selectedObject)
  const selectedTabularSection = useUiStore((s) => s.selectedTabularSection)
  const expandedTreeNodes = useUiStore((s) => s.expandedTreeNodes)
  const toggleTreeNode = useUiStore((s) => s.toggleTreeNode)

  // --- Побудова дерева ---
  const treeData = useMemo(
    () => buildTreeData(model, searchQuery),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, version, searchQuery]
  )

  // --- Розміри контейнера ---
  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setDimensions({ width, height })
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  // --- Початковий стан відкритих вузлів ---
  const initialOpenState = useMemo(() => {
    const state: Record<string, boolean> = {}
    for (const nodeId of expandedTreeNodes) {
      state[nodeId] = true
    }
    return state
  }, [expandedTreeNodes])

  // --- Selection ---
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(
    undefined
  )

  useEffect(() => {
    if (selectedTabularSection) {
      const sectionId = `${selectedTabularSection.objectRef.kind}/${selectedTabularSection.objectRef.name}/tabularSections/${selectedTabularSection.tabularSectionName}`
      if (selectedNodeId !== sectionId) {
        setSelectedNodeId(sectionId)
      }
      return
    }

    if (selectedObject) {
      const objId = `${selectedObject.kind}/${selectedObject.name}`
      if (selectedNodeId !== objId) {
        setSelectedNodeId(objId)
      }
    } else {
      setSelectedNodeId(undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedObject, selectedTabularSection])

  // --- Обробники ---
  const handleSelect = useCallback((nodes: NodeApi<TreeNodeData>[]) => {
    if (nodes.length === 0) return
    const node = nodes[0]
    const d = node.data

    if (d.nodeType === "kind" || d.nodeType === "group") {
      setSelectedNodeId(undefined)
      useUiStore.getState().selectObject(null)
      return
    }

    setSelectedNodeId(node.id)

    if (d.nodeType === "field" && d.objectName) {
      const objectRef = { kind: d.kind!, name: d.objectName }
      useUiStore.getState().selectObject(objectRef)

      if (d.groupKey === "values") return

      useUiStore.getState().selectField({
        objectRef,
        fieldName: d.name,
        tabularSectionName: d.tabularSectionName,
      })
      return
    }

    if (d.nodeType === "tabularSection" && d.objectName) {
      const objectRef = {
        kind: d.kind!,
        name: d.objectName,
      }
      const uiStore = useUiStore.getState()
      uiStore.selectObject(objectRef)
      uiStore.selectTabularSection({
        objectRef,
        tabularSectionName: d.name,
      })
      return
    }

    useUiStore.getState().selectObject({
      kind: d.kind!,
      name: d.name,
    })
  }, [])

  const handleActivate = useCallback((node: NodeApi<TreeNodeData>) => {
    const d = node.data

    if (d.nodeType === "kind" || d.nodeType === "group") return

    if (d.nodeType === "field" && d.objectName) {
      useUiStore.getState().openTab({ kind: d.kind!, name: d.objectName })

      if (d.groupKey !== "values") {
        useUiStore.getState().selectField({
          objectRef: { kind: d.kind!, name: d.objectName },
          fieldName: d.name,
          tabularSectionName: d.tabularSectionName,
        })
      }
      return
    }

    if (d.nodeType === "tabularSection" && d.objectName) {
      const objectRef = { kind: d.kind!, name: d.objectName }
      const uiStore = useUiStore.getState()
      uiStore.openTab(objectRef)
      uiStore.selectTabularSection({
        objectRef,
        tabularSectionName: d.name,
      })
      return
    }

    useUiStore.getState().openTab({
      kind: d.kind!,
      name: d.name,
    })
  }, [])

  // --- Hotkeys ---
  useHotkeys(
    "mod+f",
    (e) => {
      e.preventDefault()
      setSearchVisible(true)
      setTimeout(() => searchInputRef.current?.focus(), 0)
    },
    { enableOnFormTags: true }
  )

  useHotkeys(
    "escape",
    () => {
      if (searchVisible) {
        setSearchVisible(false)
        setSearchQuery("")
        treeRef.current?.focus(
          treeRef.current.focusedNode ?? treeRef.current.firstNode
        )
      }
    },
    { enableOnFormTags: true }
  )

  // --- Search ---
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value)
    },
    [setSearchQuery]
  )

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        setSearchVisible(false)
        setSearchQuery("")
        treeRef.current?.focus(
          treeRef.current.focusedNode ?? treeRef.current.firstNode
        )
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        treeRef.current?.focus(treeRef.current.firstNode)
      }
    },
    [setSearchQuery]
  )

  return (
    <DeleteDialogContext.Provider value={deleteDialogCtx}>
      <WhereUsedDialogContext.Provider value={whereUsedDialogCtx}>
        <div
          className="flex h-full flex-col"
          onFocus={() => useUiStore.getState().setFocusedPanel("tree")}
        >
          {/* Пошук */}
          {searchVisible && (
            <div className="flex items-center gap-1 border-b border-border px-1.5 py-1">
              <HugeiconsIcon
                icon={Search01Icon}
                size={14}
                className="shrink-0 text-muted-foreground"
              />
              <Input
                ref={searchInputRef}
                value={searchQuery}
                onChange={handleSearchChange}
                onKeyDown={handleSearchKeyDown}
                placeholder={t("tree.searchPlaceholder")}
                className="h-6 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label={t("action.close")}
                  className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setSearchQuery("")
                    searchInputRef.current?.focus()
                  }}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} />
                </button>
              )}
            </div>
          )}

          {!searchVisible && (
            <div className="flex items-center justify-between border-b border-border px-2 py-1">
              <span className="text-[0.6875rem] font-medium text-muted-foreground">
                {t("commandPalette.group.objects")}
              </span>
              <button
                type="button"
                aria-label={t("action.search")}
                className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setSearchVisible(true)
                  setTimeout(() => searchInputRef.current?.focus(), 0)
                }}
              >
                <HugeiconsIcon icon={Search01Icon} size={14} />
              </button>
            </div>
          )}

          {/* Дерево */}
          <div ref={containerRef} className="flex-1 overflow-hidden">
            <Tree<TreeNodeData>
              ref={treeRef}
              data={treeData}
              width={dimensions.width}
              height={dimensions.height}
              initialOpenState={initialOpenState}
              openByDefault={false}
              indent={16}
              rowHeight={28}
              overscanCount={5}
              selection={selectedNodeId}
              onSelect={handleSelect}
              onActivate={handleActivate}
              disableDrag
              disableDrop
              disableMultiSelection
              onToggle={toggleTreeNode}
              searchTerm={searchQuery}
              searchMatch={(node, term) => {
                const d = node.data
                if (d.nodeType === "kind") return true
                if (d.nodeType === "group") return true
                return d.name.toLowerCase().includes(term.toLowerCase())
              }}
              padding={4}
            >
              {TreeNode}
            </Tree>
          </div>

          {/* Один діалог видалення на все дерево */}
          <DeleteConfirmDialog
            open={deleteTarget !== null}
            onOpenChange={(open) => {
              if (!open) setDeleteTarget(null)
            }}
            objectName={deleteTarget?.name ?? ""}
            references={deleteRefs}
            onConfirm={confirmDelete}
          />

          {/* Діалог «Де використовується» */}
          <WhereUsedDialog
            open={whereUsedTarget !== null}
            onOpenChange={(open) => {
              if (!open) setWhereUsedTarget(null)
            }}
            objectName={whereUsedTarget?.name ?? ""}
            references={whereUsedTarget?.refs ?? []}
          />
        </div>
      </WhereUsedDialogContext.Provider>
    </DeleteDialogContext.Provider>
  )
}

// --- Діалог підтвердження видалення ---

function DeleteConfirmDialog({
  open,
  onOpenChange,
  objectName,
  references,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  objectName: string
  references: Reference[]
  onConfirm: () => void
}) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dialog.deleteTitle")}</DialogTitle>
          <DialogDescription>
            {references.length > 0
              ? t("dialog.deleteWithReferences", { name: objectName })
              : t("dialog.deleteMessage", { name: objectName })}
          </DialogDescription>
        </DialogHeader>

        {references.length > 0 && (
          <ul className="max-h-32 overflow-y-auto text-xs text-muted-foreground">
            {references.map((ref, i) => {
              const fmt = formatReference(ref)
              const fieldPath = fmt.fieldName
                ? fmt.tabularSectionName
                  ? `${fmt.tabularSectionName}.${fmt.fieldName}`
                  : fmt.fieldName
                : null
              return (
                <li key={i} className="py-0.5">
                  <span className="font-mono">
                    {ref.from.kind}/{ref.from.name}
                  </span>
                  <span className="ml-1 text-muted-foreground/70">
                    ({fieldPath ? `${fieldPath}, ` : ""}
                    {t(`referenceKind.${fmt.referenceKind}`)})
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("action.cancel")}
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {t("action.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
