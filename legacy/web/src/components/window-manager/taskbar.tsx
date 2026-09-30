import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"
import { useUiStore } from "../../stores/ui-store"

/**
 * Taskbar — смужка в нижній частині центральної панелі
 * для мінімізованих floating windows.
 */
export function Taskbar() {
  const { t } = useTranslation()
  const floatingWindows = useUiStore((s) => s.floatingWindows)
  const restoreWindow = useUiStore((s) => s.restoreWindow)
  const focusWindow = useUiStore((s) => s.focusWindow)
  const closeWindow = useUiStore((s) => s.closeWindow)

  const minimizedWindows = floatingWindows.filter((w) => w.isMinimized)

  if (minimizedWindows.length === 0) return null

  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-t border-border bg-muted/50 px-2">
      {minimizedWindows.map((win) => (
        <TaskbarItem
          key={win.id}
          kind={win.objectRef.kind}
          name={win.objectRef.name}
          onRestore={() => {
            restoreWindow(win.id)
            focusWindow(win.id)
          }}
          onClose={() => closeWindow(win.id)}
          closeLabel={t("floatingWindow.close")}
        />
      ))}
    </div>
  )
}

function TaskbarItem({
  kind,
  name,
  onRestore,
  onClose,
  closeLabel,
}: {
  kind: string
  name: string
  onRestore: () => void
  onClose: () => void
  closeLabel: string
}) {
  const { t } = useTranslation()

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onClose()
    },
    [onClose]
  )

  return (
    <button
      type="button"
      className={cn(
        "group flex h-5 items-center gap-1 rounded-sm border border-border",
        "bg-background px-1.5 text-[10px] transition-colors hover:bg-accent/50"
      )}
      onClick={onRestore}
    >
      <Badge
        variant="outline"
        className="shrink-0 px-0.5 py-0 text-[8px] leading-tight"
      >
        {t(`metadata.kind.${kind}`)}
      </Badge>
      <span className="max-w-20 truncate font-mono">{name}</span>
      <button
        type="button"
        className="ml-0.5 shrink-0 rounded-sm opacity-0 group-hover:opacity-100 hover:text-destructive"
        onClick={handleClose}
        aria-label={closeLabel}
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M2 2l6 6M8 2l-6 6" />
        </svg>
      </button>
    </button>
  )
}
