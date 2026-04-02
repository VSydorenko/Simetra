import { useCallback, useMemo, useRef, useState, useEffect, createContext, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { Tree, type NodeRendererProps, type NodeApi, type TreeApi } from 'react-arborist'
import { useHotkeys } from 'react-hotkeys-hook'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Add01Icon,
  Copy01Icon,
  Delete02Icon,
  PencilEdit02Icon,
  Search01Icon,
  Cancel01Icon,
  LinkSquare02Icon,
} from '@hugeicons/core-free-icons'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@workspace/ui/components/context-menu'
import { Badge } from '@workspace/ui/components/badge'
import { Input } from '@workspace/ui/components/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components/dialog'
import { Button } from '@workspace/ui/components/button'
import { cn } from '@workspace/ui/lib/utils'
import type { MetadataKind, MetadataObject, ProjectModel } from '@simetra/core'
import { useMetadataStore } from '@/stores/metadata-store'
import { useUiStore, refToTabId } from '@/stores/ui-store'
import { KIND_ICONS, KIND_COLORS } from '@/lib/metadata-icons'
import { createDefaultObject, generateUniqueName, getObjectNames, KIND_TO_KEY } from '@/lib/metadata-defaults'
import { findReferences, type Reference } from '@/lib/find-references'

// --- Типи даних дерева ---

interface TreeNodeData {
  id: string
  name: string
  kind: MetadataKind
  isSection: boolean
  objectCount?: number
  children?: TreeNodeData[]
}

// Порядок розділів у дереві
const SECTION_ORDER: MetadataKind[] = [
  'Catalog',
  'Document',
  'Enumeration',
  'InformationRegister',
  'AccumulationRegister',
  'Constant',
  'CustomTable',
]

// --- Контекст для діалогу видалення (один на все дерево) ---

interface DeleteDialogState {
  requestDelete: (kind: MetadataKind, name: string) => void
}

const DeleteDialogContext = createContext<DeleteDialogState>({
  requestDelete: () => {},
})

// --- Побудова дерева ---

function buildTreeData(
  model: ProjectModel,
  searchQuery: string,
): TreeNodeData[] {
  const lowerQuery = searchQuery.toLowerCase()

  return SECTION_ORDER.map((kind) => {
    const key = KIND_TO_KEY[kind]
    const objects = model[key] as MetadataObject[]

    const filtered = searchQuery
      ? objects.filter((o) => o.name.toLowerCase().includes(lowerQuery))
      : objects

    return {
      id: kind,
      name: kind,
      kind,
      isSection: true,
      objectCount: objects.length,
      children: filtered.map((obj) => ({
        id: `${kind}/${obj.name}`,
        name: obj.name,
        kind,
        isSection: false,
      })),
    }
  })
}

// --- Головний компонент ---

export function TreePanel() {
  const { t } = useTranslation()
  const treeRef = useRef<TreeApi<TreeNodeData>>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [dimensions, setDimensions] = useState({ width: 240, height: 600 })
  const [searchVisible, setSearchVisible] = useState(false)

  // --- Delete dialog state (один на все дерево) ---
  const [deleteTarget, setDeleteTarget] = useState<{ kind: MetadataKind; name: string } | null>(null)
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
    useMetadataStore.getState().deleteObject(deleteTarget.kind, deleteTarget.name)
    setDeleteTarget(null)
  }, [deleteTarget])

  const deleteDialogCtx = useMemo(() => ({ requestDelete }), [requestDelete])

  // --- Store state ---
  const model = useMetadataStore((s) => s.model)
  const version = useMetadataStore((s) => s.version)

  const searchQuery = useUiStore((s) => s.searchQuery)
  const setSearchQuery = useUiStore((s) => s.setSearchQuery)
  const selectedObject = useUiStore((s) => s.selectedObject)
  const expandedTreeNodes = useUiStore((s) => s.expandedTreeNodes)
  const toggleTreeNode = useUiStore((s) => s.toggleTreeNode)

  // --- Побудова дерева ---
  const treeData = useMemo(
    () => buildTreeData(model, searchQuery),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, version, searchQuery],
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
  const selectedId = useMemo(() => {
    if (!selectedObject) return undefined
    return `${selectedObject.kind}/${selectedObject.name}`
  }, [selectedObject])

  // --- Обробники ---
  const handleSelect = useCallback(
    (nodes: NodeApi<TreeNodeData>[]) => {
      if (nodes.length === 0) return
      const node = nodes[0]
      if (node.data.isSection) {
        useUiStore.getState().selectObject(null)
        return
      }
      useUiStore.getState().selectObject({
        kind: node.data.kind,
        name: node.data.name,
      })
    },
    [],
  )

  const handleActivate = useCallback(
    (node: NodeApi<TreeNodeData>) => {
      if (node.data.isSection) return
      useUiStore.getState().openTab({
        kind: node.data.kind,
        name: node.data.name,
      })
    },
    [],
  )

  const handleRename = useCallback(
    ({ id, name }: { id: string; name: string; node: NodeApi<TreeNodeData> }) => {
      const parts = id.split('/')
      if (parts.length !== 2) return
      const kind = parts[0] as MetadataKind
      const oldName = parts[1]
      if (name === oldName) return

      const errors = useMetadataStore.getState().renameObject(kind, oldName, name)
      if (errors) return

      // Оновити вибір і вкладки на нове імʼя
      const uiState = useUiStore.getState()
      if (
        uiState.selectedObject?.kind === kind &&
        uiState.selectedObject.name === oldName
      ) {
        uiState.selectObject({ kind, name })
      }

      // Оновити відкриту вкладку якщо є
      const oldTabId = refToTabId({ kind, name: oldName })
      const existingTab = uiState.openTabs.find((tab) => tab.id === oldTabId)
      if (existingTab) {
        uiState.closeTab(oldTabId)
        uiState.openTab({ kind, name })
      }
    },
    [],
  )

  // --- Hotkeys ---
  useHotkeys(
    'mod+f',
    (e) => {
      e.preventDefault()
      setSearchVisible(true)
      setTimeout(() => searchInputRef.current?.focus(), 0)
    },
    { enableOnFormTags: true },
  )

  useHotkeys(
    'escape',
    () => {
      if (searchVisible) {
        setSearchVisible(false)
        setSearchQuery('')
        treeRef.current?.focus(treeRef.current.focusedNode ?? treeRef.current.firstNode)
      }
    },
    { enableOnFormTags: true },
  )

  // --- Search ---
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value)
    },
    [setSearchQuery],
  )

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        setSearchVisible(false)
        setSearchQuery('')
        treeRef.current?.focus(treeRef.current.focusedNode ?? treeRef.current.firstNode)
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        treeRef.current?.focus(treeRef.current.firstNode)
      }
    },
    [setSearchQuery],
  )

  return (
    <DeleteDialogContext.Provider value={deleteDialogCtx}>
      <div
        className="flex h-full flex-col"
        onFocus={() => useUiStore.getState().setFocusedPanel('tree')}
      >
        {/* Пошук */}
        {searchVisible && (
          <div className="flex items-center gap-1 border-b border-border px-1.5 py-1">
            <HugeiconsIcon icon={Search01Icon} size={14} className="shrink-0 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={handleSearchChange}
              onKeyDown={handleSearchKeyDown}
              placeholder={t('tree.searchPlaceholder')}
              className="h-6 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
            />
            {searchQuery && (
              <button
                type="button"
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setSearchQuery('')
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
              {t('commandPalette.group.objects')}
            </span>
            <button
              type="button"
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
            selection={selectedId}
            onSelect={handleSelect}
            onActivate={handleActivate}
            onRename={handleRename}
            disableDrag
            disableDrop
            disableMultiSelection
            onToggle={toggleTreeNode}
            searchTerm={searchQuery}
            searchMatch={(node, term) =>
              node.data.isSection || node.data.name.toLowerCase().includes(term.toLowerCase())
            }
            padding={4}
          >
            {TreeNode}
          </Tree>
        </div>

        {/* Один діалог видалення на все дерево */}
        <DeleteConfirmDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
          objectName={deleteTarget?.name ?? ''}
          references={deleteRefs}
          onConfirm={confirmDelete}
        />
      </div>
    </DeleteDialogContext.Provider>
  )
}

// --- Рендерер вузлів ---

function TreeNode({ node, style, dragHandle }: NodeRendererProps<TreeNodeData>) {
  const data = node.data

  if (data.isSection) {
    return <SectionNode node={node} style={style} dragHandle={dragHandle} />
  }

  return <ObjectNode node={node} style={style} dragHandle={dragHandle} />
}

// --- Вузол розділу ---

function SectionNode({
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
  const icon = KIND_ICONS[data.kind]

  const handleAddObject = useCallback(() => {
    const model = useMetadataStore.getState().model
    const existingNames = getObjectNames(model, data.kind)
    const name = generateUniqueName(data.kind, existingNames)
    const obj = createDefaultObject(data.kind, name)
    const errors = useMetadataStore.getState().createObject(obj)
    if (!errors) {
      useUiStore.getState().selectObject({ kind: data.kind, name })
      node.open()
    }
  }, [data.kind, node])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={dragHandle}
          style={style}
          className={cn(
            'group flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs',
            'hover:bg-accent/50',
            node.isFocused && 'bg-accent',
          )}
          onClick={() => node.toggle()}
        >
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {node.isOpen ? '▼' : '▶'}
          </span>
          <HugeiconsIcon
            icon={icon}
            size={14}
            className={cn('shrink-0', KIND_COLORS[data.kind])}
          />
          <span className="truncate font-medium">
            {t(`metadata.kindPlural.${data.kind}`)}
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
          {t('tree.addObject', { kind: t(`metadata.kind.${data.kind}`) })}
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
  const icon = KIND_ICONS[data.kind]
  const { requestDelete } = useContext(DeleteDialogContext)

  const handleAdd = useCallback(() => {
    const model = useMetadataStore.getState().model
    const existingNames = getObjectNames(model, data.kind)
    const name = generateUniqueName(data.kind, existingNames)
    const obj = createDefaultObject(data.kind, name)
    const errors = useMetadataStore.getState().createObject(obj)
    if (!errors) {
      useUiStore.getState().selectObject({ kind: data.kind, name })
    }
  }, [data.kind])

  const handleRename = useCallback(() => {
    node.edit()
  }, [node])

  const handleDuplicate = useCallback(() => {
    const model = useMetadataStore.getState().model
    const existingNames = getObjectNames(model, data.kind)
    const newName = generateUniqueName(data.kind, existingNames)
    useMetadataStore.getState().duplicateObject(data.kind, data.name, newName)
    useUiStore.getState().selectObject({ kind: data.kind, name: newName })
  }, [data.kind, data.name])

  const handleDelete = useCallback(() => {
    requestDelete(data.kind, data.name)
  }, [data.kind, data.name, requestDelete])

  const handleWhereUsed = useCallback(() => {
    // TODO: повноцінний діалог «Де використовується» — Модуль 9
    const model = useMetadataStore.getState().model
    const refs = findReferences(model, data.kind, data.name)
    if (refs.length === 0) {
      console.info(`"${data.name}" не використовується`)
    } else {
      console.info(`"${data.name}" використовується в:`, refs)
    }
  }, [data.kind, data.name])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={dragHandle}
          style={style}
          className={cn(
            'flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-xs',
            'hover:bg-accent/50',
            node.isSelected && 'bg-accent text-accent-foreground border-l-2 border-primary',
            node.isFocused && !node.isSelected && 'ring-1 ring-ring',
          )}
        >
          <HugeiconsIcon
            icon={icon}
            size={14}
            className={cn('shrink-0', KIND_COLORS[data.kind])}
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
          {t('tree.addObject', { kind: t(`metadata.kind.${data.kind}`) })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleRename}>
          <HugeiconsIcon icon={PencilEdit02Icon} size={14} className="mr-2" />
          {t('tree.renameObject')}
        </ContextMenuItem>
        <ContextMenuItem onClick={handleDuplicate}>
          <HugeiconsIcon icon={Copy01Icon} size={14} className="mr-2" />
          {t('tree.duplicateObject')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleWhereUsed}>
          <HugeiconsIcon icon={LinkSquare02Icon} size={14} className="mr-2" />
          {t('tree.whereUsed')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={handleDelete}
          className="text-destructive focus:text-destructive"
        >
          <HugeiconsIcon icon={Delete02Icon} size={14} className="mr-2" />
          {t('tree.deleteObject')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// --- Inline rename input ---

function RenameInput({ node }: { node: NodeApi<TreeNodeData> }) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <input
      ref={inputRef}
      type="text"
      defaultValue={node.data.name}
      className="h-5 w-full rounded-sm border border-ring bg-background px-1 font-mono text-[0.75rem] outline-none"
      onBlur={() => node.reset()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          node.submit(e.currentTarget.value)
        }
        if (e.key === 'Escape') {
          node.reset()
        }
      }}
    />
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
          <DialogTitle>{t('dialog.deleteTitle')}</DialogTitle>
          <DialogDescription>
            {references.length > 0
              ? t('dialog.deleteWithReferences', { name: objectName })
              : t('dialog.deleteMessage', { name: objectName })}
          </DialogDescription>
        </DialogHeader>

        {references.length > 0 && (
          <ul className="max-h-32 overflow-y-auto text-xs text-muted-foreground">
            {references.map((ref, i) => (
              <li key={i} className="py-0.5">
                <span className="font-mono">{ref.from.kind}/{ref.from.name}</span>
                <span className="ml-1 text-muted-foreground/70">({ref.via})</span>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('action.cancel')}
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {t('action.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
