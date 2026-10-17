import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Separator } from "@workspace/ui/components/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  FileAddIcon,
  FolderOpenIcon,
  FloppyDiskIcon,
  Download04Icon,
  Upload04Icon,
  SourceCodeIcon,
  ArrowTurnBackwardIcon,
  ArrowTurnForwardIcon,
} from "@hugeicons/core-free-icons"
import { useStore } from "zustand"
import { useMetadataStore } from "@/stores/metadata-store"
import { useProjectStore } from "@/stores/project-store"
import { useDdlStore } from "@/stores/ddl-store"
import { useUiStore } from "@/stores/ui-store"
import { useIsDirty } from "@/hooks/use-is-dirty"
import { formatShortcut } from "@/lib/format-shortcut"

export function TopBar() {
  const { t } = useTranslation()
  const isDirty = useIsDirty()
  const projectName = useMetadataStore((s) => s.model.project.name)
  const isSaving = useProjectStore((s) => s.isSaving)
  const isLoading = useProjectStore((s) => s.isLoading)

  const canUndo = useStore(
    useMetadataStore.temporal,
    (s) => s.pastStates.length > 0
  )
  const canRedo = useStore(
    useMetadataStore.temporal,
    (s) => s.futureStates.length > 0
  )

  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelledRef = useRef(false)

  const startEditing = useCallback(() => {
    cancelledRef.current = false
    setDraft(projectName)
    setIsEditing(true)
  }, [projectName])

  const commitEdit = useCallback(() => {
    if (cancelledRef.current) return
    const trimmed = draft.trim()
    if (trimmed.length > 0 && trimmed !== projectName) {
      useMetadataStore.getState().updateProject({ name: trimmed })
    }
    setIsEditing(false)
  }, [draft, projectName])

  const cancelEdit = useCallback(() => {
    cancelledRef.current = true
    setDraft(projectName)
    setIsEditing(false)
  }, [projectName])

  // AutoFocus + selectAll при вході в режим редагування
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleNew = () => useProjectStore.getState().newProject("NewProject")
  const handleOpen = () => void useProjectStore.getState().openProject()
  const handleSave = () => void useProjectStore.getState().saveProject()
  const handleExport = () => void useProjectStore.getState().exportProject()
  const handleImport = () => void useProjectStore.getState().importProject()
  const handleGenerate = () => {
    useDdlStore.getState().generateDdl()
    useUiStore.getState().openSqlPreview()
  }
  const handleUndo = () => useMetadataStore.temporal.getState().undo()
  const handleRedo = () => useMetadataStore.temporal.getState().redo()

  const busy = isSaving || isLoading

  return (
    <header className="z-panels flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-3">
      {/* Логотип і назва проєкту */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold tracking-tight">
          {t("app.name")}
        </span>
        <Separator orientation="vertical" className="!h-4" />
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit()
              if (e.key === "Escape") cancelEdit()
            }}
            className="max-w-48 rounded-sm border border-border bg-transparent px-1 text-xs text-muted-foreground outline-none focus:border-primary"
          />
        ) : (
          <span
            className="max-w-48 cursor-pointer truncate text-xs text-muted-foreground hover:text-foreground"
            onClick={startEditing}
            onKeyDown={(e) => {
              if (e.key === "F2") startEditing()
            }}
            role="button"
            tabIndex={0}
          >
            {projectName}
            {isDirty && <span className="text-warning"> *</span>}
          </span>
        )}
      </div>

      {/* Кнопки дій */}
      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={busy}
              onClick={handleNew}
            >
              <HugeiconsIcon
                icon={FileAddIcon}
                strokeWidth={2}
                className="size-4"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("action.new")}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={busy}
              onClick={handleOpen}
            >
              <HugeiconsIcon
                icon={FolderOpenIcon}
                strokeWidth={2}
                className="size-4"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("action.open")}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={busy || !isDirty}
              onClick={handleSave}
            >
              <HugeiconsIcon
                icon={FloppyDiskIcon}
                strokeWidth={2}
                className="size-4"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("action.save")} ({formatShortcut("Mod+S")})
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={busy}
              onClick={handleGenerate}
            >
              <HugeiconsIcon
                icon={SourceCodeIcon}
                strokeWidth={2}
                className="size-4"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("sqlPreview.generateSql")} ({formatShortcut("Mod+G")})
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={busy}
              onClick={handleExport}
            >
              <HugeiconsIcon
                icon={Download04Icon}
                strokeWidth={2}
                className="size-4"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("action.export")}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={busy}
              onClick={handleImport}
            >
              <HugeiconsIcon
                icon={Upload04Icon}
                strokeWidth={2}
                className="size-4"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("action.import")}</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="!mx-1 !h-4" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!canUndo}
              onClick={handleUndo}
            >
              <HugeiconsIcon
                icon={ArrowTurnBackwardIcon}
                strokeWidth={2}
                className="size-4"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("action.undo")} ({formatShortcut("Mod+Z")})
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!canRedo}
              onClick={handleRedo}
            >
              <HugeiconsIcon
                icon={ArrowTurnForwardIcon}
                strokeWidth={2}
                className="size-4"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("action.redo")} ({formatShortcut("Mod+Shift+Z")})
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
